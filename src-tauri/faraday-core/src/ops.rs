/// Filesystem operations.
///
/// All operations return data structures. Serialization to proto::Writer
/// (for the elevated helper) or to napi JS values (for the addon) is
/// handled by the respective callers.
use crate::error::FsError;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// On Windows, paths from the frontend use forward slashes; ensure we use a path the OS accepts.
#[cfg(windows)]
fn path_for_fs(s: &str) -> PathBuf {
    PathBuf::from(s.replace('/', std::path::MAIN_SEPARATOR_STR))
}

#[cfg(not(windows))]
fn path_for_fs(s: &str) -> PathBuf {
    PathBuf::from(s)
}

// ── Result types ─────────────────────────────────────────────────────

/// Entry kind — must match KIND_MAP in src/fs/fsProxy.ts.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    Unknown = 0,
    File = 1,
    Directory = 2,
    Symlink = 3,
    BlockDevice = 4,
    CharDevice = 5,
    NamedPipe = 6,
    Socket = 7,
    Whiteout = 8,
    Door = 9,
    EventPort = 10,
}

impl TryFrom<u8> for EntryKind {
    type Error = ();
    fn try_from(v: u8) -> Result<Self, ()> {
        match v {
            0 => Ok(Self::Unknown),
            1 => Ok(Self::File),
            2 => Ok(Self::Directory),
            3 => Ok(Self::Symlink),
            4 => Ok(Self::BlockDevice),
            5 => Ok(Self::CharDevice),
            6 => Ok(Self::NamedPipe),
            7 => Ok(Self::Socket),
            8 => Ok(Self::Whiteout),
            9 => Ok(Self::Door),
            10 => Ok(Self::EventPort),
            _ => Err(()),
        }
    }
}

impl EntryKind {
    /// Canonical kind string for each entry kind.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "unknown",
            Self::File => "file",
            Self::Directory => "directory",
            Self::Symlink => "symlink",
            Self::BlockDevice => "block_device",
            Self::CharDevice => "char_device",
            Self::NamedPipe => "named_pipe",
            Self::Socket => "socket",
            Self::Whiteout => "whiteout",
            Self::Door => "door",
            Self::EventPort => "event_port",
        }
    }

    /// Parse from the canonical string. Used by napi layer.
    pub fn from_str(s: &str) -> Self {
        match s {
            "file" => Self::File,
            "directory" => Self::Directory,
            "symlink" => Self::Symlink,
            "block_device" => Self::BlockDevice,
            "char_device" => Self::CharDevice,
            "named_pipe" => Self::NamedPipe,
            "socket" => Self::Socket,
            "whiteout" => Self::Whiteout,
            "door" => Self::Door,
            "event_port" => Self::EventPort,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EntryInfo {
    pub name: String,
    pub kind: EntryKind,
    pub size: f64,
    pub mtime_ms: f64,
    pub mode: u32,
    pub nlink: u32,
    pub hidden: bool,
    pub link_target: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct StatResult {
    pub size: f64,
    pub mtime_ms: f64,
}

// ── File-descriptor table ────────────────────────────────────────────

/// Tracks open file descriptors. Closing an fd removes it and calls close(2).
///
/// On POSIX, we store the raw fd (i32). On Windows, we'd store HANDLE cast to i64,
/// but for now we use RawFd which is i32 on Unix.
#[cfg(unix)]
type RawFd = i32;
#[cfg(windows)]
type RawFd = i64;

pub struct FdTable {
    map: Mutex<HashMap<RawFd, ()>>,
}

impl FdTable {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }

    pub fn track(&self, fd: RawFd) {
        self.map.lock().insert(fd, ());
    }

    pub fn contains(&self, fd: RawFd) -> bool {
        self.map.lock().contains_key(&fd)
    }

    pub fn remove(&self, fd: RawFd) {
        if self.map.lock().remove(&fd).is_some() {
            #[cfg(unix)]
            unsafe {
                libc::close(fd);
            }
        }
    }
}

impl Default for FdTable {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for FdTable {
    fn drop(&mut self) {
        let map = self.map.get_mut();
        for &_fd in map.keys() {
            #[cfg(unix)]
            unsafe {
                libc::close(_fd);
            }
        }
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

fn metadata_mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn entry_kind(ft: &fs::FileType) -> EntryKind {
    if ft.is_file() {
        EntryKind::File
    } else if ft.is_dir() {
        EntryKind::Directory
    } else if ft.is_symlink() {
        EntryKind::Symlink
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::FileTypeExt;
            if ft.is_block_device() {
                return EntryKind::BlockDevice;
            }
            if ft.is_char_device() {
                return EntryKind::CharDevice;
            }
            if ft.is_fifo() {
                return EntryKind::NamedPipe;
            }
            if ft.is_socket() {
                return EntryKind::Socket;
            }
        }
        EntryKind::Unknown
    }
}

#[cfg(unix)]
fn entry_mode(meta: &fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    meta.mode()
}

#[cfg(not(unix))]
fn entry_mode(_meta: &fs::Metadata) -> u32 {
    0
}

/// On Windows, executable-ness is determined by extension; PATHEXT lists those extensions.
#[cfg(windows)]
fn is_executable_extension(name: &str) -> bool {
    let ext = name
        .rfind('.')
        .map(|i| name[i..].to_lowercase())
        .filter(|s| s.len() > 1);
    let Some(ext) = ext else { return false };
    let pathext = std::env::var_os("PATHEXT")
        .unwrap_or_else(|| std::ffi::OsString::from(".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"));
    let pathext = pathext.to_string_lossy();
    pathext.split(';').any(|s| {
        let s = s.trim().to_lowercase();
        s.starts_with('.') && s == ext
    })
}

/// No extension-based executable check on non-Windows (mode bits are used).
#[cfg(not(windows))]
fn is_executable_extension(_name: &str) -> bool {
    false
}

#[cfg(unix)]
fn entry_nlink(path: &Path) -> u32 {
    fs::symlink_metadata(path)
        .map(|m| {
            use std::os::unix::fs::MetadataExt;
            m.nlink() as u32
        })
        .unwrap_or(1)
}

#[cfg(not(unix))]
fn entry_nlink(_path: &Path) -> u32 {
    1
}

fn is_hidden(name: &str, #[allow(unused)] full_path: &Path) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let wide: Vec<u16> = full_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let attrs = windows_sys::Win32::Storage::FileSystem::GetFileAttributesW(wide.as_ptr());
            if attrs != u32::MAX {
                return (attrs & 0x02) != 0; // FILE_ATTRIBUTE_HIDDEN
            }
        }
        name.starts_with('.')
    }
    #[cfg(not(windows))]
    {
        name.starts_with('.')
    }
}

// ── Operations ───────────────────────────────────────────────────────

pub fn entries(dir_path: &str) -> Result<Vec<EntryInfo>, FsError> {
    let path = path_for_fs(dir_path);
    let dir = fs::read_dir(&path).map_err(FsError::from_io)?;
    let mut result = Vec::new();

    for entry in dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        let kind = entry_kind(&ft);

        // stat() follows symlinks — gives target size/mtime/mode
        let full_path = entry.path();
        let (size, mtime_ms, mut mode) = match fs::metadata(&full_path) {
            Ok(meta) => (meta.len() as f64, metadata_mtime_ms(&meta), entry_mode(&meta)),
            Err(_) => (0.0, 0.0, 0),
        };
        // On platforms without execute bits (e.g. Windows), use executable extension heuristic
        if kind == EntryKind::File && mode & 0o111 == 0 && is_executable_extension(&name) {
            mode |= 0o111;
        }

        let nlink = entry_nlink(&full_path);
        let hidden = is_hidden(&name, &full_path);

        let link_target = if kind == EntryKind::Symlink {
            fs::read_link(&full_path)
                .ok()
                .map(|p| p.to_string_lossy().into_owned())
        } else {
            None
        };

        result.push(EntryInfo {
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
    Ok(result)
}

pub fn stat(file_path: &str) -> Result<StatResult, FsError> {
    let path = path_for_fs(file_path);
    let meta = fs::metadata(&path).map_err(FsError::from_io)?;
    Ok(StatResult {
        size: meta.len() as f64,
        mtime_ms: metadata_mtime_ms(&meta),
    })
}

pub fn exists(file_path: &str) -> bool {
    path_for_fs(file_path).try_exists().unwrap_or(false)
}

pub fn write_text(file_path: &str, data: &str) -> Result<(), FsError> {
  let path = path_for_fs(file_path);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(FsError::from_io)?;
  }
  let mut file = fs::File::create(&path).map_err(FsError::from_io)?;
  file.write_all(data.as_bytes()).map_err(FsError::from_io)
}

#[cfg(unix)]
pub fn open(file_path: &str, fdt: &FdTable) -> Result<i32, FsError> {
    use std::os::unix::io::IntoRawFd;
    let path = path_for_fs(file_path);
    let file = fs::File::open(&path).map_err(FsError::from_io)?;
    let fd = file.into_raw_fd();
    fdt.track(fd);
    Ok(fd)
}

#[cfg(not(unix))]
pub fn open(file_path: &str, fdt: &FdTable) -> Result<i32, FsError> {
    use std::os::windows::io::IntoRawHandle;
    let path = path_for_fs(file_path);
    let file = fs::File::open(&path).map_err(FsError::from_io)?;
    let handle = file.into_raw_handle();
    let fd = handle as i64;
    fdt.track(fd);
    Ok(fd as i32)
}

#[cfg(unix)]
pub fn pread(fd: i32, offset: u64, length: usize, fdt: &FdTable) -> Result<Vec<u8>, FsError> {
    if !fdt.contains(fd) {
        return Err(FsError::BadFd);
    }
    let mut buf = vec![0u8; length];
    let n = unsafe { libc::pread(fd, buf.as_mut_ptr() as *mut libc::c_void, length, offset as i64) };
    if n < 0 {
        return Err(FsError::Io(std::io::Error::last_os_error()));
    }
    buf.truncate(n as usize);
    Ok(buf)
}

#[cfg(not(unix))]
pub fn pread(fd: i32, offset: u64, length: usize, fdt: &FdTable) -> Result<Vec<u8>, FsError> {
    // Windows: use SetFilePointerEx + ReadFile
    // For now, use Rust's File abstraction
    use std::io::{Read, Seek};
    use std::os::windows::io::FromRawHandle;
    if !fdt.contains(fd as i64) {
        return Err(FsError::BadFd);
    }
    let handle = fd as *mut std::ffi::c_void;
    let file = unsafe { fs::File::from_raw_handle(handle) };
    let mut file = std::io::BufReader::new(file);
    file.seek(std::io::SeekFrom::Start(offset))
        .map_err(FsError::from_io)?;
    let mut buf = vec![0u8; length];
    let n = file.read(&mut buf).map_err(FsError::from_io)?;
    buf.truncate(n);
    // Don't drop the file — we don't own it
    std::mem::forget(file.into_inner());
    Ok(buf)
}

pub fn close(fd: i32, fdt: &FdTable) {
    #[cfg(unix)]
    fdt.remove(fd);
    #[cfg(not(unix))]
    fdt.remove(fd as i64);
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn entry_kind_codes() {
        // Verify repr(u8) values match the protocol's kind codes
        assert_eq!(EntryKind::Unknown as u8, 0);
        assert_eq!(EntryKind::File as u8, 1);
        assert_eq!(EntryKind::Directory as u8, 2);
        assert_eq!(EntryKind::Symlink as u8, 3);
        assert_eq!(EntryKind::BlockDevice as u8, 4);
        assert_eq!(EntryKind::CharDevice as u8, 5);
        assert_eq!(EntryKind::NamedPipe as u8, 6);
        assert_eq!(EntryKind::Socket as u8, 7);
        assert_eq!(EntryKind::Whiteout as u8, 8);
        assert_eq!(EntryKind::Door as u8, 9);
        assert_eq!(EntryKind::EventPort as u8, 10);
    }

    #[test]
    fn entry_kind_str_roundtrip() {
        for kind in [
            EntryKind::Unknown,
            EntryKind::File,
            EntryKind::Directory,
            EntryKind::Symlink,
            EntryKind::BlockDevice,
            EntryKind::CharDevice,
            EntryKind::NamedPipe,
            EntryKind::Socket,
        ] {
            assert_eq!(EntryKind::from_str(kind.as_str()), kind);
        }
    }

    #[test]
    fn entries_reads_directory() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("test.txt");
        fs::File::create(&file_path)
            .unwrap()
            .write_all(b"hello")
            .unwrap();

        let result = entries(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "test.txt");
        assert_eq!(result[0].kind, EntryKind::File);
        assert_eq!(result[0].size, 5.0);
        assert!(!result[0].hidden);
    }

    #[test]
    fn entries_hidden_file() {
        let dir = tempfile::tempdir().unwrap();
        fs::File::create(dir.path().join(".hidden")).unwrap();

        let result = entries(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].hidden);
    }

    #[test]
    fn stat_file() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("stat_test.txt");
        fs::File::create(&file_path)
            .unwrap()
            .write_all(b"data")
            .unwrap();

        let result = stat(file_path.to_str().unwrap()).unwrap();
        assert_eq!(result.size, 4.0);
        assert!(result.mtime_ms > 0.0);
    }

    #[test]
    fn stat_not_found() {
        let result = stat("/nonexistent/path/file.txt");
        assert!(matches!(result, Err(FsError::NotFound)));
    }

    #[test]
    fn exists_check() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("exists_test.txt");
        assert!(!exists(file_path.to_str().unwrap()));
        fs::File::create(&file_path).unwrap();
        assert!(exists(file_path.to_str().unwrap()));
    }

    #[test]
    fn open_read_close() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("read_test.txt");
        fs::File::create(&file_path)
            .unwrap()
            .write_all(b"hello world")
            .unwrap();

        let fdt = FdTable::new();
        let fd = open(file_path.to_str().unwrap(), &fdt).unwrap();
        assert!(fd >= 0);
        assert!(fdt.contains(fd));

        let data = pread(fd, 0, 5, &fdt).unwrap();
        assert_eq!(&data, b"hello");

        let data2 = pread(fd, 6, 5, &fdt).unwrap();
        assert_eq!(&data2, b"world");

        close(fd, &fdt);
        assert!(!fdt.contains(fd));
    }

    #[test]
    fn pread_bad_fd() {
        let fdt = FdTable::new();
        let result = pread(999, 0, 10, &fdt);
        assert!(matches!(result, Err(FsError::BadFd)));
    }
}
