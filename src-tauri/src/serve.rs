/// `faraday serve` — headless HTTP + WebSocket server.
///
/// Serves static web UI files and exposes filesystem operations via
/// JSON-RPC 2.0 over WebSocket. Uses faraday-core for all FS ops.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
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
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::sync::mpsc;
use tower_http::services::{ServeDir, ServeFile};

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
                let mut frame = Vec::with_capacity(4 + bytes.len());
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

    let handle = match pty::spawn(cwd, 80, 24) {
        Ok(h) => h,
        Err(e) => return rpc_error(id, &FsError::Io(e)),
    };

    let pty_id = session
        .next_pty_id
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    #[cfg(unix)]
    let master_fd = handle.master_fd;

    session.ptys.lock().unwrap().insert(pty_id, handle);

    // Start reader thread that sends pty.data notifications
    #[cfg(unix)]
    {
        let tx_pty = tx.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match pty::read_blocking(master_fd, &mut buf) {
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
                        let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                        let msg = json!({
                            "jsonrpc": "2.0",
                            "method": "pty.data",
                            "params": { "ptyId": pty_id, "data": data }
                        });
                        if tx_pty.send(Message::Text(msg.to_string())).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }

    Message::Text(
        json!({ "jsonrpc": "2.0", "id": id, "result": pty_id }).to_string(),
    )
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
            #[cfg(unix)]
            pty::write_all(handle.master_fd, data.as_bytes()).map_err(FsError::Io)?;
            Ok(Value::Null)
        }
        "pty.resize" => {
            let pty_id = params["ptyId"].as_u64().ok_or(FsError::InvalidInput)? as u32;
            let cols = params["cols"].as_u64().ok_or(FsError::InvalidInput)? as u16;
            let rows = params["rows"].as_u64().ok_or(FsError::InvalidInput)? as u16;
            let ptys = session.ptys.lock().unwrap();
            let handle = ptys.get(&pty_id).ok_or(FsError::BadFd)?;
            #[cfg(unix)]
            pty::resize(handle.master_fd, cols, rows).map_err(FsError::Io)?;
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
        _ => Err(FsError::InvalidInput),
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

    if static_dir.is_none() {
        for c in ["dist-web", "../dist-web"] {
            if PathBuf::from(c).join("index.html").exists() {
                static_dir = Some(c.into());
                break;
            }
        }
    }

    if icons_dir.is_none() {
        for c in ["src-tauri/icons-bundle", "icons-bundle", "icons"] {
            if PathBuf::from(c).exists() {
                if let Ok(p) = std::fs::canonicalize(c) {
                    icons_dir = Some(p.to_string_lossy().into_owned());
                }
                break;
            }
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
    let config = parse_config(args);
    let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
    rt.block_on(async {
        let state = ServerState {
            icons_dir: Arc::new(config.icons_dir),
        };

        let app = Router::new()
            .route("/ws", get(ws_handler))
            .with_state(state);

        let app = if let Some(ref dir) = config.static_dir {
            let index = PathBuf::from(dir).join("index.html");
            if index.exists() {
                eprintln!("Serving web UI from {dir}");
                app.fallback_service(
                    ServeDir::new(dir).not_found_service(ServeFile::new(index)),
                )
            } else {
                app
            }
        } else {
            app
        };

        let addr = format!("{}:{}", config.host, config.port);
        eprintln!("Faraday server listening on http://{addr}");
        eprintln!("WebSocket endpoint: ws://{addr}/ws");

        let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
        axum::serve(listener, app).await.unwrap();
    });
}
