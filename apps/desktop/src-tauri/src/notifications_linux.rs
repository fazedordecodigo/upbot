use super::{parse_activation, Notification, NotificationResponse};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use tauri::AppHandle;
use zbus::{
    blocking::{Connection, Proxy},
    zvariant::Value,
};

static BACKEND: OnceLock<Mutex<Option<Backend>>> = OnceLock::new();

struct Backend {
    proxy: Proxy<'static>,
    actions: bool,
    markup: bool,
    entries: Arc<Mutex<Entries>>,
}

#[derive(Default)]
struct Entries(HashMap<String, (u32, Vec<String>)>);

impl Entries {
    fn server_id(&self, id: &str) -> u32 {
        self.0.get(id).map_or(0, |entry| entry.0)
    }

    fn replace(&mut self, id: String, server: u32, actions: Vec<String>) {
        self.close(server);
        self.0.insert(id, (server, actions));
    }

    fn remove(&mut self, id: &str) -> Option<u32> {
        self.0.remove(id).map(|entry| entry.0)
    }

    fn close(&mut self, server: u32) {
        self.0.retain(|_, entry| entry.0 != server);
    }

    fn response(&self, server: u32, action: &str) -> Option<NotificationResponse> {
        let (id, _) = self.0.iter().find(|(_, entry)| {
            entry.0 == server && entry.1.iter().step_by(2).any(|key| key == action)
        })?;
        let action = if action == "default" {
            "review"
        } else {
            action
        };
        parse_activation(&format!("{action}|{id}"))
    }
}

fn escape_body(body: &str, markup: bool) -> String {
    if markup {
        body.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    } else {
        body.to_string()
    }
}

fn actions(notification: &Notification, supported: bool) -> Vec<String> {
    if !supported {
        return Vec::new();
    }
    let mut actions = vec!["default".into(), "Revisar no Boto".into()];
    for button in &notification.actions {
        if button.id != "default"
            && parse_activation(&format!("{}|{}", button.id, notification.id)).is_some()
        {
            actions.extend([button.id.clone(), button.label.clone()]);
        }
    }
    actions
}

fn connect() -> zbus::Result<Backend> {
    let connection = Connection::session()?;
    let proxy = Proxy::new_owned(
        connection,
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
        "org.freedesktop.Notifications",
    )?;
    let _: (String, String, String, String) = proxy.call("GetServerInformation", &())?;
    let capabilities: Vec<String> = proxy.call("GetCapabilities", &())?;
    Ok(Backend {
        proxy,
        actions: capabilities.iter().any(|c| c == "actions"),
        markup: capabilities.iter().any(|c| c == "body-markup"),
        entries: Arc::new(Mutex::new(Entries::default())),
    })
}

pub fn initialize(app: AppHandle) -> bool {
    let mut backend = BACKEND.get_or_init(|| Mutex::new(None)).lock().unwrap();
    if backend.is_some() {
        return true;
    }
    let Ok(native) = connect() else { return false };
    let Ok(signals) = native.proxy.receive_all_signals() else {
        return false;
    };
    let entries = native.entries.clone();
    if std::thread::Builder::new()
        .name("boto-notifications".into())
        .spawn(move || {
            for message in signals {
                match message.header().member().map(|m| m.as_str()) {
                    Some("ActionInvoked") => {
                        if let Ok((server, action)) = message.body().deserialize::<(u32, String)>()
                        {
                            let response = entries.lock().unwrap().response(server, &action);
                            if let Some(response) = response {
                                super::respond(&app, response.id, response.action);
                            }
                        }
                    }
                    Some("NotificationClosed") => {
                        if let Ok((server, _)) = message.body().deserialize::<(u32, u32)>() {
                            entries.lock().unwrap().close(server);
                        }
                    }
                    _ => {}
                }
            }
        })
        .is_err()
    {
        return false;
    }
    *backend = Some(native);
    true
}

fn dbus_error(_: zbus::Error) -> String {
    log::warn!("Native notification failure: dbus_call");
    "notification_dbus_call".into()
}

impl Backend {
    fn post(&self, notification: Notification) -> Result<(), String> {
        if notification.muted {
            return Ok(());
        }
        let mut entries = self.entries.lock().unwrap();
        let action_list = actions(&notification, self.actions);
        let hints = HashMap::from([("desktop-entry", Value::from("com.boto.desktop"))]);
        let server: u32 = self
            .proxy
            .call(
                "Notify",
                &(
                    "Boto",
                    entries.server_id(&notification.id),
                    "",
                    &notification.title,
                    escape_body(&notification.body, self.markup),
                    &action_list,
                    hints,
                    -1i32,
                ),
            )
            .map_err(dbus_error)?;
        entries.replace(notification.id, server, action_list);
        Ok(())
    }

    fn remove(&self, id: &str) -> Result<(), String> {
        let mut entries = self.entries.lock().unwrap();
        if let Some(server) = entries.remove(id) {
            self.proxy
                .call::<_, _, ()>("CloseNotification", &(server,))
                .map_err(dbus_error)?;
        }
        Ok(())
    }
}

pub fn post(notification: Notification) -> Result<(), String> {
    let backend = BACKEND.get_or_init(|| Mutex::new(None)).lock().unwrap();
    backend
        .as_ref()
        .map_or(Ok(()), |native| native.post(notification))
}

pub fn remove(id: &str) -> Result<(), String> {
    let backend = BACKEND.get_or_init(|| Mutex::new(None)).lock().unwrap();
    backend.as_ref().map_or(Ok(()), |native| native.remove(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notification() -> Notification {
        Notification {
            id: "linux-test".into(),
            title: "Boto".into(),
            body: "Um bot precisa de aprovação.".into(),
            muted: false,
            actions: vec![
                super::super::NotificationButton {
                    id: "task".into(),
                    label: "Permitir".into(),
                },
                super::super::NotificationButton {
                    id: "deny".into(),
                    label: "Negar".into(),
                },
            ],
        }
    }

    #[test]
    fn markup_and_actions() {
        assert_eq!(escape_body("&<b>", true), "&amp;&lt;b&gt;");
        assert_eq!(escape_body("&<b>", false), "&<b>");
        assert_eq!(escape_body("", true), "");
        assert!(actions(&notification(), false).is_empty());
        assert_eq!(
            actions(&notification(), true),
            [
                "default",
                "Revisar no Boto",
                "task",
                "Permitir",
                "deny",
                "Negar"
            ]
        );
        let mut empty = notification();
        empty.actions.clear();
        assert_eq!(actions(&empty, true).len(), 2);
        empty.actions.push(super::super::NotificationButton {
            id: "always".into(),
            label: "invalid".into(),
        });
        assert_eq!(actions(&empty, true).len(), 2);
    }

    #[test]
    fn mapping_and_signals() {
        let mut entries = Entries::default();
        assert_eq!(entries.server_id("missing"), 0);
        assert_eq!(entries.remove("missing"), None);
        entries.replace("id".into(), 1, actions(&notification(), true));
        assert_eq!(
            entries.response(1, "default"),
            parse_activation("review|id")
        );
        assert_eq!(entries.response(1, "task"), parse_activation("task|id"));
        assert!(entries.response(2, "task").is_none());
        assert!(entries.response(1, "undo").is_none());
        assert!(entries.response(1, "always").is_none());
        entries.replace("id".into(), 2, vec![]);
        entries.close(1);
        assert_eq!(entries.server_id("id"), 2);
        assert!(entries.response(1, "task").is_none());
        assert!(entries.response(2, "default").is_none());
        entries.close(2);
        assert_eq!(entries.server_id("id"), 0);
        entries.replace("id".into(), 3, vec![]);
        assert_eq!(entries.remove("id"), Some(3));
        assert!(entries.0.is_empty());
        entries.replace("bad|id".into(), 4, actions(&notification(), true));
        assert!(entries.response(4, "task").is_none());
    }

    #[test]
    #[ignore = "requires a freedesktop notification server; invoke task on linux-test"]
    fn notifications_real_server() {
        let native = connect().expect("notification server");
        assert!(native.actions);
        let mut signals = native.proxy.receive_all_signals().unwrap();
        native.post(notification()).unwrap();
        let first = native.entries.lock().unwrap().server_id("linux-test");
        let mut muted = notification();
        muted.muted = true;
        native.post(muted).unwrap();
        assert_eq!(
            native.entries.lock().unwrap().server_id("linux-test"),
            first
        );
        native.post(notification()).unwrap();
        assert_eq!(
            native.entries.lock().unwrap().server_id("linux-test"),
            first
        );
        println!("replacement server id: {first}");
        for message in &mut signals {
            if message.header().member().map(|m| m.as_str()) == Some("ActionInvoked") {
                let (server, action): (u32, String) = message.body().deserialize().unwrap();
                let response = native
                    .entries
                    .lock()
                    .unwrap()
                    .response(server, &action)
                    .unwrap();
                assert_eq!(response, parse_activation("task|linux-test").unwrap());
                println!("response: {}|{}", response.action, response.id);
                break;
            }
        }
        native.remove("linux-test").unwrap();
    }
}
