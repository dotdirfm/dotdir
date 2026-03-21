/// Move/Rename engine.
///
/// Same-filesystem moves use `fs::rename()` (atomic, instant).
/// Cross-filesystem moves fall back to copy + delete, reusing the copy engine
/// for progress reporting and platform fast paths.

use crate::copy::{
    self, CancelToken, ConflictPolicy, ConflictResolution, CopyEvent, CopyOptions, CopyProgress,
    SymlinkMode,
};
use crate::error::FsError;
use log::debug;
use serde::{Deserialize, Serialize};
use std::cell::Cell;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

// ── Types ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveOptions {
    #[serde(default)]
    pub conflict_policy: ConflictPolicy,
}

impl Default for MoveOptions {
    fn default() -> Self {
        Self {
            conflict_policy: ConflictPolicy::default(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct MoveResult {
    pub files_moved: u32,
    pub bytes_moved: u64,
}

// ── Cross-device detection ──────────────────────────────────────────

fn is_cross_device_error(e: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        e.raw_os_error() == Some(libc::EXDEV)
    }
    #[cfg(windows)]
    {
        e.raw_os_error() == Some(17) // ERROR_NOT_SAME_DEVICE
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = e;
        false
    }
}

// ── Rename (in-place) ───────────────────────────────────────────────

/// Rename a file or directory within the same parent directory.
pub fn rename_item(source: &Path, new_name: &str) -> Result<PathBuf, FsError> {
    let parent = source.parent().ok_or(FsError::InvalidInput)?;
    let dest = parent.join(new_name);
    if dest.exists() {
        return Err(FsError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("'{}' already exists", dest.display()),
        )));
    }
    fs::rename(source, &dest).map_err(FsError::from_io)?;
    Ok(dest)
}

// ── Move tree ───────────────────────────────────────────────────────

/// Move one or more source paths into dest_dir.
///
/// Tries `fs::rename()` first. Falls back to copy + delete for cross-device moves.
pub fn move_tree(
    sources: &[PathBuf],
    dest_dir: &PathBuf,
    options: &MoveOptions,
    token: &CancelToken,
    on_progress: &dyn Fn(CopyEvent),
    on_conflict: &dyn Fn(&Path, &Path) -> ConflictResolution,
) -> Result<MoveResult, FsError> {
    // Self-move detection
    let canonical_dest = dest_dir.canonicalize().unwrap_or_else(|_| dest_dir.clone());
    for source in sources {
        let canonical_src = source.canonicalize().unwrap_or_else(|_| source.clone());
        if canonical_src.is_dir() && canonical_dest.starts_with(&canonical_src) {
            return Err(FsError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!(
                    "Cannot move '{}' into itself ('{}')",
                    source.display(),
                    dest_dir.display()
                ),
            )));
        }
    }

    let pre = copy::pre_walk(sources);
    debug!(
        "[move] starting: {} files, {} bytes",
        pre.total_files, pre.total_bytes
    );

    let bytes_moved = Cell::new(0u64);
    let files_done = Cell::new(0u32);
    let mut override_all: Option<ConflictResolution> = None;

    // Build CopyOptions for cross-device fallback (preserve everything)
    let copy_options = CopyOptions {
        conflict_policy: ConflictPolicy::Overwrite, // conflicts already handled by move_tree
        copy_permissions: true,
        copy_xattrs: true,
        sparse_files: false,
        use_cow: false,
        symlink_mode: SymlinkMode::Smart,
        disable_write_cache: false,
    };

    for source in sources {
        if token.is_cancelled() {
            break;
        }
        let source_name = source
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        let meta = fs::symlink_metadata(source).map_err(FsError::from_io)?;
        let dest_path = dest_dir.join(&source_name);

        // Handle conflict
        let actual_dest = copy::handle_conflict(
            source,
            &dest_path,
            &CopyOptions {
                conflict_policy: options.conflict_policy.clone(),
                ..copy_options.clone()
            },
            on_conflict,
            &mut override_all,
            token,
        )?;
        let actual_dest = match actual_dest {
            Some(d) => d,
            None => continue, // skipped
        };

        on_progress(CopyEvent::Progress(CopyProgress {
            bytes_copied: bytes_moved.get(),
            bytes_total: pre.total_bytes,
            files_done: files_done.get(),
            files_total: pre.total_files,
            current_file: source_name.clone(),
        }));

        // If dest already exists and we're overwriting, remove it first for rename to work
        if actual_dest.exists() {
            let dest_meta = fs::symlink_metadata(&actual_dest).map_err(FsError::from_io)?;
            if dest_meta.is_dir() {
                fs::remove_dir_all(&actual_dest).map_err(FsError::from_io)?;
            } else {
                fs::remove_file(&actual_dest).map_err(FsError::from_io)?;
            }
        }

        // Try rename first (same filesystem, atomic)
        match fs::rename(source, &actual_dest) {
            Ok(()) => {
                // Instant success — count all bytes/files
                if meta.is_dir() {
                    // Count the pre-walked contents
                    let sub_pre = copy::pre_walk(&[source.to_path_buf()]);
                    bytes_moved.set(bytes_moved.get() + sub_pre.total_bytes);
                    files_done.set(files_done.get() + sub_pre.total_files);
                } else if meta.file_type().is_symlink() {
                    files_done.set(files_done.get() + 1);
                } else {
                    bytes_moved.set(bytes_moved.get() + meta.len());
                    files_done.set(files_done.get() + 1);
                }
                continue;
            }
            Err(e) if is_cross_device_error(&e) => {
                // Fall through to copy + delete
            }
            Err(e) => return Err(FsError::from_io(e)),
        }

        // Cross-device fallback: copy + delete
        if meta.file_type().is_symlink() {
            copy::copy_symlink(source, &actual_dest, &copy_options)?;
            fs::remove_file(source).map_err(FsError::from_io)?;
            files_done.set(files_done.get() + 1);
        } else if meta.is_dir() {
            let mut visited_dirs = HashSet::new();
            if let Ok(canonical) = source.canonicalize() {
                visited_dirs.insert(canonical);
            }
            copy_dir_for_move(
                source,
                &actual_dest,
                &copy_options,
                token,
                &bytes_moved,
                &files_done,
                pre.total_files,
                pre.total_bytes,
                on_progress,
                &mut visited_dirs,
            )?;
            // Delete original directory tree
            if !token.is_cancelled() {
                fs::remove_dir_all(source).map_err(FsError::from_io)?;
            }
        } else {
            copy::copy_single_file(source, &actual_dest, &copy_options, token, &|delta| {
                bytes_moved.set(bytes_moved.get() + delta);
                on_progress(CopyEvent::Progress(CopyProgress {
                    bytes_copied: bytes_moved.get(),
                    bytes_total: pre.total_bytes,
                    files_done: files_done.get(),
                    files_total: pre.total_files,
                    current_file: source_name.clone(),
                }));
            })?;
            fs::remove_file(source).map_err(FsError::from_io)?;
            files_done.set(files_done.get() + 1);
        }
    }

    let result = MoveResult {
        files_moved: files_done.get(),
        bytes_moved: bytes_moved.get(),
    };
    on_progress(CopyEvent::Done {
        files_done: files_done.get(),
        bytes_copied: bytes_moved.get(),
    });
    debug!(
        "[move] done: {} files, {} bytes",
        result.files_moved, result.bytes_moved
    );
    Ok(result)
}

/// Copy a directory recursively for cross-device move (no conflict handling — already resolved).
fn copy_dir_for_move(
    src_dir: &Path,
    dest_dir: &Path,
    options: &CopyOptions,
    token: &CancelToken,
    bytes_copied: &Cell<u64>,
    files_done: &Cell<u32>,
    files_total: u32,
    bytes_total: u64,
    on_progress: &dyn Fn(CopyEvent),
    visited_dirs: &mut HashSet<PathBuf>,
) -> Result<(), FsError> {
    if token.is_cancelled() {
        return Ok(());
    }

    fs::create_dir_all(dest_dir).map_err(FsError::from_io)?;
    let _ = copy::copy_permissions(src_dir, dest_dir);

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
                debug!("[move] skipping {:?}: {}", src_path, e);
                continue;
            }
        };

        if meta.file_type().is_symlink() {
            copy::copy_symlink(&src_path, &dest_path, options)?;
            files_done.set(files_done.get() + 1);
        } else if meta.is_dir() {
            let canonical = match src_path.canonicalize() {
                Ok(c) => c,
                Err(e) => {
                    debug!(
                        "[move] skipping {:?}: cannot canonicalize: {}",
                        src_path, e
                    );
                    continue;
                }
            };
            if !visited_dirs.insert(canonical) {
                debug!("[move] skipping {:?}: symlink loop detected", src_path);
                continue;
            }
            copy_dir_for_move(
                &src_path,
                &dest_path,
                options,
                token,
                bytes_copied,
                files_done,
                files_total,
                bytes_total,
                on_progress,
                visited_dirs,
            )?;
        } else {
            on_progress(CopyEvent::Progress(CopyProgress {
                bytes_copied: bytes_copied.get(),
                bytes_total,
                files_done: files_done.get(),
                files_total,
                current_file: entry_name.clone(),
            }));
            copy::copy_single_file(&src_path, &dest_path, options, token, &|delta| {
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
    Ok(())
}
