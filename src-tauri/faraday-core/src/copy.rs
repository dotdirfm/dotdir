/// Cross-platform copy engine with progress reporting, cancellation, and conflict resolution.
///
/// Platform fast paths:
///   macOS  — clonefile() (CoW) → fcopyfile() → chunked fallback
///   Linux  — ioctl(FICLONE) → copy_file_range() → chunked fallback
///   Windows — CopyFileExW with progress callback → chunked fallback

use crate::error::FsError;
use log::debug;
use serde::{Deserialize, Serialize};
use std::cell::Cell;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const CHUNK_SIZE: usize = 256 * 1024; // 256 KB

// ── Types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    Ask,
    Overwrite,
    Skip,
    Rename,
    Append,
    OnlyNewer,
}

impl Default for ConflictPolicy {
    fn default() -> Self {
        Self::Ask
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SymlinkMode {
    Smart,
    AlwaysLink,
    AlwaysTarget,
}

impl Default for SymlinkMode {
    fn default() -> Self {
        Self::Smart
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyOptions {
    #[serde(default)]
    pub conflict_policy: ConflictPolicy,
    #[serde(default = "default_true")]
    pub copy_permissions: bool,
    #[serde(default)]
    pub copy_xattrs: bool,
    #[serde(default)]
    pub sparse_files: bool,
    #[serde(default)]
    pub use_cow: bool,
    #[serde(default)]
    pub symlink_mode: SymlinkMode,
    #[serde(default)]
    pub disable_write_cache: bool,
}

fn default_true() -> bool {
    true
}

impl Default for CopyOptions {
    fn default() -> Self {
        Self {
            conflict_policy: ConflictPolicy::default(),
            copy_permissions: true,
            copy_xattrs: false,
            sparse_files: false,
            use_cow: false,
            symlink_mode: SymlinkMode::default(),
            disable_write_cache: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictResolution {
    Overwrite,
    Skip,
    Rename(String),
    OverwriteAll,
    SkipAll,
    Cancel,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyProgress {
    pub bytes_copied: u64,
    pub bytes_total: u64,
    pub files_done: u32,
    pub files_total: u32,
    pub current_file: String,
}

/// Event emitted to the frontend during copy.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum CopyEvent {
    Progress(CopyProgress),
    Conflict {
        src: String,
        dest: String,
        #[serde(rename = "srcSize")]
        src_size: u64,
        #[serde(rename = "srcMtimeMs")]
        src_mtime_ms: f64,
        #[serde(rename = "destSize")]
        dest_size: u64,
        #[serde(rename = "destMtimeMs")]
        dest_mtime_ms: f64,
    },
    Done {
        #[serde(rename = "filesDone")]
        files_done: u32,
        #[serde(rename = "bytesCopied")]
        bytes_copied: u64,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone)]
pub struct CopyResult {
    pub files_copied: u32,
    pub bytes_copied: u64,
}

/// Thread-safe cancellation token.
#[derive(Debug, Clone)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn new() -> Self {
        Self(Arc::new(AtomicBool::new(false)))
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

impl Default for CancelToken {
    fn default() -> Self {
        Self::new()
    }
}

// ── Pre-walk to calculate totals ─────────────────────────────────────

pub(crate) struct PreWalkResult {
    pub(crate) total_bytes: u64,
    pub(crate) total_files: u32,
}

pub(crate) fn pre_walk(sources: &[PathBuf]) -> PreWalkResult {
    let mut total_bytes = 0u64;
    let mut total_files = 0u32;
    let mut visited_dirs = HashSet::new();

    fn walk(path: &Path, bytes: &mut u64, files: &mut u32, visited: &mut HashSet<PathBuf>) {
        let meta = match fs::symlink_metadata(path) {
            Ok(m) => m,
            Err(_) => return,
        };
        if meta.file_type().is_symlink() {
            // Count symlinks as files; don't follow them to avoid loops
            *files += 1;
            return;
        }
        if meta.is_dir() {
            // Track visited directories by canonical path to detect loops
            let canonical = match path.canonicalize() {
                Ok(c) => c,
                Err(_) => return,
            };
            if !visited.insert(canonical) {
                return; // Already visited — symlink loop
            }
            if let Ok(entries) = fs::read_dir(path) {
                for entry in entries.flatten() {
                    walk(&entry.path(), bytes, files, visited);
                }
            }
        } else {
            *bytes += meta.len();
            *files += 1;
        }
    }

    for source in sources {
        walk(source, &mut total_bytes, &mut total_files, &mut visited_dirs);
    }

    PreWalkResult {
        total_bytes,
        total_files,
    }
}

// ── Unique name generation ──────────────────────────────────────────

pub fn generate_unique_name(path: &Path) -> PathBuf {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    let parent = path.parent().unwrap_or(path);

    let candidate = parent.join(format!("{stem}_copy{ext}"));
    if !candidate.exists() {
        return candidate;
    }

    for i in 2.. {
        let candidate = parent.join(format!("{stem}_copy{i}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

// ── Metadata helpers ─────────────────────────────────────────────────

pub(crate) fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

// ── Platform-specific single file copy ──────────────────────────────

#[cfg(target_os = "macos")]
fn copy_single_file_platform(
    src: &Path,
    dest: &Path,
    options: &CopyOptions,
    _token: &CancelToken,
    _on_progress: &dyn Fn(u64),
) -> Result<bool, FsError> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    if options.use_cow {
        let src_c = CString::new(src.as_os_str().as_bytes()).map_err(|_| FsError::InvalidInput)?;
        let dest_c =
            CString::new(dest.as_os_str().as_bytes()).map_err(|_| FsError::InvalidInput)?;
        let ret = unsafe { libc::clonefile(src_c.as_ptr(), dest_c.as_ptr(), 0) };
        if ret == 0 {
            if let Ok(meta) = fs::metadata(src) {
                _on_progress(meta.len());
            }
            return Ok(true);
        }
        // ENOTSUP/EXDEV → fall through to regular copy
    }

    // Fall through to chunked copy
    Ok(false)
}

#[cfg(target_os = "linux")]
fn copy_single_file_platform(
    src: &Path,
    dest: &Path,
    options: &CopyOptions,
    _token: &CancelToken,
    on_progress: &dyn Fn(u64),
) -> Result<bool, FsError> {
    use std::os::unix::io::AsRawFd;

    if options.use_cow {
        // Try FICLONE
        let src_file = fs::File::open(src).map_err(FsError::from_io)?;
        let dest_file = fs::File::create(dest).map_err(FsError::from_io)?;
        // FICLONE = _IOW(0x94, 9, int) = 0x40049409
        const FICLONE: libc::c_ulong = 0x40049409;
        let ret = unsafe { libc::ioctl(dest_file.as_raw_fd(), FICLONE, src_file.as_raw_fd()) };
        if ret == 0 {
            if let Ok(meta) = fs::metadata(src) {
                on_progress(meta.len());
            }
            return Ok(true);
        }
        // Fall through
    }

    // Try copy_file_range
    {
        let src_file = fs::File::open(src).map_err(FsError::from_io)?;
        let dest_file = fs::File::create(dest).map_err(FsError::from_io)?;
        let src_meta = src_file.metadata().map_err(FsError::from_io)?;
        let total = src_meta.len();
        let mut copied = 0u64;

        loop {
            if _token.is_cancelled() {
                return Err(FsError::Io(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "cancelled",
                )));
            }
            let chunk = std::cmp::min(CHUNK_SIZE as u64, total - copied) as usize;
            if chunk == 0 {
                break;
            }
            let n = unsafe {
                libc::copy_file_range(
                    src_file.as_raw_fd(),
                    std::ptr::null_mut(),
                    dest_file.as_raw_fd(),
                    std::ptr::null_mut(),
                    chunk,
                    0,
                )
            };
            if n < 0 {
                let err = std::io::Error::last_os_error();
                if err.raw_os_error() == Some(libc::ENOSYS)
                    || err.raw_os_error() == Some(libc::EXDEV)
                {
                    // Not supported, fall through to chunked
                    // Clean up the partially created dest
                    drop(dest_file);
                    let _ = fs::remove_file(dest);
                    return Ok(false);
                }
                return Err(FsError::Io(err));
            }
            if n == 0 {
                break;
            }
            copied += n as u64;
            on_progress(n as u64);
        }
        return Ok(true);
    }
}

#[cfg(windows)]
fn copy_single_file_platform(
    src: &Path,
    dest: &Path,
    _options: &CopyOptions,
    token: &CancelToken,
    on_progress: &dyn Fn(u64),
) -> Result<bool, FsError> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    fn to_wide(s: &OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    let src_wide = to_wide(src.as_os_str());
    let dest_wide = to_wide(dest.as_os_str());

    struct CallbackData<'a> {
        token: &'a CancelToken,
        on_progress: &'a dyn Fn(u64),
        last_transferred: u64,
    }

    unsafe extern "system" fn progress_routine(
        _total_size: i64,
        total_transferred: i64,
        _stream_size: i64,
        _stream_transferred: i64,
        _stream_number: u32,
        _callback_reason: u32,
        _src_handle: *mut std::ffi::c_void,
        _dest_handle: *mut std::ffi::c_void,
        data: *mut std::ffi::c_void,
    ) -> u32 {
        let data = &mut *(data as *mut CallbackData);
        if data.token.is_cancelled() {
            return 1; // PROGRESS_CANCEL
        }
        let transferred = total_transferred as u64;
        let delta = transferred.saturating_sub(data.last_transferred);
        if delta > 0 {
            (data.on_progress)(delta);
            data.last_transferred = transferred;
        }
        0 // PROGRESS_CONTINUE
    }

    let mut cb_data = CallbackData {
        token,
        on_progress,
        last_transferred: 0,
    };

    let ret = unsafe {
        windows_sys::Win32::Storage::FileSystem::CopyFileExW(
            src_wide.as_ptr(),
            dest_wide.as_ptr(),
            Some(progress_routine),
            &mut cb_data as *mut _ as *mut std::ffi::c_void,
            std::ptr::null_mut(),
            0,
        )
    };

    if ret == 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(1235) {
            // ERROR_REQUEST_ABORTED (cancel)
            return Err(FsError::Io(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "cancelled",
            )));
        }
        return Err(FsError::Io(err));
    }

    Ok(true)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn copy_single_file_platform(
    _src: &Path,
    _dest: &Path,
    _options: &CopyOptions,
    _token: &CancelToken,
    _on_progress: &dyn Fn(u64),
) -> Result<bool, FsError> {
    Ok(false)
}

/// Chunked read/write fallback (all platforms).
fn copy_single_file_chunked(
    src: &Path,
    dest: &Path,
    token: &CancelToken,
    on_progress: &dyn Fn(u64),
) -> Result<(), FsError> {
    use std::io::{Read, Write};
    let mut reader = fs::File::open(src).map_err(FsError::from_io)?;
    let mut writer = fs::File::create(dest).map_err(FsError::from_io)?;
    let mut buf = vec![0u8; CHUNK_SIZE];

    loop {
        if token.is_cancelled() {
            return Err(FsError::Io(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "cancelled",
            )));
        }
        let n = reader.read(&mut buf).map_err(FsError::from_io)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).map_err(FsError::from_io)?;
        on_progress(n as u64);
    }
    Ok(())
}

/// Copy permissions from source to dest (all platforms).
pub(crate) fn copy_permissions(src: &Path, dest: &Path) -> Result<(), FsError> {
    let meta = fs::metadata(src).map_err(FsError::from_io)?;
    fs::set_permissions(dest, meta.permissions()).map_err(FsError::from_io)?;
    Ok(())
}

/// Copy extended attributes (unix only).
#[cfg(unix)]
pub(crate) fn copy_xattrs(src: &Path, dest: &Path) -> Result<(), FsError> {
    let attrs = match xattr::list(src) {
        Ok(a) => a,
        Err(_) => return Ok(()),
    };
    for attr in attrs {
        if let Ok(Some(value)) = xattr::get(src, &attr) {
            let _ = xattr::set(dest, &attr, &value);
        }
    }
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn copy_xattrs(_src: &Path, _dest: &Path) -> Result<(), FsError> {
    Ok(())
}

/// Copy a single file using platform fast paths with chunked fallback.
pub(crate) fn copy_single_file(
    src: &Path,
    dest: &Path,
    options: &CopyOptions,
    token: &CancelToken,
    on_progress: &dyn Fn(u64),
) -> Result<(), FsError> {
    // Try platform-specific first
    let handled = copy_single_file_platform(src, dest, options, token, on_progress)?;
    if !handled {
        copy_single_file_chunked(src, dest, token, on_progress)?;
    }

    if options.copy_permissions {
        let _ = copy_permissions(src, dest);
    }
    if options.copy_xattrs {
        let _ = copy_xattrs(src, dest);
    }

    Ok(())
}

// ── Entry point ─────────────────────────────────────────────────────

/// Copy one or more source paths into dest_dir.
///
/// Callbacks:
///   `on_progress` — called frequently with cumulative progress
///   `on_conflict` — called when a destination already exists and policy is Ask;
///                    blocks the copy thread until the frontend responds
pub fn copy_tree(
    sources: &[PathBuf],
    dest_dir: &PathBuf,
    options: &CopyOptions,
    token: &CancelToken,
    on_progress: &dyn Fn(CopyEvent),
    on_conflict: &dyn Fn(&Path, &Path) -> ConflictResolution,
) -> Result<CopyResult, FsError> {
    // Canonicalize dest_dir for self-copy detection
    let canonical_dest = dest_dir.canonicalize().unwrap_or_else(|_| dest_dir.clone());

    // Check: none of the sources should be an ancestor of (or equal to) dest_dir.
    // Copying /a into /a/b would create infinite recursion.
    for source in sources {
        let canonical_src = source.canonicalize().unwrap_or_else(|_| source.clone());
        if canonical_src.is_dir() && canonical_dest.starts_with(&canonical_src) {
            return Err(FsError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "Cannot copy '{}' into itself ('{}')",
                    source.display(),
                    dest_dir.display()
                ),
            )));
        }
    }

    let pre = pre_walk(sources);
    debug!(
        "[copy] starting: {} files, {} bytes",
        pre.total_files, pre.total_bytes
    );

    // Use Cell for interior mutability in Fn closures (single-threaded copy job)
    let bytes_copied = Cell::new(0u64);
    let files_done = Cell::new(0u32);

    // Track "all" overrides from conflict resolution
    let mut override_all: Option<ConflictResolution> = None;

    // Track visited directories (by canonical path) to detect symlink loops
    let mut visited_dirs = HashSet::new();

    for source in sources {
        if token.is_cancelled() {
            break;
        }
        let source_name = source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        let meta = fs::symlink_metadata(source).map_err(FsError::from_io)?;

        if meta.file_type().is_symlink() {
            // Handle symlinks before is_dir() check to avoid following them
            let dest_path = dest_dir.join(&source_name);
            copy_symlink(source, &dest_path, options)?;
            files_done.set(files_done.get() + 1);
        } else if meta.is_dir() {
            // Track this directory
            if let Ok(canonical) = source.canonicalize() {
                visited_dirs.insert(canonical);
            }
            copy_dir_recursive(
                source,
                &dest_dir.join(&source_name),
                options,
                token,
                &bytes_copied,
                &files_done,
                pre.total_files,
                pre.total_bytes,
                on_progress,
                on_conflict,
                &mut override_all,
                &mut visited_dirs,
            )?;
        } else {
            let dest_path = dest_dir.join(&source_name);
            let actual_dest = handle_conflict(
                source,
                &dest_path,
                options,
                on_conflict,
                &mut override_all,
                token,
            )?;
            if let Some(actual_dest) = actual_dest {
                on_progress(CopyEvent::Progress(CopyProgress {
                    bytes_copied: bytes_copied.get(),
                    bytes_total: pre.total_bytes,
                    files_done: files_done.get(),
                    files_total: pre.total_files,
                    current_file: source_name.clone(),
                }));

                copy_single_file(source, &actual_dest, options, token, &|delta| {
                    bytes_copied.set(bytes_copied.get() + delta);
                    on_progress(CopyEvent::Progress(CopyProgress {
                        bytes_copied: bytes_copied.get(),
                        bytes_total: pre.total_bytes,
                        files_done: files_done.get(),
                        files_total: pre.total_files,
                        current_file: source_name.clone(),
                    }));
                })?;
                files_done.set(files_done.get() + 1);
            }
        }
    }

    let result = CopyResult {
        files_copied: files_done.get(),
        bytes_copied: bytes_copied.get(),
    };
    on_progress(CopyEvent::Done {
        files_done: files_done.get(),
        bytes_copied: bytes_copied.get(),
    });
    debug!(
        "[copy] done: {} files, {} bytes",
        result.files_copied, result.bytes_copied
    );
    Ok(result)
}

fn copy_dir_recursive(
    src_dir: &Path,
    dest_dir: &Path,
    options: &CopyOptions,
    token: &CancelToken,
    bytes_copied: &Cell<u64>,
    files_done: &Cell<u32>,
    files_total: u32,
    bytes_total: u64,
    on_progress: &dyn Fn(CopyEvent),
    on_conflict: &dyn Fn(&Path, &Path) -> ConflictResolution,
    override_all: &mut Option<ConflictResolution>,
    visited_dirs: &mut HashSet<PathBuf>,
) -> Result<(), FsError> {
    if token.is_cancelled() {
        return Ok(());
    }

    // Create destination directory
    fs::create_dir_all(dest_dir).map_err(FsError::from_io)?;

    if options.copy_permissions {
        let _ = copy_permissions(src_dir, dest_dir);
    }

    let entries = fs::read_dir(src_dir).map_err(FsError::from_io)?;
    for entry in entries {
        if token.is_cancelled() {
            break;
        }
        let entry = entry.map_err(FsError::from_io)?;
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        let src_path = entry.path();
        let dest_path = dest_dir.join(&entry_name);

        let meta = match fs::symlink_metadata(&src_path) {
            Ok(m) => m,
            Err(e) => {
                debug!("[copy] skipping {:?}: {}", src_path, e);
                continue;
            }
        };

        // Check symlinks first — before is_dir() which would follow them
        if meta.file_type().is_symlink() {
            copy_symlink(&src_path, &dest_path, options)?;
            files_done.set(files_done.get() + 1);
        } else if meta.is_dir() {
            // Detect symlink loops: only recurse if we haven't visited this canonical path
            let canonical = match src_path.canonicalize() {
                Ok(c) => c,
                Err(e) => {
                    debug!("[copy] skipping {:?}: cannot canonicalize: {}", src_path, e);
                    continue;
                }
            };
            if !visited_dirs.insert(canonical) {
                debug!("[copy] skipping {:?}: symlink loop detected", src_path);
                continue;
            }
            copy_dir_recursive(
                &src_path,
                &dest_path,
                options,
                token,
                bytes_copied,
                files_done,
                files_total,
                bytes_total,
                on_progress,
                on_conflict,
                override_all,
                visited_dirs,
            )?;
        } else {
            let actual_dest = handle_conflict(
                &src_path,
                &dest_path,
                options,
                on_conflict,
                override_all,
                token,
            )?;
            if let Some(actual_dest) = actual_dest {
                on_progress(CopyEvent::Progress(CopyProgress {
                    bytes_copied: bytes_copied.get(),
                    bytes_total,
                    files_done: files_done.get(),
                    files_total,
                    current_file: entry_name.clone(),
                }));

                copy_single_file(&src_path, &actual_dest, options, token, &|delta| {
                    bytes_copied.set(bytes_copied.get() + delta);
                    on_progress(CopyEvent::Progress(CopyProgress {
                        bytes_copied: bytes_copied.get(),
                        bytes_total,
                        files_done: files_done.get(),
                        files_total,
                        current_file: entry_name.clone(),
                    }));
                })?;
                files_done.set(files_done.get() + 1);
            }
        }
    }
    Ok(())
}

pub(crate) fn copy_symlink(src: &Path, dest: &Path, options: &CopyOptions) -> Result<(), FsError> {
    let target = fs::read_link(src).map_err(FsError::from_io)?;

    match options.symlink_mode {
        SymlinkMode::AlwaysTarget => {
            // Copy the target content instead of the link
            let resolved = if target.is_relative() {
                src.parent().unwrap_or(src).join(&target)
            } else {
                target
            };
            if resolved.is_dir() {
                // Just create the dir for now; recursive copy would happen at a higher level
                fs::create_dir_all(dest).map_err(FsError::from_io)?;
            } else {
                fs::copy(&resolved, dest).map_err(FsError::from_io)?;
            }
        }
        SymlinkMode::AlwaysLink | SymlinkMode::Smart => {
            // Recreate the symlink
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(&target, dest).map_err(FsError::from_io)?;
            }
            #[cfg(windows)]
            {
                if target.is_dir() {
                    std::os::windows::fs::symlink_dir(&target, dest)
                        .map_err(FsError::from_io)?;
                } else {
                    std::os::windows::fs::symlink_file(&target, dest)
                        .map_err(FsError::from_io)?;
                }
            }
        }
    }
    Ok(())
}

/// Handle conflict: returns Some(dest_path) to proceed, None to skip.
pub(crate) fn handle_conflict(
    src: &Path,
    dest: &Path,
    options: &CopyOptions,
    on_conflict: &dyn Fn(&Path, &Path) -> ConflictResolution,
    override_all: &mut Option<ConflictResolution>,
    token: &CancelToken,
) -> Result<Option<PathBuf>, FsError> {
    if !dest.exists() {
        return Ok(Some(dest.to_path_buf()));
    }

    // Check for "All" overrides first
    if let Some(ref all) = override_all {
        return apply_resolution(all, src, dest);
    }

    match options.conflict_policy {
        ConflictPolicy::Overwrite => Ok(Some(dest.to_path_buf())),
        ConflictPolicy::Skip => Ok(None),
        ConflictPolicy::Rename => Ok(Some(generate_unique_name(dest))),
        ConflictPolicy::OnlyNewer => {
            let src_meta = fs::metadata(src).map_err(FsError::from_io)?;
            let dest_meta = fs::metadata(dest).map_err(FsError::from_io)?;
            if mtime_ms(&src_meta) > mtime_ms(&dest_meta) {
                Ok(Some(dest.to_path_buf()))
            } else {
                Ok(None)
            }
        }
        ConflictPolicy::Append => {
            // Append is unusual for copy — treat as overwrite for now
            Ok(Some(dest.to_path_buf()))
        }
        ConflictPolicy::Ask => {
            if token.is_cancelled() {
                return Ok(None);
            }
            let resolution = on_conflict(src, dest);
            match &resolution {
                ConflictResolution::OverwriteAll => {
                    *override_all = Some(ConflictResolution::Overwrite);
                    Ok(Some(dest.to_path_buf()))
                }
                ConflictResolution::SkipAll => {
                    *override_all = Some(ConflictResolution::Skip);
                    Ok(None)
                }
                ConflictResolution::Cancel => {
                    token.cancel();
                    Ok(None)
                }
                other => apply_resolution(other, src, dest),
            }
        }
    }
}

pub(crate) fn apply_resolution(
    resolution: &ConflictResolution,
    _src: &Path,
    dest: &Path,
) -> Result<Option<PathBuf>, FsError> {
    match resolution {
        ConflictResolution::Overwrite | ConflictResolution::OverwriteAll => {
            Ok(Some(dest.to_path_buf()))
        }
        ConflictResolution::Skip | ConflictResolution::SkipAll => Ok(None),
        ConflictResolution::Rename(new_name) => {
            let parent = dest.parent().unwrap_or(dest);
            Ok(Some(parent.join(new_name)))
        }
        ConflictResolution::Cancel => Ok(None),
    }
}
