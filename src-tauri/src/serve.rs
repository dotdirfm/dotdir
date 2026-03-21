/// `faraday serve` — headless HTTP + WebSocket server.
///
/// Serves static web UI files and exposes filesystem operations via
/// JSON-RPC 2.0 over WebSocket. Uses faraday-core for all FS ops.

use axum::{
    body::Body,
    extract::{
        Path,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use crate::pty;
use faraday_core::{
    copy::{self, CancelToken, ConflictResolution, CopyEvent, CopyOptions},
    move_op::{self, MoveOptions},
    error::FsError,
    ops::{self, FdTable},
    watch::{EventCallback, FsWatcher},
};
use futures::{SinkExt, StreamExt};
use log::debug;
use rust_embed::RustEmbed;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
};

use tokio::sync::mpsc;

#[derive(RustEmbed)]
#[folder = "../dist"]
struct EmbeddedAssets;

// ── JSON entry for the wire ─────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct JsEntry {
    name: String,
    kind: String,
    size: f64,
    mtime_ms: f64,
    mode: u32,
    nlink: u32,
    hidden: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    link_target: Option<String>,
}

impl From<ops::EntryInfo> for JsEntry {
    fn from(e: ops::EntryInfo) -> Self {
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

// ── Per-connection session ──────────────────────────────────────────

struct CopyJobHandle {
    cancel_token: CancelToken,
    conflict_tx: std::sync::mpsc::SyncSender<ConflictResolution>,
}

struct MoveJobHandle {
    cancel_token: CancelToken,
    conflict_tx: std::sync::mpsc::SyncSender<ConflictResolution>,
}

struct Session {
    fdt: FdTable,
    watcher: FsWatcher,
    ptys: std::sync::Mutex<HashMap<u32, pty::PtyHandle>>,
    next_pty_id: AtomicU32,
    copy_jobs: std::sync::Mutex<HashMap<u32, CopyJobHandle>>,
    next_copy_id: AtomicU32,
    move_jobs: std::sync::Mutex<HashMap<u32, MoveJobHandle>>,
    next_move_id: AtomicU32,
}

// ── WebSocket handler ───────────────────────────────────────────────

async fn ws_handler(
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket))
}

async fn handle_socket(socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let tx_watch = tx.clone();
    let cb: EventCallback = Arc::new(move |watch_id, kind, name| {
        let n = json!({
            "jsonrpc": "2.0",
            "method": "fs.change",
            "params": { "watchId": watch_id, "type": kind.as_str(), "name": name }
        });
        let _ = tx_watch.send(Message::Text(n.to_string()));
    });

    let watcher = match FsWatcher::new(cb) {
        Ok(w) => w,
        Err(_) => return,
    };

    let session = Arc::new(Session {
        fdt: FdTable::new(),
        watcher,
        ptys: std::sync::Mutex::new(HashMap::new()),
        next_pty_id: AtomicU32::new(0),
        copy_jobs: std::sync::Mutex::new(HashMap::new()),
        next_copy_id: AtomicU32::new(0),
        move_jobs: std::sync::Mutex::new(HashMap::new()),
        next_move_id: AtomicU32::new(0),
    });

    let write_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };

        let session = session.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            if let Some(response) = process_message(&session, &text, &tx).await {
                let _ = tx.send(response);
            }
        });
    }

    drop(tx);
    let _ = write_task.await;
}

// ── RPC dispatch ────────────────────────────────────────────────────

async fn process_message(
    session: &Arc<Session>,
    text: &str,
    tx: &mpsc::UnboundedSender<Message>,
) -> Option<Message> {
    let msg: Value = serde_json::from_str(text).ok()?;
    let id = msg.get("id")?.clone();
    let method = msg["method"].as_str()?.to_string();
    let params = msg["params"].clone();

    if method == "fs.read" {
        let fd = params["handle"].as_i64()? as i32;
        let offset = params["offset"].as_u64()?;
        let length = params["length"].as_u64()? as usize;
        let id_num = id.as_u64()? as u32;

        let session = session.clone();
        let data =
            tokio::task::spawn_blocking(move || ops::pread(fd, offset, length, &session.fdt))
                .await
                .unwrap();

        return Some(match data {
            Ok(bytes) => {
                let mut frame = Vec::with_capacity(1 + 4 + bytes.len());
                frame.push(0x00); // type: RPC response
                frame.extend_from_slice(&id_num.to_le_bytes());
                frame.extend_from_slice(&bytes);
                Message::Binary(frame)
            }
            Err(e) => rpc_error(&id, &e),
        });
    }

    // PTY spawn needs tx for the reader thread
    if method == "pty.spawn" {
        return Some(handle_pty_spawn(session, &id, &params, tx));
    }

    // copy.start needs tx for progress streaming
    if method == "copy.start" {
        return Some(handle_copy_start(session, &id, &params, tx));
    }

    // move.start needs tx for progress streaming
    if method == "move.start" {
        return Some(handle_move_start(session, &id, &params, tx));
    }

    let session = session.clone();
    let result = tokio::task::spawn_blocking(move || dispatch(&session, &method, &params))
        .await
        .unwrap();

    Some(match result {
        Ok(value) => Message::Text(
            json!({ "jsonrpc": "2.0", "id": id, "result": value }).to_string(),
        ),
        Err(e) => rpc_error(&id, &e),
    })
}

fn handle_pty_spawn(
    session: &Arc<Session>,
    id: &Value,
    params: &Value,
    tx: &mpsc::UnboundedSender<Message>,
) -> Message {
    let cwd = match params["cwd"].as_str() {
        Some(s) => s,
        None => return rpc_error(id, &FsError::InvalidInput),
    };
    let cols = params["cols"].as_u64().unwrap_or(80) as u16;
    let rows = params["rows"].as_u64().unwrap_or(24) as u16;
    let profile_id = params["profileId"].as_str();

    let handle = match pty::spawn(cwd, profile_id, cols, rows) {
        Ok(h) => h,
        Err(e) => return rpc_error(id, &FsError::Io(e)),
    };

    let pty_id = session
        .next_pty_id
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let reader = handle.reader.clone();
    let result = json!({
        "ptyId": pty_id,
        "cwd": handle.cwd,
        "shell": handle.shell,
        "profileId": handle.profile_id,
        "profileLabel": handle.profile_label,
    });

    session.ptys.lock().unwrap().insert(pty_id, handle);

    // Start reader thread that sends pty data as binary frames
    let tx_pty = tx.clone();
    std::thread::spawn(move || {
        let pty_id_bytes = pty_id.to_le_bytes();
        let mut buf = [0u8; 4096];
        let mut leftover = Vec::new(); // incomplete UTF-8 bytes from previous read
        loop {
            let offset = leftover.len();
            buf[..offset].copy_from_slice(&leftover);
            leftover.clear();
            match pty::read_blocking(&reader, &mut buf[offset..]) {
                Ok(0) | Err(_) => {
                    let n = json!({
                        "jsonrpc": "2.0",
                        "method": "pty.exit",
                        "params": { "ptyId": pty_id }
                    });
                    let _ = tx_pty.send(Message::Text(n.to_string()));
                    break;
                }
                Ok(n) => {
                    let total = offset + n;
                    // Find valid UTF-8 boundary
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
                    // Binary frame: [0x01][pty_id: u32 LE][valid UTF-8 bytes]
                    let mut frame = Vec::with_capacity(1 + 4 + valid_up_to);
                    frame.push(0x01); // type: PTY data
                    frame.extend_from_slice(&pty_id_bytes);
                    frame.extend_from_slice(&buf[..valid_up_to]);
                    if tx_pty.send(Message::Binary(frame)).is_err() {
                        break;
                    }
                }
            }
        }
    });

    Message::Text(json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string())
}

fn handle_copy_start(
    session: &Arc<Session>,
    id: &Value,
    params: &Value,
    tx: &mpsc::UnboundedSender<Message>,
) -> Message {
    let sources: Vec<String> = match serde_json::from_value(params["sources"].clone()) {
        Ok(v) => v,
        Err(_) => return rpc_error(id, &FsError::InvalidInput),
    };
    let dest_dir = match params["destDir"].as_str() {
        Some(s) => s.to_string(),
        None => return rpc_error(id, &FsError::InvalidInput),
    };
    let options: CopyOptions = serde_json::from_value(params["options"].clone()).unwrap_or_default();

    let copy_id = session.next_copy_id.fetch_add(1, Ordering::Relaxed);
    let cancel_token = CancelToken::new();
    let (conflict_tx, conflict_rx) = std::sync::mpsc::sync_channel::<ConflictResolution>(0);

    session.copy_jobs.lock().unwrap().insert(
        copy_id,
        CopyJobHandle {
            cancel_token: cancel_token.clone(),
            conflict_tx,
        },
    );

    let source_paths: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
    let dest_path = PathBuf::from(&dest_dir);
    let tx_copy = tx.clone();
    let session_ref = session.clone();

    std::thread::spawn(move || {
        let tx_progress = tx_copy.clone();
        let emit_progress = move |event: CopyEvent| {
            let payload = json!({
                "jsonrpc": "2.0",
                "method": "copy.progress",
                "params": { "copyId": copy_id, "event": event }
            });
            let _ = tx_progress.send(Message::Text(payload.to_string()));
        };

        let tx_conflict = tx_copy.clone();
        let on_conflict = |src: &std::path::Path, dest: &std::path::Path| -> ConflictResolution {
            let src_meta = std::fs::metadata(src).ok();
            let dest_meta = std::fs::metadata(dest).ok();
            let payload = json!({
                "jsonrpc": "2.0",
                "method": "copy.progress",
                "params": {
                    "copyId": copy_id,
                    "event": {
                        "kind": "conflict",
                        "src": src.to_string_lossy(),
                        "dest": dest.to_string_lossy(),
                        "srcSize": src_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        "srcMtimeMs": src_meta.as_ref().map(|m| serve_mtime_ms(m)).unwrap_or(0.0),
                        "destSize": dest_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        "destMtimeMs": dest_meta.as_ref().map(|m| serve_mtime_ms(m)).unwrap_or(0.0),
                    }
                }
            });
            let _ = tx_conflict.send(Message::Text(payload.to_string()));
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

        session_ref.copy_jobs.lock().unwrap().remove(&copy_id);
    });

    Message::Text(json!({ "jsonrpc": "2.0", "id": id, "result": copy_id }).to_string())
}

fn handle_move_start(
    session: &Arc<Session>,
    id: &Value,
    params: &Value,
    tx: &mpsc::UnboundedSender<Message>,
) -> Message {
    let sources: Vec<String> = match serde_json::from_value(params["sources"].clone()) {
        Ok(v) => v,
        Err(_) => return rpc_error(id, &FsError::InvalidInput),
    };
    let dest_dir = match params["destDir"].as_str() {
        Some(s) => s.to_string(),
        None => return rpc_error(id, &FsError::InvalidInput),
    };
    let options: MoveOptions = serde_json::from_value(params["options"].clone()).unwrap_or_default();

    let move_id = session.next_move_id.fetch_add(1, Ordering::Relaxed);
    let cancel_token = CancelToken::new();
    let (conflict_tx, conflict_rx) = std::sync::mpsc::sync_channel::<ConflictResolution>(0);

    session.move_jobs.lock().unwrap().insert(
        move_id,
        MoveJobHandle {
            cancel_token: cancel_token.clone(),
            conflict_tx,
        },
    );

    let source_paths: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
    let dest_path = PathBuf::from(&dest_dir);
    let tx_move = tx.clone();
    let session_ref = session.clone();

    std::thread::spawn(move || {
        let tx_progress = tx_move.clone();
        let emit_progress = move |event: CopyEvent| {
            let payload = json!({
                "jsonrpc": "2.0",
                "method": "move.progress",
                "params": { "moveId": move_id, "event": event }
            });
            let _ = tx_progress.send(Message::Text(payload.to_string()));
        };

        let tx_conflict = tx_move.clone();
        let on_conflict = |src: &std::path::Path, dest: &std::path::Path| -> ConflictResolution {
            let src_meta = std::fs::metadata(src).ok();
            let dest_meta = std::fs::metadata(dest).ok();
            let payload = json!({
                "jsonrpc": "2.0",
                "method": "move.progress",
                "params": {
                    "moveId": move_id,
                    "event": {
                        "kind": "conflict",
                        "src": src.to_string_lossy(),
                        "dest": dest.to_string_lossy(),
                        "srcSize": src_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        "srcMtimeMs": src_meta.as_ref().map(|m| serve_mtime_ms(m)).unwrap_or(0.0),
                        "destSize": dest_meta.as_ref().map(|m| m.len()).unwrap_or(0),
                        "destMtimeMs": dest_meta.as_ref().map(|m| serve_mtime_ms(m)).unwrap_or(0.0),
                    }
                }
            });
            let _ = tx_conflict.send(Message::Text(payload.to_string()));
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

        session_ref.move_jobs.lock().unwrap().remove(&move_id);
    });

    Message::Text(json!({ "jsonrpc": "2.0", "id": id, "result": move_id }).to_string())
}

fn serve_mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn rpc_error(id: &Value, e: &FsError) -> Message {
    Message::Text(
        json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -1, "message": e.to_string(), "data": { "errno": e.errno_str() } }
        })
        .to_string(),
    )
}

fn dispatch(session: &Session, method: &str, params: &Value) -> Result<Value, FsError> {
    debug!("[ws] dispatch method={}", method);
    match method {
        "fs.entries" => {
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            debug!("[ws] fs.entries {:?}", path);
            let entries: Vec<JsEntry> = ops::entries(path)?.into_iter().map(Into::into).collect();
            debug!("[ws] fs.entries {:?} → {} entries", path, entries.len());
            Ok(serde_json::to_value(entries).unwrap())
        }
        "fs.stat" => {
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            let s = ops::stat(path)?;
            Ok(json!({ "size": s.size, "mtimeMs": s.mtime_ms }))
        }
        "fs.exists" => {
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            Ok(json!(ops::exists(path)))
        }
        "fs.writeFile" => {
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            let data = params["data"].as_str().ok_or(FsError::InvalidInput)?;
            ops::write_text(path, data)?;
            Ok(Value::Null)
        }
        "fs.writeBinary" => {
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            let arr = params["data"].as_array().ok_or(FsError::InvalidInput)?;
            let bytes: Vec<u8> = arr.iter()
                .map(|v| v.as_u64().unwrap_or(0) as u8)
                .collect();
            ops::write_bytes(path, &bytes)?;
            Ok(Value::Null)
        }
        "fs.createDir" => {
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            std::fs::create_dir_all(path).map_err(FsError::Io)?;
            Ok(Value::Null)
        }
        "fs.open" => {
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            Ok(json!(ops::open(path, &session.fdt)?))
        }
        "fs.close" => {
            let fd = params["handle"].as_i64().ok_or(FsError::InvalidInput)? as i32;
            ops::close(fd, &session.fdt);
            Ok(Value::Null)
        }
        "fs.watch" => {
            let watch_id = params["watchId"].as_str().ok_or(FsError::InvalidInput)?;
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            debug!("[ws] fs.watch id={} path={:?}", watch_id, path);
            Ok(json!(session.watcher.add(watch_id, path)))
        }
        "fs.unwatch" => {
            let watch_id = params["watchId"].as_str().ok_or(FsError::InvalidInput)?;
            debug!("[ws] fs.unwatch id={}", watch_id);
            session.watcher.remove(watch_id);
            Ok(Value::Null)
        }
        "pty.write" => {
            let pty_id = params["ptyId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            let data = params["data"].as_str().ok_or(FsError::InvalidInput)?;
            let ptys = session.ptys.lock().unwrap();
            let handle = ptys.get(&pty_id).ok_or(FsError::BadFd)?;
            pty::write_all(&handle.writer, data.as_bytes()).map_err(FsError::Io)?;
            Ok(Value::Null)
        }
        "pty.resize" => {
            let pty_id = params["ptyId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            let cols = params["cols"].as_u64().ok_or(FsError::InvalidInput)? as u16;
            let rows = params["rows"].as_u64().ok_or(FsError::InvalidInput)? as u16;
            let ptys = session.ptys.lock().unwrap();
            let handle = ptys.get(&pty_id).ok_or(FsError::BadFd)?;
            pty::resize(handle.master.as_ref(), cols, rows).map_err(FsError::Io)?;
            Ok(Value::Null)
        }
        "pty.close" => {
            let pty_id = params["ptyId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            if let Some(mut handle) = session.ptys.lock().unwrap().remove(&pty_id) {
                pty::close(&mut handle);
            }
            Ok(Value::Null)
        }
        "copy.cancel" => {
            let copy_id = params["copyId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            if let Some(job) = session.copy_jobs.lock().unwrap().get(&copy_id) {
                job.cancel_token.cancel();
                let _ = job.conflict_tx.try_send(ConflictResolution::Cancel);
            }
            Ok(Value::Null)
        }
        "copy.resolveConflict" => {
            let copy_id = params["copyId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            let resolution: ConflictResolution =
                serde_json::from_value(params["resolution"].clone())
                    .map_err(|_| FsError::InvalidInput)?;
            if let Some(job) = session.copy_jobs.lock().unwrap().get(&copy_id) {
                let _ = job.conflict_tx.send(resolution);
            }
            Ok(Value::Null)
        }
        "move.cancel" => {
            let move_id = params["moveId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            if let Some(job) = session.move_jobs.lock().unwrap().get(&move_id) {
                job.cancel_token.cancel();
                let _ = job.conflict_tx.try_send(ConflictResolution::Cancel);
            }
            Ok(Value::Null)
        }
        "move.resolveConflict" => {
            let move_id = params["moveId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            let resolution: ConflictResolution =
                serde_json::from_value(params["resolution"].clone())
                    .map_err(|_| FsError::InvalidInput)?;
            if let Some(job) = session.move_jobs.lock().unwrap().get(&move_id) {
                let _ = job.conflict_tx.send(resolution);
            }
            Ok(Value::Null)
        }
        "fs.rename" => {
            let source = params["source"].as_str().ok_or(FsError::InvalidInput)?;
            let new_name = params["newName"].as_str().ok_or(FsError::InvalidInput)?;
            move_op::rename_item(std::path::Path::new(source), new_name)?;
            Ok(Value::Null)
        }
        "fs.moveToTrash" => {
            let paths = params["paths"].as_array().ok_or(FsError::InvalidInput)?;
            let canonical: Vec<std::path::PathBuf> = paths
                .iter()
                .map(|v| {
                    let s = v.as_str().ok_or(FsError::InvalidInput)?;
                    std::path::Path::new(s)
                        .canonicalize()
                        .map_err(FsError::from_io)
                })
                .collect::<Result<Vec<_>, _>>()?;
            trash::delete_all(&canonical).map_err(|e| {
                FsError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
            })?;
            Ok(Value::Null)
        }
        "fs.deletePath" => {
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            let p = std::path::Path::new(path);
            let meta = std::fs::metadata(p).map_err(FsError::from_io)?;
            if meta.is_dir() {
                std::fs::remove_dir(p).map_err(FsError::from_io)?;
            } else {
                std::fs::remove_file(p).map_err(FsError::from_io)?;
            }
            Ok(Value::Null)
        }
        "ping" => Ok(Value::Null),
        "utils.getHomePath" => Ok(json!(
            dirs::home_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default()
        )),
        "utils.getTerminalProfiles" => Ok(serde_json::to_value(pty::list_profiles()).unwrap()),
        _ => Err(FsError::InvalidInput),
    }
}

// ── macOS Dock suppression ─────────────────────────────────────────

#[cfg(target_os = "macos")]
fn suppress_dock_icon() {
    unsafe {
        let cls = objc2::runtime::AnyClass::get(c"NSApplication").expect("NSApplication class");
        let app: *mut objc2::runtime::AnyObject = objc2::msg_send![cls, sharedApplication];
        // NSApplicationActivationPolicyAccessory = 1
        let _: bool = objc2::msg_send![app, setActivationPolicy: 1_isize];
    }
}

// ── Asset serving ──────────────────────────────────────────────────

async fn embedded_asset_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match EmbeddedAssets::get(path) {
        Some(file) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, file.metadata.mimetype())
            .body(Body::from(file.data.into_owned()))
            .unwrap(),
        None => {
            // SPA fallback: serve index.html for client-side routing
            match EmbeddedAssets::get("index.html") {
                Some(file) => Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "text/html")
                    .body(Body::from(file.data.into_owned()))
                    .unwrap(),
                None => Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::empty())
                    .unwrap(),
            }
        }
    }
}

// ── VFS (raw filesystem) serving ─────────────────────────────────────

#[cfg(unix)]
fn vfs_path_to_os(path: &str) -> Option<PathBuf> {
    // We expose absolute paths through the VFS surface. The HTTP route is
    // `/vfs/<absolute path without leading slash>`.
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from("/").join(trimmed))
}

#[cfg(windows)]
fn vfs_path_to_os(path: &str) -> Option<PathBuf> {
    // Windows uses `/vfs/C/Program Files/...` where the first segment is the drive.
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

async fn vfs_handler(Path(path): Path<String>) -> Response {
    // Virtual mount for extension iframes (stateless):
    // - `/vfs/_ext/<abs extension dir>/` -> generated index.html (+ inline postMessage bootstrap)
    // - `/vfs/_ext/<abs extension dir>/<relative file>` -> served from the real dir
    let p = path.trim_start_matches('/');
    if p.starts_with("_ext/") {
        // Stateless extension mount:
        //  - `/vfs/_ext/<abs extension dir>/` -> generated index.html
        //  - `/vfs/_ext/<abs extension dir>/<relative file>` -> served from real dir
        let rest = &p["_ext/".len()..];
        if rest.is_empty() {
            return Response::builder().status(StatusCode::NOT_FOUND).body(Body::empty()).unwrap();
        }

        let wants_index = p.ends_with('/')
            || rest.ends_with("/index.html")
            || rest == "index.html";

        let os_path = match vfs_path_to_os(rest) {
            Some(p) => p,
            None => return Response::builder().status(StatusCode::BAD_REQUEST).body(Body::empty()).unwrap(),
        };

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

        if wants_index {
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .body(Body::from(html.as_bytes().to_vec()))
                .unwrap();
        }

        // If the request points to a directory without an explicit trailing slash,
        // still return index.html.
        if tokio::fs::metadata(&os_path).await.map(|m| m.is_dir()).unwrap_or(false) {
            return Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                .body(Body::from(html.as_bytes().to_vec()))
                .unwrap();
        }

        // Serve the file directly from disk.
        let meta = match tokio::fs::metadata(&os_path).await {
            Ok(m) => m,
            Err(_) => {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::empty())
                    .unwrap();
            }
        };
        if meta.is_dir() {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .unwrap();
        }
        let bytes = match tokio::fs::read(&os_path).await {
            Ok(b) => b,
            Err(_) => {
                return Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::empty())
                    .unwrap();
            }
        };
        let mime_str: String = match os_path.extension().and_then(|e| e.to_str()) {
            Some("cjs" | "mjs") => "application/javascript".to_owned(),
            _ => mime_guess::from_path(&os_path).first_or_octet_stream().to_string(),
        };
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime_str.as_str())
            .body(Body::from(bytes))
            .unwrap();
    }
  

    let os_path = match vfs_path_to_os(&path) {
        Some(p) => p,
        None => {
            return Response::builder()
                .status(StatusCode::BAD_REQUEST)
                .body(Body::empty())
                .unwrap();
        }
    };

    let meta = match tokio::fs::metadata(&os_path).await {
        Ok(m) => m,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .unwrap();
        }
    };

    if meta.is_dir() {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    }

    let bytes = match tokio::fs::read(&os_path).await {
        Ok(b) => b,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .unwrap();
        }
    };

    let mime_str: String = match os_path.extension().and_then(|e| e.to_str()) {
        Some("cjs" | "mjs") => "application/javascript".to_owned(),
        _ => mime_guess::from_path(&os_path).first_or_octet_stream().to_string(),
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_str.as_str())
        .body(Body::from(bytes))
        .unwrap()
}

// ── Config parsing ──────────────────────────────────────────────────

struct Config {
    port: u16,
    host: String,
}

fn parse_config(args: &[String]) -> Config {
    let mut port: u16 = std::env::var("FARADAY_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3001);
    let mut host = std::env::var("FARADAY_HOST").unwrap_or_else(|_| "127.0.0.1".into());

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" if i + 1 < args.len() => {
                if let Ok(p) = args[i + 1].parse() {
                    port = p;
                }
                i += 2;
            }
            "--host" if i + 1 < args.len() => {
                host = args[i + 1].clone();
                i += 2;
            }
            _ => i += 1,
        }
    }

    Config {
        port,
        host,
    }
}

// ── Entry point ─────────────────────────────────────────────────────

/// Run the headless HTTP + WebSocket server.
/// `args` are the arguments after the `serve` subcommand.
pub fn run(args: &[String]) {
    #[cfg(target_os = "macos")]
    suppress_dock_icon();

    let config = parse_config(args);
    let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
    rt.block_on(async {
        let app = Router::new()
            .route("/ws", get(ws_handler))
            .route("/vfs/*path", get(vfs_handler))
            .fallback(embedded_asset_handler);

        let addr = format!("{}:{}", config.host, config.port);
        let listener = match tokio::net::TcpListener::bind(&addr).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Error: failed to bind {addr}: {e}");
                if e.kind() == std::io::ErrorKind::AddrInUse {
                    eprintln!("Hint: another process is using port {}. Kill it or use --port <N>.", config.port);
                }
                std::process::exit(1);
            }
        };

        eprintln!("Faraday server listening on http://{addr}");
        eprintln!("WebSocket endpoint: ws://{addr}/ws");

        axum::serve(listener, app).await.unwrap();
    });
}
