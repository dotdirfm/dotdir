/// `dotdir serve` — headless HTTP + WebSocket server.
///
/// Serves static web UI files and exposes filesystem operations via
/// JSON-RPC 2.0 over WebSocket. Uses dotdir-core for all FS ops.

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
use crate::extensions_install::ExtensionInstallRequest;
use crate::runtime_ops::{
    RuntimeState, cancel_copy_job, cancel_delete_job, cancel_extension_install_job,
    cancel_move_job, cancel_search_job, fsp_list_entries as backend_fsp_list_entries,
    fsp_load as backend_fsp_load, fsp_read_file_range as backend_fsp_read_file_range,
    fs_close as backend_fs_close, fs_entries as backend_fs_entries,
    fs_create_dir as backend_fs_create_dir, fs_exists as backend_fs_exists,
    fs_open as backend_fs_open, fs_read as backend_fs_read,
    fs_read_file as backend_fs_read_file, fs_stat as backend_fs_stat,
    fs_unwatch as backend_fs_unwatch, fs_watch as backend_fs_watch,
    fs_write_binary as backend_fs_write_binary, fs_write_text as backend_fs_write_text,
    get_app_dirs as backend_get_app_dirs, get_env as backend_get_env,
    get_home_path as backend_get_home_path, get_mounted_roots as backend_get_mounted_roots,
    move_to_trash as backend_move_to_trash, rename_item as backend_rename_item,
    pty_close as backend_pty_close, pty_resize as backend_pty_resize,
    pty_spawn as backend_pty_spawn, pty_write as backend_pty_write,
    resolve_copy_conflict, resolve_move_conflict, start_copy_job, start_delete_job,
    start_extension_install_job, start_move_job, start_search_job,
};
use dotdir_core::{
    copy::{ConflictResolution, CopyOptions},
    move_op::MoveOptions,
    error::FsError,
    search::FileSearchRequest,
    watch::{EventCallback, FsWatcher},
};
use futures::{SinkExt, StreamExt};
use log::debug;
use rust_embed::RustEmbed;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::Arc,
};

use tokio::sync::mpsc;

use crate::FsEntry;

#[derive(RustEmbed)]
#[folder = "../dist"]
struct EmbeddedAssets;

struct Session {
    runtime: RuntimeState,
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
        runtime: RuntimeState::new(watcher),
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

    if method == "extensions.install.start" {
        let request: ExtensionInstallRequest =
            serde_json::from_value(params["request"].clone()).ok()?;
        let tx_install = tx.clone();
        let session_ref = session.clone();
        let install_id = start_extension_install_job(
            &session.runtime,
            request,
            move |event, install_id| {
                let payload = json!({
                    "jsonrpc": "2.0",
                    "method": "extensions.install.progress",
                    "params": { "installId": install_id, "event": event }
                });
                let _ = tx_install.send(Message::Text(payload.to_string()));
            },
            move |install_id| {
                session_ref
                    .runtime
                    .extension_install_jobs
                    .lock()
                    .unwrap()
                    .remove(&install_id);
            },
        );

        return Some(Message::Text(
            json!({ "jsonrpc": "2.0", "id": id, "result": install_id }).to_string(),
        ));
    }

    if method == "extensions.install.cancel" {
        let install_id = params["installId"].as_u64()? as u32;
        cancel_extension_install_job(&session.runtime, install_id);
        return Some(Message::Text(
            json!({ "jsonrpc": "2.0", "id": id, "result": Value::Null }).to_string(),
        ));
    }

    if method == "fs.read" {
        let fd = params["handle"].as_i64()? as i32;
        let offset = params["offset"].as_u64()?;
        let length = params["length"].as_u64()? as usize;
        let id_num = id.as_u64()? as u32;

        let session = session.clone();
        let data = tokio::task::spawn_blocking(move || {
            backend_fs_read(&session.runtime, fd, offset, length)
        })
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

    if method == "fs.readFile" {
        let path = params["path"].as_str()?.to_string();
        let id_num = id.as_u64()? as u32;
        let data = tokio::task::spawn_blocking(move || backend_fs_read_file(&path))
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

    // delete.start needs tx for progress streaming
    if method == "delete.start" {
        return Some(handle_delete_start(session, &id, &params, tx));
    }

    // search.start needs tx for progress streaming
    if method == "search.start" {
        return Some(handle_search_start(session, &id, &params, tx));
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
    let shell_path = match params["shellPath"].as_str() {
        Some(s) => s,
        None => return rpc_error(id, &FsError::InvalidInput),
    };

    let spawn_args: Vec<String> = params["spawnArgs"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let (result, reader) = match backend_pty_spawn(
        &session.runtime,
        cwd,
        shell_path,
        &spawn_args,
        cols,
        rows,
    ) {
        Ok(pair) => pair,
        Err(e) => return rpc_error(id, &e),
    };
    let pty_id = result.pty_id;

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

    let tx_copy = tx.clone();
    let session_ref = session.clone();
    let copy_id = start_copy_job(
        &session.runtime,
        sources,
        dest_dir,
        options,
        move |event, copy_id| {
            let payload = json!({
                "jsonrpc": "2.0",
                "method": "copy.progress",
                "params": { "copyId": copy_id, "event": event }
            });
            let _ = tx_copy.send(Message::Text(payload.to_string()));
        },
        move |copy_id| {
            session_ref.runtime.copy_jobs.lock().unwrap().remove(&copy_id);
        },
    );

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

    let tx_move = tx.clone();
    let session_ref = session.clone();
    let move_id = start_move_job(
        &session.runtime,
        sources,
        dest_dir,
        options,
        move |event, move_id| {
            let payload = json!({
                "jsonrpc": "2.0",
                "method": "move.progress",
                "params": { "moveId": move_id, "event": event }
            });
            let _ = tx_move.send(Message::Text(payload.to_string()));
        },
        move |move_id| {
            session_ref.runtime.move_jobs.lock().unwrap().remove(&move_id);
        },
    );

    Message::Text(json!({ "jsonrpc": "2.0", "id": id, "result": move_id }).to_string())
}

fn handle_delete_start(
    session: &Arc<Session>,
    id: &Value,
    params: &Value,
    tx: &mpsc::UnboundedSender<Message>,
) -> Message {
    let paths: Vec<String> = match serde_json::from_value(params["paths"].clone()) {
        Ok(v) => v,
        Err(_) => return rpc_error(id, &FsError::InvalidInput),
    };

    let tx_del = tx.clone();
    let session_ref = session.clone();
    let delete_id = start_delete_job(
        &session.runtime,
        paths,
        move |event, delete_id| {
            let payload = json!({
                "jsonrpc": "2.0",
                "method": "delete.progress",
                "params": { "deleteId": delete_id, "event": event }
            });
            let _ = tx_del.send(Message::Text(payload.to_string()));
        },
        move |delete_id| {
            session_ref.runtime.delete_jobs.lock().unwrap().remove(&delete_id);
        },
    );

    Message::Text(json!({ "jsonrpc": "2.0", "id": id, "result": delete_id }).to_string())
}

fn handle_search_start(
    session: &Arc<Session>,
    id: &Value,
    params: &Value,
    tx: &mpsc::UnboundedSender<Message>,
) -> Message {
    let request: FileSearchRequest = match serde_json::from_value(params["request"].clone()) {
        Ok(v) => v,
        Err(_) => return rpc_error(id, &FsError::InvalidInput),
    };

    let tx_search = tx.clone();
    let session_ref = session.clone();
    let search_id = start_search_job(
        &session.runtime,
        request,
        move |event, search_id| {
            let payload = json!({
                "jsonrpc": "2.0",
                "method": "search.progress",
                "params": { "searchId": search_id, "event": event }
            });
            let _ = tx_search.send(Message::Text(payload.to_string()));
        },
        move |search_id| {
            session_ref.runtime.search_jobs.lock().unwrap().remove(&search_id);
        },
    );

    Message::Text(json!({ "jsonrpc": "2.0", "id": id, "result": search_id }).to_string())
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
            let entries: Vec<FsEntry> = backend_fs_entries(path)?.into_iter().map(FsEntry::from).collect();
            debug!("[ws] fs.entries {:?} → {} entries", path, entries.len());
            Ok(serde_json::to_value(entries).unwrap())
        }
        "fs.stat" => {
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            let s = backend_fs_stat(path)?;
            Ok(json!({ "size": s.size, "mtimeMs": s.mtime_ms }))
        }
        "fs.exists" => {
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            Ok(json!(backend_fs_exists(path)))
        }
        "fs.writeFile" => {
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            let data = params["data"].as_str().ok_or(FsError::InvalidInput)?;
            backend_fs_write_text(path, data)?;
            Ok(Value::Null)
        }
        "fs.writeBinary" => {
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            let arr = params["data"].as_array().ok_or(FsError::InvalidInput)?;
            let bytes: Vec<u8> = arr.iter()
                .map(|v| v.as_u64().unwrap_or(0) as u8)
                .collect();
            backend_fs_write_binary(path, &bytes)?;
            Ok(Value::Null)
        }
        "fs.createDir" => {
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            backend_fs_create_dir(path)?;
            Ok(Value::Null)
        }
        "fs.open" => {
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            Ok(json!(backend_fs_open(&session.runtime, path)?))
        }
        "fs.close" => {
            let fd = params["handle"].as_i64().ok_or(FsError::InvalidInput)? as i32;
            backend_fs_close(&session.runtime, fd);
            Ok(Value::Null)
        }
        "fs.watch" => {
            let watch_id = params["watchId"].as_str().ok_or(FsError::InvalidInput)?;
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            debug!("[ws] fs.watch id={} path={:?}", watch_id, path);
            Ok(json!(backend_fs_watch(&session.runtime, watch_id, path)))
        }
        "fs.unwatch" => {
            let watch_id = params["watchId"].as_str().ok_or(FsError::InvalidInput)?;
            debug!("[ws] fs.unwatch id={}", watch_id);
            backend_fs_unwatch(&session.runtime, watch_id);
            Ok(Value::Null)
        }
        "pty.write" => {
            let pty_id = params["ptyId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            let data = params["data"].as_str().ok_or(FsError::InvalidInput)?;
            backend_pty_write(&session.runtime, pty_id, data.as_bytes())?;
            Ok(Value::Null)
        }
        "pty.resize" => {
            let pty_id = params["ptyId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            let cols = params["cols"].as_u64().ok_or(FsError::InvalidInput)? as u16;
            let rows = params["rows"].as_u64().ok_or(FsError::InvalidInput)? as u16;
            backend_pty_resize(&session.runtime, pty_id, cols, rows)?;
            Ok(Value::Null)
        }
        "pty.close" => {
            let pty_id = params["ptyId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            backend_pty_close(&session.runtime, pty_id);
            Ok(Value::Null)
        }
        "copy.cancel" => {
            let copy_id = params["copyId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            cancel_copy_job(&session.runtime, copy_id);
            Ok(Value::Null)
        }
        "copy.resolveConflict" => {
            let copy_id = params["copyId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            let resolution: ConflictResolution =
                serde_json::from_value(params["resolution"].clone())
                    .map_err(|_| FsError::InvalidInput)?;
            resolve_copy_conflict(&session.runtime, copy_id, resolution);
            Ok(Value::Null)
        }
        "move.cancel" => {
            let move_id = params["moveId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            cancel_move_job(&session.runtime, move_id);
            Ok(Value::Null)
        }
        "move.resolveConflict" => {
            let move_id = params["moveId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            let resolution: ConflictResolution =
                serde_json::from_value(params["resolution"].clone())
                    .map_err(|_| FsError::InvalidInput)?;
            resolve_move_conflict(&session.runtime, move_id, resolution);
            Ok(Value::Null)
        }
        "fs.rename" => {
            let source = params["source"].as_str().ok_or(FsError::InvalidInput)?;
            let new_name = params["newName"].as_str().ok_or(FsError::InvalidInput)?;
            backend_rename_item(source, new_name)?;
            Ok(Value::Null)
        }
        "fs.moveToTrash" => {
            let paths = params["paths"].as_array().ok_or(FsError::InvalidInput)?;
            let paths: Vec<String> = paths
                .iter()
                .map(|v| v.as_str().map(str::to_owned).ok_or(FsError::InvalidInput))
                .collect::<Result<Vec<_>, _>>()?;
            backend_move_to_trash(&paths)?;
            Ok(Value::Null)
        }
        "delete.cancel" => {
            let delete_id = params["deleteId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            cancel_delete_job(&session.runtime, delete_id);
            Ok(Value::Null)
        }
        "search.cancel" => {
            let search_id = params["searchId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            cancel_search_job(&session.runtime, search_id);
            Ok(Value::Null)
        }
        "fsp.load" => {
            let wasm_path = params["wasmPath"].as_str().ok_or(FsError::InvalidInput)?;
            backend_fsp_load(&session.runtime, wasm_path)
                .map_err(|e| FsError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
            Ok(Value::Null)
        }
        "fsp.listEntries" => {
            let wasm_path = params["wasmPath"].as_str().ok_or(FsError::InvalidInput)?;
            let container_path = params["containerPath"].as_str().ok_or(FsError::InvalidInput)?;
            let inner_path = params["innerPath"].as_str().ok_or(FsError::InvalidInput)?;
            let entries = backend_fsp_list_entries(&session.runtime, wasm_path, container_path, inner_path)
                .map_err(|e| FsError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
            Ok(serde_json::to_value(entries).unwrap())
        }
        "fsp.readFileRange" => {
            let wasm_path = params["wasmPath"].as_str().ok_or(FsError::InvalidInput)?;
            let container_path = params["containerPath"].as_str().ok_or(FsError::InvalidInput)?;
            let inner_path = params["innerPath"].as_str().ok_or(FsError::InvalidInput)?;
            let offset = params["offset"].as_u64().ok_or(FsError::InvalidInput)?;
            let length = params["length"].as_u64().ok_or(FsError::InvalidInput)? as usize;
            let bytes = backend_fsp_read_file_range(
                &session.runtime,
                wasm_path,
                container_path,
                inner_path,
                offset,
                length,
            )
                .map_err(|e| FsError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
            Ok(serde_json::to_value(bytes).unwrap())
        }
        "ping" => Ok(Value::Null),
        "utils.getHomePath" => Ok(json!(backend_get_home_path())),
        "utils.getMountedRoots" => Ok(serde_json::to_value(backend_get_mounted_roots()).unwrap()),
        "utils.getAppDirs" => Ok(serde_json::to_value(backend_get_app_dirs()).unwrap()),
        "utils.getEnv" => Ok(serde_json::to_value(backend_get_env()).unwrap()),
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
fn vfs_path_to_os(path: &str) -> Option<PathBuf> {
    // We expose absolute paths through the VFS surface. The HTTP route is
    // `/vfs/<absolute path without leading slash>`.
    let decoded = decode_vfs_path(path)?;
    let trimmed = decoded.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from("/").join(trimmed))
}

#[cfg(windows)]
fn vfs_path_to_os(path: &str) -> Option<PathBuf> {
    // Windows uses `/vfs/C/Program Files/...` where the first segment is the drive.
    let decoded = decode_vfs_path(path)?;
    let trimmed = decoded.trim_start_matches('/');
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

        let bootstrap_js =
            include_str!("../../packages/ui/lib/features/extensions/iframeBootstrap.inline.js"); // postMessage RPC bootstrap
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
    let mut port: u16 = std::env::var("DOTDIR_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3001);
    let mut host = std::env::var("DOTDIR_HOST").unwrap_or_else(|_| "127.0.0.1".into());

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

        eprintln!(".dir server listening on http://{addr}");
        eprintln!("WebSocket endpoint: ws://{addr}/ws");

        axum::serve(listener, app).await.unwrap();
    });
}
