/// Elevation proxy — spawns frdye with admin privileges and communicates
/// over a Unix domain socket using the binary protocol.
use faraday_core::error::FsError;
use faraday_core::ops::EntryInfo;
use faraday_core::proto::{Method, MsgReader, MsgType, Reader, Writer};
use std::collections::HashMap;
use std::io::{Read, Write as IoWrite};
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub type WatchCallback = Arc<dyn Fn(&str, &str, Option<&str>) + Send + Sync>;

fn io_err(msg: impl Into<String>) -> FsError {
    FsError::Io(std::io::Error::new(std::io::ErrorKind::Other, msg.into()))
}

struct Pending {
    tx: std::sync::mpsc::Sender<Result<Vec<u8>, (String, String)>>,
}

pub struct FsProxy {
    stream: Mutex<UnixStream>,
    pending: Arc<Mutex<HashMap<u32, Pending>>>,
    next_id: AtomicU32,
    _child: Option<Child>,
    _reader_thread: Option<std::thread::JoinHandle<()>>,
}

impl FsProxy {
    fn send_request(&self, method: Method, args: &[u8]) -> Result<Vec<u8>, FsError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = std::sync::mpsc::channel();
        self.pending.lock().unwrap().insert(id, Pending { tx });

        let mut w = Writer::new();
        w.u8(MsgType::Request as u8).u32(id).u8(method as u8).raw(args);
        let framed = w.into_framed();

        {
            let mut stream = self.stream.lock().unwrap();
            stream.write_all(&framed).map_err(|e| io_err(format!("proxy write: {e}")))?;
        }

        match rx.recv_timeout(Duration::from_secs(30)) {
            Ok(Ok(payload)) => Ok(payload),
            Ok(Err((code, msg))) => Err(FsError::from_errno_str(&code, &msg)),
            Err(_) => Err(io_err("proxy request timeout")),
        }
    }

    pub fn entries(&self, dir_path: &str) -> Result<Vec<EntryInfo>, FsError> {
        let mut w = Writer::new();
        w.str(dir_path);
        let payload = self.send_request(Method::Entries, w.as_slice())?;
        let mut r = Reader::new(&payload);
        let count = r.u32().map_err(|_| FsError::InvalidInput)? as usize;

        use faraday_core::ops::EntryKind;
        let mut entries = Vec::with_capacity(count);
        for _ in 0..count {
            let name = r.str().map_err(|_| FsError::InvalidInput)?.to_string();
            let kind_byte = r.u8().map_err(|_| FsError::InvalidInput)?;
            let kind = EntryKind::try_from(kind_byte).unwrap_or(EntryKind::Unknown);
            let size = r.f64().map_err(|_| FsError::InvalidInput)?;
            let mtime_ms = r.f64().map_err(|_| FsError::InvalidInput)?;
            let mode = r.u32().map_err(|_| FsError::InvalidInput)?;
            let nlink = r.u32().map_err(|_| FsError::InvalidInput)?;
            let hidden = r.u8().map_err(|_| FsError::InvalidInput)? != 0;
            let has_link = r.u8().map_err(|_| FsError::InvalidInput)? != 0;
            let link_target = if has_link {
                Some(r.str().map_err(|_| FsError::InvalidInput)?.to_string())
            } else {
                None
            };
            entries.push(EntryInfo {
                name,
                kind,
                size,
                mtime_ms,
                mode,
                nlink,
                hidden,
                link_target,
            });
        }
        Ok(entries)
    }

    pub fn stat(&self, file_path: &str) -> Result<faraday_core::ops::StatResult, FsError> {
        let mut w = Writer::new();
        w.str(file_path);
        let payload = self.send_request(Method::Stat, w.as_slice())?;
        let mut r = Reader::new(&payload);
        Ok(faraday_core::ops::StatResult {
            size: r.f64().map_err(|_| FsError::InvalidInput)?,
            mtime_ms: r.f64().map_err(|_| FsError::InvalidInput)?,
        })
    }

    pub fn exists(&self, file_path: &str) -> bool {
        let mut w = Writer::new();
        w.str(file_path);
        match self.send_request(Method::Exists, w.as_slice()) {
            Ok(payload) => {
                let mut r = Reader::new(&payload);
                r.u8().map(|v| v != 0).unwrap_or(false)
            }
            Err(_) => false,
        }
    }

    pub fn open(&self, file_path: &str) -> Result<i32, FsError> {
        let mut w = Writer::new();
        w.str(file_path);
        let payload = self.send_request(Method::Open, w.as_slice())?;
        let mut r = Reader::new(&payload);
        let fd = r.f64().map_err(|_| FsError::InvalidInput)? as i32;
        Ok(-fd) // negate to mark as proxy fd
    }

    pub fn pread(&self, fd: i32, offset: u64, length: usize) -> Result<Vec<u8>, FsError> {
        let remote_fd = -fd; // un-negate
        let mut w = Writer::new();
        w.f64(remote_fd as f64).f64(offset as f64).f64(length as f64);
        let payload = self.send_request(Method::Read, w.as_slice())?;
        let mut r = Reader::new(&payload);
        Ok(r.bytes().map_err(|_| FsError::InvalidInput)?.to_vec())
    }

    pub fn close(&self, fd: i32) {
        let remote_fd = -fd;
        let mut w = Writer::new();
        w.f64(remote_fd as f64);
        let _ = self.send_request(Method::Close, w.as_slice());
    }

    pub fn watch(&self, watch_id: &str, dir_path: &str) -> bool {
        let mut w = Writer::new();
        w.str(watch_id).str(dir_path);
        match self.send_request(Method::Watch, w.as_slice()) {
            Ok(payload) => {
                let mut r = Reader::new(&payload);
                r.u8().map(|v| v != 0).unwrap_or(false)
            }
            Err(_) => false,
        }
    }

    pub fn unwatch(&self, watch_id: &str) {
        let mut w = Writer::new();
        w.str(watch_id);
        let _ = self.send_request(Method::Unwatch, w.as_slice());
    }

    pub fn is_alive(&self) -> bool {
        // Check if the pending map still has capacity to process
        // (reader thread clears pending on disconnect)
        self.pending.lock().map(|_| true).unwrap_or(false)
    }
}

impl Drop for FsProxy {
    fn drop(&mut self) {
        if let Ok(stream) = self.stream.lock() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }
}

fn socket_path() -> String {
    let pid = std::process::id();
    let tmp = std::env::temp_dir();
    tmp.join(format!("faraday-fs-{pid}.sock"))
        .to_string_lossy()
        .into_owned()
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The helper is ourselves — `faraday rpc`.
fn helper_path() -> String {
    std::env::current_exe()
        .expect("cannot determine current exe path")
        .to_string_lossy()
        .into_owned()
}

pub fn launch_elevated(watch_callback: WatchCallback) -> Result<Arc<FsProxy>, FsError> {
    let token = random_token();
    let sock_path = socket_path();
    let helper = helper_path();

    // Clean up any leftover socket
    let _ = std::fs::remove_file(&sock_path);

    let listener = UnixListener::bind(&sock_path)
        .map_err(|e| io_err(format!("bind socket: {e}")))?;

    // chmod 600
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o600));
    }

    // Spawn elevated helper (ourselves with "rpc" subcommand)
    let args = vec![
        "rpc".to_string(),
        "--socket".to_string(),
        sock_path.clone(),
        "--token".to_string(),
        token.clone(),
        "--ppid".to_string(),
        std::process::id().to_string(),
    ];

    let child = spawn_elevated(&helper, &args)
        .map_err(|e| io_err(format!("spawn elevated: {e}")))?;

    // Wait for connection with timeout
    listener.set_nonblocking(false)
        .map_err(|e| io_err(format!("set_nonblocking: {e}")))?;

    let (conn_tx, conn_rx) = std::sync::mpsc::channel();
    let _accept_thread = std::thread::spawn(move || {
        let result = listener.accept();
        let _ = conn_tx.send(result);
    });

    let (mut stream, _) = conn_rx
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| io_err("elevated helper did not connect within 30s"))?
        .map_err(|e| io_err(format!("accept: {e}")))?;

    // Read auth message
    stream.set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| io_err(format!("set timeout: {e}")))?;

    let mut msg_reader = MsgReader::new();
    loop {
        let n = msg_reader
            .fill(&mut stream)
            .map_err(|e| io_err(format!("read auth: {e}")))?;
        if n == 0 {
            return Err(io_err("elevated helper disconnected before auth"));
        }
        if let Some(msg) = msg_reader.next_msg() {
            if msg.is_empty() || msg[0] != MsgType::Auth as u8 {
                return Err(io_err("invalid auth message type"));
            }
            let received = std::str::from_utf8(&msg[1..])
                .map_err(|_| io_err("invalid auth token encoding"))?;
            if received != token {
                return Err(io_err("auth token mismatch"));
            }
            break;
        }
    }

    // Reset read timeout for normal operation
    stream.set_read_timeout(Some(Duration::from_millis(200))).ok();

    // Clone stream for reader thread
    let read_stream = stream.try_clone()
        .map_err(|e| io_err(format!("clone stream: {e}")))?;

    let pending: Arc<Mutex<HashMap<u32, Pending>>> = Arc::new(Mutex::new(HashMap::new()));
    let pending_clone = pending.clone();

    let leftover_reader = msg_reader;

    let reader_thread = std::thread::spawn(move || {
        reader_loop(read_stream, pending_clone, watch_callback, leftover_reader);
    });

    let proxy = Arc::new(FsProxy {
        stream: Mutex::new(stream),
        pending,
        next_id: AtomicU32::new(0),
        _child: Some(child),
        _reader_thread: Some(reader_thread),
    });

    // Clean up socket file
    let _ = std::fs::remove_file(&sock_path);

    Ok(proxy)
}

fn reader_loop(
    mut stream: UnixStream,
    pending: Arc<Mutex<HashMap<u32, Pending>>>,
    watch_callback: WatchCallback,
    mut msg_reader: MsgReader,
) {
    loop {
        let mut buf = [0u8; 4096];
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                msg_reader.feed(&buf[..n]);
                while let Some(msg) = msg_reader.next_msg() {
                    if msg.is_empty() {
                        continue;
                    }
                    let msg_type = msg[0];
                    let payload = &msg[1..];

                    if msg_type == MsgType::Response as u8 {
                        if payload.len() >= 4 {
                            let mut r = Reader::new(payload);
                            if let Ok(id) = r.u32() {
                                let data = r.remaining().to_vec();
                                if let Some(p) = pending.lock().unwrap().remove(&id) {
                                    let _ = p.tx.send(Ok(data));
                                }
                            }
                        }
                    } else if msg_type == MsgType::Error as u8 {
                        if payload.len() >= 4 {
                            let mut r = Reader::new(payload);
                            if let Ok(id) = r.u32() {
                                let code = r.str().unwrap_or("UNKNOWN").to_string();
                                let message = r.str().unwrap_or("unknown error").to_string();
                                if let Some(p) = pending.lock().unwrap().remove(&id) {
                                    let _ = p.tx.send(Err((code, message)));
                                }
                            }
                        }
                    } else if msg_type == MsgType::Event as u8 {
                        let mut r = Reader::new(payload);
                        if let (Ok(watch_id), Ok(type_code)) = (r.str(), r.u8()) {
                            let has_name = r.u8().unwrap_or(0);
                            let name = if has_name != 0 {
                                r.str().ok()
                            } else {
                                None
                            };
                            let evt_types = [
                                "appeared",
                                "disappeared",
                                "modified",
                                "errored",
                                "unknown",
                            ];
                            let kind = evt_types
                                .get(type_code as usize)
                                .unwrap_or(&"unknown");
                            watch_callback(watch_id, kind, name);
                        }
                    }
                }
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::Interrupted =>
            {
                continue;
            }
            Err(_) => break,
        }
    }

    // Reject all pending requests
    let mut map = pending.lock().unwrap();
    for (_, p) in map.drain() {
        let _ = p.tx.send(Err((
            "EIO".to_string(),
            "elevated helper disconnected".to_string(),
        )));
    }
}

fn spawn_elevated(helper: &str, args: &[String]) -> std::io::Result<Child> {
    #[cfg(target_os = "macos")]
    {
        let cmd_parts: Vec<String> = std::iter::once(helper.to_string())
            .chain(args.iter().cloned())
            .map(|s| shell_quote(&s))
            .collect();
        let cmd = cmd_parts.join(" ");
        let as_str = cmd.replace('\\', "\\\\").replace('"', "\\\"");
        Command::new("osascript")
            .args([
                "-e",
                &format!("do shell script \"{as_str}\" with administrator privileges"),
            ])
            .spawn()
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("pkexec")
            .arg(helper)
            .args(args)
            .spawn()
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (helper, args);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "elevation not supported on this platform",
        ))
    }
}

fn rand_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut buf);
    }
    buf
}

fn random_token() -> String {
    rand_bytes(32)
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}
