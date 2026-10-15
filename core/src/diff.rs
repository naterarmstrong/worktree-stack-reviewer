//! Diffs between trees, and between a tree and a worktree's uncommitted state.
//!
//! `git diff <commit>` compares a commit against the files on disk. Here the
//! files on disk are first turned into a tree — HEAD's tree with the index's
//! changes and then the worktree's edits applied over it — and the two trees
//! are diffed like any others. The blobs and trees that takes are written to
//! an in-memory overlay of the object database, so nothing reaches `.git`.

use crate::patch::{self, Kind, Side};
use anyhow::{Context, Result, anyhow};
use gix::bstr::{BStr, ByteSlice};
use gix::object::tree::EntryKind;
use gix::objs::tree::EntryMode;
use gix::status::index_worktree::Item as WtItem;
use gix::status::plumbing::index_as_worktree::{Change as WtChange, EntryStatus};
use gix::{ObjectId, Repository};
use serde::Serialize;
use std::collections::BTreeSet;
use std::io::Read;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub status: &'static str,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub removed: Option<u32>,
}

/// One change with its patch section, before it's split into the two.
pub struct Rendered {
    pub file: FileChange,
    pub patch: Option<String>,
}

pub fn rewrites() -> gix::diff::Rewrites {
    // `--find-renames` at git's defaults: 50% similar, at most 1000 candidates
    // a side, no copies.
    gix::diff::Rewrites { copies: None, percentage: Some(0.5), limit: 1000, track_empty: false }
}

/// Every file-level change from `old` to `new`, with renames paired up.
pub fn tree_changes(repo: &Repository, old: ObjectId, new: ObjectId) -> Result<Vec<gix::object::tree::diff::ChangeDetached>> {
    let old = repo.find_tree(old).context("reading the base tree")?;
    let new = repo.find_tree(new).context("reading the changed tree")?;
    let mut opts = gix::diff::Options::default();
    opts.track_path();
    opts.track_rewrites(Some(rewrites()));
    let changes = repo.diff_tree_to_tree(&old, &new, opts)?;
    // Trees are reported as well as the files in them; a diff lists files.
    Ok(changes.into_iter().filter(|c| !c.entry_mode().is_tree()).collect())
}

fn kind_of(mode: EntryMode) -> &'static str {
    if mode.is_link() {
        "link"
    } else if mode.is_commit() {
        "commit"
    } else {
        "blob"
    }
}

fn path_str(p: &BStr) -> String {
    p.to_str_lossy().into_owned()
}

fn mode_bits(mode: EntryMode) -> u32 {
    mode.value() as u32
}

/// What a side of a change reads as: a blob's bytes, or a submodule's commit.
fn side_data(repo: &Repository, id: ObjectId, mode: EntryMode) -> Result<Vec<u8>> {
    if mode.is_commit() {
        return Ok(id.to_hex().to_string().into_bytes());
    }
    Ok(repo.find_object(id)?.detach().data)
}

fn short(repo: &Repository, id: ObjectId) -> String {
    gix::prelude::ObjectIdExt::attach(id, repo).shorten_or_id().to_string()
}

/// Status letter, counts and (when `with_patch`) patch text for each change.
pub fn render(
    repo: &Repository,
    changes: &[gix::object::tree::diff::ChangeDetached],
    with_patch: bool,
) -> Result<Vec<Rendered>> {
    use gix::object::tree::diff::ChangeDetached as C;
    let mut out = Vec::with_capacity(changes.len());
    for change in changes {
        let (kind, status, old, new) = match change {
            C::Addition { location, entry_mode, id, .. } => (Kind::Added, "A", None, Some((path_str(location.as_ref()), *entry_mode, *id))),
            C::Deletion { location, entry_mode, id, .. } => (Kind::Deleted, "D", Some((path_str(location.as_ref()), *entry_mode, *id)), None),
            C::Modification { location, previous_entry_mode, previous_id, entry_mode, id } => {
                let path = path_str(location.as_ref());
                let status = if kind_of(*previous_entry_mode) == kind_of(*entry_mode) { "M" } else { "T" };
                (Kind::Modified, status, Some((path.clone(), *previous_entry_mode, *previous_id)), Some((path, *entry_mode, *id)))
            }
            C::Rewrite { source_location, source_entry_mode, source_id, diff, entry_mode, id, location, copy, .. } => {
                let similarity = if source_id == id {
                    100
                } else {
                    diff.map_or(0, |d| (d.similarity * 100.0).floor() as u32).min(99)
                };
                (
                    Kind::Renamed { similarity, copy: *copy },
                    if *copy { "C" } else { "R" },
                    Some((path_str(source_location.as_ref()), *source_entry_mode, *source_id)),
                    Some((path_str(location.as_ref()), *entry_mode, *id)),
                )
            }
        };
        let path = new.as_ref().or(old.as_ref()).map(|s| s.0.clone()).unwrap_or_default();
        let old_path = match (&kind, &old) {
            (Kind::Renamed { .. }, Some(o)) => Some(o.0.clone()),
            _ => None,
        };
        let old_data = old.as_ref().map(|(_, m, id)| side_data(repo, *id, *m)).transpose()?;
        let new_data = new.as_ref().map(|(_, m, id)| side_data(repo, *id, *m)).transpose()?;
        let submodule = old.as_ref().is_some_and(|s| s.1.is_commit()) || new.as_ref().is_some_and(|s| s.1.is_commit());
        let old_side = old.as_ref().map(|(p, m, id)| Side {
            path: p,
            mode: mode_bits(*m),
            short_id: short(repo, *id),
            data: old_data.as_deref().unwrap_or_default(),
        });
        let new_side = new.as_ref().map(|(p, m, id)| Side {
            path: p,
            mode: mode_bits(*m),
            short_id: short(repo, *id),
            data: new_data.as_deref().unwrap_or_default(),
        });
        let rendered = patch::render(&kind, old_side.as_ref(), new_side.as_ref(), submodule);
        out.push(Rendered {
            file: FileChange {
                status,
                path,
                old_path,
                added: rendered.counts.map(|c| c.0),
                removed: rendered.counts.map(|c| c.1),
            },
            patch: with_patch.then_some(rendered.patch),
        });
    }
    // Rename tracking reports paired renames after everything else; git lists
    // a diff in path order.
    out.sort_by(|a, b| a.file.path.cmp(&b.file.path));
    Ok(out)
}

pub fn peel_to_commit(repo: &Repository, spec: &str) -> Result<ObjectId> {
    Ok(repo
        .rev_parse_single(spec)
        .with_context(|| format!("unknown revision {spec}"))?
        .object()?
        .peel_to_commit()
        .with_context(|| format!("{spec} is not a commit"))?
        .id)
}

pub fn peel_to_tree(repo: &Repository, spec: &str) -> Result<ObjectId> {
    Ok(repo
        .rev_parse_single(spec)
        .with_context(|| format!("unknown revision {spec}"))?
        .object()?
        .peel_to_tree()
        .with_context(|| format!("{spec} has no tree"))?
        .id)
}

pub fn merge_base(repo: &Repository, a: ObjectId, b: ObjectId) -> Result<ObjectId> {
    repo.merge_base(a, b)?
        .map(|id| id.detach())
        .ok_or_else(|| anyhow!("no merge base between {a} and {b}"))
}

pub fn commit_tree(repo: &Repository, commit: ObjectId) -> Result<ObjectId> {
    Ok(repo.find_commit(commit)?.tree_id()?.detach())
}

/// What a worktree holds beyond HEAD.
pub struct WorktreeState {
    /// HEAD's tree with staged and unstaged edits applied, in object memory.
    pub tree: ObjectId,
    /// Tracked paths whose content differs from HEAD, staged or not.
    pub dirty: BTreeSet<String>,
    /// Untracked, unignored files, one entry per file.
    pub untracked: Vec<String>,
}

/// `repo` must have object memory enabled, which is where the edited blobs
/// and trees are written.
pub fn worktree_state(repo: &Repository) -> Result<WorktreeState> {
    let head_tree = repo.head_tree_id_or_empty()?.detach();
    let workdir = repo.workdir().ok_or_else(|| anyhow!("repository has no worktree"))?.to_path_buf();
    let index = repo.index_or_empty()?;
    let (mut pipeline, _) = repo.filter_pipeline(Some(head_tree))?;

    let items: Vec<gix::status::Item> = repo
        .status(gix::progress::Discard)?
        .untracked_files(gix::status::UntrackedFiles::Files)
        .index_worktree_rewrites(None)
        .tree_index_track_renames(gix::status::tree_index::TrackRenames::Disabled)
        .index_worktree_submodules(gix::status::Submodule::Given {
            ignore: gix::submodule::config::Ignore::All,
            check_dirty: false,
        })
        .into_iter(None)?
        .collect::<std::result::Result<_, _>>()?;

    let mut editor = repo.edit_tree(head_tree)?;
    let mut dirty = BTreeSet::new();
    let mut untracked = Vec::new();

    // The index's view of HEAD first, so the worktree's own edits land on top.
    for item in &items {
        let gix::status::Item::TreeIndex(change) = item else { continue };
        use gix::diff::index::ChangeRef as T;
        match change {
            T::Addition { location, entry_mode, id, .. } | T::Modification { location, entry_mode, id, .. } => {
                editor.upsert(location.as_ref(), entry_kind(*entry_mode), id.as_ref().to_owned())?;
                dirty.insert(path_str(location.as_ref()));
            }
            T::Deletion { location, .. } => {
                editor.remove(location.as_ref())?;
                dirty.insert(path_str(location.as_ref()));
            }
            T::Rewrite { source_location, location, entry_mode, id, .. } => {
                editor.remove(source_location.as_ref())?;
                editor.upsert(location.as_ref(), entry_kind(*entry_mode), id.as_ref().to_owned())?;
                dirty.insert(path_str(source_location.as_ref()));
                dirty.insert(path_str(location.as_ref()));
            }
        }
    }

    for item in items {
        let gix::status::Item::IndexWorktree(item) = item else { continue };
        match item {
            WtItem::Modification { entry, rela_path, status, .. } => {
                let path = path_str(rela_path.as_ref());
                let mode = match &status {
                    EntryStatus::NeedsUpdate(_) => continue,
                    EntryStatus::Change(WtChange::Removed) => {
                        editor.remove(rela_path.as_bstr())?;
                        dirty.insert(path);
                        continue;
                    }
                    EntryStatus::Change(WtChange::SubmoduleModification(_)) => continue,
                    EntryStatus::Change(WtChange::Type { worktree_mode }) => *worktree_mode,
                    EntryStatus::Change(WtChange::Modification { executable_bit_changed, .. }) => {
                        if *executable_bit_changed {
                            toggle_executable(entry.mode)
                        } else {
                            entry.mode
                        }
                    }
                    EntryStatus::Conflict { .. } | EntryStatus::IntentToAdd => entry.mode,
                };
                let id = hash_worktree_file(repo, &mut pipeline, &workdir, &path, mode, &index)?;
                editor.upsert(rela_path.as_bstr(), entry_kind(mode), id)?;
                dirty.insert(path);
            }
            WtItem::DirectoryContents { entry, .. } => {
                if entry.status == gix::dir::entry::Status::Untracked
                    && matches!(entry.disk_kind, Some(gix::dir::entry::Kind::File | gix::dir::entry::Kind::Symlink))
                {
                    untracked.push(path_str(entry.rela_path.as_ref()));
                }
            }
            WtItem::Rewrite { .. } => {}
        }
    }

    let tree = editor.write()?.detach();
    Ok(WorktreeState { tree, dirty, untracked })
}

fn toggle_executable(mode: gix::index::entry::Mode) -> gix::index::entry::Mode {
    use gix::index::entry::Mode;
    if mode == Mode::FILE_EXECUTABLE { Mode::FILE } else if mode == Mode::FILE { Mode::FILE_EXECUTABLE } else { mode }
}

fn entry_kind(mode: gix::index::entry::Mode) -> EntryKind {
    use gix::index::entry::Mode;
    if mode == Mode::SYMLINK {
        EntryKind::Link
    } else if mode == Mode::COMMIT {
        EntryKind::Commit
    } else if mode == Mode::DIR {
        EntryKind::Tree
    } else if mode == Mode::FILE_EXECUTABLE {
        EntryKind::BlobExecutable
    } else {
        EntryKind::Blob
    }
}

/// The blob a worktree file would be committed as: a symlink's target, or the
/// file run through the repository's to-git filters (line endings, `ident`,
/// clean filters such as LFS), the way `git diff` reads it.
fn hash_worktree_file(
    repo: &Repository,
    pipeline: &mut gix::filter::Pipeline<'_>,
    workdir: &std::path::Path,
    rela_path: &str,
    mode: gix::index::entry::Mode,
    index: &gix::index::State,
) -> Result<ObjectId> {
    let abs = workdir.join(rela_path);
    let data = if mode == gix::index::entry::Mode::SYMLINK {
        let target = std::fs::read_link(&abs)?;
        gix::path::into_bstr(target)?.into_owned().into()
    } else {
        let file = std::fs::File::open(&abs).with_context(|| format!("reading {}", abs.display()))?;
        let mut buf = Vec::new();
        use gix::filter::plumbing::pipeline::convert::ToGitOutcome;
        match pipeline.convert_to_git(file, std::path::Path::new(rela_path), index)? {
            ToGitOutcome::Unchanged(mut r) => {
                r.read_to_end(&mut buf)?;
            }
            ToGitOutcome::Buffer(b) => buf.extend_from_slice(b),
            ToGitOutcome::Process(mut r) => {
                r.read_to_end(&mut buf)?;
            }
        }
        buf
    };
    Ok(repo.write_blob(data)?.detach())
}
