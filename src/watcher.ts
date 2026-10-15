import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { gitDirs, type Worktree } from './git';
import { describeError, log } from './log';

const DEBOUNCE_MS = 1500;
const SUPPRESS_TRAILING_MS = 2000;

/**
 * Filenames whose writes mean a ref moved or a stack changed. Every other name
 * in these directories is ignored, which is what keeps a refresh from
 * scheduling the next one: a read-only pass writes `index.lock` in each
 * worktree's gitdir and `gh stack` takes its `gh-stack*.lock` files beside it,
 * and both land in a directory we watch.
 *
 * `gh-stack` is the stack state `gh stack` and `gt` share in the common dir.
 * Tracking a branch or adding one to a stack rewrites it without moving any
 * ref, so it is the only sign the Stack section is out of date.
 */
const REF_FILENAMES = new Set(['HEAD', 'packed-refs', 'gh-stack']);

/**
 * Watches each worktree's gitdir for ref changes and fires a debounced
 * callback. Linked worktrees store their HEAD under
 * <common-dir>/worktrees/<name>/HEAD, so we resolve both the per-worktree
 * gitdir and the shared common gitdir.
 *
 * The watches are on the directories holding the ref files rather than on the
 * files themselves. Git replaces `HEAD` and `packed-refs` by writing a lock
 * file and renaming it into place, which leaves a watch on the file bound to
 * the replaced inode and silently dead from the first checkout onward; a
 * directory keeps its inode across that.
 *
 * `logs/HEAD` is watched because it is the only one of these paths an amend
 * touches: amending leaves `HEAD` alone and writes `refs/heads/<branch>`, so
 * without it a `gt modify` in the main worktree goes unnoticed.
 *
 * We intentionally skip recursive `refs/` watches. `git fetch`, packed refs
 * updates, and reflog activity all churn `refs/` constantly. Watching
 * `logs/HEAD` does not reopen that: a fetch writes `FETCH_HEAD` and
 * `logs/refs/remotes/*`, leaving `logs/HEAD` untouched.
 */
export class WorktreeWatcher implements vscode.Disposable {
  private watchers: fs.FSWatcher[] = [];
  private watchedGitDirs: string[] = [];
  private debounce: NodeJS.Timeout | undefined;
  private suppressDepth = 0;
  private suppressUntil = 0;

  constructor(private readonly onChange: () => void) {}

  async update(worktrees: Worktree[]): Promise<void> {
    const gitDirs = new Set<string>();
    for (const w of worktrees) {
      const dirs = await resolveGitDirs(w.path);
      for (const d of dirs) gitDirs.add(d);
    }
    const sorted = Array.from(gitDirs).sort();
    if (sameList(sorted, this.watchedGitDirs)) return;

    this.disposeWatchers();
    this.watchedGitDirs = sorted;
    for (const dir of sorted) {
      this.watchDir(dir, false);
      this.watchDir(path.join(dir, 'logs'), false);
      this.watchDir(path.join(dir, 'worktrees'), true);
    }
    log().info(
      `watcher: tracking ${this.watchers.length} directories across ${sorted.length} gitdirs`,
    );
  }

  /**
   * Runs `fn` with the refresh callback held off, plus a short trailing window
   * so filesystem events that land just after the git commands finish are held
   * too. The provider wraps every refresh in this so a checkout it performs
   * itself does not race the explicit refresh that follows. The window lasts as
   * long as the work does rather than for a fixed guess that a slow refresh
   * could outlast.
   *
   * Events arriving during the window are deferred rather than discarded, so a
   * branch switched from a terminal while a refresh happens to be running is
   * still picked up.
   */
  async runSuppressed<T>(fn: () => Promise<T>): Promise<T> {
    this.suppressDepth++;
    try {
      return await fn();
    } finally {
      this.suppressDepth = Math.max(0, this.suppressDepth - 1);
      if (this.suppressDepth === 0) {
        this.suppressUntil = Date.now() + SUPPRESS_TRAILING_MS;
      }
    }
  }

  private suppressed(): boolean {
    return this.suppressDepth > 0 || Date.now() < this.suppressUntil;
  }

  private watchDir(p: string, recursive: boolean): void {
    if (!fs.existsSync(p)) return;
    try {
      this.watchers.push(
        fs.watch(p, { recursive }, (_event, filename) => {
          if (isRefFile(filename)) this.fire();
        }),
      );
    } catch {
      if (recursive) this.watchDir(p, false);
    }
  }

  private fire(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.onDebounceElapsed(), DEBOUNCE_MS);
  }

  private onDebounceElapsed(): void {
    // The ref that moved stays moved, so a refresh in flight is a reason to
    // wait rather than to give up on the event.
    if (this.suppressed()) {
      this.debounce = setTimeout(() => this.onDebounceElapsed(), DEBOUNCE_MS);
      return;
    }
    this.debounce = undefined;
    // Bridge the gap until the provider's runSuppressed wrapper takes over.
    this.suppressUntil = Date.now() + SUPPRESS_TRAILING_MS;
    log().info('watcher: gitdir change detected, refreshing');
    this.onChange();
  }

  private disposeWatchers(): void {
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.watchers = [];
  }

  dispose(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = undefined;
    this.disposeWatchers();
    this.watchedGitDirs = [];
  }
}

async function resolveGitDirs(worktreePath: string): Promise<string[]> {
  try {
    const dirs = await gitDirs(worktreePath);
    return [dirs.gitDir, dirs.commonDir];
  } catch (err) {
    log().warn(`watcher: reading gitdirs failed in ${worktreePath}: ${describeError(err)}`);
    return [];
  }
}

/**
 * Node omits the filename on platforms that report no per-event name. Treating
 * that as a miss is deliberate: the alternative is refreshing on every write
 * into a gitdir, including the ones our own refresh makes.
 */
function isRefFile(filename: string | null): boolean {
  if (filename === null) return false;
  return REF_FILENAMES.has(path.basename(filename));
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
