use faraday_core::copy::{self, CancelToken, ConflictResolution, CopyEvent, CopyOptions};
use faraday_core::delete::{self, DeleteEvent};
use faraday_core::move_op::{self, MoveOptions};
use faraday_core::error::FsError;
use faraday_core::ops::{self, EntryInfo, FdTable, StatResult};
use faraday_core::watch::{EventCallback, FsWatcher};
use log::debug;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc as std_mpsc, Arc};
use tauri::{Emitter, Manager, State};
use tauri::http::header as http_header;
use tauri::http::StatusCode as HttpStatusCode;

#[cfg(unix)]
mod elevate;
#[cfg(not(unix))]
#[path = "elevate_stub.rs"]
mod elevate;

mod fsprovider;
mod pty;
pub mod rpc;
pub mod serve;

// ── Serializable types for Tauri IPC ─────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub kind: String,
    pub size: f64,
    pub mtime_ms: f64,
    pub mode: u32,
    pub nlink: u32,
    pub hidden: bool,
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

// ── Copy/Move job state ──────────────────────────────────────────────

struct CopyJobHandle {
    cancel_token: CancelToken,
    conflict_tx: std_mpsc::SyncSender<ConflictResolution>,
}

struct MoveJobHandle {
    cancel_token: CancelToken,
    conflict_tx: std_mpsc::SyncSender<ConflictResolution>,
}

struct DeleteJobHandle {
    cancel_token: CancelToken,
}

// ── Managed state ────────────────────────────────────────────────────

pub struct AppState {
    pub fdt: FdTable,
    pub watcher: FsWatcher,
    pub proxy: std::sync::Mutex<Option<Arc<elevate::FsProxy>>>,
    pub emit_handle: std::sync::Mutex<Option<tauri::AppHandle>>,
    pub ptys: std::sync::Mutex<HashMap<u32, pty::PtyHandle>>,
    pub next_pty_id: AtomicU32,
    pub(crate) copy_jobs: std::sync::Mutex<HashMap<u32, CopyJobHandle>>,
    pub(crate) next_copy_id: AtomicU32,
    pub(crate) move_jobs: std::sync::Mutex<HashMap<u32, MoveJobHandle>>,
    pub(crate) next_move_id: AtomicU32,
    pub(crate) delete_jobs: std::sync::Mutex<HashMap<u32, DeleteJobHandle>>,
    pub(crate) next_delete_id: AtomicU32,
    pub fsp_manager: fsprovider::FsProviderManager,
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
    match ops::entries(&dir_path) {
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
fn fs_exists(file_path: String) -> bool {
    ops::exists(&file_path)
}

#[tauri::command]
fn fs_read_file(file_path: String, state: State<'_, AppState>) -> CmdResult<Vec<u8>> {
    match ops::read_file(&file_path) {
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
  ops::write_text(&file_path, &data).map_err(Into::into)
}

#[tauri::command]
fn fs_write_binary(file_path: String, data: Vec<u8>) -> CmdResult<()> {
  ops::write_bytes(&file_path, &data).map_err(Into::into)
}

#[tauri::command]
fn fs_create_dir(dir_path: String) -> CmdResult<()> {
    fs::create_dir_all(&dir_path).map_err(|e| CmdError(FsError::from_io(e)))?;
    Ok(())
}

#[tauri::command]
fn fs_open(file_path: String, state: State<'_, AppState>) -> CmdResult<i32> {
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
fn fs_read(fd: i32, offset: u64, length: usize, state: State<'_, AppState>) -> CmdResult<Vec<u8>> {
    if fd < 0 {
        // Negative fd = proxy fd
        let proxy = state.get_or_launch_proxy()?;
        proxy.pread(fd, offset, length).map_err(Into::into)
    } else {
        ops::pread(fd, offset, length, &state.fdt).map_err(Into::into)
    }
}

#[tauri::command]
fn fs_close(fd: i32, state: State<'_, AppState>) {
    if fd < 0 {
        if let Ok(proxy) = state.get_or_launch_proxy() {
            proxy.close(fd);
        }
    } else {
        ops::close(fd, &state.fdt);
    }
}

#[tauri::command]
fn fs_watch(watch_id: String, dir_path: String, state: State<'_, AppState>) -> bool {
    debug!("[cmd] fs_watch id={} path={:?}", watch_id, dir_path);
    state.watcher.add(&watch_id, &dir_path)
}

#[tauri::command]
fn fs_unwatch(watch_id: String, state: State<'_, AppState>) {
    debug!("[cmd] fs_unwatch id={}", watch_id);
    state.watcher.remove(&watch_id);
    if let Some(ref proxy) = *state.proxy.lock().unwrap() {
        proxy.unwatch(&watch_id);
    }
}

// ── PTY commands ────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
struct PtyDataEvent {
    pty_id: u32,
    data: Vec<u8>,
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
) -> CmdResult<PtySpawnResult> {
    let id = state.next_pty_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let args = spawn_args.as_deref().unwrap_or(&[]);
    write_debug_log(&format!(
        "pty_spawn requested id={} cwd={} shell={} argc={}",
        id,
        cwd,
        shell_path,
        args.len()
    ));
    let handle = match pty::spawn(
        &cwd,
        &shell_path,
        cols.unwrap_or(80),
        rows.unwrap_or(24),
        args,
    ) {
        Ok(handle) => handle,
        Err(e) => {
            write_debug_log(&format!("pty_spawn failed id={} error={}", id, e));
            return Err(CmdError(FsError::Io(e)));
        }
    };
    let reader = handle.reader.clone();
    let result = PtySpawnResult {
        pty_id: id,
        cwd: handle.cwd.clone(),
        shell: handle.shell.clone(),
    };
    state.ptys.lock().unwrap().insert(id, handle);
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
    let mut env: HashMap<String, String> = std::env::vars().collect();
    // Inject platform key so frontend can branch on OS without a separate call.
    env.insert("__platform__".to_string(), std::env::consts::OS.to_string());
    env
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
    let ptys = state.ptys.lock().unwrap();
    let handle = ptys.get(&pty_id).ok_or(CmdError(FsError::BadFd))?;
    let payload = match (data_bytes, data) {
        (Some(bytes), _) => bytes,
        (None, Some(text)) => text.into_bytes(),
        (None, None) => return Err(CmdError(FsError::InvalidInput)),
    };
    pty::write_all(&handle.writer, &payload).map_err(|e| CmdError(FsError::Io(e)))?;
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
    let copy_id = state.next_copy_id.fetch_add(1, Ordering::Relaxed);
    let cancel_token = CancelToken::new();
    let (conflict_tx, conflict_rx) = std_mpsc::sync_channel::<ConflictResolution>(0);

    state.copy_jobs.lock().unwrap().insert(
        copy_id,
        CopyJobHandle {
            cancel_token: cancel_token.clone(),
            conflict_tx,
        },
    );

    let source_paths: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
    let dest_path = PathBuf::from(&dest_dir);

    std::thread::spawn(move || {
        let handle = app_handle.clone();
        let emit_progress = move |event: CopyEvent| {
            let _ = handle.emit(
                "copy:progress",
                CopyProgressEvent {
                    copy_id,
                    event,
                },
            );
        };

        let on_conflict = |src: &Path, dest: &Path| -> ConflictResolution {
            // Emit conflict event so frontend can show dialog
            let src_meta = fs::metadata(src).ok();
            let dest_meta = fs::metadata(dest).ok();
            let _ = app_handle.emit(
                "copy:progress",
                CopyProgressEvent {
                    copy_id,
                    event: CopyEvent::Conflict {
                        src: src.to_string_lossy().into_owned(),
                        dest: dest.to_string_lossy().into_owned(),
                        src_size: src_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        src_mtime_ms: src_meta.as_ref().map(|m| crate::copy_mtime_ms(m)).unwrap_or(0.0),
                        dest_size: dest_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        dest_mtime_ms: dest_meta.as_ref().map(|m| crate::copy_mtime_ms(m)).unwrap_or(0.0),
                    },
                },
            );
            // Block until frontend responds
            conflict_rx.recv().unwrap_or(ConflictResolution::Cancel)
        };

        let result = copy::copy_tree(
            &source_paths,
            &dest_path,
            &options,
            &cancel_token,
            &emit_progress,
            &on_conflict,
        );

        if let Err(e) = result {
            emit_progress(CopyEvent::Error {
                message: e.to_string(),
            });
        }

        // Clean up job
        if let Some(app) = tauri::Manager::try_state::<AppState>(&app_handle) {
            app.copy_jobs.lock().unwrap().remove(&copy_id);
        }
    });

    Ok(copy_id)
}

fn copy_mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

#[tauri::command]
fn copy_cancel(copy_id: u32, state: State<'_, AppState>) {
    if let Some(job) = state.copy_jobs.lock().unwrap().get(&copy_id) {
        job.cancel_token.cancel();
        // Also unblock any waiting conflict resolution
        let _ = job.conflict_tx.try_send(ConflictResolution::Cancel);
    }
}

#[tauri::command]
fn copy_resolve_conflict(copy_id: u32, resolution: ConflictResolution, state: State<'_, AppState>) {
    if let Some(job) = state.copy_jobs.lock().unwrap().get(&copy_id) {
        let _ = job.conflict_tx.send(resolution);
    }
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
    let move_id = state.next_move_id.fetch_add(1, Ordering::Relaxed);
    let cancel_token = CancelToken::new();
    let (conflict_tx, conflict_rx) = std_mpsc::sync_channel::<ConflictResolution>(0);

    state.move_jobs.lock().unwrap().insert(
        move_id,
        MoveJobHandle {
            cancel_token: cancel_token.clone(),
            conflict_tx,
        },
    );

    let source_paths: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
    let dest_path = PathBuf::from(&dest_dir);

    std::thread::spawn(move || {
        let handle = app_handle.clone();
        let emit_progress = move |event: CopyEvent| {
            let _ = handle.emit(
                "move:progress",
                MoveProgressEvent {
                    move_id,
                    event,
                },
            );
        };

        let on_conflict = |src: &Path, dest: &Path| -> ConflictResolution {
            let src_meta = fs::metadata(src).ok();
            let dest_meta = fs::metadata(dest).ok();
            let _ = app_handle.emit(
                "move:progress",
                MoveProgressEvent {
                    move_id,
                    event: CopyEvent::Conflict {
                        src: src.to_string_lossy().into_owned(),
                        dest: dest.to_string_lossy().into_owned(),
                        src_size: src_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        src_mtime_ms: src_meta.as_ref().map(|m| copy_mtime_ms(m)).unwrap_or(0.0),
                        dest_size: dest_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        dest_mtime_ms: dest_meta.as_ref().map(|m| copy_mtime_ms(m)).unwrap_or(0.0),
                    },
                },
            );
            conflict_rx.recv().unwrap_or(ConflictResolution::Cancel)
        };

        let result = move_op::move_tree(
            &source_paths,
            &dest_path,
            &options,
            &cancel_token,
            &emit_progress,
            &on_conflict,
        );

        if let Err(e) = result {
            emit_progress(CopyEvent::Error {
                message: e.to_string(),
            });
        }

        if let Some(app) = tauri::Manager::try_state::<AppState>(&app_handle) {
            app.move_jobs.lock().unwrap().remove(&move_id);
        }
    });

    Ok(move_id)
}

#[tauri::command]
fn move_cancel(move_id: u32, state: State<'_, AppState>) {
    if let Some(job) = state.move_jobs.lock().unwrap().get(&move_id) {
        job.cancel_token.cancel();
        let _ = job.conflict_tx.try_send(ConflictResolution::Cancel);
    }
}

#[tauri::command]
fn move_resolve_conflict(move_id: u32, resolution: ConflictResolution, state: State<'_, AppState>) {
    if let Some(job) = state.move_jobs.lock().unwrap().get(&move_id) {
        let _ = job.conflict_tx.send(resolution);
    }
}

// ── Delete commands ──────────────────────────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DeleteProgressEvent {
    delete_id: u32,
    event: DeleteEvent,
}

#[tauri::command]
fn delete_start(
    paths: Vec<String>,
    state: State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> CmdResult<u32> {
    let delete_id = state.next_delete_id.fetch_add(1, Ordering::Relaxed);
    let cancel_token = CancelToken::new();

    state.delete_jobs.lock().unwrap().insert(
        delete_id,
        DeleteJobHandle { cancel_token: cancel_token.clone() },
    );

    let source_paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();

    std::thread::spawn(move || {
        let handle = app_handle.clone();
        let emit_progress = move |event: DeleteEvent| {
            let _ = handle.emit(
                "delete:progress",
                DeleteProgressEvent { delete_id, event },
            );
        };

        delete::delete_recursive(&source_paths, &cancel_token, &emit_progress)
            .unwrap_or_else(|e| emit_progress(DeleteEvent::Error { message: e.to_string() }));

        if let Some(app) = tauri::Manager::try_state::<AppState>(&app_handle) {
            app.delete_jobs.lock().unwrap().remove(&delete_id);
        }
    });

    Ok(delete_id)
}

#[tauri::command]
fn delete_cancel(delete_id: u32, state: State<'_, AppState>) {
    if let Some(job) = state.delete_jobs.lock().unwrap().get(&delete_id) {
        job.cancel_token.cancel();
    }
}

#[tauri::command]
fn rename_item(source: String, new_name: String) -> CmdResult<()> {
    let source_path = PathBuf::from(&source);
    move_op::rename_item(&source_path, &new_name)?;
    Ok(())
}

// ── VFS protocol handler ─────────────────────────────────────────────

#[cfg(unix)]
fn vfs_request_path_to_os(path: &str) -> Option<PathBuf> {
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from("/").join(trimmed))
}

#[cfg(windows)]
fn vfs_request_path_to_os(path: &str) -> Option<PathBuf> {
    // Windows: `/C/Program Files/...` where the first segment is the drive letter.
    let trimmed = path.trim_start_matches('/');
    let mut parts = trimmed.split('/').filter(|s| !s.is_empty());
    let drive = parts.next()?;
    if drive.len() != 1 || !drive.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let mut pb = PathBuf::from(format!("{}:\\", drive.to_ascii_uppercase()));
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
    let canonical: Vec<std::path::PathBuf> = paths
        .iter()
        .map(|p| Path::new(p).canonicalize().map_err(|e| CmdError(FsError::from_io(e))))
        .collect::<Result<Vec<_>, _>>()?;
    trash::delete_all(&canonical).map_err(|e| {
        CmdError(FsError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))
    })?;
    Ok(())
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
    <script type="module">__FARADAY_BOOTSTRAP_INLINE__</script>
  </body>
</html>"#;
        let html = html.replace("__FARADAY_BOOTSTRAP_INLINE__", bootstrap_js);
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
    state.fsp_manager.load(&wasm_path)
}

#[tauri::command]
fn fsp_list_entries(
    wasm_path: String,
    container_path: String,
    inner_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<fsprovider::FspEntry>, String> {
    state.fsp_manager.list_entries(&wasm_path, &container_path, &inner_path)
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
    state.fsp_manager.read_file_range(&wasm_path, &container_path, &inner_path, offset, length)
}

// ── App setup ────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    write_debug_log("faraday_tauri_lib::run entered");
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
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
                fdt: FdTable::new(),
                watcher,
                proxy: std::sync::Mutex::new(None),
                emit_handle: std::sync::Mutex::new(Some(app.handle().clone())),
                ptys: std::sync::Mutex::new(HashMap::new()),
                next_pty_id: AtomicU32::new(0),
                copy_jobs: std::sync::Mutex::new(HashMap::new()),
                next_copy_id: AtomicU32::new(0),
                move_jobs: std::sync::Mutex::new(HashMap::new()),
                next_move_id: AtomicU32::new(0),
                delete_jobs: std::sync::Mutex::new(HashMap::new()),
                next_delete_id: AtomicU32::new(0),
                fsp_manager: fsprovider::FsProviderManager::new(),
            };
            app.manage(state);
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
            fs_open,
            fs_read,
            fs_close,
            fs_watch,
            fs_unwatch,
            get_home_path,
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
            rename_item,
            fsp_load,
            fsp_list_entries,
            fsp_read_file_range,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
