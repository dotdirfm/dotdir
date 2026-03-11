/// Stub elevation module for platforms without Unix socket support (Windows).
///
/// Elevation on Windows would require named pipes + UAC; not yet implemented.
/// All operations return an error indicating elevation is unsupported.
use faraday_core::error::FsError;
use std::sync::Arc;

pub type WatchCallback = Arc<dyn Fn(&str, &str, Option<&str>) + Send + Sync>;

pub struct FsProxy;

impl FsProxy {
    pub fn is_alive(&self) -> bool {
        false
    }

    pub fn entries(&self, _dir_path: &str) -> Result<Vec<faraday_core::ops::EntryInfo>, FsError> {
        Err(unsupported())
    }

    pub fn stat(&self, _file_path: &str) -> Result<faraday_core::ops::StatResult, FsError> {
        Err(unsupported())
    }

    pub fn open(&self, _file_path: &str) -> Result<i32, FsError> {
        Err(unsupported())
    }

    pub fn pread(&self, _fd: i32, _offset: u64, _length: usize) -> Result<Vec<u8>, FsError> {
        Err(unsupported())
    }

    pub fn close(&self, _fd: i32) {}

    pub fn unwatch(&self, _watch_id: &str) {}
}

pub fn launch_elevated(_watch_callback: WatchCallback) -> Result<Arc<FsProxy>, FsError> {
    Err(unsupported())
}

fn unsupported() -> FsError {
    FsError::Io(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "elevation not supported on this platform",
    ))
}
