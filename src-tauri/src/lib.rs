use faraday_core::error::FsError;
use faraday_core::ops::{self, EntryInfo, FdTable, StatResult};
use faraday_core::watch::{EventCallback, FsWatcher};
use serde::Serialize;
use std::sync::Arc;
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
    match ops::entries(&dir_path) {
        Ok(v) => Ok(v.into_iter().map(FsEntry::from).collect()),
        Err(e) if is_eacces(&e) => {
            let proxy = state.get_or_launch_proxy()?;
            proxy
                .entries(&dir_path)
                .map(|v| v.into_iter().map(FsEntry::from).collect())
                .map_err(Into::into)
        }
        Err(e) => Err(e.into()),
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
    state.watcher.add(&watch_id, &dir_path)
}

#[tauri::command]
fn fsa_unwatch(watch_id: String, state: State<'_, AppState>) {
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

#[tauri::command]
fn pty_spawn(cwd: String, state: State<'_, AppState>, app_handle: tauri::AppHandle) -> CmdResult<u32> {
    let id = state.next_pty_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let handle = pty::spawn(&cwd, 80, 24).map_err(|e| CmdError(FsError::Io(e)))?;
    #[cfg(unix)]
    let master_fd = handle.master_fd;
    // HANDLE is *mut c_void which is not Send.  Cast to usize (which IS Send)
    // before moving into the reader thread; cast back to HANDLE inside the thread.
    // The handle value remains valid because pty_close() is only called after the
    // frontend receives pty:exit, which is emitted by this very thread.
    #[cfg(windows)]
    let read_handle_raw = handle.read_handle as usize;
    state.ptys.lock().unwrap().insert(id, handle);

    #[cfg(unix)]
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match pty::read_blocking(master_fd, &mut buf) {
                Ok(0) | Err(_) => {
                    let _ = app_handle.emit("pty:exit", PtyExitEvent { pty_id: id });
                    break;
                }
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_handle.emit("pty:data", PtyDataEvent { pty_id: id, data });
                }
            }
        }
    });

    #[cfg(windows)]
    std::thread::spawn(move || {
        let read_handle = read_handle_raw as windows_sys::Win32::Foundation::HANDLE;
        let mut buf = [0u8; 4096];
        loop {
            match pty::read_blocking(read_handle, &mut buf) {
                Ok(0) | Err(_) => {
                    let _ = app_handle.emit("pty:exit", PtyExitEvent { pty_id: id });
                    break;
                }
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let _ = app_handle.emit("pty:data", PtyDataEvent { pty_id: id, data });
                }
            }
        }
    });

    Ok(id)
}

#[tauri::command]
fn pty_write(pty_id: u32, data: String, state: State<'_, AppState>) -> CmdResult<()> {
    let ptys = state.ptys.lock().unwrap();
    let handle = ptys.get(&pty_id).ok_or(CmdError(FsError::BadFd))?;
    #[cfg(unix)]
    {
        pty::write_all(handle.master_fd, data.as_bytes()).map_err(|e| CmdError(FsError::Io(e)))?;
    }
    #[cfg(windows)]
    {
        pty::write_all(handle.write_handle, data.as_bytes()).map_err(|e| CmdError(FsError::Io(e)))?;
    }
    #[cfg(not(any(unix, windows)))]
    { let _ = handle; let _ = data; return Err(CmdError(FsError::Io(std::io::Error::new(std::io::ErrorKind::Unsupported, "PTY not supported")))); }
    Ok(())
}

#[tauri::command]
fn pty_resize(pty_id: u32, cols: u32, rows: u32, state: State<'_, AppState>) -> CmdResult<()> {
    let ptys = state.ptys.lock().unwrap();
    let handle = ptys.get(&pty_id).ok_or(CmdError(FsError::BadFd))?;
    #[cfg(unix)]
    {
        pty::resize(handle.master_fd, cols as u16, rows as u16).map_err(|e| CmdError(FsError::Io(e)))?;
    }
    #[cfg(windows)]
    {
        pty::resize(handle.con_pty, cols as u16, rows as u16).map_err(|e| CmdError(FsError::Io(e)))?;
    }
    #[cfg(not(any(unix, windows)))]
    { let _ = (handle, cols, rows); return Err(CmdError(FsError::Io(std::io::Error::new(std::io::ErrorKind::Unsupported, "PTY not supported")))); }
    Ok(())
}

#[tauri::command]
fn pty_close(pty_id: u32, state: State<'_, AppState>) {
    if let Some(mut handle) = state.ptys.lock().unwrap().remove(&pty_id) {
        pty::close(&mut handle);
    }
}

#[tauri::command]
fn get_icons_path(app_handle: tauri::AppHandle) -> String {
    app_handle
        .path()
        .resource_dir()
        .map(|p| p.join("icons").to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[tauri::command]
fn get_home_path() -> String {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[tauri::command]
fn get_theme(window: tauri::Window) -> String {
    match window.theme() {
        Ok(tauri::Theme::Dark) => "dark".to_string(),
        Ok(tauri::Theme::Light) => "light".to_string(),
        _ => "dark".to_string(),
    }
}

// ── App setup ────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let cb: EventCallback = Arc::new(move |watch_id, kind, name| {
                let event = FsChangeEvent {
                    watch_id: watch_id.to_string(),
                    kind: kind.as_str().to_string(),
                    name: name.map(|s| s.to_string()),
                };
                let _ = handle.emit("fsa:change", event);
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fsa_entries,
            fsa_stat,
            fsa_exists,
            fsa_write_text,
            fsa_open,
            fsa_read,
            fsa_close,
            fsa_watch,
            fsa_unwatch,
            get_home_path,
            get_icons_path,
            get_theme,
            pty_spawn,
            pty_write,
            pty_resize,
            pty_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
