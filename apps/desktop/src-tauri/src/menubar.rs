use std::sync::Mutex;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const TRAY_ID: &str = "boto";

#[derive(Default)]
struct MenubarState {
    navigation: Mutex<MainNavigation>,
}

#[derive(Default)]
struct MainNavigation {
    ready: bool,
    pending: Option<String>,
}

impl MainNavigation {
    fn request(&mut self, view: String) -> Option<String> {
        if self.ready {
            Some(view)
        } else {
            self.pending = Some(view);
            None
        }
    }

    fn mounted(&mut self) -> Option<String> {
        self.ready = true;
        self.pending.take()
    }
}

fn keep_main_window(window: &tauri::WebviewWindow) {
    let handle = window.app_handle().clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(window) = handle.get_webview_window("main") {
                if let Err(error) = window.hide() {
                    log::warn!("could not hide main window: {error}");
                }
            }
        }
    });
}

fn tray_tooltip(count: u32) -> String {
    if count == 0 {
        "Boto".into()
    } else if count == 1 {
        "Boto — 1 tarefa aguardando você".into()
    } else {
        format!("Boto — {count} tarefas aguardando você")
    }
}

#[cfg(any(target_os = "macos", test))]
fn tray_title(count: u32) -> String {
    if count == 0 {
        String::new()
    } else {
        count.to_string()
    }
}

fn focus_main(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = open_main(app, None).await {
            log::warn!("could not focus main window: {error}");
        }
    });
}

pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(MenubarState::default());
    if let Some(window) = app.get_webview_window("main") {
        keep_main_window(&window);
    }
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../icons/tray-symbol.png"
        ))?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip(tray_tooltip(0))
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            let app = tray.app_handle();
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_main(app.clone());
            }
        })
        .build(app)?;
    let modifiers = Modifiers::ALT
        | if cfg!(target_os = "macos") {
            Modifiers::SUPER
        } else {
            Modifiers::CONTROL
        };
    app.global_shortcut().on_shortcut(
        Shortcut::new(Some(modifiers), Code::KeyU),
        |app, _, event| {
            if event.state == ShortcutState::Pressed {
                focus_main(app.clone());
            }
        },
    )?;
    Ok(())
}

#[tauri::command]
pub fn set_tray_count(app: AppHandle, count: u32) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("Boto tray icon not found")?;
    #[cfg(target_os = "macos")]
    tray.set_title(Some(tray_title(count)))
        .map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(tray_tooltip(count)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn open_main(app: AppHandle, view: Option<String>) -> Result<(), String> {
    let existing = app.get_webview_window("main");
    let navigation = {
        let state = app.state::<MenubarState>();
        let mut navigation = state.navigation.lock().unwrap();
        if existing.is_none() {
            navigation.ready = false;
        }
        view.and_then(|view| navigation.request(view))
    };
    let window = match existing {
        Some(window) => window,
        None => {
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or("Main window configuration not found")?;
            let window = WebviewWindowBuilder::from_config(&app, config)
                .map_err(|error| error.to_string())?
                .visible(false)
                .build()
                .map_err(|error| error.to_string())?;
            keep_main_window(&window);
            window
        }
    };
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    if let Some(view) = navigation {
        window
            .emit("boto://navigate", view)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn main_ready(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can receive navigation".into());
    }
    let view = app
        .state::<MenubarState>()
        .navigation
        .lock()
        .unwrap()
        .mounted();
    if let Some(view) = view {
        window
            .emit("boto://navigate", view)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_waits_for_mount_and_delivers_the_latest_view_once() {
        let mut navigation = MainNavigation::default();
        assert_eq!(navigation.request("apps".into()), None);
        assert_eq!(navigation.request("bot-id".into()), None);
        assert_eq!(navigation.mounted(), Some("bot-id".into()));
        assert_eq!(navigation.mounted(), None);
        assert_eq!(navigation.request("apps".into()), Some("apps".into()));
        navigation.ready = false;
        assert_eq!(navigation.request("settings".into()), None);
        assert_eq!(navigation.mounted(), Some("settings".into()));
    }

    #[test]
    fn empty_count_clears_title_and_tooltip() {
        assert_eq!(tray_title(0), "");
        assert_eq!(tray_tooltip(0), "Boto");
    }

    #[test]
    fn pending_count_is_shown_without_truncation() {
        assert_eq!(tray_tooltip(1), "Boto — 1 tarefa aguardando você");
        assert_eq!(tray_title(1), "1");
        for count in [3, u32::MAX] {
            assert_eq!(tray_title(count), count.to_string());
            assert_eq!(
                tray_tooltip(count),
                format!("Boto — {count} tarefas aguardando você")
            );
        }
    }
}
