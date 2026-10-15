//! The requests the extension can make, one function each.

use crate::diff::{self, FileChange};
use crate::patch;
use crate::repos::Repos;
use anyhow::{Result, anyhow, bail};
use gix::bstr::ByteSlice;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

pub fn dispatch(repos: &Repos, method: &str, params: Value) -> Result<Value> {
    fn p<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T> {
        Ok(serde_json::from_value(params)?)
    }
    Ok(match method {
        "worktrees" => json!(worktrees(repos, &p::<Repo>(params)?.repo)?),
        "gitDirs" => json!(git_dirs(repos, &p::<Repo>(params)?.repo)?),
        "changedFiles" => json!(changed_files(repos, p(params)?)?),
        "diffNameStatus" => json!(diff_name_status(repos, p(params)?)?),
        "revParse" => {
            let a: RevParse = p(params)?;
            json!(repos.get(&a.repo)?.rev_parse_single(a.rev.as_str())?.to_string())
        }
        "showFile" => json!(show_file(repos, p(params)?)?),
        "mergeBase" => {
            let a: TwoRevs = p(params)?;
            let repo = repos.get(&a.repo)?;
            let left = diff::peel_to_commit(&repo, &a.left)?;
            let right = diff::peel_to_commit(&repo, &a.right)?;
            json!(diff::merge_base(&repo, left, right)?.to_string())
        }
        "currentBranch" => json!(current_branch(&repos.get(&p::<Repo>(params)?.repo)?)?),
        "localBranches" => json!(local_branches(&repos.get(&p::<Repo>(params)?.repo)?)?),
        "config" => {
            let a: Config = p(params)?;
            // Opened fresh rather than from the cache: a kept handle holds the
            // config it was opened with.
            let repo = gix::discover(&a.repo)?;
            json!(repo.config_snapshot().string(a.key.as_str()).map(|v| v.to_str_lossy().into_owned()))
        }
        "uncommitted" => json!(uncommitted(&repos.get(&p::<Repo>(params)?.repo)?)?),
        "ping" => json!("pong"),
        other => bail!("unknown method {other}"),
    })
}

#[derive(Deserialize)]
struct Repo {
    repo: PathBuf,
}

#[derive(Deserialize)]
struct RevParse {
    repo: PathBuf,
    rev: String,
}

#[derive(Deserialize)]
struct TwoRevs {
    repo: PathBuf,
    left: String,
    right: String,
}

#[derive(Deserialize)]
struct Config {
    repo: PathBuf,
    key: String,
}

#[derive(Serialize)]
struct Worktree {
    path: String,
    branch: String,
    head: String,
}

/// Worktrees with a branch checked out, main worktree first and the rest in
/// path order, the way `git worktree list` gives them. A detached worktree is
/// left out, as is a main worktree in a bare repository.
fn worktrees(repos: &Repos, path: &Path) -> Result<Vec<Worktree>> {
    let repo = repos.get(path)?;
    let mut out = Vec::new();
    let common = std::fs::canonicalize(repo.common_dir())?;
    let main_repo = gix::open(&common)?;
    if let Some(dir) = main_repo.workdir()
        && let Some(wt) = describe_worktree(&main_repo, std::fs::canonicalize(dir)?)
    {
        out.push(wt);
    }
    let mut linked = Vec::new();
    for proxy in repo.worktrees()? {
        let Ok(base) = proxy.base() else { continue };
        let Ok(linked_repo) = proxy.into_repo_with_possibly_inaccessible_worktree() else { continue };
        if let Some(wt) = describe_worktree(&linked_repo, base) {
            linked.push(wt);
        }
    }
    linked.sort_by(|a, b| a.path.cmp(&b.path));
    out.extend(linked);
    Ok(out)
}

fn describe_worktree(repo: &gix::Repository, path: PathBuf) -> Option<Worktree> {
    let head = repo.head().ok()?;
    let branch = head.referent_name()?.shorten().to_str_lossy().into_owned();
    let id = head.id().map_or_else(|| repo.object_hash().null(), |id| id.detach());
    Some(Worktree { path: path.to_string_lossy().into_owned(), branch, head: id.to_string() })
}

fn absolute(base: &Path, p: &Path) -> PathBuf {
    let joined = if p.is_absolute() { p.to_path_buf() } else { base.join(p) };
    std::fs::canonicalize(&joined).unwrap_or(joined)
}

/// The worktree's own gitdir and the shared one, which is what a watcher needs
/// to see HEAD move and refs change.
fn git_dirs(repos: &Repos, path: &Path) -> Result<Value> {
    let repo = repos.get(path)?;
    let cwd = std::env::current_dir()?;
    Ok(json!({
        "gitDir": absolute(&cwd, repo.git_dir()).to_string_lossy(),
        "commonDir": absolute(&cwd, repo.common_dir()).to_string_lossy(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangedArgs {
    worktree: PathBuf,
    base: String,
    include_uncommitted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedFile {
    #[serde(flatten)]
    change: FileChange,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    uncommitted: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    generated: bool,
    /// Only for untracked files, which have no diff to take a patch id from.
    #[serde(skip_serializing_if = "Option::is_none")]
    content_hash: Option<String>,
}

#[derive(Serialize)]
struct Changed {
    files: Vec<ChangedFile>,
    /// `git diff -U0 --find-renames` text for the tracked changes, from which
    /// the extension derives each file's patch id.
    patch: String,
}

/// What a worktree changes relative to where it left `base`: committed changes
/// only (`base...HEAD`), or with staged, unstaged and untracked files too.
fn changed_files(repos: &Repos, args: ChangedArgs) -> Result<Changed> {
    let repo = repos.get(&args.worktree)?.with_object_memory();
    let head = repo.head_id()?.detach();
    let base = diff::peel_to_commit(&repo, &args.base)?;
    let left = diff::commit_tree(&repo, diff::merge_base(&repo, head, base)?)?;
    let (right, state) = if args.include_uncommitted {
        let state = diff::worktree_state(&repo)?;
        (state.tree, Some(state))
    } else {
        (diff::commit_tree(&repo, head)?, None)
    };

    let changes = diff::tree_changes(&repo, left, right)?;
    let rendered = diff::render(&repo, &changes, true)?;
    let mut patch_text = String::new();
    let mut files = Vec::with_capacity(rendered.len());
    for r in rendered {
        if let Some(p) = r.patch {
            patch_text.push_str(&p);
        }
        files.push(ChangedFile { change: r.file, uncommitted: false, generated: false, content_hash: None });
    }

    if let Some(state) = state {
        let workdir = repo.workdir().ok_or_else(|| anyhow!("repository has no worktree"))?;
        for path in &state.untracked {
            let (lines, hash) = untracked_stats(&workdir.join(path));
            files.push(ChangedFile {
                change: FileChange {
                    status: "A",
                    path: path.clone(),
                    added: lines,
                    removed: lines.map(|_| 0),
                    ..Default::default()
                },
                uncommitted: true,
                generated: false,
                content_hash: hash,
            });
        }
        for file in &mut files {
            if state.dirty.contains(&file.change.path) {
                file.uncommitted = true;
            }
        }
    }

    let paths: Vec<String> = files.iter().map(|f| f.change.path.clone()).collect();
    let generated = generated_paths(&repo, &paths)?;
    for file in &mut files {
        file.generated = generated.contains(&file.change.path);
    }
    Ok(Changed { files, patch: patch_text })
}

/// Untracked files above this size are reported without a line count.
const MAX_COUNTED_BYTES: u64 = 4 * 1024 * 1024;

/// Line count and content hash of an untracked file, from one read. A binary
/// file gets only the hash; an oversized or unreadable one gets neither.
fn untracked_stats(path: &Path) -> (Option<u32>, Option<String>) {
    let Ok(meta) = std::fs::metadata(path) else { return (None, None) };
    if !meta.is_file() || meta.len() > MAX_COUNTED_BYTES {
        return (None, None);
    }
    let Ok(data) = std::fs::read(path) else { return (None, None) };
    let mut hasher = gix::hash::hasher(gix::hash::Kind::Sha1);
    hasher.update(&data);
    let hash = hasher.try_finalize().ok().map(|id| id.to_string());
    if patch::is_binary(&data) {
        return (None, hash);
    }
    (Some(patch::count_lines(&data)), hash)
}

/// Paths marked `linguist-generated`, read from the worktree's
/// `.gitattributes` files and then the index's, as `git check-attr` does.
fn generated_paths(repo: &gix::Repository, paths: &[String]) -> Result<BTreeSet<String>> {
    let mut out = BTreeSet::new();
    if paths.is_empty() {
        return Ok(out);
    }
    let index = repo.index_or_empty()?;
    let source = if repo.workdir().is_some() {
        gix::worktree::stack::state::attributes::Source::WorktreeThenIdMapping
    } else {
        gix::worktree::stack::state::attributes::Source::IdMapping
    };
    let mut attrs = repo.attributes_only(&index, source)?;
    let mut outcome = attrs.selected_attribute_matches(["linguist-generated"]);
    for path in paths {
        let platform = attrs.at_entry(path.as_str(), None)?;
        platform.matching_attributes(&mut outcome);
        if outcome.iter_selected().any(|m| {
            let state = m.assignment.state;
            matches!(state, gix::attrs::StateRef::Set)
                || state.as_bstr().is_some_and(|v| v == "true" || v == "set")
        }) {
            out.insert(path.clone());
        }
    }
    Ok(out)
}

/// Files differing between two commits or trees, no counts.
fn diff_name_status(repos: &Repos, a: TwoRevs) -> Result<Vec<FileChange>> {
    let repo = repos.get(&a.repo)?;
    let left = diff::peel_to_tree(&repo, &a.left)?;
    let right = diff::peel_to_tree(&repo, &a.right)?;
    let changes = diff::tree_changes(&repo, left, right)?;
    Ok(diff::render(&repo, &changes, false)?
        .into_iter()
        .map(|r| FileChange { added: None, removed: None, ..r.file })
        .collect())
}

#[derive(Deserialize)]
struct ShowFile {
    repo: PathBuf,
    rev: String,
    path: String,
}

/// A file's content at a revision, empty when it has none there.
fn show_file(repos: &Repos, a: ShowFile) -> Result<String> {
    let repo = repos.get(&a.repo)?;
    let spec = format!("{}:{}", a.rev, a.path);
    let Ok(id) = repo.rev_parse_single(spec.as_str()) else { return Ok(String::new()) };
    let object = id.object()?;
    Ok(String::from_utf8_lossy(&object.data).into_owned())
}

/// HEAD's branch name, or `HEAD` when detached, like `rev-parse --abbrev-ref`.
fn current_branch(repo: &gix::Repository) -> Result<String> {
    Ok(match repo.head_name()? {
        Some(name) => name.shorten().to_str_lossy().into_owned(),
        None => "HEAD".into(),
    })
}

fn local_branches(repo: &gix::Repository) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for r in repo.references()?.local_branches()? {
        let Ok(r) = r else { continue };
        out.push(r.name().shorten().to_str_lossy().into_owned());
    }
    Ok(out)
}

/// Paths with staged, unstaged or untracked changes, an untracked directory
/// collapsed to one entry the way `git status` shows it.
fn uncommitted(repo: &gix::Repository) -> Result<Vec<String>> {
    let mut out = BTreeSet::new();
    let iter = repo
        .status(gix::progress::Discard)?
        .untracked_files(gix::status::UntrackedFiles::Collapsed)
        .index_worktree_rewrites(None)
        .tree_index_track_renames(gix::status::tree_index::TrackRenames::Disabled)
        .into_iter(None)?;
    for item in iter {
        let item = item?;
        if let gix::status::Item::IndexWorktree(gix::status::index_worktree::Item::Modification {
            status: gix::status::plumbing::index_as_worktree::EntryStatus::NeedsUpdate(_),
            ..
        }) = item
        {
            continue;
        }
        let mut path = item.location().to_str_lossy().into_owned();
        // An untracked directory reads `dir/`, as `git status` writes it.
        if let gix::status::Item::IndexWorktree(gix::status::index_worktree::Item::DirectoryContents { entry, .. }) = &item
            && entry.disk_kind == Some(gix::dir::entry::Kind::Directory)
        {
            path.push('/');
        }
        out.insert(path);
    }
    Ok(out.into_iter().collect())
}
