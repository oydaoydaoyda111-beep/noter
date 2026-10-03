mod archive;
mod vault;
use serde_json::{Value, json};
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
struct VaultState(Mutex<Option<PathBuf>>);
fn root(state: &State<'_, VaultState>) -> Result<PathBuf, String> {
    state
        .0
        .lock()
        .map_err(|_| "Workspace is busy.".to_string())?
        .clone()
        .ok_or("Choose a workspace folder first.".into())
}
#[tauri::command]
fn workspace_folder(state: State<'_, VaultState>) -> Result<Option<String>, String> {
    Ok(state
        .0
        .lock()
        .map_err(|_| "Workspace is busy.")?
        .as_ref()
        .map(|path| path.to_string_lossy().to_string()))
}
#[tauri::command]
async fn choose_workspace_folder(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
) -> Result<Option<String>, String> {
    let Some(folder) = app
        .dialog()
        .file()
        .set_title("Choose your Noter workspace folder")
        .blocking_pick_folder()
    else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|_| "Choose a local folder.")?
        .canonicalize()
        .map_err(|_| "Could not open that folder.")?;
    if !path.is_dir() {
        return Err("Choose a folder.".into());
    }
    // Confirm this folder can be read and is safe before changing the selection.
    vault::load(&path)?;
    let config = app
        .path()
        .app_config_dir()
        .map_err(|_| "App settings are unavailable.")?
        .join("vault.json");
    vault::atomic_write(&config, &serde_json::to_vec(&json!({"path":path})).unwrap())?;
    *state.0.lock().map_err(|_| "Workspace is busy.")? = Some(path.clone());
    Ok(Some(path.to_string_lossy().to_string()))
}
#[tauri::command]
async fn load_workspace(state: State<'_, VaultState>) -> Result<vault::LoadedWorkspace, String> {
    vault::load(&root(&state)?)
}
#[tauri::command]
async fn workspace_revision(state: State<'_, VaultState>) -> Result<String, String> {
    vault::revision(&root(&state)?)
}
#[tauri::command]
async fn save_workspace(
    state: State<'_, VaultState>,
    workspace: Value,
    expected: String,
) -> Result<String, String> {
    vault::save(&root(&state)?, workspace, &expected)
}
#[tauri::command]
async fn load_finance(state: State<'_, VaultState>) -> Result<Value, String> {
    let folder = root(&state)?;
    let revision = vault::finance_revision(&folder)?;
    let finance = vault::read_finance(&folder)?;
    if vault::finance_revision(&folder)? != revision {
        return Err("Finance changed while loading. Wait for synchronization and reload.".into());
    }
    Ok(json!({"finance":finance, "revision":revision}))
}
#[tauri::command]
async fn finance_revision(state: State<'_, VaultState>) -> Result<String, String> {
    vault::finance_revision(&root(&state)?)
}
#[tauri::command]
async fn save_finance(
    state: State<'_, VaultState>,
    data: Value,
    template: Vec<u8>,
    expected: String,
) -> Result<String, String> {
    vault::save_finance(&root(&state)?, data, &template, &expected)
}
#[tauri::command]
async fn open_document(app: tauri::AppHandle, extension: String) -> Result<Option<Value>, String> {
    if !["xlsx", "json"].contains(&extension.as_str()) {
        return Err("Unsupported file type.".into());
    }
    let Some(file) = app
        .dialog()
        .file()
        .add_filter("Noter file", &[&extension])
        .blocking_pick_file()
    else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|_| "Could not open that file.")?;
    if fs::metadata(&path)
        .map_err(|_| "Could not read that file.")?
        .len()
        > if extension == "json" {
            100_000_000
        } else {
            10_000_000
        }
    {
        return Err(format!(
            "Choose a file smaller than {} MB.",
            if extension == "json" { 100 } else { 10 }
        ));
    }
    let bytes = fs::read(&path).map_err(|_| "Could not read that file.")?;
    Ok(Some(
        json!({"name":path.file_name().unwrap_or_default().to_string_lossy(),"bytes":bytes}),
    ))
}
#[tauri::command]
async fn save_document(
    app: tauri::AppHandle,
    name: String,
    bytes: Vec<u8>,
) -> Result<bool, String> {
    if bytes.len() > 100_000_000 {
        return Err("This export is too large.".into());
    }
    let extension = if name.ends_with(".xlsx") {
        "xlsx"
    } else if name.ends_with(".json") {
        "json"
    } else {
        return Err("Unsupported file type.".into());
    };
    let Some(file) = app
        .dialog()
        .file()
        .set_file_name(&name)
        .add_filter("Noter file", &[extension])
        .blocking_save_file()
    else {
        return Ok(false);
    };
    vault::atomic_write(
        &file
            .into_path()
            .map_err(|_| "Could not save to that location.")?,
        &bytes,
    )?;
    Ok(true)
}
#[tauri::command]
async fn unpack_workbook(
    bytes: Vec<u8>,
) -> Result<std::collections::BTreeMap<String, Vec<u8>>, String> {
    tauri::async_runtime::spawn_blocking(move || archive::unpack(&bytes))
        .await
        .map_err(|_| "Workbook reader failed.")?
}
#[tauri::command]
async fn pack_workbook(
    files: std::collections::BTreeMap<String, Vec<u8>>,
) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || archive::pack(files))
        .await
        .map_err(|_| "Workbook exporter failed.")?
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(VaultState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            unpack_workbook,
            pack_workbook,
            workspace_folder,
            choose_workspace_folder,
            load_workspace,
            save_workspace,
            workspace_revision,
            load_finance,
            save_finance,
            finance_revision,
            open_document,
            save_document
        ])
        .setup(|app| {
            let config = app.path().app_config_dir()?.join("vault.json");
            if let Ok(bytes) = fs::read(config) {
                if let Ok(data) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(path) = data["path"].as_str() {
                        *app.state::<VaultState>().0.lock().unwrap() = Some(PathBuf::from(path));
                    }
                }
            }
            use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
            let new_note = MenuItemBuilder::with_id("new-note", "New Note")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let save = MenuItemBuilder::with_id("save", "Save")
                .accelerator("CmdOrCtrl+S")
                .build(app)?;
            let folder =
                MenuItemBuilder::with_id("folder", "Choose Workspace Folder…").build(app)?;
            let reload = MenuItemBuilder::with_id("reload", "Reload Synced Files").build(app)?;
            let settings = MenuItemBuilder::with_id("settings", "Settings…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit Noter")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;
            let app_menu = SubmenuBuilder::new(app, "Noter")
                .item(&PredefinedMenuItem::about(app, Some("About Noter"), None)?)
                .item(&settings)
                .separator();
            #[cfg(target_os = "macos")]
            let app_menu = app_menu
                .item(&PredefinedMenuItem::hide(app, None)?)
                .item(&PredefinedMenuItem::hide_others(app, None)?)
                .item(&PredefinedMenuItem::show_all(app, None)?)
                .separator();
            let app_menu = app_menu.item(&quit).build()?;
            let file_menu = SubmenuBuilder::new(app, "File")
                .items(&[&new_note, &save])
                .separator()
                .items(&[&folder, &reload])
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;
            app.set_menu(
                MenuBuilder::new(app)
                    .items(&[&app_menu, &file_menu, &edit_menu])
                    .build()?,
            )?;
            app.on_menu_event(|app, event| {
                if event.id().as_ref() == "quit" {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.close();
                    }
                } else {
                    let _ = app.emit("desktop-command", event.id().as_ref());
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Could not start Noter");
}
