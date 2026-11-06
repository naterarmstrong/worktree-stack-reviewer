import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  applyCommitOnto,
  commitSubject,
  deleteRef,
  getCurrentBranch,
  mainWorktreePath,
  pinRef,
  revParse,
} from './git';
import { describeError, log } from './log';
import { stateDirFor } from './statePaths';

/**
 * A hidden change is a commit an agent (the wt-review skill) built to hold one
 * class of mechanical change, such as the knock-on edits of a rename. VS Code's
 * diff takes two documents and can't suppress a hunk, so hiding means moving
 * the left side: the diff is taken against the merge base plus whichever of
 * these commits are switched on, and what they hold matches the right side and
 * drops out. A hidden commit never touches the branch and is never pushed.
 *
 * One file for the whole repository, beside stacks.json in the main worktree's
 * state directory, keyed by branch so the list follows the branch between
 * worktrees the way its comments do.
 */
const HIDDEN_FILENAME = 'hidden-changes.json';
const STORE_VERSION = 1;

/** Keeps a registered commit from being garbage collected: nothing else reaches it. */
const PIN_PREFIX = 'refs/wt-review/hidden/';
const VIEW_PREFIX = 'refs/wt-review/view/';

/**
 * The ref a branch's left side is read through. A diff tab names this ref
 * rather than the tree it points at, so a toggle moves the ref and invalidates
 * the content and an open tab redraws in place. `/` is escaped so that branches
 * `a` and `a/b` can't collide as a file and a directory under refs/.
 */
export function viewRefFor(branch: string): string {
  return VIEW_PREFIX + branch.replace(/%/g, '%25').replace(/\//g, '%2F');
}

export interface HiddenChange {
  /** Full sha. Its diff against its first parent is what gets hidden. */
  commit: string;
  subject: string;
  /** Unticking keeps the commit registered and puts its changes back in the diff. */
  enabled: boolean;
  /** ISO time. */
  addedAt: string;
}

/** An inbox entry registering a hidden commit, or removing one. */
export interface HiddenChangeEntry {
  kind: 'hiddenChange';
  commit: string;
  /** Defaults to the branch checked out in the worktree whose inbox carried it. */
  branch?: string;
  action: 'add' | 'remove';
}

/** The left side of a branch's diff, for a branch with hidden changes. */
export interface HiddenView {
  ref: string;
  /** What `ref` points at: the merge base, or a tree built on it. */
  left: string;
  /** How many commits made it in. Zero with every one switched off. */
  applied: number;
  /** Switched-on commits that could not be applied, by sha, with the reason. */
  failed: Map<string, string>;
}

/** The entry an inbox item describes, or undefined when it is not a hidden-change entry. */
export function parseHiddenChangeEntry(
  e: Record<string, unknown>,
): HiddenChangeEntry | undefined {
  if (e.kind !== 'hiddenChange') return undefined;
  if (typeof e.commit !== 'string' || !e.commit.trim()) return undefined;
  if (e.action !== undefined && e.action !== 'add' && e.action !== 'remove') return undefined;
  return {
    kind: 'hiddenChange',
    commit: e.commit.trim(),
    branch: typeof e.branch === 'string' && e.branch.trim() ? e.branch.trim() : undefined,
    action: e.action ?? 'add',
  };
}

interface StoreFile {
  version: number;
  branches: Record<string, HiddenChange[]>;
}

export class HiddenChangeStore implements vscode.Disposable {
  private root: Promise<string | undefined> | undefined;
  private branches = new Map<string, HiddenChange[]>();
  private loaded = false;
  /** The last view built per branch, so a tree pass costs no git process. */
  private readonly views = new Map<string, { key: string; view: HiddenView }>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires when a commit is added, removed or toggled. */
  readonly onDidChange = this._onDidChange.event;
  private readonly _onDidMoveView = new vscode.EventEmitter<void>();
  /** Fires when a view ref moved, so anything read through one is out of date. */
  readonly onDidMoveView = this._onDidMoveView.event;

  constructor(private readonly repoPath: string) {}

  list(branch: string): HiddenChange[] {
    return this.branches.get(branch) ?? [];
  }

  /** Reads the file, on first use or after `clear`. */
  async load(): Promise<void> {
    if (this.loaded) return;
    const file = await this.filePath();
    this.loaded = true;
    if (!file) return;
    this.branches = await readStore(file);
  }

  /** Forces a re-read on the next load: another window may have written the file. */
  clear(): void {
    this.loaded = false;
  }

  /** Applies an inbox entry; returns why it was refused, if it was. */
  async apply(worktreePath: string, entry: HiddenChangeEntry): Promise<string | undefined> {
    const branch = entry.branch ?? (await getCurrentBranch(worktreePath));
    if (!branch || branch === 'HEAD') return 'no branch to hide this on';
    const known = await revParse(worktreePath, `refs/heads/${branch}`).catch(() => undefined);
    if (!known) return `no branch named ${branch}`;
    const commit = await revParse(worktreePath, `${entry.commit}^{commit}`).catch(() => undefined);
    if (!commit) return `no commit ${entry.commit}`;
    // Re-read first, so a change another window saved isn't overwritten.
    this.loaded = false;
    await this.load();
    const rest = this.list(branch).filter((c) => c.commit !== commit);
    if (entry.action === 'remove') {
      if (rest.length === this.list(branch).length) return `${commit} is not hidden on ${branch}`;
      this.setBranch(branch, rest);
      await deleteRef(worktreePath, PIN_PREFIX + commit).catch((err) =>
        log().warn(`hidden: could not unpin ${commit}: ${describeError(err)}`),
      );
    } else {
      const parent = await revParse(worktreePath, `${commit}^`).catch(() => undefined);
      if (!parent) return `${commit} has no parent, so there is nothing to compare it with`;
      await pinRef(worktreePath, PIN_PREFIX + commit, commit);
      const subject = await commitSubject(worktreePath, commit);
      this.setBranch(branch, [
        ...rest,
        { commit, subject, enabled: true, addedAt: new Date().toISOString() },
      ]);
    }
    await this.save();
    log().info(`hidden: ${entry.action} ${commit} on ${branch}`);
    this._onDidChange.fire();
    return undefined;
  }

  async setEnabled(branch: string, enabled: Map<string, boolean>): Promise<void> {
    await this.load();
    let changed = false;
    for (const change of this.list(branch)) {
      const next = enabled.get(change.commit);
      if (next === undefined || next === change.enabled) continue;
      change.enabled = next;
      changed = true;
    }
    if (!changed) return;
    await this.save();
    this._onDidChange.fire();
  }

  /**
   * The left side `branch` should diff against, or undefined when it has no
   * hidden changes and the plain merge base is the answer.
   *
   * Commits are replayed in order with a three-way merge rather than used as
   * they stand, so toggling one off leaves those above it standing and a
   * restack moves the whole set onto the new base. One that no longer applies
   * is skipped and reported, which leaves its changes showing: a failure must
   * never hide something the reviewer wasn't told about.
   *
   * The ref stays put once a branch has one, even with nothing left to hide. A
   * deleted ref would turn an open tab's left side blank and show the whole
   * file as added, and base-side comments written on it name it too.
   */
  async viewFor(
    worktreePath: string,
    branch: string,
    mergeBase: string,
  ): Promise<HiddenView | undefined> {
    await this.load();
    const ref = viewRefFor(branch);
    const changes = this.list(branch);
    try {
      if (changes.length === 0) {
        if (this.views.delete(branch)) {
          await pinRef(worktreePath, ref, mergeBase);
          this._onDidMoveView.fire();
        }
        return undefined;
      }
      const on = changes.filter((c) => c.enabled);
      const key = [mergeBase, ...on.map((c) => c.commit)].join(' ');
      const known = this.views.get(branch);
      if (known?.key === key) return known.view;

      let left = mergeBase;
      let applied = 0;
      const failed = new Map<string, string>();
      for (const change of on) {
        try {
          left = await applyCommitOnto(worktreePath, left, change.commit);
          applied += 1;
        } catch (err) {
          failed.set(change.commit, whyNotApplied(err));
          log().warn(`hidden: ${change.commit} not applied on ${branch}: ${describeError(err)}`);
        }
      }
      await pinRef(worktreePath, ref, left);
      const view: HiddenView = { ref, left, applied, failed };
      this.views.set(branch, { key, view });
      if (known?.view.left !== left) this._onDidMoveView.fire();
      return view;
    } catch (err) {
      log().error(`hidden: cannot build the view for ${branch}: ${describeError(err)}`);
      return undefined;
    }
  }

  private setBranch(branch: string, changes: HiddenChange[]): void {
    if (changes.length > 0) {
      this.branches.set(branch, changes);
    } else {
      this.branches.delete(branch);
    }
  }

  private filePath(): Promise<string | undefined> {
    this.root ??= mainWorktreePath(this.repoPath).catch((err) => {
      log().warn(`hidden: cannot locate the main worktree: ${describeError(err)}`);
      return undefined;
    });
    return this.root.then((root) => (root ? path.join(stateDirFor(root), HIDDEN_FILENAME) : undefined));
  }

  private async save(): Promise<void> {
    const file = await this.filePath();
    if (!file) return;
    const payload: StoreFile = {
      version: STORE_VERSION,
      branches: Object.fromEntries(this.branches),
    };
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp${process.pid}`;
      await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await fs.rename(tmp, file);
    } catch (err) {
      log().error(`hidden: failed to write ${file}: ${describeError(err)}`);
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
    this._onDidMoveView.dispose();
  }
}

/** `git merge-tree` exits 1 for a conflict and higher for anything else. */
function whyNotApplied(err: unknown): string {
  if ((err as { code?: unknown }).code === 1) {
    return 'conflicts with the base or with a hidden change above it';
  }
  const stderr = (err as { stderr?: string }).stderr?.trim();
  return stderr || describeError(err);
}

/** A missing file is an empty store; a corrupt one is moved aside, as the other stores do. */
async function readStore(file: string): Promise<Map<string, HiddenChange[]>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log().warn(`hidden: cannot read ${file}: ${describeError(err)}`);
    }
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw) as StoreFile;
    return new Map(Object.entries(parsed?.branches ?? {}));
  } catch (err) {
    const quarantine = `${file}.corrupt`;
    log().error(`hidden: ${file} is not valid JSON (${describeError(err)}); moving to ${quarantine}`);
    await fs.rename(file, quarantine).catch(() => undefined);
    return new Map();
  }
}
