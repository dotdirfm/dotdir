use faraday_core::error::FsError;
use faraday_core::ops::{self, EntryInfo, FdTable, StatResult};
use faraday_core::watch::{EventCallback, FsWatcher};
use log::debug;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::RwLock;
use tauri::{Emitter, Manager, State};

#[cfg(unix)]
mod elevate;
#[cfg(not(unix))]
#[path = "elevate_stub.rs"]
mod elevate;

mod pty;
pub mod rpc;
pub mod serve;

// ── Serializable types for Tauri IPC ─────────────────────────────────

#[derive(Serialize, Clone)]
pub struct FsEntry {
    pub name: String,
    pub kind: String,
    pub size: f64,
    pub mtime_ms: f64,
    pub mode: u32,
    pub nlink: u32,
    pub hidden: bool,
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
    base.join("Faraday").join("startup.log")
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

// ── Managed state ────────────────────────────────────────────────────

pub struct AppState {
    pub fdt: FdTable,
    pub watcher: FsWatcher,
    pub proxy: std::sync::Mutex<Option<Arc<elevate::FsProxy>>>,
    pub emit_handle: std::sync::Mutex<Option<tauri::AppHandle>>,
    pub ptys: std::sync::Mutex<std::collections::HashMap<u32, pty::PtyHandle>>,
    pub next_pty_id: std::sync::atomic::AtomicU32,
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
fn fsa_entries(dir_path: String, state: State<'_, AppState>) -> CmdResult<Vec<FsEntry>> {
    debug!("[cmd] fsa_entries {:?}", dir_path);
    match ops::entries(&dir_path) {
        Ok(v) => {
            debug!("[cmd] fsa_entries {:?} → {} entries", dir_path, v.len());
            Ok(v.into_iter().map(FsEntry::from).collect())
        }
        Err(e) if is_eacces(&e) => {
            debug!("[cmd] fsa_entries {:?} EACCES, trying proxy", dir_path);
            let proxy = state.get_or_launch_proxy()?;
            proxy
                .entries(&dir_path)
                .map(|v| v.into_iter().map(FsEntry::from).collect())
                .map_err(Into::into)
        }
        Err(e) => {
            debug!("[cmd] fsa_entries {:?} error: {}", dir_path, e);
            Err(e.into())
        }
    }
}

#[tauri::command]
fn fsa_stat(file_path: String, state: State<'_, AppState>) -> CmdResult<FsStat> {
    match ops::stat(&file_path) {
        Ok(s) => Ok(FsStat::from(s)),
        Err(e) if is_eacces(&e) => {
            let proxy = state.get_or_launch_proxy()?;
            proxy.stat(&file_path).map(FsStat::from).map_err(Into::into)
        }
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
fn fsa_exists(file_path: String) -> bool {
    ops::exists(&file_path)
}

#[tauri::command]
fn fsa_write_text(file_path: String, data: String) -> CmdResult<()> {
  ops::write_text(&file_path, &data).map_err(Into::into)
}

#[tauri::command]
fn fsa_create_dir(dir_path: String) -> CmdResult<()> {
    fs::create_dir_all(&dir_path).map_err(|e| CmdError(FsError::from_io(e)))?;
    Ok(())
}

#[tauri::command]
fn fsa_open(file_path: String, state: State<'_, AppState>) -> CmdResult<i32> {
    match ops::open(&file_path, &state.fdt) {
        Ok(fd) => Ok(fd),
        Err(e) if is_eacces(&e) => {
            let proxy = state.get_or_launch_proxy()?;
            proxy.open(&file_path).map_err(Into::into)
        }
        Err(e) => Err(e.into()),
    }
}

#[tauri::command]
fn fsa_read(fd: i32, offset: u64, length: usize, state: State<'_, AppState>) -> CmdResult<Vec<u8>> {
    if fd < 0 {
        // Negative fd = proxy fd
        let proxy = state.get_or_launch_proxy()?;
        proxy.pread(fd, offset, length).map_err(Into::into)
    } else {
        ops::pread(fd, offset, length, &state.fdt).map_err(Into::into)
    }
}

#[tauri::command]
fn fsa_close(fd: i32, state: State<'_, AppState>) {
    if fd < 0 {
        if let Ok(proxy) = state.get_or_launch_proxy() {
            proxy.close(fd);
        }
    } else {
        ops::close(fd, &state.fdt);
    }
}

#[tauri::command]
fn fsa_watch(watch_id: String, dir_path: String, state: State<'_, AppState>) -> bool {
    debug!("[cmd] fsa_watch id={} path={:?}", watch_id, dir_path);
    state.watcher.add(&watch_id, &dir_path)
}

#[tauri::command]
fn fsa_unwatch(watch_id: String, state: State<'_, AppState>) {
    debug!("[cmd] fsa_unwatch id={}", watch_id);
    state.watcher.remove(&watch_id);
    if let Some(ref proxy) = *state.proxy.lock().unwrap() {
        proxy.unwatch(&watch_id);
    }
}

// ── PTY commands ────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct PtyDataEvent {
    pty_id: u32,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExitEvent {
    pty_id: u32,
}

#[derive(Serialize, Clone)]
struct PtySpawnResult {
    pty_id: u32,
    cwd: String,
    shell: String,
    profile_id: String,
    profile_label: String,
}

#[tauri::command]
fn pty_spawn(
    cwd: String,
    profile_id: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> CmdResult<PtySpawnResult> {
    let id = state.next_pty_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    write_debug_log(&format!(
        "pty_spawn requested id={} cwd={} profile={}",
        id,
        cwd,
        profile_id.as_deref().unwrap_or("<default>")
    ));
    let handle = match pty::spawn(
        &cwd,
        profile_id.as_deref(),
        cols.unwrap_or(80),
        rows.unwrap_or(24),
    ) {
        Ok(handle) => handle,
        Err(e) => {
            write_debug_log(&format!("pty_spawn failed id={} cwd={} error={}", id, cwd, e));
            return Err(CmdError(FsError::Io(e)));
        }
    };
    let reader = handle.reader.clone();
    let result = PtySpawnResult {
        pty_id: id,
        cwd: handle.cwd.clone(),
        shell: handle.shell.clone(),
        profile_id: handle.profile_id.clone(),
        profile_label: handle.profile_label.clone(),
    };
    state.ptys.lock().unwrap().insert(id, handle);
    write_debug_log(&format!("pty_spawn started id={}", id));

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut leftover = Vec::new(); // incomplete UTF-8 bytes from previous read
        loop {
            let offset = leftover.len();
            buf[..offset].copy_from_slice(&leftover);
            leftover.clear();
            match pty::read_blocking(&reader, &mut buf[offset..]) {
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
                    let total = offset + n;
                    let valid_up_to = match std::str::from_utf8(&buf[..total]) {
                        Ok(_) => total,
                        Err(e) => e.valid_up_to(),
                    };
                    if valid_up_to < total {
                        leftover.extend_from_slice(&buf[valid_up_to..total]);
                    }
                    if valid_up_to == 0 {
                        continue;
                    }
                    let data = unsafe { std::str::from_utf8_unchecked(&buf[..valid_up_to]) }.to_owned();
                    let _ = app_handle.emit("pty:data", PtyDataEvent { pty_id: id, data });
                }
            }
        }
    });
    Ok(result)
}

#[tauri::command]
fn get_terminal_profiles() -> Vec<pty::TerminalProfile> {
    pty::list_profiles()
}

#[tauri::command]
fn pty_write(pty_id: u32, data: String, state: State<'_, AppState>) -> CmdResult<()> {
    let ptys = state.ptys.lock().unwrap();
    let handle = ptys.get(&pty_id).ok_or(CmdError(FsError::BadFd))?;
    pty::write_all(&handle.writer, data.as_bytes()).map_err(|e| CmdError(FsError::Io(e)))?;
    Ok(())
}

#[tauri::command]
fn pty_resize(pty_id: u32, cols: u32, rows: u32, state: State<'_, AppState>) -> CmdResult<()> {
    let ptys = state.ptys.lock().unwrap();
    let handle = ptys.get(&pty_id).ok_or(CmdError(FsError::BadFd))?;
    pty::resize(handle.master.as_ref(), cols.max(2) as u16, rows.max(1) as u16)
        .map_err(|e| CmdError(FsError::Io(e)))?;
    Ok(())
}

#[tauri::command]
fn pty_close(pty_id: u32, state: State<'_, AppState>) {
    if let Some(mut handle) = state.ptys.lock().unwrap().remove(&pty_id) {
        pty::close(&mut handle);
    }
}

#[tauri::command]
fn get_home_path() -> String {
    let path = dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    // On Windows, fallback to USERPROFILE if home_dir is empty (e.g. in some sandboxed contexts)
    if path.is_empty() {
        #[cfg(windows)]
        {
            if let Ok(p) = std::env::var("USERPROFILE") {
                return p;
            }
        }
    }
    path
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

// ── Move to Trash & Permanent Delete ─────────────────────────────────

#[tauri::command]
fn move_to_trash(path: String) -> CmdResult<()> {
    let p = Path::new(&path).canonicalize().map_err(|e| CmdError(FsError::from_io(e)))?;
    trash::delete(&p).map_err(|e| {
        CmdError(FsError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))
    })?;
    Ok(())
}

/// Remove a single file or empty directory. For recursive delete the frontend
/// must delete in order (files first, then dirs from deepest to shallowest).
#[tauri::command]
fn fsa_delete_path(path: String) -> CmdResult<()> {
    let p = Path::new(&path);
    let meta = fs::metadata(p).map_err(|e| CmdError(FsError::from_io(e)))?;
    if meta.is_dir() {
        fs::remove_dir(p).map_err(|e| CmdError(FsError::from_io(e)))?;
    } else {
        fs::remove_file(p).map_err(|e| CmdError(FsError::from_io(e)))?;
    }
    Ok(())
}

// ── App setup ────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    write_debug_log("faraday_tauri_lib::run entered");
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
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
                fdt: FdTable::new(),
                watcher,
                proxy: std::sync::Mutex::new(None),
                emit_handle: std::sync::Mutex::new(Some(app.handle().clone())),
                ptys: std::sync::Mutex::new(std::collections::HashMap::new()),
                next_pty_id: std::sync::atomic::AtomicU32::new(0),
            };
            app.manage(state);
            write_debug_log("tauri setup completed");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fsa_entries,
            fsa_stat,
            fsa_exists,
            fsa_write_text,
            fsa_create_dir,
            fsa_open,
            fsa_read,
            fsa_close,
            fsa_watch,
            fsa_unwatch,
            get_home_path,
            get_terminal_profiles,
            get_theme,
            debug_log,
            move_to_trash,
            fsa_delete_path,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
