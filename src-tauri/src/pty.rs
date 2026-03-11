/// PTY (pseudo-terminal) operations for spawning shells.

#[cfg(unix)]
use std::io;
#[cfg(unix)]
use std::os::unix::io::RawFd;

#[cfg(unix)]
pub struct PtyHandle {
    pub master_fd: RawFd,
    pub child: std::process::Child,
}

#[cfg(unix)]
pub fn spawn(cwd: &str, cols: u16, rows: u16) -> io::Result<PtyHandle> {
    use std::ffi::{CStr, CString};
    use std::os::unix::io::FromRawFd;
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());

    // Create PTY master
    let master = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY) };
    if master < 0 {
        return Err(io::Error::last_os_error());
    }

    if unsafe { libc::grantpt(master) } != 0 {
        unsafe { libc::close(master); }
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::unlockpt(master) } != 0 {
        unsafe { libc::close(master); }
        return Err(io::Error::last_os_error());
    }

    let slave_path = unsafe {
        let ptr = libc::ptsname(master);
        if ptr.is_null() {
            libc::close(master);
            return Err(io::Error::last_os_error());
        }
        CStr::from_ptr(ptr).to_string_lossy().into_owned()
    };

    // Set initial window size
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    unsafe {
        libc::ioctl(master, libc::TIOCSWINSZ as _, &ws);
    }

    // Open slave fd + dup for stdout/stderr
    let slave_c = CString::new(slave_path)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid slave path"))?;
    let slave_fd = unsafe { libc::open(slave_c.as_ptr(), libc::O_RDWR) };
    if slave_fd < 0 {
        unsafe { libc::close(master); }
        return Err(io::Error::last_os_error());
    }
    let slave_out = unsafe { libc::dup(slave_fd) };
    let slave_err = unsafe { libc::dup(slave_fd) };

    let child = unsafe {
        Command::new(&shell)
            .current_dir(cwd)
            .env("TERM", "xterm-256color")
            .env("HISTCONTROL", "ignoreboth")
            .stdin(Stdio::from_raw_fd(slave_fd))
            .stdout(Stdio::from_raw_fd(slave_out))
            .stderr(Stdio::from_raw_fd(slave_err))
            .pre_exec(|| {
                libc::setsid();
                libc::ioctl(0, libc::TIOCSCTTY as _, 0 as libc::c_int);
                Ok(())
            })
            .spawn()?
    };

    // Write shell init: set up OSC 7 cwd reporting + history-ignore-space
    let shell_basename = std::path::Path::new(&shell)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let init = match shell_basename.as_str() {
        "bash" => Some(
            r#" __frd(){ printf '\e]7;file://localhost%s\e\\' "$PWD";}; PROMPT_COMMAND="__frd;${PROMPT_COMMAND}"; clear"#,
        ),
        "zsh" => Some(
            r#" setopt HIST_IGNORE_SPACE; __frd(){ printf '\e]7;file://localhost%s\e\\' "$PWD";}; precmd_functions+=(__frd); clear"#,
        ),
        _ => None,
    };
    if let Some(cmd) = init {
        let line = format!("{}\n", cmd);
        let _ = write_all(master, line.as_bytes());
    }

    Ok(PtyHandle { master_fd: master, child })
}

#[cfg(unix)]
pub fn write_all(master_fd: RawFd, data: &[u8]) -> io::Result<()> {
    let mut offset = 0;
    while offset < data.len() {
        let n = unsafe {
            libc::write(
                master_fd,
                data[offset..].as_ptr() as *const libc::c_void,
                data.len() - offset,
            )
        };
        if n < 0 {
            return Err(io::Error::last_os_error());
        }
        offset += n as usize;
    }
    Ok(())
}

#[cfg(unix)]
pub fn resize(master_fd: RawFd, cols: u16, rows: u16) -> io::Result<()> {
    let ws = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe { libc::ioctl(master_fd, libc::TIOCSWINSZ as _, &ws) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Blocking read from PTY master. Returns 0 on EOF (child exited).
#[cfg(unix)]
pub fn read_blocking(master_fd: RawFd, buf: &mut [u8]) -> io::Result<usize> {
    let n = unsafe { libc::read(master_fd, buf.as_mut_ptr() as *mut libc::c_void, buf.len()) };
    if n < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(n as usize)
}

/// Close master fd and kill child.
#[cfg(unix)]
pub fn close(handle: &mut PtyHandle) {
    let _ = handle.child.kill();
    let _ = handle.child.wait();
    unsafe { libc::close(handle.master_fd); }
}

// ── Windows stub ────────────────────────────────────────────────────

#[cfg(not(unix))]
pub struct PtyHandle {
    _private: (),
}

#[cfg(not(unix))]
pub fn spawn(_cwd: &str, _cols: u16, _rows: u16) -> std::io::Result<PtyHandle> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "PTY not supported on this platform",
    ))
}

#[cfg(not(unix))]
pub fn write_all(_master_fd: i32, _data: &[u8]) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "PTY not supported"))
}

#[cfg(not(unix))]
pub fn resize(_master_fd: i32, _cols: u16, _rows: u16) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "PTY not supported"))
}

#[cfg(not(unix))]
pub fn read_blocking(_master_fd: i32, _buf: &mut [u8]) -> std::io::Result<usize> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "PTY not supported"))
}

#[cfg(not(unix))]
pub fn close(_handle: &mut PtyHandle) {}
