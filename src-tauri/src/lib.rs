use dotdir_core::copy::{ConflictResolution, CopyEvent, CopyOptions};
use dotdir_core::delete::DeleteEvent;
use dotdir_core::move_op::MoveOptions;
use dotdir_core::error::FsError;
use dotdir_core::ops::{EntryInfo, StatResult};
use dotdir_core::watch::{EventCallback, FsWatcher};
use extensions_install::{ExtensionInstallEvent, ExtensionInstallRequest};
use log::debug;
use runtime_ops::{
    RuntimeState, cancel_copy_job, cancel_delete_job, cancel_extension_install_job,
    cancel_move_job, fsp_list_entries as backend_fsp_list_entries,
    fsp_load as backend_fsp_load, fsp_read_file_range as backend_fsp_read_file_range,
    fs_close as backend_fs_close, fs_create_dir as backend_fs_create_dir,
    fs_entries as backend_fs_entries, fs_exists as backend_fs_exists,
    fs_open as backend_fs_open, fs_read as backend_fs_read,
    fs_read_file as backend_fs_read_file, fs_stat as backend_fs_stat,
    fs_unwatch as backend_fs_unwatch, fs_watch as backend_fs_watch,
    fs_write_binary as backend_fs_write_binary, fs_write_text as backend_fs_write_text,
    get_app_dirs as backend_get_app_dirs, get_env as backend_get_env,
    get_home_path as backend_get_home_path, get_mounted_roots as backend_get_mounted_roots,
    move_to_trash as backend_move_to_trash, pty_close as backend_pty_close,
    pty_resize as backend_pty_resize, pty_spawn as backend_pty_spawn,
    pty_write as backend_pty_write, rename_item as backend_rename_item,
    resolve_copy_conflict, resolve_move_conflict, start_copy_job, start_delete_job,
    start_extension_install_job, start_move_job, PtySpawnInfo,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Size, State, WebviewUrl, WebviewWindowBuilder};
use tauri::http::header as http_header;
use tauri::http::StatusCode as HttpStatusCode;

#[cfg(unix)]
mod elevate;
#[cfg(not(unix))]
#[path = "elevate_stub.rs"]
mod elevate;

mod fsprovider;
mod extensions_install;
mod pty;
pub mod rpc;
mod runtime_ops;
pub mod serve;

// ── Serializable types for Tauri IPC ─────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub size: f64,
    #[serde(default, alias = "mtime_ms")]
    pub mtime_ms: f64,
    #[serde(default)]
    pub mode: u32,
    #[serde(default)]
    pub nlink: u32,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
}

impl From<EntryInfo> for FsEntry {
    fn from(e: EntryInfo) -> Self {
        Self {
            name: e.name,
            kind: e.kind.as_str().to_string(),
            size: e.size,
            mtime_ms: e.mtime_ms,
            mode: e.mode,
            nlink: e.nlink,
            hidden: e.hidden,
            link_target: e.link_target,
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FsStat {
    pub size: f64,
    pub mtime_ms: f64,
}

impl From<StatResult> for FsStat {
    fn from(s: StatResult) -> Self {
        Self {
            size: s.size,
            mtime_ms: s.mtime_ms,
        }
    }
}

#[derive(Serialize, Clone)]
pub struct FsChangeEvent {
    pub watch_id: String,
    pub kind: String,
    pub name: Option<String>,
}

// ── Error handling ───────────────────────────────────────────────────

#[derive(Serialize)]
pub struct FsErrorResponse {
    pub errno: String,
    pub message: String,
}

impl From<FsError> for FsErrorResponse {
    fn from(e: FsError) -> Self {
        Self {
            errno: e.errno_str().to_string(),
            message: e.to_string(),
        }
    }
}

struct CmdError(FsError);

impl From<FsError> for CmdError {
    fn from(e: FsError) -> Self {
        Self(e)
    }
}

impl From<CmdError> for tauri::ipc::InvokeError {
    fn from(e: CmdError) -> Self {
        let resp = FsErrorResponse::from(e.0);
        tauri::ipc::InvokeError::from(serde_json::to_value(resp).unwrap())
    }
}

type CmdResult<T> = Result<T, CmdError>;

fn debug_log_path() -> PathBuf {
    let base = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(std::env::temp_dir);
    base.join(".dir").join("startup.log")
}

pub fn write_debug_log(message: &str) {
    let path = debug_log_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{message}");
    }
}

fn is_eacces(e: &FsError) -> bool {
    matches!(e, FsError::PermissionDenied)
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct UiLayoutIndex {
    #[serde(default)]
    window_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedWindowState {
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    is_maximized: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CreateWindowOptions {
    id: String,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    is_maximized: Option<bool>,
}

fn app_data_dir() -> PathBuf {
    PathBuf::from(backend_get_app_dirs().data_dir)
}

fn ui_layout_index_path() -> PathBuf {
    app_data_dir().join("ui-layout.json")
}

fn window_state_path(window_id: &str) -> PathBuf {
    app_data_dir().join(format!("window-state-{window_id}.json"))
}

fn read_ui_layout_index() -> UiLayoutIndex {
    fs::read(ui_layout_index_path())
        .ok()
        .and_then(|bytes| serde_json::from_slice::<UiLayoutIndex>(&bytes).ok())
        .unwrap_or_default()
}

fn read_window_state(window_id: &str) -> PersistedWindowState {
    fs::read(window_state_path(window_id))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<PersistedWindowState>(&bytes).ok())
        .unwrap_or_default()
}

fn cleanup_unused_window_files(index: &UiLayoutIndex) {
    let keep: std::collections::HashSet<String> = index.window_ids.iter().cloned().collect();
    let data_dir = app_data_dir();
    if let Ok(entries) = fs::read_dir(data_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };

            let matched = file_name
                .strip_prefix("window-layout-")
                .and_then(|rest| rest.strip_suffix(".json"))
                .or_else(|| {
                    file_name
                        .strip_prefix("window-state-")
                        .and_then(|rest| rest.strip_suffix(".json"))
                });

            let Some(window_id) = matched else {
                continue;
            };

            if !keep.contains(window_id) {
                let _ = fs::remove_file(path);
            }
        }
    }
}

fn create_app_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    options: &CreateWindowOptions,
) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::new(app, &options.id, WebviewUrl::default())
        .title(".dir")
        .inner_size(1200.0, 700.0)
        .visible(false);

    let window = builder.build()?;

    if let (Some(width), Some(height)) = (options.width, options.height) {
        window.set_size(Size::Physical(PhysicalSize::new(width, height)))?;
    }

    if let (Some(x), Some(y)) = (options.x, options.y) {
        window.set_position(Position::Physical(PhysicalPosition::new(x, y)))?;
    }

    if options.is_maximized.unwrap_or(false) {
        window.maximize()?;
    } else {
        let _ = window.unmaximize();
    }

    Ok(())
}

// ── Managed state ────────────────────────────────────────────────────

pub struct AppState {
    pub(crate) runtime: RuntimeState,
    pub proxy: std::sync::Mutex<Option<Arc<elevate::FsProxy>>>,
    pub emit_handle: std::sync::Mutex<Option<tauri::AppHandle>>,
}

impl AppState {
    fn get_or_launch_proxy(&self) -> Result<Arc<elevate::FsProxy>, FsError> {
        let mut guard = self.proxy.lock().unwrap();
        if let Some(ref p) = *guard {
            if p.is_alive() {
                return Ok(p.clone());
            }
        }

        let emit_handle = self.emit_handle.lock().unwrap().clone();
        let watch_cb: elevate::WatchCallback = Arc::new(move |watch_id, kind, name| {
            if let Some(ref handle) = emit_handle {
                let event = FsChangeEvent {
                    watch_id: watch_id.to_string(),
                    kind: kind.to_string(),
                    name: name.map(|s| s.to_string()),
                };
                let _ = handle.emit("fsa:change", event);
            }
        });

        let proxy = elevate::launch_elevated(watch_cb)?;
        *guard = Some(proxy.clone());
        Ok(proxy)
    }
}

// ── Commands ─────────────────────────────────────────────────────────

#[tauri::command]
fn fs_entries(dir_path: String, state: State<'_, AppState>) -> CmdResult<Vec<FsEntry>> {
    debug!("[cmd] fs_entries {:?}", dir_path);
    match backend_fs_entries(&dir_path) {
        Ok(v) => {
            debug!("[cmd] fs_entries {:?} → {} entries", dir_path, v.len());
            Ok(v.into_iter().map(FsEntry::from).collect())
        }
        Err(e) if is_eacces(&e) => {
            debug!("[cmd] fs_entries {:?} EACCES, trying proxy", dir_path);
            let proxy = state.get_or_launch_proxy()?;
            proxy
                .entries(&dir_path)
                .map(|v| v.into_iter().map(FsEntry::from).collect())
                .map_err(Into::into)
        }
        Err(e) => {
            debug!("[cmd] fs_entries {:?} error: {}", dir_path, e);
            Err(e.into())
        }
    }
}

#[tauri::command]
fn fs_stat(file_path: String, state: State<'_, AppState>) -> CmdResult<FsStat> {
    match backend_fs_stat(&file_path) {
        Ok(s) => Ok(FsStat::from(s)),
        Err(e) if is_eacces(&e) => {
            let proxy = state.get_or_launch_proxy()?;
            proxy.stat(&file_path).map(FsStat::from).map_err(Into::into)
        }
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
fn fs_exists(file_path: String) -> bool {
    backend_fs_exists(&file_path)
}

#[tauri::command]
fn fs_remove_file(file_path: String) -> CmdResult<()> {
    match fs::remove_file(&file_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(FsError::from_io(err).into()),
    }
}

#[tauri::command]
fn fs_read_file(file_path: String, state: State<'_, AppState>) -> CmdResult<Vec<u8>> {
    match backend_fs_read_file(&file_path) {
        Ok(bytes) => Ok(bytes),
        Err(e) if is_eacces(&e) => {
            let proxy = state.get_or_launch_proxy()?;
            let stat = proxy.stat(&file_path)?;
            let size = stat.size.max(0.0) as usize;
            let fd = proxy.open(&file_path)?;
            let result = proxy.pread(fd, 0, size).map_err(CmdError::from);
            proxy.close(fd);
            result
        }
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
fn fs_write_text(file_path: String, data: String) -> CmdResult<()> {
  backend_fs_write_text(&file_path, &data).map_err(Into::into)
}

#[tauri::command]
fn fs_write_binary(file_path: String, data: Vec<u8>) -> CmdResult<()> {
  backend_fs_write_binary(&file_path, &data).map_err(Into::into)
}

#[tauri::command]
fn fs_create_dir(dir_path: String) -> CmdResult<()> {
    backend_fs_create_dir(&dir_path).map_err(Into::into)
}

#[tauri::command]
fn fs_open(file_path: String, state: State<'_, AppState>) -> CmdResult<i32> {
    match backend_fs_open(&state.runtime, &file_path) {
        Ok(fd) => Ok(fd),
        Err(e) if is_eacces(&e) => {
            let proxy = state.get_or_launch_proxy()?;
            proxy.open(&file_path).map_err(Into::into)
        }
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
fn fs_read(fd: i32, offset: u64, length: usize, state: State<'_, AppState>) -> CmdResult<Vec<u8>> {
    if fd < 0 {
        // Negative fd = proxy fd
        let proxy = state.get_or_launch_proxy()?;
        proxy.pread(fd, offset, length).map_err(Into::into)
    } else {
        backend_fs_read(&state.runtime, fd, offset, length).map_err(Into::into)
    }
}

#[tauri::command]
fn fs_close(fd: i32, state: State<'_, AppState>) {
    if fd < 0 {
        if let Ok(proxy) = state.get_or_launch_proxy() {
            proxy.close(fd);
        }
    } else {
        backend_fs_close(&state.runtime, fd);
    }
}

#[tauri::command]
fn fs_watch(watch_id: String, dir_path: String, state: State<'_, AppState>) -> bool {
    debug!("[cmd] fs_watch id={} path={:?}", watch_id, dir_path);
    backend_fs_watch(&state.runtime, &watch_id, &dir_path)
}

#[tauri::command]
fn fs_unwatch(watch_id: String, state: State<'_, AppState>) {
    debug!("[cmd] fs_unwatch id={}", watch_id);
    backend_fs_unwatch(&state.runtime, &watch_id);
    if let Some(ref proxy) = *state.proxy.lock().unwrap() {
        proxy.unwatch(&watch_id);
    }
}

// ── PTY commands ────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyDataEvent {
    pty_id: u32,
    data: Vec<u8>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyExitEvent {
    pty_id: u32,
}

#[tauri::command]
fn pty_spawn(
    cwd: String,
    shell_path: String,
    spawn_args: Option<Vec<String>>,
    cols: Option<u16>,
    rows: Option<u16>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
 ) -> CmdResult<PtySpawnInfo> {
    let args = spawn_args.as_deref().unwrap_or(&[]);
    write_debug_log(&format!(
        "pty_spawn requested cwd={} shell={} argc={}",
        cwd,
        shell_path,
        args.len()
    ));
    let (result, reader) = match backend_pty_spawn(
        &state.runtime,
        &cwd,
        &shell_path,
        args,
        cols.unwrap_or(80),
        rows.unwrap_or(24),
    ) {
        Ok(pair) => pair,
        Err(e) => {
            write_debug_log(&format!("pty_spawn failed error={}", e));
            return Err(CmdError(e));
        }
    };
    let id = result.pty_id;
    write_debug_log(&format!("pty_spawn started id={}", id));

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match pty::read_blocking(&reader, &mut buf) {
                Ok(0) => {
                    write_debug_log(&format!("pty read eof id={}", id));
                    let _ = app_handle.emit("pty:exit", PtyExitEvent { pty_id: id });
                    break;
                }
                Err(err) => {
                    write_debug_log(&format!("pty read error id={} error={}", id, err));
                    let _ = app_handle.emit("pty:exit", PtyExitEvent { pty_id: id });
                    break;
                }
                Ok(n) => {
                    let data = buf[..n].to_vec();
                    let _ = app_handle.emit("pty:data", PtyDataEvent { pty_id: id, data });
                }
            }
        }
    });
    Ok(result)
}

#[tauri::command]
fn get_env() -> HashMap<String, String> {
    backend_get_env()
}

#[tauri::command]
fn pty_set_shell_integrations(integrations: HashMap<String, pty::ShellIntegrationInit>) {
    pty::set_shell_integrations(integrations);
}

#[tauri::command]
fn pty_write(
    pty_id: u32,
    data: Option<String>,
    data_bytes: Option<Vec<u8>>,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let payload = match (data_bytes, data) {
        (Some(bytes), _) => bytes,
        (None, Some(text)) => text.into_bytes(),
        (None, None) => return Err(CmdError(FsError::InvalidInput)),
    };
    backend_pty_write(&state.runtime, pty_id, &payload).map_err(Into::into)
}

#[tauri::command]
fn pty_resize(pty_id: u32, cols: u32, rows: u32, state: State<'_, AppState>) -> CmdResult<()> {
    backend_pty_resize(&state.runtime, pty_id, cols.max(2) as u16, rows.max(1) as u16)
        .map_err(Into::into)
}

#[tauri::command]
fn pty_close(pty_id: u32, state: State<'_, AppState>) {
    backend_pty_close(&state.runtime, pty_id);
}

#[tauri::command]
fn get_home_path() -> String {
    backend_get_home_path()
}

#[tauri::command]
fn get_mounted_roots() -> Vec<String> {
    backend_get_mounted_roots()
}

#[tauri::command]
fn get_app_dirs() -> runtime_ops::AppDirs {
    backend_get_app_dirs()
}

#[tauri::command]
fn get_theme(window: tauri::Window) -> String {
    match window.theme() {
        Ok(tauri::Theme::Dark) => "dark".to_string(),
        Ok(tauri::Theme::Light) => "light".to_string(),
        _ => "dark".to_string(),
    }
}

#[tauri::command]
fn debug_log(message: String) {
    write_debug_log(&message);
}

// ── Copy commands ────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CopyProgressEvent {
    copy_id: u32,
    event: CopyEvent,
}

#[tauri::command]
fn copy_start(
    sources: Vec<String>,
    dest_dir: String,
    options: CopyOptions,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> CmdResult<u32> {
    let emit_handle = app_handle.clone();
    let cleanup_handle = app_handle.clone();
    Ok(start_copy_job(
        &state.runtime,
        sources,
        dest_dir,
        options,
        move |event, copy_id| {
            let _ = emit_handle.emit(
                "copy:progress",
                CopyProgressEvent {
                    copy_id,
                    event,
                },
            );
        },
        move |copy_id| {
            if let Some(app) = tauri::Manager::try_state::<AppState>(&cleanup_handle) {
                app.runtime.copy_jobs.lock().unwrap().remove(&copy_id);
            }
        },
    ))
}

#[tauri::command]
fn copy_cancel(copy_id: u32, state: State<'_, AppState>) {
    cancel_copy_job(&state.runtime, copy_id);
}

#[tauri::command]
fn copy_resolve_conflict(copy_id: u32, resolution: ConflictResolution, state: State<'_, AppState>) {
    resolve_copy_conflict(&state.runtime, copy_id, resolution);
}

// ── Move commands ────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MoveProgressEvent {
    move_id: u32,
    event: CopyEvent,
}

#[tauri::command]
fn move_start(
    sources: Vec<String>,
    dest_dir: String,
    options: MoveOptions,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> CmdResult<u32> {
    let emit_handle = app_handle.clone();
    let cleanup_handle = app_handle.clone();
    Ok(start_move_job(
        &state.runtime,
        sources,
        dest_dir,
        options,
        move |event, move_id| {
            let _ = emit_handle.emit(
                "move:progress",
                MoveProgressEvent {
                    move_id,
                    event,
                },
            );
        },
        move |move_id| {
            if let Some(app) = tauri::Manager::try_state::<AppState>(&cleanup_handle) {
                app.runtime.move_jobs.lock().unwrap().remove(&move_id);
            }
        },
    ))
}

#[tauri::command]
fn move_cancel(move_id: u32, state: State<'_, AppState>) {
    cancel_move_job(&state.runtime, move_id);
}

#[tauri::command]
fn move_resolve_conflict(move_id: u32, resolution: ConflictResolution, state: State<'_, AppState>) {
    resolve_move_conflict(&state.runtime, move_id, resolution);
}

// ── Delete commands ──────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DeleteProgressEvent {
    delete_id: u32,
    event: DeleteEvent,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExtensionInstallProgressEvent {
    install_id: u32,
    event: ExtensionInstallEvent,
}

#[tauri::command]
fn delete_start(
    paths: Vec<String>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> CmdResult<u32> {
    let emit_handle = app_handle.clone();
    let cleanup_handle = app_handle.clone();
    Ok(start_delete_job(
        &state.runtime,
        paths,
        move |event, delete_id| {
            let _ = emit_handle.emit(
                "delete:progress",
                DeleteProgressEvent { delete_id, event },
            );
        },
        move |delete_id| {
            if let Some(app) = tauri::Manager::try_state::<AppState>(&cleanup_handle) {
                app.runtime.delete_jobs.lock().unwrap().remove(&delete_id);
            }
        },
    ))
}

#[tauri::command]
fn delete_cancel(delete_id: u32, state: State<'_, AppState>) {
    cancel_delete_job(&state.runtime, delete_id);
}

#[tauri::command]
fn extensions_install_start(
    request: ExtensionInstallRequest,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> CmdResult<u32> {
    let emit_handle = app_handle.clone();
    let cleanup_handle = app_handle.clone();
    Ok(start_extension_install_job(
        &state.runtime,
        request,
        move |event, install_id| {
            let _ = emit_handle.emit(
                "extensions:install:progress",
                ExtensionInstallProgressEvent { install_id, event },
            );
        },
        move |install_id| {
            if let Some(app) = tauri::Manager::try_state::<AppState>(&cleanup_handle) {
                app.runtime
                    .extension_install_jobs
                    .lock()
                    .unwrap()
                    .remove(&install_id);
            }
        },
    ))
}

#[tauri::command]
fn extensions_install_cancel(install_id: u32, state: State<'_, AppState>) {
    cancel_extension_install_job(&state.runtime, install_id);
}

#[tauri::command]
fn rename_item(source: String, new_name: String) -> CmdResult<()> {
    backend_rename_item(&source, &new_name).map_err(Into::into)
}

#[tauri::command]
fn create_window(options: CreateWindowOptions, app_handle: tauri::AppHandle) -> Result<(), String> {
    create_app_window(&app_handle, &options).map_err(|err| err.to_string())
}

#[tauri::command]
fn show_current_window(window: tauri::Window) -> Result<(), String> {
    window.show().map_err(|err| err.to_string())?;
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
fn app_exit(app_handle: tauri::AppHandle) {
    app_handle.exit(0);
}

// ── Auth token storage ───────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub user_sub: String,
    pub user_name: Option<String>,
    pub user_email: Option<String>,
}

fn auth_tokens_path(app_handle: &tauri::AppHandle) -> Option<PathBuf> {
    app_handle
        .path()
        .app_config_dir()
        .ok()
        .map(|p| p.join("auth.json"))
}

#[tauri::command]
fn auth_store_tokens(tokens: AuthTokens, app_handle: tauri::AppHandle) {
    if let Some(path) = auth_tokens_path(&app_handle) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&tokens) {
            let _ = fs::write(&path, json);
        }
    }
}

#[tauri::command]
fn auth_load_tokens(app_handle: tauri::AppHandle) -> Option<AuthTokens> {
    let path = auth_tokens_path(&app_handle)?;
    let bytes = fs::read(&path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[tauri::command]
fn auth_clear_tokens(app_handle: tauri::AppHandle) {
    if let Some(path) = auth_tokens_path(&app_handle) {
        let _ = fs::remove_file(path);
    }
}

// ── VFS protocol handler ─────────────────────────────────────────────

fn decode_vfs_path(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                if i + 2 >= bytes.len() {
                    return None;
                }
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
                let value = u8::from_str_radix(hex, 16).ok()?;
                out.push(value);
                i += 3;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(unix)]
fn vfs_request_path_to_os(path: &str) -> Option<PathBuf> {
    let decoded = decode_vfs_path(path)?;
    let trimmed = decoded.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from("/").join(trimmed))
}

#[cfg(windows)]
fn vfs_request_path_to_os(path: &str) -> Option<PathBuf> {
    // Accept both `/C/Users/...` (single-letter segments) and `C:/Users/...` (colon after
    // drive), which is what the frontend path helpers and percent-decoded URLs produce.
    let decoded = decode_vfs_path(path)?;
    let trimmed = decoded.trim_start_matches('/');
    let mut parts = trimmed.split('/').filter(|s| !s.is_empty());
    let first = parts.next()?;
    let mut pb = if first.len() == 2
        && first.as_bytes().get(1) == Some(&b':')
        && first.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
    {
        PathBuf::from(format!(
            "{}:\\",
            first.chars().next().unwrap().to_ascii_uppercase()
        ))
    } else if first.len() == 1 && first.chars().all(|c| c.is_ascii_alphabetic()) {
        PathBuf::from(format!("{}:\\", first.to_ascii_uppercase()))
    } else {
        return None;
    };
    for seg in parts {
        pb.push(seg);
    }
    Some(pb)
}

fn vfs_response_for_path(os_path: &Path) -> tauri::http::Response<Vec<u8>> {
    let meta = match fs::metadata(os_path) {
        Ok(m) => m,
        Err(_) => {
            return tauri::http::Response::builder()
                .status(HttpStatusCode::NOT_FOUND)
                .body(Vec::new())
                .unwrap();
        }
    };

    if meta.is_dir() {
        return tauri::http::Response::builder()
            .status(HttpStatusCode::NOT_FOUND)
            .body(Vec::new())
            .unwrap();
    }

    let bytes = match fs::read(os_path) {
        Ok(b) => b,
        Err(_) => {
            return tauri::http::Response::builder()
                .status(HttpStatusCode::NOT_FOUND)
                .body(Vec::new())
                .unwrap();
        }
    };

    let mime_str: String = match os_path.extension().and_then(|e| e.to_str()) {
        Some("cjs" | "mjs") => "application/javascript".to_owned(),
        _ => mime_guess::from_path(os_path).first_or_octet_stream().to_string(),
    };
    tauri::http::Response::builder()
        .status(HttpStatusCode::OK)
        .header(http_header::CONTENT_TYPE, mime_str.as_str())
        .body(bytes)
        .unwrap()
}

// ── Move to Trash & Permanent Delete ─────────────────────────────────

#[tauri::command]
fn move_to_trash(paths: Vec<String>) -> CmdResult<()> {
    backend_move_to_trash(&paths).map_err(Into::into)
}

fn vfs_with_cors(
    mut builder: tauri::http::response::Builder,
    origin: Option<&str>,
) -> tauri::http::response::Builder {
    // NOTE: Security/auth will come later. For now we allow the requesting origin
    // (dev is usually http://localhost:1420) and fall back to "*".
    let allow_origin = origin.unwrap_or("*");
    builder = builder.header(http_header::ACCESS_CONTROL_ALLOW_ORIGIN, allow_origin);
    builder = builder.header(http_header::VARY, "Origin");
    builder = builder.header(http_header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS");
    builder = builder.header(http_header::ACCESS_CONTROL_ALLOW_HEADERS, "*");
    builder
}

fn vfs_virtual_response(path: &str) -> Option<tauri::http::Response<Vec<u8>>> {
    // Virtual mount for extension iframes:
    // `vfs://vfs/_ext/<abs extension dir>/` -> generated index.html (+ inline postMessage bootstrap)
    // `vfs://vfs/_ext/<abs extension dir>/<relative file>` -> served from the real dir
    let p = path.trim_start_matches('/');
    if !p.starts_with("_ext/") {
        return None;
    }

    let rest = &p["_ext/".len()..];
    if rest.is_empty() {
        return None;
    }

    let wants_index = p.ends_with('/')
        || rest.ends_with("/index.html")
        || rest == "index.html";

    let os_path = vfs_request_path_to_os(rest)?;
    let meta_is_dir = fs::metadata(&os_path).map(|m| m.is_dir()).unwrap_or(false);

    if wants_index || meta_is_dir {
        let bootstrap_js = include_str!("vfs_virtual/inline_bootstrap_postmsg.js"); // postMessage RPC bootstrap

        let html = r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
      #root { width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module">__DOTDIR_BOOTSTRAP_INLINE__</script>
  </body>
</html>"#;
        let html = html.replace("__DOTDIR_BOOTSTRAP_INLINE__", bootstrap_js);
        return Some(
            tauri::http::Response::builder()
                .status(HttpStatusCode::OK)
                .header(http_header::CONTENT_TYPE, "text/html; charset=utf-8")
                .body(html.as_bytes().to_vec())
                .unwrap(),
        );
    }

    Some(vfs_response_for_path(&os_path))
}

// ── FsProvider (WASM) commands ───────────────────────────────────────

#[tauri::command]
fn fsp_load(wasm_path: String, state: State<'_, AppState>) -> Result<(), String> {
    backend_fsp_load(&state.runtime, &wasm_path)
}

#[tauri::command]
fn fsp_list_entries(
    wasm_path: String,
    container_path: String,
    inner_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<FsEntry>, String> {
    backend_fsp_list_entries(&state.runtime, &wasm_path, &container_path, &inner_path)
}

#[tauri::command]
fn fsp_read_file_range(
    wasm_path: String,
    container_path: String,
    inner_path: String,
    offset: u64,
    length: usize,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    backend_fsp_read_file_range(
        &state.runtime,
        &wasm_path,
        &container_path,
        &inner_path,
        offset,
        length,
    )
}

// ── App setup ────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    write_debug_log("dotdir_tauri_lib::run entered");
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_deep_link::init())
        .register_uri_scheme_protocol("vfs", |_app, request| {
            // macOS/Linux: typically `vfs://vfs/<abs path>`.
            // Windows: WebView2 maps custom schemes to http(s) hosts like
            // `http://vfs.localhost/<path>` (the scheme is not preserved).
            let origin = request
                .headers()
                .get(http_header::ORIGIN)
                .and_then(|v| v.to_str().ok());

            // Preflight
            if request.method() == tauri::http::Method::OPTIONS {
                return vfs_with_cors(tauri::http::Response::builder().status(HttpStatusCode::NO_CONTENT), origin)
                    .body(Vec::new())
                    .unwrap();
            }

            if let Some(resp) = vfs_virtual_response(request.uri().path()) {
                let mut resp = resp;
                let allow_origin = origin.unwrap_or("*").to_string();
                resp.headers_mut().insert(
                    http_header::ACCESS_CONTROL_ALLOW_ORIGIN,
                    allow_origin.parse().unwrap(),
                );
                resp.headers_mut()
                    .insert(http_header::VARY, "Origin".parse().unwrap());
                resp.headers_mut().insert(
                    http_header::ACCESS_CONTROL_ALLOW_METHODS,
                    "GET, HEAD, OPTIONS".parse().unwrap(),
                );
                resp.headers_mut().insert(
                    http_header::ACCESS_CONTROL_ALLOW_HEADERS,
                    "*".parse().unwrap(),
                );
                return resp;
            }

            let os_path = match vfs_request_path_to_os(request.uri().path()) {
                Some(p) => p,
                None => {
                    return vfs_with_cors(
                        tauri::http::Response::builder().status(HttpStatusCode::BAD_REQUEST),
                        origin,
                    )
                    .body(Vec::new())
                    .unwrap();
                }
            };

            let mut resp = vfs_response_for_path(&os_path);
            // Add CORS headers to the final response
            let allow_origin = origin.unwrap_or("*").to_string();
            resp.headers_mut().insert(
                http_header::ACCESS_CONTROL_ALLOW_ORIGIN,
                allow_origin.parse().unwrap(),
            );
            resp.headers_mut()
                .insert(http_header::VARY, "Origin".parse().unwrap());
            resp.headers_mut().insert(
                http_header::ACCESS_CONTROL_ALLOW_METHODS,
                "GET, HEAD, OPTIONS".parse().unwrap(),
            );
            resp.headers_mut().insert(
                http_header::ACCESS_CONTROL_ALLOW_HEADERS,
                "*".parse().unwrap(),
            );
            resp
        })
        .setup(|app| {
            write_debug_log("tauri setup started");
            let handle = app.handle().clone();
            // IMPORTANT: The notify callback runs on the FSEvents thread (macOS).
            // handle.emit() dispatches to the main thread. If we block the
            // FSEvents thread waiting for the main thread, and the main thread
            // later calls watcher.unwatch() (which syncs with the FSEvents
            // thread), we get a deadlock. Spawning a thread decouples them.
            let cb: EventCallback = Arc::new(move |watch_id, kind, name| {
                let event = FsChangeEvent {
                    watch_id: watch_id.to_string(),
                    kind: kind.as_str().to_string(),
                    name: name.map(|s| s.to_string()),
                };
                let h = handle.clone();
                std::thread::spawn(move || {
                    let _ = h.emit("fsa:change", event);
                });
            });

            let watcher = FsWatcher::new(cb).expect("failed to create file watcher");
            let state = AppState {
                runtime: RuntimeState::new(watcher),
                proxy: std::sync::Mutex::new(None),
                emit_handle: std::sync::Mutex::new(Some(app.handle().clone())),
            };
            app.manage(state);

            let mut index = read_ui_layout_index();
            if index.window_ids.is_empty() {
                index.window_ids.push("window-1".to_string());
            }
            cleanup_unused_window_files(&index);

            for window_id in &index.window_ids {
                let saved = read_window_state(window_id);
                create_app_window(
                    &app.handle(),
                    &CreateWindowOptions {
                        id: window_id.clone(),
                        x: saved.x,
                        y: saved.y,
                        width: saved.width,
                        height: saved.height,
                        is_maximized: saved.is_maximized,
                    },
                )?;
            }

            write_debug_log("tauri setup completed");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs_entries,
            fs_stat,
            fs_exists,
            fs_read_file,
            fs_write_text,
            fs_write_binary,
            fs_create_dir,
            fs_remove_file,
            fs_open,
            fs_read,
            fs_close,
            fs_watch,
            fs_unwatch,
            get_home_path,
            get_mounted_roots,
            get_app_dirs,
            get_env,
            get_theme,
            debug_log,
            move_to_trash,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_close,
            pty_set_shell_integrations,
            copy_start,
            copy_cancel,
            copy_resolve_conflict,
            move_start,
            move_cancel,
            move_resolve_conflict,
            delete_start,
            delete_cancel,
            extensions_install_start,
            extensions_install_cancel,
            rename_item,
            create_window,
            show_current_window,
            fsp_load,
            fsp_list_entries,
            fsp_read_file_range,
            auth_store_tokens,
            auth_load_tokens,
            auth_clear_tokens,
            app_exit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
