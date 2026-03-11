/// Directory watching using the `notify` crate.
///
/// Directory watching using the `notify` crate.
/// The `notify` crate abstracts all platform backends (FSEvents, kqueue,
/// inotify, ReadDirectoryChangesW) behind a single RecommendedWatcher.
use notify::{self, RecommendedWatcher, RecursiveMode, Watcher as NotifyWatcher};
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

/// Event kind — matches the canonical strings used throughout the codebase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    Appeared,
    Disappeared,
    Modified,
    Errored,
    Unknown,
}

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Appeared => "appeared",
            Self::Disappeared => "disappeared",
            Self::Modified => "modified",
            Self::Errored => "errored",
            Self::Unknown => "unknown",
        }
    }
}

/// Callback invoked for each watch event.
/// Parameters: (watch_id, event_kind, filename or None)
pub type EventCallback = Arc<dyn Fn(&str, EventKind, Option<&str>) + Send + Sync>;

struct WatchEntry {
    path: PathBuf,
}

/// File system watcher that maps watch IDs to directory paths.
pub struct FsWatcher {
    watcher: Mutex<RecommendedWatcher>,
    watches: Mutex<HashMap<String, WatchEntry>>,
    /// Shared with the notify callback closure for routing events.
    path_to_ids: Arc<Mutex<HashMap<PathBuf, HashSet<String>>>>,
}

impl FsWatcher {
    /// Create a new watcher. The callback fires on a background thread for
    /// each filesystem event detected.
    pub fn new(cb: EventCallback) -> notify::Result<Self> {
        let path_to_ids: Arc<Mutex<HashMap<PathBuf, HashSet<String>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let path_map = path_to_ids.clone();

        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let event = match res {
                Ok(ev) => ev,
                Err(_) => return,
            };

            let kind = match event.kind {
                notify::EventKind::Create(_) => EventKind::Appeared,
                notify::EventKind::Remove(_) => EventKind::Disappeared,
                notify::EventKind::Modify(_) => EventKind::Modified,
                _ => EventKind::Unknown,
            };

            let map = path_map.lock();
            for path in &event.paths {
                // The event path is the full path to the changed file.
                // Find which watched directory it belongs to and extract the filename.
                if let Some(parent) = path.parent() {
                    let parent_buf = parent.to_path_buf();
                    if let Some(watch_ids) = map.get(&parent_buf) {
                        let name = path.file_name().map(|n| n.to_string_lossy());
                        for watch_id in watch_ids {
                            cb(watch_id, kind, name.as_deref());
                        }
                    }
                }
            }
        })?;

        Ok(Self {
            watcher: Mutex::new(watcher),
            watches: Mutex::new(HashMap::new()),
            path_to_ids,
        })
    }

    /// Start watching a directory. Returns true on success.
    pub fn add(&self, watch_id: &str, dir_path: &str) -> bool {
        // Canonicalize to resolve symlinks (macOS /var → /private/var)
        // so event paths from notify match our stored path.
        let path = PathBuf::from(dir_path)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(dir_path));

        // Remove existing watch with this ID first
        self.remove(watch_id);

        // Only register with notify if this path isn't already watched
        {
            let ids = self.path_to_ids.lock();
            let already_watched = ids.get(&path).is_some_and(|s| !s.is_empty());
            if !already_watched {
                if self
                    .watcher
                    .lock()
                    .watch(&path, RecursiveMode::NonRecursive)
                    .is_err()
                {
                    return false;
                }
            }
        }

        self.path_to_ids
            .lock()
            .entry(path.clone())
            .or_default()
            .insert(watch_id.to_string());
        self.watches
            .lock()
            .insert(watch_id.to_string(), WatchEntry { path });
        true
    }

    /// Stop watching a directory by watch ID.
    pub fn remove(&self, watch_id: &str) {
        if let Some(entry) = self.watches.lock().remove(watch_id) {
            let mut ids = self.path_to_ids.lock();
            if let Some(set) = ids.get_mut(&entry.path) {
                set.remove(watch_id);
                if set.is_empty() {
                    ids.remove(&entry.path);
                    let _ = self.watcher.lock().unwatch(&entry.path);
                }
            }
        }
    }
}

// ── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    #[test]
    fn watcher_creation() {
        let cb: EventCallback = Arc::new(|_id, _kind, _name| {});
        let watcher = FsWatcher::new(cb);
        assert!(watcher.is_ok());
    }

    #[test]
    fn watch_and_unwatch() {
        let cb: EventCallback = Arc::new(|_id, _kind, _name| {});
        let watcher = FsWatcher::new(cb).unwrap();

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();

        assert!(watcher.add("test-1", path));
        watcher.remove("test-1");
        // Removing again should be a no-op
        watcher.remove("test-1");
    }

    #[test]
    fn watch_nonexistent_dir() {
        let cb: EventCallback = Arc::new(|_id, _kind, _name| {});
        let watcher = FsWatcher::new(cb).unwrap();
        assert!(!watcher.add("bad", "/nonexistent/path/that/doesnt/exist"));
    }

    #[test]
    fn watch_detects_file_creation() {
        let got_event = Arc::new(AtomicBool::new(false));
        let got_event_clone = got_event.clone();

        let cb: EventCallback = Arc::new(move |_id, kind, _name| {
            if kind == EventKind::Appeared || kind == EventKind::Modified {
                got_event_clone.store(true, Ordering::SeqCst);
            }
        });

        let watcher = FsWatcher::new(cb).unwrap();
        let dir = tempfile::tempdir().unwrap();
        // Canonicalize to resolve symlinks (macOS /var → /private/var)
        let canonical = dir.path().canonicalize().unwrap();
        assert!(watcher.add("w1", canonical.to_str().unwrap()));

        // Create a file in the watched directory
        std::fs::File::create(canonical.join("new_file.txt")).unwrap();

        // Wait for the event (FSEvents on macOS can have ~2s latency)
        for _ in 0..50 {
            if got_event.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(got_event.load(Ordering::SeqCst));
    }

    /// Verify that passing a non-canonical path (e.g. /tmp → /private/tmp on macOS)
    /// still detects events correctly.
    #[test]
    fn watch_non_canonical_path() {
        let got = Arc::new(AtomicBool::new(false));
        let got_clone = got.clone();

        let cb: EventCallback = Arc::new(move |_id, kind, _name| {
            if kind == EventKind::Appeared || kind == EventKind::Modified {
                got_clone.store(true, Ordering::SeqCst);
            }
        });

        let watcher = FsWatcher::new(cb).unwrap();
        let dir = tempfile::tempdir().unwrap();
        // Use the raw (potentially non-canonical) path
        assert!(watcher.add("w1", dir.path().to_str().unwrap()));

        std::thread::sleep(Duration::from_millis(500));

        let canonical = dir.path().canonicalize().unwrap();
        std::fs::File::create(canonical.join("test.txt")).unwrap();

        for _ in 0..50 {
            if got.load(Ordering::SeqCst) { break; }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(got.load(Ordering::SeqCst));
    }

    /// Two watches on the same directory must both receive events,
    /// and removing one must not break the other.
    #[test]
    fn dual_watch_same_directory() {
        use std::sync::atomic::AtomicU32;

        let count_a = Arc::new(AtomicU32::new(0));
        let count_b = Arc::new(AtomicU32::new(0));
        let ca = count_a.clone();
        let cb_count = count_b.clone();

        let cb: EventCallback = Arc::new(move |id, kind, _name| {
            if kind == EventKind::Appeared || kind == EventKind::Modified {
                match id {
                    "w-a" => { ca.fetch_add(1, Ordering::SeqCst); }
                    "w-b" => { cb_count.fetch_add(1, Ordering::SeqCst); }
                    _ => {}
                }
            }
        });

        let watcher = FsWatcher::new(cb).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let canonical = dir.path().canonicalize().unwrap();
        let path = canonical.to_str().unwrap();

        assert!(watcher.add("w-a", path));
        assert!(watcher.add("w-b", path));

        std::thread::sleep(Duration::from_millis(500));

        // Both watches should receive the event
        std::fs::File::create(canonical.join("file1.txt")).unwrap();

        for _ in 0..50 {
            if count_a.load(Ordering::SeqCst) > 0 && count_b.load(Ordering::SeqCst) > 0 {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(count_a.load(Ordering::SeqCst) > 0, "watch A must receive events");
        assert!(count_b.load(Ordering::SeqCst) > 0, "watch B must receive events");

        // Remove one watch — the other must keep working
        watcher.remove("w-a");
        count_b.store(0, Ordering::SeqCst);

        std::fs::File::create(canonical.join("file2.txt")).unwrap();

        for _ in 0..50 {
            if count_b.load(Ordering::SeqCst) > 0 { break; }
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(count_b.load(Ordering::SeqCst) > 0, "watch B must still work after A removed");
    }
}
