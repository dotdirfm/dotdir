/// `faraday serve` — headless HTTP + WebSocket server.
///
/// Serves static web UI files and exposes filesystem operations via
/// JSON-RPC 2.0 over WebSocket. Uses faraday-core for all FS ops.

use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use crate::pty;
use faraday_core::{
    error::FsError,
    ops::{self, FdTable},
    watch::{EventCallback, FsWatcher},
};
use futures::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
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

// ── Shared server config ────────────────────────────────────────────

#[derive(Clone)]
struct ServerState {
    icons_dir: Arc<Option<String>>,
}

// ── Per-connection session ──────────────────────────────────────────

struct Session {
    fdt: FdTable,
    watcher: FsWatcher,
    icons_dir: Option<String>,
    ptys: std::sync::Mutex<HashMap<u32, pty::PtyHandle>>,
    next_pty_id: std::sync::atomic::AtomicU32,
}

// ── WebSocket handler ───────────────────────────────────────────────

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<ServerState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: ServerState) {
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
        icons_dir: state.icons_dir.as_ref().clone(),
        ptys: std::sync::Mutex::new(HashMap::new()),
        next_pty_id: std::sync::atomic::AtomicU32::new(0),
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
    match method {
        "fs.entries" => {
            let path = params["path"].as_str().ok_or(FsError::InvalidInput)?;
            let entries: Vec<JsEntry> = ops::entries(path)?.into_iter().map(Into::into).collect();
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
            Ok(json!(session.watcher.add(watch_id, path)))
        }
        "fs.unwatch" => {
            let watch_id = params["watchId"].as_str().ok_or(FsError::InvalidInput)?;
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
        "ping" => Ok(Value::Null),
        "utils.getHomePath" => Ok(json!(
            dirs::home_dir()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default()
        )),
        "utils.getIconsPath" => Ok(json!(session.icons_dir.as_deref().unwrap_or(""))),
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

async fn disk_asset_handler(uri: Uri, dir: &str) -> Response {
    let path = uri.path().trim_start_matches('/');
    let file_path = PathBuf::from(dir).join(if path.is_empty() { "index.html" } else { path });

    match tokio::fs::read(&file_path).await {
        Ok(bytes) => {
            let mime = mime_guess::from_path(&file_path)
                .first_or_octet_stream()
                .to_string();
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .body(Body::from(bytes))
                .unwrap()
        }
        Err(_) => {
            // SPA fallback
            let index = PathBuf::from(dir).join("index.html");
            match tokio::fs::read(&index).await {
                Ok(bytes) => Response::builder()
                    .status(StatusCode::OK)
                    .header(header::CONTENT_TYPE, "text/html")
                    .body(Body::from(bytes))
                    .unwrap(),
                Err(_) => Response::builder()
                    .status(StatusCode::NOT_FOUND)
                    .body(Body::empty())
                    .unwrap(),
            }
        }
    }
}

// ── Config parsing ──────────────────────────────────────────────────

struct Config {
    port: u16,
    host: String,
    static_dir: Option<String>,
    icons_dir: Option<String>,
}

fn parse_config(args: &[String]) -> Config {
    let mut port: u16 = std::env::var("FARADAY_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(3001);
    let mut host = std::env::var("FARADAY_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let mut static_dir: Option<String> = None;
    let mut icons_dir: Option<String> = None;

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
            "--static-dir" if i + 1 < args.len() => {
                static_dir = Some(args[i + 1].clone());
                i += 2;
            }
            "--icons-dir" if i + 1 < args.len() => {
                icons_dir = std::fs::canonicalize(&args[i + 1])
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned())
                    .or_else(|| Some(args[i + 1].clone()));
                i += 2;
            }
            _ => i += 1,
        }
    }

    Config {
        port,
        host,
        static_dir,
        icons_dir,
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
        let state = ServerState {
            icons_dir: Arc::new(config.icons_dir),
        };

        let app = Router::new()
            .route("/ws", get(ws_handler))
            .with_state(state);

        let app = if let Some(dir) = config.static_dir {
            eprintln!("Serving web UI from {dir} (disk)");
            app.fallback(move |uri: Uri| {
                let dir = dir.clone();
                async move { disk_asset_handler(uri, &dir).await }
            })
        } else {
            eprintln!("Serving web UI from embedded assets");
            app.fallback(embedded_asset_handler)
        };

        let addr = format!("{}:{}", config.host, config.port);
        eprintln!("Faraday server listening on http://{addr}");
        eprintln!("WebSocket endpoint: ws://{addr}/ws");

        let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
        axum::serve(listener, app).await.unwrap();
    });
}
