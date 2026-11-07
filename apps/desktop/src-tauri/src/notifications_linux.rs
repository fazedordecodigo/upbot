use super::{parse_activation, Notification, NotificationResponse};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;
use zbus::{
    blocking::{Connection, Proxy},
    zvariant::Value,
};

static BACKEND: OnceLock<Mutex<Option<Backend>>> = OnceLock::new();

#[derive(Clone)]
struct Backend {
    proxy: Proxy<'static>,
    actions: bool,
    markup: bool,
    entries: Arc<Mutex<Entries>>,
}

#[derive(Default)]
struct Entries(HashMap<String, (u32, Vec<String>, Notification)>);

impl Entries {
    fn server_id(&self, id: &str) -> u32 {
        self.0.get(id).map_or(0, |entry| entry.0)
    }

    fn replace(&mut self, notification: Notification, server: u32, actions: Vec<String>) {
        self.close(server);
        self.0
            .insert(notification.id.clone(), (server, actions, notification));
    }

    fn remove(&mut self, id: &str) -> Option<u32> {
        self.0.remove(id).map(|entry| entry.0)
    }

    fn close(&mut self, server: u32) {
        self.0.retain(|_, entry| entry.0 != server);
    }

    fn expired(
        &mut self,
        server: u32,
        reason: u32,
        now: u64,
        mute_until: u64,
    ) -> Option<Notification> {
        let entry = self.0.values().find(|entry| entry.0 == server)?;
        if should_repost(reason, &entry.2, now, mute_until) {
            Some(entry.2.clone())
        } else {
            self.close(server);
            None
        }
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

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

fn timeout(expires_at: Option<u64>, now: u64) -> i32 {
    expires_at.map_or(-1, |expires| {
        expires.saturating_sub(now).clamp(1, i32::MAX as u64) as i32
    })
}

fn should_repost(reason: u32, notification: &Notification, now: u64, mute_until: u64) -> bool {
    reason == 1
        && mute_until <= now
        && !notification.muted
        && notification.expires_at.is_some_and(|expires| expires > now)
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
    let listener = native.clone();
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
                        if let Ok((server, reason)) = message.body().deserialize::<(u32, u32)>() {
                            let _ = listener.closed(server, reason);
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
            return self.remove(&notification.id);
        }
        let mut entries = self.entries.lock().unwrap();
        let replaces = entries.server_id(&notification.id);
        self.notify(&mut entries, notification, replaces)
            .map(|_| ())
    }

    fn closed(&self, server: u32, reason: u32) -> Result<Option<u32>, String> {
        let mut entries = self.entries.lock().unwrap();
        if let Some(notification) = entries.expired(
            server,
            reason,
            now_ms(),
            super::MUTE_UNTIL.load(super::Ordering::SeqCst),
        ) {
            let result = self.notify(&mut entries, notification, server);
            if result.is_err() {
                entries.close(server);
            }
            return result.map(Some);
        }
        Ok(None)
    }

    fn notify(
        &self,
        entries: &mut Entries,
        notification: Notification,
        replaces: u32,
    ) -> Result<u32, String> {
        let action_list = actions(&notification, self.actions);
        let hints = HashMap::from([("desktop-entry", Value::from("com.boto.desktop"))]);
        let server: u32 = self
            .proxy
            .call(
                "Notify",
                &(
                    "Boto",
                    replaces,
                    "",
                    &notification.title,
                    escape_body(&notification.body, self.markup),
                    &action_list,
                    hints,
                    timeout(notification.expires_at, now_ms()),
                ),
            )
            .map_err(dbus_error)?;
        entries.replace(notification, server, action_list);
        Ok(server)
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
    let backend = BACKEND
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap()
        .clone();
    backend
        .as_ref()
        .map_or(Ok(()), |native| native.post(notification))
}

pub fn remove(id: &str) -> Result<(), String> {
    let backend = BACKEND
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap()
        .clone();
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
            expires_at: None,
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

    fn with_id(id: &str) -> Notification {
        Notification {
            id: id.into(),
            ..notification()
        }
    }

    #[test]
    fn notification_timeouts() {
        assert_eq!(timeout(None, 100), -1);
        assert_eq!(timeout(Some(200), 100), 100);
        assert_eq!(timeout(Some(100), 100), 1);
        assert_eq!(timeout(Some(0), 100), 1);
        assert_eq!(timeout(Some(u64::MAX), 0), i32::MAX);
        assert_eq!(timeout(Some(i32::MAX as u64 + 100), 100), i32::MAX);
        let parsed: Notification = serde_json::from_str(
            r#"{"id":"id","title":"","body":"","actions":[],"muted":false,"expiresAt":200}"#,
        )
        .unwrap();
        assert_eq!(parsed.expires_at, Some(200));
        let legacy: Notification =
            serde_json::from_str(r#"{"id":"id","title":"","body":"","actions":[],"muted":false}"#)
                .unwrap();
        assert_eq!(legacy.expires_at, None);
    }

    #[test]
    fn notification_expiry_and_muted_removal() {
        let mut pending = notification();
        pending.expires_at = Some(200);
        assert!(should_repost(1, &pending, 100, 0));
        assert!(!should_repost(1, &pending, 200, 0));
        assert!(!should_repost(1, &pending, 201, 0));
        for reason in [0, 2, 3, 4] {
            assert!(!should_repost(reason, &pending, 100, 0));
        }
        assert!(!should_repost(1, &notification(), 100, 0));
        let mut muted = pending.clone();
        muted.muted = true;
        assert!(!should_repost(1, &muted, 100, 0));

        let mut entries = Entries::default();
        assert!(entries.expired(1, 1, 100, 0).is_none());
        entries.replace(pending.clone(), 1, actions(&pending, true));
        let repost = entries.expired(1, 1, 100, 0).unwrap();
        assert_eq!(repost.expires_at, pending.expires_at);
        assert_eq!(repost.body, pending.body);
        assert_eq!(entries.server_id(&pending.id), 1);
        entries.replace(repost, 2, actions(&pending, true));
        assert!(entries.expired(1, 1, 100, 0).is_none());
        assert_eq!(entries.server_id(&pending.id), 2);
        entries.replace(notification(), 2, vec![]);
        assert!(entries.expired(2, 1, 100, 0).is_none());
        assert!(entries.0.is_empty());
        for reason in [1, 2, 3, 4] {
            entries.replace(pending.clone(), 1, vec![]);
            assert!(entries.expired(1, reason, 200, 0).is_none());
            assert!(entries.0.is_empty());
        }
        entries.replace(pending.clone(), 1, vec![]);
        assert_eq!(entries.remove(&muted.id), Some(1));
        assert!(entries.expired(1, 1, 100, 0).is_none());
        assert_eq!(entries.remove(&muted.id), None);
    }

    #[test]
    fn notification_repost_tracks_reused_or_new_server_id() {
        for replacement in [1, 2] {
            let mut pending = notification();
            pending.expires_at = Some(200);
            let mut entries = Entries::default();
            entries.replace(pending.clone(), 1, actions(&pending, true));
            let repost = entries.expired(1, 1, 100, 0).unwrap();
            entries.replace(repost, replacement, actions(&pending, true));
            assert_eq!(entries.0.len(), 1);
            assert_eq!(entries.server_id(&pending.id), replacement);
            assert_eq!(
                entries.response(replacement, "task"),
                parse_activation("task|linux-test")
            );
            if replacement != 1 {
                assert!(entries.response(1, "task").is_none());
                assert!(entries.expired(1, 1, 100, 0).is_none());
                assert!(entries.expired(1, 1, 100, 0).is_none());
                assert_eq!(entries.0.len(), 1);
                assert_eq!(entries.server_id(&pending.id), replacement);
            }
            assert_eq!(entries.remove(&pending.id), Some(replacement));
            assert!(entries.0.is_empty());
            assert!(entries.expired(replacement, 1, 100, 0).is_none());
        }
    }

    #[test]
    fn native_mute_blocks_expiry_without_replay() {
        let mut pending = notification();
        pending.expires_at = Some(500);
        assert!(!should_repost(1, &pending, 100, 200));
        assert!(should_repost(1, &pending, 200, 200));
        assert!(should_repost(1, &pending, 201, 200));
        assert!(should_repost(1, &pending, 100, 0));
        let mut entries = Entries::default();
        entries.replace(pending.clone(), 1, actions(&pending, true));
        assert!(entries.expired(1, 1, 100, 200).is_none());
        assert!(entries.0.is_empty());
        assert!(entries.expired(1, 1, 201, 200).is_none());
        assert!(entries.expired(1, 1, 201, 0).is_none());
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
        entries.replace(with_id("id"), 1, actions(&notification(), true));
        assert_eq!(
            entries.response(1, "default"),
            parse_activation("review|id")
        );
        assert_eq!(entries.response(1, "task"), parse_activation("task|id"));
        assert!(entries.response(2, "task").is_none());
        assert!(entries.response(1, "undo").is_none());
        assert!(entries.response(1, "always").is_none());
        entries.replace(with_id("id"), 2, vec![]);
        entries.close(1);
        assert_eq!(entries.server_id("id"), 2);
        assert!(entries.response(1, "task").is_none());
        assert!(entries.response(2, "default").is_none());
        entries.close(2);
        assert_eq!(entries.server_id("id"), 0);
        entries.replace(with_id("id"), 3, vec![]);
        assert_eq!(entries.remove("id"), Some(3));
        assert!(entries.0.is_empty());
        entries.replace(with_id("bad|id"), 4, actions(&notification(), true));
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
        assert_eq!(native.entries.lock().unwrap().server_id("linux-test"), 0);
        println!("muted post removed server id: {first}");
        native.post(notification()).unwrap();
        let first = native.entries.lock().unwrap().server_id("linux-test");
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

    #[test]
    #[ignore = "requires a freedesktop notification server supporting expiry"]
    fn notifications_real_expiry() {
        let native = connect().expect("notification server");
        let mut signals = native.proxy.receive_all_signals().unwrap();
        let mut pending = with_id("linux-expiry-test");
        pending.expires_at = Some(now_ms() + 30_000);
        native.post(pending.clone()).unwrap();
        let first = native.entries.lock().unwrap().server_id(&pending.id);
        let forced: u32 = native
            .proxy
            .call(
                "Notify",
                &(
                    "Boto",
                    first,
                    "",
                    &pending.title,
                    &pending.body,
                    actions(&pending, native.actions),
                    HashMap::from([("transient", Value::from(true))]),
                    100i32,
                ),
            )
            .unwrap();
        assert_eq!(forced, first);
        for message in &mut signals {
            if message.header().member().map(|m| m.as_str()) == Some("NotificationClosed") {
                let (server, reason): (u32, u32) = message.body().deserialize().unwrap();
                if server != first {
                    continue;
                }
                assert_eq!(reason, 1);
                let replacement = native.closed(server, reason).unwrap().unwrap();
                let mut entries = native.entries.lock().unwrap();
                assert_eq!(entries.server_id(&pending.id), replacement);
                assert_eq!(entries.0.len(), 1);
                assert_eq!(
                    entries.response(replacement, "task"),
                    parse_activation("task|linux-expiry-test")
                );
                if replacement != first {
                    assert!(entries.response(first, "task").is_none());
                    assert!(entries.expired(first, 1, now_ms(), 0).is_none());
                }
                println!("early expiry re-presented: {first} -> {replacement}");
                break;
            }
        }
        pending.muted = true;
        native.post(pending.clone()).unwrap();
        assert_eq!(native.entries.lock().unwrap().server_id(&pending.id), 0);
        native.closed(first, 1).unwrap();
        assert_eq!(native.entries.lock().unwrap().server_id(&pending.id), 0);
        println!("muted post closed notification; late expiry did not re-present");
    }
}
