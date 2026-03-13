/// PTY (pseudo-terminal) operations for spawning shells.

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex};

pub struct PtyHandle {
    pub master: Box<dyn MasterPty + Send>,
    pub reader: Arc<Mutex<Box<dyn Read + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Box<dyn Child + Send>,
}

fn portable_pty_error(err: impl std::fmt::Display) -> io::Error {
    io::Error::other(err.to_string())
}

fn shell_init(shell: &str) -> Option<String> {
    let shell_name = std::path::Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();

    #[cfg(windows)]
    if shell_name.eq_ignore_ascii_case("cmd.exe") {
        return Some("prompt $e]7;file://localhost/$P$e\\\\$P$G\r\ncls\r\n".to_string());
    }

    match shell_name {
        "bash" => Some(
            r#" __frd(){ printf '\e]7;file://localhost%s\e\\' "$PWD"; printf '\e[999;1H'; printf '\e]133;A\e\\';}; PROMPT_COMMAND="__frd;${PROMPT_COMMAND}"; PS0='\e]133;C\e\\'; printf '\e[2J\e[999;1H'"#
                .to_string(),
        ),
        "zsh" => Some(
            r#" setopt HIST_IGNORE_SPACE; __frd(){ printf '\e]7;file://localhost%s\e\\' "$PWD"; printf '\e[999;1H'; printf '\e]133;A\e\\';}; __frd_pre(){ printf '\e]133;C\e\\';}; precmd_functions+=(__frd); preexec_functions+=(__frd_pre); __frd_cls(){ printf '\e[2J\e[3J\e[999;1H'; zle reset-prompt;}; zle -N clear-screen __frd_cls; printf '\e[2J\e[999;1H'"#
                .to_string(),
        ),
        "fish" => Some(
            r#" function __frd_prompt --on-event fish_prompt; printf '\e]7;file://localhost%s\e\\' $PWD; printf '\e[999;1H'; printf '\e]133;A\e\\'; end; function __frd_preexec --on-event fish_preexec; printf '\e]133;C\e\\'; end; printf '\e[2J\e[999;1H'"#
                .to_string(),
        ),
        #[cfg(windows)]
        "powershell.exe" | "pwsh.exe" => Some(
            concat!(
                "function prompt {",
                " [Console]::Write(",
                "[char]27 + ']7;file://localhost/' + ($pwd.Path -replace '\\\\','/') + [char]27 + '\\' +",
                " [char]27 + '[999;1H' +",
                " [char]27 + ']133;A' + [char]27 + '\\'",
                ");",
                " 'PS ' + $pwd.Path + '> '",
                " };",
                " try{ Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {",
                " [Console]::Write([char]27 + ']133;C' + [char]27 + '\\');",
                " [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()",
                " } }catch{};",
                " [Console]::Write([char]27 + '[2J' + [char]27 + '[999;1H')\r\n",
            )
            .to_string(),
        ),
        "pwsh" => Some(
            concat!(
                "function prompt {",
                " [Console]::Write(",
                "[char]27 + ']7;file://localhost' + $pwd.Path + [char]27 + '\\' +",
                " [char]27 + '[999;1H' +",
                " [char]27 + ']133;A' + [char]27 + '\\'",
                ");",
                " 'PS ' + $pwd.Path + '> '",
                " };",
                " try{ Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {",
                " [Console]::Write([char]27 + ']133;C' + [char]27 + '\\');",
                " [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()",
                " } }catch{};",
                " [Console]::Write([char]27 + '[2J' + [char]27 + '[999;1H')",
            )
            .to_string(),
        ),
        _ => None,
    }
}

#[cfg(windows)]
fn resolve_shell() -> String {
    if let Ok(comspec) = std::env::var("ComSpec") {
        let trimmed = comspec.trim().trim_matches('"');
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    "C:\\WINDOWS\\system32\\cmd.exe".to_string()
}

#[cfg(not(windows))]
fn resolve_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
}

pub fn spawn(cwd: &str, cols: u16, rows: u16) -> io::Result<PtyHandle> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(portable_pty_error)?;

    let shell = resolve_shell();
    crate::write_debug_log(&format!("pty shell path={} cwd={}", shell, cwd));

    let mut cmd = CommandBuilder::new(shell.clone());
    cmd.cwd(cwd);

    #[cfg(windows)]
    {
        cmd.arg("/Q");
        cmd.arg("/D");
        cmd.arg("/K");
    }

    #[cfg(not(windows))]
    {
        cmd.env("TERM", "xterm-256color");
        cmd.env("HISTCONTROL", "ignoreboth");
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
    };

    if let Some(init) = shell_init(&shell) {
        let line = if cfg!(windows) { init } else { format!("{}\n", init) };
        let _ = write_all(&handle.writer, line.as_bytes());
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
pub fn read_blocking(reader: &Arc<Mutex<Box<dyn Read + Send>>>, buf: &mut [u8]) -> io::Result<usize> {
    let mut reader = reader
        .lock()
        .map_err(|_| io::Error::other("pty reader lock poisoned"))?;
    reader.read(buf)
}

pub fn close(handle: &mut PtyHandle) {
    let _ = handle.child.kill();
    let _ = handle.child.wait();
}
