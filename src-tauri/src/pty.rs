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
const PS_PROMPT_INIT: &str = concat!(
    "function prompt {",
    " [char]27 + ']7;file://localhost/' + ($pwd.Path -replace '\\\\','/') + [char]27 + '\\';",
    " \"PS $($pwd.Path)> \" };",
    " Clear-Host\r\n",
);

#[cfg(windows)]
pub struct PtyHandle {
    pub con_pty: windows_sys::Win32::System::Console::HPCON,
    pub write_handle: windows_sys::Win32::Foundation::HANDLE,
    pub read_handle: windows_sys::Win32::Foundation::HANDLE,
    pub process_handle: windows_sys::Win32::Foundation::HANDLE,
    pub thread_handle: windows_sys::Win32::Foundation::HANDLE,
}

// HPCON is *mut c_void which is not Send by default; we manage its lifetime
// exclusively through the Mutex<HashMap<u32, PtyHandle>> in AppState.
#[cfg(windows)]
unsafe impl Send for PtyHandle {}

#[cfg(windows)]
pub fn spawn(cwd: &str, cols: u16, rows: u16) -> std::io::Result<PtyHandle> {
    use std::ffi::OsStr;
    use std::io;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::WriteFile;
    use windows_sys::Win32::System::Console::{
        CreatePseudoConsole, COORD, HPCON,
    };
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
        UpdateProcThreadAttribute, EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTUPINFOEXW,
    };

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    unsafe {
        // Create anonymous pipes for PTY I/O.
        // pty_in_read  → ConPTY reads input from here
        // pty_in_write → we write input to here
        // pty_out_read → we read output from here
        // pty_out_write → ConPTY writes output to here
        let mut pty_in_read: HANDLE = INVALID_HANDLE_VALUE;
        let mut pty_in_write: HANDLE = INVALID_HANDLE_VALUE;
        let mut pty_out_read: HANDLE = INVALID_HANDLE_VALUE;
        let mut pty_out_write: HANDLE = INVALID_HANDLE_VALUE;

        if CreatePipe(&mut pty_in_read, &mut pty_in_write, std::ptr::null(), 0) == 0 {
            return Err(io::Error::last_os_error());
        }
        if CreatePipe(&mut pty_out_read, &mut pty_out_write, std::ptr::null(), 0) == 0 {
            CloseHandle(pty_in_read);
            CloseHandle(pty_in_write);
            return Err(io::Error::last_os_error());
        }

        // Create the pseudo-console.
        let size = COORD { X: cols as i16, Y: rows as i16 };
        let mut con_pty: HPCON = std::ptr::null_mut();
        let hr = CreatePseudoConsole(size, pty_in_read, pty_out_write, 0, &mut con_pty);

        // These ends are now owned by the ConPTY; close our copies.
        CloseHandle(pty_in_read);
        CloseHandle(pty_out_write);

        if hr < 0 {
            CloseHandle(pty_in_write);
            CloseHandle(pty_out_read);
            return Err(io::Error::from_raw_os_error(hr));
        }

        // Build a PROC_THREAD_ATTRIBUTE_LIST large enough for one attribute.
        let mut attr_size: usize = 0;
        InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attr_size);
        let mut attr_buf = vec![0u8; attr_size];
        let attr_list = attr_buf.as_mut_ptr()
            as windows_sys::Win32::System::Threading::LPPROC_THREAD_ATTRIBUTE_LIST;

        if InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_size) == 0 {
            windows_sys::Win32::System::Console::ClosePseudoConsole(con_pty);
            CloseHandle(pty_in_write);
            CloseHandle(pty_out_read);
            return Err(io::Error::last_os_error());
        }

        if UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            con_pty as *mut _,
            std::mem::size_of::<HPCON>(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) == 0
        {
            DeleteProcThreadAttributeList(attr_list);
            windows_sys::Win32::System::Console::ClosePseudoConsole(con_pty);
            CloseHandle(pty_in_write);
            CloseHandle(pty_out_read);
            return Err(io::Error::last_os_error());
        }

        // Populate STARTUPINFOEXW.
        let mut startup_info: STARTUPINFOEXW = std::mem::zeroed();
        startup_info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup_info.lpAttributeList = attr_list;

        // Find PowerShell: prefer pwsh (PS 7+) then fall back to powershell.exe.
        let shell = find_powershell();
        let mut cmd_wide = to_wide(&shell);
        let cwd_wide = to_wide(cwd);

        let mut proc_info: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessW(
            std::ptr::null(),
            cmd_wide.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,                             // bInheritHandles = FALSE
            EXTENDED_STARTUPINFO_PRESENT,  // required to use lpAttributeList
            std::ptr::null(),
            cwd_wide.as_ptr(),
            &startup_info.StartupInfo,
            &mut proc_info,
        );

        DeleteProcThreadAttributeList(attr_list);

        if ok == 0 {
            windows_sys::Win32::System::Console::ClosePseudoConsole(con_pty);
            CloseHandle(pty_in_write);
            CloseHandle(pty_out_read);
            return Err(io::Error::last_os_error());
        }

        // Send shell initialisation: install OSC 7 cwd-reporting prompt and clear.
        // Windows paths look like C:\Users\alice; the URL form is /C:/Users/alice.
        let mut written: u32 = 0;
        WriteFile(
            pty_in_write,
            PS_PROMPT_INIT.as_ptr() as *const _,
            PS_PROMPT_INIT.len() as u32,
            &mut written,
            std::ptr::null_mut(),
        );

        Ok(PtyHandle {
            con_pty,
            write_handle: pty_in_write,
            read_handle: pty_out_read,
            process_handle: proc_info.hProcess,
            thread_handle: proc_info.hThread,
        })
    }
}

/// Locate PowerShell: try `pwsh.exe` (PowerShell 7+) then `powershell.exe`.
#[cfg(windows)]
fn find_powershell() -> String {
    for name in &["pwsh.exe", "powershell.exe"] {
        if let Ok(out) = std::process::Command::new("where.exe").arg(name).output() {
            if out.status.success() {
                if let Ok(s) = std::str::from_utf8(&out.stdout) {
                    if let Some(path) = s.lines().next().map(|l| l.trim().to_string()).filter(|p| !p.is_empty()) {
                        return path;
                    }
                }
            }
        }
    }
    "powershell.exe".to_string()
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
                data[offset..].as_ptr() as *const _,
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
            buf.as_mut_ptr() as *mut _,
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
    use windows_sys::Win32::Foundation::{CloseHandle, INFINITE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Console::ClosePseudoConsole;
    use windows_sys::Win32::System::Threading::{TerminateProcess, WaitForSingleObject};
    unsafe {
        TerminateProcess(handle.process_handle, 1);
        WaitForSingleObject(handle.process_handle, INFINITE);
        ClosePseudoConsole(handle.con_pty);
        CloseHandle(handle.write_handle);
        CloseHandle(handle.read_handle);
        CloseHandle(handle.process_handle);
        CloseHandle(handle.thread_handle);
        handle.con_pty = std::ptr::null_mut();
        handle.write_handle = INVALID_HANDLE_VALUE;
        handle.read_handle = INVALID_HANDLE_VALUE;
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
