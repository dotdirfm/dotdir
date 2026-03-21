/// Recursive delete engine with progress reporting and cancellation.

use crate::copy::CancelToken;
use crate::error::FsError;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

const PROGRESS_INTERVAL_MS: u128 = 100;

/// Event emitted to the frontend during deletion.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum DeleteEvent {
    Progress {
        #[serde(rename = "filesDone")]
        files_done: u64,
        #[serde(rename = "currentFile")]
        current_file: String,
    },
    Done {
        #[serde(rename = "filesDone")]
        files_done: u64,
    },
    Error {
        message: String,
    },
}

/// Recursively delete all given paths, emitting progress events roughly every
/// 100 ms. Always emits a `Done` event on completion or cancellation.
pub fn delete_recursive(
    paths: &[PathBuf],
    cancel_token: &CancelToken,
    emit_progress: &impl Fn(DeleteEvent),
) -> Result<(), FsError> {
    let mut files_done: u64 = 0;
    let mut last_emit = Instant::now();

    for path in paths {
        if cancel_token.is_cancelled() {
            break;
        }
        if let Err(e) = delete_one(path, &mut files_done, &mut last_emit, cancel_token, emit_progress) {
            emit_progress(DeleteEvent::Error { message: e.to_string() });
            return Ok(());
        }
    }

    emit_progress(DeleteEvent::Done { files_done });
    Ok(())
}

fn delete_one(
    path: &Path,
    files_done: &mut u64,
    last_emit: &mut Instant,
    cancel_token: &CancelToken,
    emit_progress: &impl Fn(DeleteEvent),
) -> Result<(), FsError> {
    if cancel_token.is_cancelled() {
        return Ok(());
    }

    let meta = fs::symlink_metadata(path).map_err(FsError::from_io)?;

    if meta.is_dir() {
        let mut children: Vec<PathBuf> = fs::read_dir(path)
            .map_err(FsError::from_io)?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .collect();
        children.sort();

        for child in children {
            if cancel_token.is_cancelled() {
                return Ok(());
            }
            delete_one(&child, files_done, last_emit, cancel_token, emit_progress)?;
        }

        fs::remove_dir(path).map_err(FsError::from_io)?;
    } else {
        fs::remove_file(path).map_err(FsError::from_io)?;
    }

    *files_done += 1;

    if last_emit.elapsed().as_millis() >= PROGRESS_INTERVAL_MS {
        emit_progress(DeleteEvent::Progress {
            files_done: *files_done,
            current_file: path.to_string_lossy().into_owned(),
        });
        *last_emit = Instant::now();
    }

    Ok(())
}
