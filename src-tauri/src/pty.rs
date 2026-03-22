/// PTY (pseudo-terminal) operations for spawning shells.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex, OnceLock};

/// Shell integration scripts registered by extensions (shell basename → init script).
/// When set, these are injected into the PTY on spawn.
static SHELL_INTEGRATIONS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn shell_integrations_map() -> &'static Mutex<HashMap<String, String>> {
    SHELL_INTEGRATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Called by the frontend to register shell integration scripts from extensions.
pub fn set_shell_integrations(integrations: HashMap<String, String>) {
    let mut lock = shell_integrations_map().lock().unwrap_or_else(|e| e.into_inner());
    *lock = integrations;
}

pub struct PtyHandle {
    pub master: Box<dyn MasterPty + Send>,
    pub reader: Arc<Mutex<Box<dyn Read + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Box<dyn Child + Send>,
    pub shell: String,
    pub cwd: String,
}

fn portable_pty_error(err: impl std::fmt::Display) -> io::Error {
    io::Error::other(err.to_string())
}

/// Returns the init script for the given shell, if one has been registered by an extension.
///
/// The frontend may register scripts keyed by **full executable path** (e.g. `/bin/zsh`) or by
/// basename (`zsh`). Lookup tries basename first (matches `spawn`'s shell path), then the full path.
fn shell_init(shell: &str) -> Option<String> {
    let shell_name = std::path::Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    // Strip .exe suffix on Windows so "cmd.exe" → "cmd", "pwsh.exe" → "pwsh"
    let shell_name = shell_name.strip_suffix(".exe").unwrap_or(shell_name);
    let lock = shell_integrations_map().lock().unwrap_or_else(|e| e.into_inner());
    lock
        .get(shell_name)
        .or_else(|| lock.get(shell))
        .cloned()
}

pub fn spawn(
    cwd: &str,
    shell: &str,
    cols: u16,
    rows: u16,
    extra_args: &[String],
) -> io::Result<PtyHandle> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(portable_pty_error)?;

    crate::write_debug_log(&format!(
        "pty spawn shell={} cwd={} extra_args={}",
        shell,
        cwd,
        extra_args.len()
    ));

    let mut cmd = CommandBuilder::new(shell);
    cmd.cwd(cwd);

    #[cfg(windows)]
    {
        let shell_name = std::path::Path::new(shell)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_lowercase();
        for a in extra_args {
            cmd.arg(a);
        }
    }

    #[cfg(not(windows))]
    {
        cmd.env("TERM", "xterm-256color");
        cmd.env("HISTCONTROL", "ignoreboth");
        let lang = std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".to_string());
        cmd.env("LANG", &lang);
        cmd.env("LC_CTYPE", "UTF-8");
        for a in extra_args {
            cmd.arg(a);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(portable_pty_error)?;

    let reader = pair.master.try_clone_reader().map_err(portable_pty_error)?;
    let writer = pair.master.take_writer().map_err(portable_pty_error)?;

    let handle = PtyHandle {
        master: pair.master,
        reader: Arc::new(Mutex::new(reader)),
        writer: Arc::new(Mutex::new(writer)),
        child,
        shell: shell.to_string(),
        cwd: cwd.to_string(),
    };

    if let Some(init) = shell_init(shell) {
        let _ = write_all(&handle.writer, init.as_bytes());
        // Multiline init must not be sent to an interactive shell: each line is a separate
        // command (zsh shows function>, pwsh breaks mid-statement). Newlines → spaces only;
        // do not re-tokenize (would break quoted strings in contributions).
        // let t: String = init
        //     .chars()
        //     .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
        //     .collect();
        // let line = if cfg!(windows) {
        //     format!("{}\r\n", t.trim())
        // } else {
        //     format!("{}\n", t.trim())
        // };
        // let _ = write_all(&handle.writer, line.as_bytes());
    }

    Ok(handle)
}

pub fn write_all(writer: &Arc<Mutex<Box<dyn Write + Send>>>, data: &[u8]) -> io::Result<()> {
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::other("pty writer lock poisoned"))?;
    writer.write_all(data)?;
    writer.flush()
}

pub fn resize(master: &dyn MasterPty, cols: u16, rows: u16) -> io::Result<()> {
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(portable_pty_error)
}

/// Blocking read from PTY master. Returns 0 on EOF (child exited).
pub fn read_blocking(
    reader: &Arc<Mutex<Box<dyn Read + Send>>>,
    buf: &mut [u8],
) -> io::Result<usize> {
    let mut reader = reader
        .lock()
        .map_err(|_| io::Error::other("pty reader lock poisoned"))?;
    reader.read(buf)
}

pub fn close(handle: &mut PtyHandle) {
    let _ = handle.child.kill();
    let _ = handle.child.wait();
}
