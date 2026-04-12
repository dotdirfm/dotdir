use crate::copy::CancelToken;
use crate::error::FsError;
use globset::{GlobBuilder, GlobMatcher};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchRequest {
    pub start_path: String,
    pub ignore_dirs_enabled: bool,
    #[serde(default)]
    pub ignore_dirs: Vec<String>,
    pub file_pattern: String,
    pub content_pattern: String,
    pub recursive: bool,
    pub follow_symlinks: bool,
    pub shell_patterns: bool,
    pub case_sensitive_file_name: bool,
    pub whole_words: bool,
    pub regex: bool,
    pub case_sensitive_content: bool,
    pub all_charsets: bool,
    pub first_hit: bool,
    pub skip_hidden: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchMatch {
    pub path: String,
    pub is_directory: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum FileSearchEvent {
    Match { r#match: FileSearchMatch },
    Done { found: u32 },
    Cancelled { found: u32 },
    Error { message: String, found: u32 },
}

enum NameMatcher {
    Any,
    Exact {
        pattern: String,
        case_sensitive: bool,
    },
    Glob(GlobMatcher),
}

impl NameMatcher {
    fn matches(&self, input: &str) -> bool {
        match self {
            NameMatcher::Any => true,
            NameMatcher::Exact {
                pattern,
                case_sensitive,
            } => {
                if *case_sensitive {
                    input.contains(pattern)
                } else {
                    input.to_lowercase().contains(&pattern.to_lowercase())
                }
            }
            NameMatcher::Glob(matcher) => matcher.is_match(input),
        }
    }
}

fn build_name_matcher(request: &FileSearchRequest) -> Result<NameMatcher, FsError> {
    let pattern = request.file_pattern.trim();
    if pattern.is_empty() || pattern == "*" {
        return Ok(NameMatcher::Any);
    }
    if request.shell_patterns {
        let glob = GlobBuilder::new(pattern)
            .case_insensitive(!request.case_sensitive_file_name)
            .build()
            .map_err(|_| FsError::InvalidInput)?;
        return Ok(NameMatcher::Glob(glob.compile_matcher()));
    }
    Ok(NameMatcher::Exact {
        pattern: pattern.to_string(),
        case_sensitive: request.case_sensitive_file_name,
    })
}

fn build_content_regex(request: &FileSearchRequest) -> Result<Option<Regex>, FsError> {
    let pattern = request.content_pattern.trim();
    if pattern.is_empty() {
        return Ok(None);
    }

    let source = if request.regex {
        pattern.to_string()
    } else {
        regex::escape(pattern)
    };
    let source = if request.whole_words {
        format!(r"\b(?:{})\b", source)
    } else {
        source
    };

    let regex = RegexBuilder::new(&source)
        .case_insensitive(!request.case_sensitive_content)
        .build()
        .map_err(|_| FsError::InvalidInput)?;
    Ok(Some(regex))
}

fn is_hidden(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with('.'))
        .unwrap_or(false)
}

fn normalize_ignored_dir(value: &str) -> String {
    value.trim_matches('/').trim().to_lowercase()
}

fn should_ignore_dir(path: &Path, ignored_dirs: &HashSet<String>) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| ignored_dirs.contains(&normalize_ignored_dir(name)))
        .unwrap_or(false)
}

fn read_file_matches(path: &Path, regex: &Regex, all_charsets: bool) -> bool {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    if all_charsets {
        let text = String::from_utf8_lossy(&bytes);
        regex.is_match(&text)
    } else {
        std::str::from_utf8(&bytes)
            .map(|text| regex.is_match(text))
            .unwrap_or(false)
    }
}

fn entry_matches(
    path: &Path,
    is_directory: bool,
    name_matcher: &NameMatcher,
    content_regex: Option<&Regex>,
    all_charsets: bool,
) -> bool {
    let file_name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if !name_matcher.matches(file_name) {
        return false;
    }
    match content_regex {
        None => true,
        Some(_) if is_directory => false,
        Some(regex) => read_file_matches(path, regex, all_charsets),
    }
}

pub fn search_files(
    request: &FileSearchRequest,
    cancel_token: &CancelToken,
    emit: impl Fn(FileSearchEvent),
) -> Result<(), FsError> {
    let start_path = PathBuf::from(&request.start_path);
    let name_matcher = build_name_matcher(request)?;
    let content_regex = build_content_regex(request)?;
    let ignored_dirs: HashSet<String> = request
        .ignore_dirs
        .iter()
        .map(|dir| normalize_ignored_dir(dir))
        .filter(|dir| !dir.is_empty())
        .collect();
    let mut found = 0u32;
    let mut stack = vec![start_path.clone()];
    let mut visited_dirs = HashSet::<PathBuf>::new();

    while let Some(path) = stack.pop() {
        if cancel_token.is_cancelled() {
            emit(FileSearchEvent::Cancelled { found });
            return Ok(());
        }

        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(err) => {
                emit(FileSearchEvent::Error {
                    message: err.to_string(),
                    found,
                });
                continue;
            }
        };

        let file_type = metadata.file_type();
        let mut is_directory = file_type.is_dir();

        if file_type.is_symlink() && request.follow_symlinks {
            if let Ok(target_meta) = fs::metadata(&path) {
                is_directory = target_meta.is_dir();
            }
        }

        if request.skip_hidden && path != start_path && is_hidden(&path) {
            continue;
        }

        if is_directory
            && request.ignore_dirs_enabled
            && path != start_path
            && should_ignore_dir(&path, &ignored_dirs)
        {
            continue;
        }

        if entry_matches(
            &path,
            is_directory,
            &name_matcher,
            content_regex.as_ref(),
            request.all_charsets,
        ) {
            found += 1;
            emit(FileSearchEvent::Match {
                r#match: FileSearchMatch {
                    path: path.to_string_lossy().into_owned(),
                    is_directory,
                },
            });
            if request.first_hit {
                emit(FileSearchEvent::Done { found });
                return Ok(());
            }
        }

        if !is_directory {
            continue;
        }

        if !request.recursive && path != start_path {
            continue;
        }

        let canonical = if request.follow_symlinks {
            path.canonicalize().unwrap_or_else(|_| path.clone())
        } else {
            path.clone()
        };
        if !visited_dirs.insert(canonical) {
            continue;
        }

        let entries = match fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(err) => {
                emit(FileSearchEvent::Error {
                    message: err.to_string(),
                    found,
                });
                continue;
            }
        };

        let mut children = Vec::new();
        for entry in entries.flatten() {
            children.push(entry.path());
        }
        children.sort();
        for child in children.into_iter().rev() {
            stack.push(child);
        }

        if !request.recursive {
            // Root children are already queued; no deeper directories needed.
            stack.retain(|queued| queued.parent() == Some(start_path.as_path()));
        }
    }

    emit(FileSearchEvent::Done { found });
    Ok(())
}
