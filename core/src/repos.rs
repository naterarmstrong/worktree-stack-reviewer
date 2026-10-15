use anyhow::{Context, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Repositories opened so far, one per path the extension asked about.
///
/// Opening reads every config file and maps nothing yet; what makes a warm
/// handle worth keeping is the object database behind it, whose pack indices
/// are mapped on first use. A kept handle still sees refs move: loose refs are
/// read from disk on each lookup, `packed-refs` is re-read when it changes, and
/// a pack a fetch adds is picked up the first time an object misses.
#[derive(Default)]
pub struct Repos {
    open: Mutex<HashMap<PathBuf, gix::ThreadSafeRepository>>,
}

/// Enough to keep commit lookups during a merge-base walk off the disk.
const OBJECT_CACHE_BYTES: usize = 16 * 1024 * 1024;

impl Repos {
    pub fn get(&self, path: &Path) -> Result<gix::Repository> {
        let cached = self.lock().get(path).cloned();
        let shared = match cached {
            Some(shared) => shared,
            None => {
                let shared = gix::ThreadSafeRepository::discover(path)
                    .with_context(|| format!("no git repository at {}", path.display()))?;
                self.lock().insert(path.to_path_buf(), shared.clone());
                shared
            }
        };
        let mut repo = shared.to_thread_local();
        repo.object_cache_size_if_unset(OBJECT_CACHE_BYTES);
        Ok(repo)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<PathBuf, gix::ThreadSafeRepository>> {
        self.open.lock().unwrap_or_else(|p| p.into_inner())
    }
}
