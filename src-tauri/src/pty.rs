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

// ── Windows ConPTY implementation ────────────────────────────────────

/// PowerShell one-liner sent to the newly spawned shell to install an OSC 7
/// `$function:prompt` hook.  The hook emits `ESC]7;file://localhost/{path}ESC\`
/// on every prompt so the file manager can track the current directory.
///
/// Rust escape note: `'\\\\'` in the Rust source becomes `'\\'` in the
/// string, which is the PowerShell regex pattern that matches one backslash.
#[cfg(windows)]
pub struct PtyHandle {
    pub con_pty: windows_sys::Win32::System::Console::HPCON,
    pub write_handle: windows_sys::Win32::Foundation::HANDLE,
    pub read_handle: windows_sys::Win32::Foundation::HANDLE,
    pub stderr_handle: windows_sys::Win32::Foundation::HANDLE,
    pub process_handle: windows_sys::Win32::Foundation::HANDLE,
    pub thread_handle: windows_sys::Win32::Foundation::HANDLE,
    pub child: std::process::Child,
}

// HANDLE is *mut c_void which is not Send by default; we manage handle
// lifetimes exclusively through the Mutex<HashMap<u32, PtyHandle>> in AppState.
#[cfg(windows)]
unsafe impl Send for PtyHandle {}

#[cfg(windows)]
pub fn spawn(cwd: &str, cols: u16, rows: u16) -> std::io::Result<PtyHandle> {
    use std::io;
    use std::os::windows::io::{AsRawHandle, IntoRawHandle};
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use windows_sys::Win32::Foundation::{HANDLE, INVALID_HANDLE_VALUE};

    let shell = find_cmd();
    crate::write_debug_log(&format!("pty shell path={} cwd={}", shell, cwd));
    let mut child = Command::new(&shell)
        .args(["/Q", "/D", "/K"])
        .creation_flags(0x0800_0000)
        .current_dir(cwd.replace('/', "\\"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let write_handle = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "missing child stdin"))?
        .into_raw_handle() as HANDLE;
    let read_handle = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "missing child stdout"))?
        .into_raw_handle() as HANDLE;
    let stderr_handle = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "missing child stderr"))?
        .into_raw_handle() as HANDLE;
    let process_handle = child.as_raw_handle() as HANDLE;

    let _ = (cols, rows);

    Ok(PtyHandle {
        con_pty: 0,
        write_handle,
        read_handle,
        stderr_handle,
        process_handle,
        thread_handle: INVALID_HANDLE_VALUE,
        child,
    })
}

#[cfg(windows)]
fn find_cmd() -> String {
    if let Ok(comspec) = std::env::var("ComSpec") {
        let trimmed = comspec.trim().trim_matches('"');
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    "C:\\WINDOWS\\system32\\cmd.exe".to_string()
}

#[cfg(windows)]
pub fn write_all(
    handle: windows_sys::Win32::Foundation::HANDLE,
    data: &[u8],
) -> std::io::Result<()> {
    use windows_sys::Win32::Storage::FileSystem::WriteFile;
    let mut offset = 0usize;
    while offset < data.len() {
        let mut written: u32 = 0;
        let ok = unsafe {
            WriteFile(
                handle,
                data[offset..].as_ptr(),
                (data.len() - offset) as u32,
                &mut written,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        offset += written as usize;
    }
    Ok(())
}

#[cfg(windows)]
pub fn resize(
    con_pty: windows_sys::Win32::System::Console::HPCON,
    cols: u16,
    rows: u16,
) -> std::io::Result<()> {
    if con_pty == 0 {
        let _ = (cols, rows);
        return Ok(());
    }
    use windows_sys::Win32::System::Console::{ResizePseudoConsole, COORD};
    let size = COORD { X: cols as i16, Y: rows as i16 };
    let hr = unsafe { ResizePseudoConsole(con_pty, size) };
    if hr < 0 {
        return Err(std::io::Error::from_raw_os_error(hr));
    }
    Ok(())
}

/// Blocking read from the PTY output pipe. Returns 0 on EOF (process exited).
#[cfg(windows)]
pub fn read_blocking(
    handle: windows_sys::Win32::Foundation::HANDLE,
    buf: &mut [u8],
) -> std::io::Result<usize> {
    use windows_sys::Win32::Storage::FileSystem::ReadFile;
    let mut read: u32 = 0;
    let ok = unsafe {
        ReadFile(
            handle,
            buf.as_mut_ptr(),
            buf.len() as u32,
            &mut read,
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(read as usize)
}

/// Terminate child process and release all ConPTY handles.
#[cfg(windows)]
pub fn close(handle: &mut PtyHandle) {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Console::ClosePseudoConsole;
    use windows_sys::Win32::System::Threading::{WaitForSingleObject, INFINITE};
    unsafe {
        let _ = handle.child.kill();
        let _ = handle.child.wait();
        if handle.con_pty != 0 {
            ClosePseudoConsole(handle.con_pty);
        }
        CloseHandle(handle.write_handle);
        CloseHandle(handle.read_handle);
        CloseHandle(handle.stderr_handle);
        CloseHandle(handle.process_handle);
        if handle.thread_handle != INVALID_HANDLE_VALUE {
            WaitForSingleObject(handle.thread_handle, INFINITE);
            CloseHandle(handle.thread_handle);
        }
        handle.con_pty = 0;
        handle.write_handle = INVALID_HANDLE_VALUE;
        handle.read_handle = INVALID_HANDLE_VALUE;
        handle.stderr_handle = INVALID_HANDLE_VALUE;
        handle.process_handle = INVALID_HANDLE_VALUE;
        handle.thread_handle = INVALID_HANDLE_VALUE;
    }
}

// ── Stub for other non-Unix, non-Windows platforms ───────────────────

#[cfg(not(any(unix, windows)))]
pub struct PtyHandle {
    _private: (),
}

#[cfg(not(any(unix, windows)))]
pub fn spawn(_cwd: &str, _cols: u16, _rows: u16) -> std::io::Result<PtyHandle> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "PTY not supported on this platform",
    ))
}

#[cfg(not(any(unix, windows)))]
pub fn write_all(_handle: i32, _data: &[u8]) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "PTY not supported"))
}

#[cfg(not(any(unix, windows)))]
pub fn resize(_handle: i32, _cols: u16, _rows: u16) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "PTY not supported"))
}

#[cfg(not(any(unix, windows)))]
pub fn read_blocking(_handle: i32, _buf: &mut [u8]) -> std::io::Result<usize> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "PTY not supported"))
}

#[cfg(not(any(unix, windows)))]
pub fn close(_handle: &mut PtyHandle) {}
