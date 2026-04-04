use crate::extensions_install::{self, ExtensionInstallEvent, ExtensionInstallRequest};
use crate::fsprovider;
use crate::pty;
use crate::FsEntry;
use dotdir_core::{
    copy::{self, CancelToken, ConflictResolution, CopyEvent, CopyOptions},
    delete::{self, DeleteEvent},
    error::FsError,
    move_op::{self, MoveOptions},
    ops::{self, EntryInfo, StatResult},
    watch::FsWatcher,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
        Mutex,
        mpsc as std_mpsc,
    },
};

pub(crate) struct CopyJobHandle {
    pub(crate) cancel_token: CancelToken,
    pub(crate) conflict_tx: std_mpsc::SyncSender<ConflictResolution>,
}

pub(crate) struct MoveJobHandle {
    pub(crate) cancel_token: CancelToken,
    pub(crate) conflict_tx: std_mpsc::SyncSender<ConflictResolution>,
}

pub(crate) struct DeleteJobHandle {
    pub(crate) cancel_token: CancelToken,
}

pub(crate) struct ExtensionInstallJobHandle {
    pub(crate) cancel_token: CancelToken,
}

pub(crate) struct RuntimeState {
    pub(crate) fdt: dotdir_core::ops::FdTable,
    pub(crate) watcher: FsWatcher,
    pub(crate) ptys: Mutex<HashMap<u32, pty::PtyHandle>>,
    pub(crate) next_pty_id: AtomicU32,
    pub(crate) copy_jobs: Mutex<HashMap<u32, CopyJobHandle>>,
    pub(crate) next_copy_id: AtomicU32,
    pub(crate) move_jobs: Mutex<HashMap<u32, MoveJobHandle>>,
    pub(crate) next_move_id: AtomicU32,
    pub(crate) delete_jobs: Mutex<HashMap<u32, DeleteJobHandle>>,
    pub(crate) next_delete_id: AtomicU32,
    pub(crate) extension_install_jobs: Mutex<HashMap<u32, ExtensionInstallJobHandle>>,
    pub(crate) next_extension_install_id: AtomicU32,
    pub(crate) fsp_manager: fsprovider::FsProviderManager,
}

impl RuntimeState {
    pub(crate) fn new(watcher: FsWatcher) -> Self {
        Self {
            fdt: dotdir_core::ops::FdTable::new(),
            watcher,
            ptys: Mutex::new(HashMap::new()),
            next_pty_id: AtomicU32::new(0),
            copy_jobs: Mutex::new(HashMap::new()),
            next_copy_id: AtomicU32::new(0),
            move_jobs: Mutex::new(HashMap::new()),
            next_move_id: AtomicU32::new(0),
            delete_jobs: Mutex::new(HashMap::new()),
            next_delete_id: AtomicU32::new(0),
            extension_install_jobs: Mutex::new(HashMap::new()),
            next_extension_install_id: AtomicU32::new(0),
            fsp_manager: fsprovider::FsProviderManager::new(),
        }
    }
}

pub(crate) fn metadata_mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub(crate) fn fs_entries(path: &str) -> Result<Vec<EntryInfo>, FsError> {
    ops::entries(path)
}

pub(crate) fn fs_stat(path: &str) -> Result<StatResult, FsError> {
    ops::stat(path)
}

pub(crate) fn fs_read_file(path: &str) -> Result<Vec<u8>, FsError> {
    ops::read_file(path)
}

pub(crate) fn fs_exists(path: &str) -> bool {
    ops::exists(path)
}

pub(crate) fn fs_write_text(path: &str, data: &str) -> Result<(), FsError> {
    ops::write_text(path, data)
}

pub(crate) fn fs_write_binary(path: &str, data: &[u8]) -> Result<(), FsError> {
    ops::write_bytes(path, data)
}

pub(crate) fn fs_create_dir(path: &str) -> Result<(), FsError> {
    fs::create_dir_all(path).map_err(FsError::from_io)
}

pub(crate) fn fs_open(runtime: &RuntimeState, path: &str) -> Result<i32, FsError> {
    ops::open(path, &runtime.fdt)
}

pub(crate) fn fs_read(runtime: &RuntimeState, fd: i32, offset: u64, length: usize) -> Result<Vec<u8>, FsError> {
    ops::pread(fd, offset, length, &runtime.fdt)
}

pub(crate) fn fs_close(runtime: &RuntimeState, fd: i32) {
    ops::close(fd, &runtime.fdt);
}

pub(crate) fn fs_watch(runtime: &RuntimeState, watch_id: &str, dir_path: &str) -> bool {
    runtime.watcher.add(watch_id, dir_path)
}

pub(crate) fn fs_unwatch(runtime: &RuntimeState, watch_id: &str) {
    runtime.watcher.remove(watch_id);
}

pub(crate) fn rename_item(source: &str, new_name: &str) -> Result<(), FsError> {
    move_op::rename_item(Path::new(source), new_name).map(|_| ())
}

pub(crate) fn move_to_trash(paths: &[String]) -> Result<(), FsError> {
    let canonical: Vec<PathBuf> = paths
        .iter()
        .map(|p| Path::new(p).canonicalize().map_err(FsError::from_io))
        .collect::<Result<Vec<_>, _>>()?;
    trash::delete_all(&canonical).map_err(|e| {
        FsError::Io(std::io::Error::new(
            std::io::ErrorKind::Other,
            e.to_string(),
        ))
    })?;
    Ok(())
}

pub(crate) fn fsp_load(runtime: &RuntimeState, wasm_path: &str) -> Result<(), String> {
    runtime.fsp_manager.load(wasm_path)
}

pub(crate) fn fsp_list_entries(
    runtime: &RuntimeState,
    wasm_path: &str,
    container_path: &str,
    inner_path: &str,
) -> Result<Vec<FsEntry>, String> {
    runtime
        .fsp_manager
        .list_entries(wasm_path, container_path, inner_path)
}

pub(crate) fn fsp_read_file_range(
    runtime: &RuntimeState,
    wasm_path: &str,
    container_path: &str,
    inner_path: &str,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>, String> {
    runtime
        .fsp_manager
        .read_file_range(wasm_path, container_path, inner_path, offset, length)
}

pub(crate) fn get_env() -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert("__platform__".to_string(), std::env::consts::OS.to_string());
    env
}

pub(crate) fn get_home_path() -> String {
    let path = dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppDirs {
    pub(crate) home_dir: String,
    pub(crate) config_dir: String,
    pub(crate) data_dir: String,
    pub(crate) cache_dir: String,
}

const APP_DIR_NAME: &str = "dev.dotdir";

pub(crate) fn get_app_dirs() -> AppDirs {
    let home_dir = get_home_path();
    let config_dir = dirs::config_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_default()
        .join(APP_DIR_NAME)
        .to_string_lossy()
        .into_owned();
    let data_dir = dirs::data_dir()
        .or_else(dirs::config_dir)
        .or_else(dirs::home_dir)
        .unwrap_or_default()
        .join(APP_DIR_NAME)
        .to_string_lossy()
        .into_owned();
    let cache_dir = dirs::cache_dir()
        .or_else(dirs::data_dir)
        .or_else(dirs::config_dir)
        .or_else(dirs::home_dir)
        .unwrap_or_default()
        .join(APP_DIR_NAME)
        .to_string_lossy()
        .into_owned();
    AppDirs {
        home_dir,
        config_dir,
        data_dir,
        cache_dir,
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtySpawnInfo {
    pub(crate) pty_id: u32,
    pub(crate) cwd: String,
    pub(crate) shell: String,
}

pub(crate) fn pty_spawn(
    runtime: &RuntimeState,
    cwd: &str,
    shell_path: &str,
    spawn_args: &[String],
    cols: u16,
    rows: u16,
) -> Result<(PtySpawnInfo, Arc<Mutex<Box<dyn std::io::Read + Send>>>), FsError> {
    let pty_id = runtime.next_pty_id.fetch_add(1, Ordering::Relaxed);
    let handle = pty::spawn(cwd, shell_path, cols, rows, spawn_args).map_err(FsError::Io)?;
    let reader = handle.reader.clone();
    let info = PtySpawnInfo {
        pty_id,
        cwd: handle.cwd.clone(),
        shell: handle.shell.clone(),
    };
    runtime.ptys.lock().unwrap().insert(pty_id, handle);
    Ok((info, reader))
}

pub(crate) fn pty_write(
    runtime: &RuntimeState,
    pty_id: u32,
    payload: &[u8],
) -> Result<(), FsError> {
    let ptys = runtime.ptys.lock().unwrap();
    let handle = ptys.get(&pty_id).ok_or(FsError::BadFd)?;
    pty::write_all(&handle.writer, payload).map_err(FsError::Io)
}

pub(crate) fn pty_resize(
    runtime: &RuntimeState,
    pty_id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), FsError> {
    let ptys = runtime.ptys.lock().unwrap();
    let handle = ptys.get(&pty_id).ok_or(FsError::BadFd)?;
    pty::resize(handle.master.as_ref(), cols, rows).map_err(FsError::Io)
}

pub(crate) fn pty_close(runtime: &RuntimeState, pty_id: u32) {
    if let Some(mut handle) = runtime.ptys.lock().unwrap().remove(&pty_id) {
        pty::close(&mut handle);
    }
}

pub(crate) fn start_copy_job(
    runtime: &RuntimeState,
    sources: Vec<String>,
    dest_dir: String,
    options: CopyOptions,
    emit_event: impl Fn(CopyEvent, u32) + Send + Sync + 'static,
    cleanup: impl Fn(u32) + Send + 'static,
) -> u32 {
    let copy_id = runtime.next_copy_id.fetch_add(1, Ordering::Relaxed);
    let cancel_token = CancelToken::new();
    let (conflict_tx, conflict_rx) = std_mpsc::sync_channel::<ConflictResolution>(0);

    runtime.copy_jobs.lock().unwrap().insert(
        copy_id,
        CopyJobHandle {
            cancel_token: cancel_token.clone(),
            conflict_tx,
        },
    );

    let source_paths: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
    let dest_path = PathBuf::from(&dest_dir);
    let emit_event = Arc::new(emit_event);

    std::thread::spawn(move || {
        let emit_progress = {
            let emit_event = emit_event.clone();
            move |event: CopyEvent| emit_event(event, copy_id)
        };

        let on_conflict = {
            let emit_event = emit_event.clone();
            move |src: &Path, dest: &Path| -> ConflictResolution {
                let src_meta = fs::metadata(src).ok();
                let dest_meta = fs::metadata(dest).ok();
                emit_event(
                    CopyEvent::Conflict {
                        src: src.to_string_lossy().into_owned(),
                        dest: dest.to_string_lossy().into_owned(),
                        src_size: src_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        src_mtime_ms: src_meta.as_ref().map(metadata_mtime_ms).unwrap_or(0.0),
                        dest_size: dest_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        dest_mtime_ms: dest_meta.as_ref().map(metadata_mtime_ms).unwrap_or(0.0),
                    },
                    copy_id,
                );
                conflict_rx.recv().unwrap_or(ConflictResolution::Cancel)
            }
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

        cleanup(copy_id);
    });

    copy_id
}

pub(crate) fn cancel_copy_job(runtime: &RuntimeState, copy_id: u32) {
    if let Some(job) = runtime.copy_jobs.lock().unwrap().get(&copy_id) {
        job.cancel_token.cancel();
        let _ = job.conflict_tx.try_send(ConflictResolution::Cancel);
    }
}

pub(crate) fn resolve_copy_conflict(
    runtime: &RuntimeState,
    copy_id: u32,
    resolution: ConflictResolution,
) {
    if let Some(job) = runtime.copy_jobs.lock().unwrap().get(&copy_id) {
        let _ = job.conflict_tx.send(resolution);
    }
}

pub(crate) fn start_move_job(
    runtime: &RuntimeState,
    sources: Vec<String>,
    dest_dir: String,
    options: MoveOptions,
    emit_event: impl Fn(CopyEvent, u32) + Send + Sync + 'static,
    cleanup: impl Fn(u32) + Send + 'static,
) -> u32 {
    let move_id = runtime.next_move_id.fetch_add(1, Ordering::Relaxed);
    let cancel_token = CancelToken::new();
    let (conflict_tx, conflict_rx) = std_mpsc::sync_channel::<ConflictResolution>(0);

    runtime.move_jobs.lock().unwrap().insert(
        move_id,
        MoveJobHandle {
            cancel_token: cancel_token.clone(),
            conflict_tx,
        },
    );

    let source_paths: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
    let dest_path = PathBuf::from(&dest_dir);
    let emit_event = Arc::new(emit_event);

    std::thread::spawn(move || {
        let emit_progress = {
            let emit_event = emit_event.clone();
            move |event: CopyEvent| emit_event(event, move_id)
        };

        let on_conflict = {
            let emit_event = emit_event.clone();
            move |src: &Path, dest: &Path| -> ConflictResolution {
                let src_meta = fs::metadata(src).ok();
                let dest_meta = fs::metadata(dest).ok();
                emit_event(
                    CopyEvent::Conflict {
                        src: src.to_string_lossy().into_owned(),
                        dest: dest.to_string_lossy().into_owned(),
                        src_size: src_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        src_mtime_ms: src_meta.as_ref().map(metadata_mtime_ms).unwrap_or(0.0),
                        dest_size: dest_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        dest_mtime_ms: dest_meta.as_ref().map(metadata_mtime_ms).unwrap_or(0.0),
                    },
                    move_id,
                );
                conflict_rx.recv().unwrap_or(ConflictResolution::Cancel)
            }
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

        cleanup(move_id);
    });

    move_id
}

pub(crate) fn cancel_move_job(runtime: &RuntimeState, move_id: u32) {
    if let Some(job) = runtime.move_jobs.lock().unwrap().get(&move_id) {
        job.cancel_token.cancel();
        let _ = job.conflict_tx.try_send(ConflictResolution::Cancel);
    }
}

pub(crate) fn resolve_move_conflict(
    runtime: &RuntimeState,
    move_id: u32,
    resolution: ConflictResolution,
) {
    if let Some(job) = runtime.move_jobs.lock().unwrap().get(&move_id) {
        let _ = job.conflict_tx.send(resolution);
    }
}

pub(crate) fn start_delete_job(
    runtime: &RuntimeState,
    paths: Vec<String>,
    emit_event: impl Fn(DeleteEvent, u32) + Send + Sync + 'static,
    cleanup: impl Fn(u32) + Send + 'static,
) -> u32 {
    let delete_id = runtime.next_delete_id.fetch_add(1, Ordering::Relaxed);
    let cancel_token = CancelToken::new();

    runtime.delete_jobs.lock().unwrap().insert(
        delete_id,
        DeleteJobHandle {
            cancel_token: cancel_token.clone(),
        },
    );

    let source_paths: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let emit_event = Arc::new(emit_event);

    std::thread::spawn(move || {
        let emit_progress = {
            let emit_event = emit_event.clone();
            move |event: DeleteEvent| emit_event(event, delete_id)
        };

        delete::delete_recursive(&source_paths, &cancel_token, &emit_progress)
            .unwrap_or_else(|e| emit_progress(DeleteEvent::Error { message: e.to_string() }));

        cleanup(delete_id);
    });

    delete_id
}

pub(crate) fn cancel_delete_job(runtime: &RuntimeState, delete_id: u32) {
    if let Some(job) = runtime.delete_jobs.lock().unwrap().get(&delete_id) {
        job.cancel_token.cancel();
    }
}

pub(crate) fn start_extension_install_job(
    runtime: &RuntimeState,
    request: ExtensionInstallRequest,
    emit_event: impl Fn(ExtensionInstallEvent, u32) + Send + Sync + 'static,
    cleanup: impl Fn(u32) + Send + 'static,
) -> u32 {
    let install_id = runtime
        .next_extension_install_id
        .fetch_add(1, Ordering::Relaxed);
    let cancel_token = CancelToken::new();

    runtime.extension_install_jobs.lock().unwrap().insert(
        install_id,
        ExtensionInstallJobHandle {
            cancel_token: cancel_token.clone(),
        },
    );

    let emit_event = Arc::new(emit_event);

    std::thread::spawn(move || {
        let emit_progress = {
            let emit_event = emit_event.clone();
            move |event: ExtensionInstallEvent| emit_event(event, install_id)
        };

        let result = extensions_install::install_extension(request, cancel_token, emit_progress);
        if let Err(message) = result {
            emit_event(ExtensionInstallEvent::Error { message }, install_id);
        }

        cleanup(install_id);
    });

    install_id
}

pub(crate) fn cancel_extension_install_job(runtime: &RuntimeState, install_id: u32) {
    if let Some(job) = runtime.extension_install_jobs.lock().unwrap().get(&install_id) {
        job.cancel_token.cancel();
    }
}
