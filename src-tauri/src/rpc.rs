/// `faraday rpc` — elevated filesystem helper.
///
/// Speaks a length-prefixed binary protocol over a Unix domain socket (macOS/Linux)
/// or a named pipe (Windows). Used internally when the main app needs elevated
/// filesystem access.

#[cfg(unix)]
use faraday_core::error::FsError;
#[cfg(unix)]
use faraday_core::ops::{self, FdTable};
#[cfg(unix)]
use faraday_core::proto::{self, EventType, Method, MsgReader, MsgType, Reader, Writer};
#[cfg(unix)]
use faraday_core::watch::{EventKind, FsWatcher};
#[cfg(unix)]
use std::io::{Read, Write as IoWrite};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
#[cfg(unix)]
use std::sync::Arc;

// ── Argument parsing ─────────────────────────────────────────────────

#[cfg(unix)]
struct Args {
    socket_path: String,
    token: String,
}

#[cfg(unix)]
fn parse_args(args: &[String]) -> Result<Args, String> {
    let mut socket_path = None;
    let mut token = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--socket" => {
                i += 1;
                socket_path = args.get(i).cloned();
            }
            "--token" => {
                i += 1;
                token = args.get(i).cloned();
            }
            _ => {}
        }
        i += 1;
    }
    Ok(Args {
        socket_path: socket_path.ok_or("missing --socket")?,
        token: token.ok_or("missing --token")?,
    })
}

// ── Protocol helpers ─────────────────────────────────────────────────

#[cfg(unix)]
fn send_auth(stream: &mut impl IoWrite, token: &str) -> std::io::Result<()> {
    let mut w = Writer::new();
    w.u8(MsgType::Auth as u8).raw(token.as_bytes());
    proto::write_msg(stream, w.as_slice())
}

#[cfg(unix)]
fn send_response(stream: &mut impl IoWrite, id: u32, payload: &[u8]) -> std::io::Result<()> {
    let mut w = Writer::new();
    w.u8(MsgType::Response as u8).u32(id).raw(payload);
    proto::write_msg(stream, w.as_slice())
}

#[cfg(unix)]
fn send_error(
    stream: &mut impl IoWrite,
    id: u32,
    code: &str,
    message: &str,
) -> std::io::Result<()> {
    let mut w = Writer::new();
    w.u8(MsgType::Error as u8).u32(id).str(code).str(message);
    proto::write_msg(stream, w.as_slice())
}

#[cfg(unix)]
fn send_event(
    stream: &mut impl IoWrite,
    watch_id: &str,
    kind: EventType,
    name: Option<&str>,
) -> std::io::Result<()> {
    let mut w = Writer::new();
    w.u8(MsgType::Event as u8).str(watch_id).u8(kind as u8);
    if let Some(n) = name {
        w.u8(1).str(n);
    } else {
        w.u8(0);
    }
    proto::write_msg(stream, w.as_slice())
}

// ── Request dispatch ─────────────────────────────────────────────────

#[cfg(unix)]
fn dispatch(
    method: Method,
    reader: &mut Reader<'_>,
    out: &mut Writer,
    watcher: &FsWatcher,
    fdt: &FdTable,
) -> Result<(), FsError> {
    match method {
        Method::Ping => {}
        Method::Entries => {
            let path = reader.str().map_err(|_| FsError::InvalidInput)?;
            let list = ops::entries(path)?;
            out.u32(list.len() as u32);
            for item in &list {
                out.str(&item.name)
                    .u8(item.kind as u8)
                    .f64(item.size)
                    .f64(item.mtime_ms)
                    .u32(item.mode)
                    .u32(item.nlink)
                    .u8(if item.hidden { 1 } else { 0 });
                if let Some(ref t) = item.link_target {
                    out.u8(1).str(t);
                } else {
                    out.u8(0);
                }
            }
        }
        Method::Stat => {
            let path = reader.str().map_err(|_| FsError::InvalidInput)?;
            let result = ops::stat(path)?;
            out.f64(result.size).f64(result.mtime_ms);
        }
        Method::Exists => {
            let path = reader.str().map_err(|_| FsError::InvalidInput)?;
            out.u8(if ops::exists(path) { 1 } else { 0 });
        }
        Method::Open => {
            let path = reader.str().map_err(|_| FsError::InvalidInput)?;
            let handle = ops::open(path, fdt)?;
            out.f64(handle as f64);
        }
        Method::Read => {
            let fd = reader.f64().map_err(|_| FsError::InvalidInput)? as i32;
            let offset = reader.f64().map_err(|_| FsError::InvalidInput)? as u64;
            let length = reader.f64().map_err(|_| FsError::InvalidInput)? as usize;
            let data = ops::pread(fd, offset, length, fdt)?;
            out.bytes(&data);
        }
        Method::Close => {
            let fd = reader.f64().map_err(|_| FsError::InvalidInput)? as i32;
            ops::close(fd, fdt);
        }
        Method::Watch => {
            let wid = reader.str().map_err(|_| FsError::InvalidInput)?;
            let path = reader.str().map_err(|_| FsError::InvalidInput)?;
            out.u8(if watcher.add(wid, path) { 1 } else { 0 });
        }
        Method::Unwatch => {
            let wid = reader.str().map_err(|_| FsError::InvalidInput)?;
            watcher.remove(wid);
        }
    }
    Ok(())
}

#[cfg(unix)]
fn handle_request(
    payload: &[u8],
    stream: &mut UnixStream,
    watcher: &FsWatcher,
    fdt: &FdTable,
) {
    let mut reader = Reader::new(payload);
    let id = match reader.u32() {
        Ok(id) => id,
        Err(_) => return,
    };
    let method_byte = match reader.u8() {
        Ok(b) => b,
        Err(_) => return,
    };
    let method = match Method::try_from(method_byte) {
        Ok(m) => m,
        Err(_) => {
            let _ = send_error(stream, id, "EINVAL", "unknown method");
            return;
        }
    };

    let mut out = Writer::new();
    match dispatch(method, &mut reader, &mut out, watcher, fdt) {
        Ok(()) => {
            let _ = send_response(stream, id, out.as_slice());
        }
        Err(e) => {
            let _ = send_error(stream, id, e.errno_str(), &e.to_string());
        }
    }
}

// ── Entry point ─────────────────────────────────────────────────────

/// Run the elevated RPC helper.
/// `args` are the arguments after the `rpc` subcommand.
#[cfg(unix)]
pub fn run(args: &[String]) {
    let parsed = match parse_args(args) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("Usage: faraday rpc --socket <path> --token <hex>\n{e}");
            std::process::exit(1);
        }
    };

    // Parent death detection (Linux)
    #[cfg(target_os = "linux")]
    unsafe {
        libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGHUP);
        if libc::getppid() == 1 {
            std::process::exit(1);
        }
    }

    // Signal handling (Unix) — SIGHUP/SIGTERM cause EINTR in poll/read
    unsafe {
        libc::signal(libc::SIGHUP, libc::SIG_DFL);
        libc::signal(libc::SIGTERM, libc::SIG_DFL);
    }

    let mut sock = match UnixStream::connect(&parsed.socket_path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("connect failed: {e}");
            std::process::exit(1);
        }
    };

    if let Err(e) = send_auth(&mut sock, &parsed.token) {
        eprintln!("auth failed: {e}");
        std::process::exit(1);
    }

    let fdt = FdTable::new();

    // Set up watch event callback that sends events over the socket.
    let event_sock = sock.try_clone().expect("failed to clone socket");
    let event_sock = Arc::new(std::sync::Mutex::new(event_sock));

    let watcher = FsWatcher::new(Arc::new(move |watch_id, kind, name| {
        let evt = match kind {
            EventKind::Appeared => EventType::Appeared,
            EventKind::Disappeared => EventType::Disappeared,
            EventKind::Modified => EventType::Modified,
            EventKind::Errored => EventType::Errored,
            EventKind::Unknown => EventType::Unknown,
        };
        let mut stream = event_sock.lock().unwrap();
        let _ = send_event(&mut *stream, watch_id, evt, name);
    }))
    .expect("failed to create watcher");

    let mut msg_reader = MsgReader::new();

    sock.set_read_timeout(Some(std::time::Duration::from_millis(200)))
        .ok();

    loop {
        let mut buf = [0u8; 4096];
        match sock.read(&mut buf) {
            Ok(0) => break, // EOF — parent closed socket
            Ok(n) => {
                msg_reader.feed(&buf[..n]);
                while let Some(msg) = msg_reader.next_msg() {
                    if !msg.is_empty() && msg[0] == MsgType::Request as u8 {
                        handle_request(&msg[1..], &mut sock, &watcher, &fdt);
                    }
                }
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::Interrupted =>
            {
                // Timeout or signal — just continue polling
            }
            Err(_) => break, // Real error — exit
        }
    }
}

#[cfg(not(unix))]
pub fn run(_args: &[String]) {
    eprintln!("faraday rpc: Windows named pipe support not yet implemented");
    std::process::exit(1);
}
