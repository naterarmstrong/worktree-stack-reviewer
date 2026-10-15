import * as fs from 'node:fs';
import * as path from 'node:path';
import { call } from './core';
import { execTimed } from './exec';
import { parseFilePatches } from './patchId';

export interface Worktree {
  path: string;
  branch: string;
  head: string;
}

/**
 * What an agent session names the worktrees it creates, after the id of the
 * session that asked for it: `bridge-cse_01UMjJsvcYhezpqm88CsrbXW`.
 */
const AGENT_WORKTREE_PREFIX = 'bridge-cse_';

/**
 * Whether an agent session's worktree is still on the branch named after it —
 * `worktree-<the worktree's own directory name>`.
 *
 * A session commits an empty marker on such a branch when it creates the
 * worktree, so that a later sweep for unused worktrees leaves this one alone.
 * It moves off that branch as soon as it commits work of its own, which leaves
 * the worktrees still on one with nothing to review.
 *
 * Both halves are needed. The prefix keeps this to worktrees an agent made:
 * a worktree created by hand is named after its branch, and hiding one would
 * hide work someone is in the middle of. The branch has to name this worktree
 * in particular, since holding some other worktree's marker branch means a
 * branch was deliberately checked out here.
 */
export function isAgentWorktreeOnItsOwnBranch(worktree: Worktree): boolean {
  const directory = path.basename(worktree.path);
  if (!directory.startsWith(AGENT_WORKTREE_PREFIX)) return false;
  return worktree.branch === `worktree-${directory}`;
}

export interface ChangedFile {
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U' | '?';
  path: string;
  oldPath?: string;
  /** Lines changed vs the base. Unset for binary files and unreadable ones. */
  added?: number;
  removed?: number;
  /**
   * The file differs from HEAD, so its most recent change is a working-tree or
   * staged edit rather than anything in the branch's commit history. Only set
   * when uncommitted changes are being shown.
   */
  uncommitted?: boolean;
  /**
   * Marked `linguist-generated` in .gitattributes. Version history leaves these
   * out of every interdiff, so they never carry a version and would otherwise
   * be indistinguishable from a file whose version could not be worked out.
   */
  generated?: boolean;
  /**
   * Identity of this file's change, stable across restacks. Drives the viewed
   * checkbox. Unset when the diff could not be read for the file.
   */
  patchId?: string;
  /** Abbreviated blob sha on the base side, when the base has the file. */
  baseBlob?: string;
}

/**
 * Runs a command with an argument array instead of a shell string. Git allows
 * `;`, backticks, `$()` and `|` in branch names, and refs reach this module
 * from places the user does not control — the `fallbackBase` setting can come
 * from a cloned repo's `.vscode/settings.json`, and PR head branches come from
 * whoever opened the pull request. Passing those through a shell would let a
 * repository run commands just by being opened.
 *
 * Only the operations that move a worktree still run `git` itself: checkouts,
 * branch creation and fetches, where git's own safety checks are the point.
 * Every read goes through the core (`./core`), which answers in-process with
 * gix rather than starting a process per question.
 */
function git(args: string[], cwd: string): Promise<string> {
  return execTimed('git', args, cwd);
}

/**
 * Worktrees with a branch checked out, the main worktree first. A detached
 * worktree is left out.
 */
export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  return call<Worktree[]>('worktrees', { repo: repoPath });
}

interface GitDirs {
  gitDir: string;
  commonDir: string;
}

/**
 * A worktree's own gitdir and the repository's shared one, both absolute.
 * Linked worktrees keep HEAD in the first and refs in the second.
 */
export async function gitDirs(worktreePath: string): Promise<GitDirs> {
  return call<GitDirs>('gitDirs', { repo: worktreePath });
}

/**
 * The main worktree — the one holding the shared gitdir. Asked of git rather
 * than taken as the first entry of `git worktree list`, which is the main
 * worktree only while it has a branch checked out. Used as the home for
 * repository-wide state that must read the same from every worktree.
 */
export async function mainWorktreePath(repoPath: string): Promise<string> {
  return path.dirname((await gitDirs(repoPath)).commonDir);
}

interface CoreChangedFile extends ChangedFile {
  /** Set only on untracked files, which have no diff to take a patch id from. */
  contentHash?: string;
}

/**
 * What a worktree changes relative to where it left `base`. Without
 * uncommitted changes this is the `base...HEAD` range a PR shows; with them,
 * the right side is the files on disk, staged and unstaged edits included,
 * plus every untracked file as an addition.
 */
export async function listChangedFiles(
  worktreePath: string,
  base: string,
  includeUncommitted: boolean,
): Promise<ChangedFile[]> {
  const { files, patch } = await call<{ files: CoreChangedFile[]; patch: string }>(
    'changedFiles',
    { worktree: worktreePath, base, includeUncommitted },
  );
  // The core writes the `-U0` patch git would, and its sections are hashed
  // here so a viewed tick keeps one definition of a patch id.
  const patches = parseFilePatches(patch);
  for (const file of files) {
    const filePatch = patches.get(file.path);
    if (filePatch) {
      file.patchId = filePatch.patchId;
      file.baseBlob = filePatch.baseBlob;
    }
    // An untracked file has no diff to derive a patch id from, so its content
    // stands in for one. Committing the file moves it into the diff and gives
    // it a real patch id, which clears its viewed tick once.
    if (file.contentHash !== undefined) {
      file.patchId = file.contentHash;
      delete file.contentHash;
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/** Files differing between two arbitrary commits or trees. */
export async function diffNameStatus(
  repoPath: string,
  left: string,
  right: string,
): Promise<ChangedFile[]> {
  return call<ChangedFile[]>('diffNameStatus', { repo: repoPath, left, right });
}

/** The full object id `ref` names. Rejects when it names nothing. */
export async function revParse(repoPath: string, ref: string): Promise<string> {
  return call<string>('revParse', { repo: repoPath, rev: ref });
}

/** A branch entry in `.git/gh-stack`; only the fields read here. */
export interface GhStackBranch {
  branch: string;
  pullRequest?: { number?: number; merged?: boolean };
}

interface GhStack {
  trunk?: { branch?: string };
  branches?: GhStackBranch[];
}

/**
 * The stacks `gh stack` and the `gt` CLI built on it keep in
 * `<common-dir>/gh-stack`. One file covers every worktree of the repository.
 * Empty when the repository has no stacks yet or the file can't be read.
 */
async function readGhStacks(repoPath: string): Promise<GhStack[]> {
  try {
    const { commonDir } = await gitDirs(repoPath);
    const raw = await fs.promises.readFile(path.join(commonDir, 'gh-stack'), 'utf8');
    return (JSON.parse(raw) as { stacks?: GhStack[] }).stacks ?? [];
  } catch {
    return [];
  }
}

/**
 * The trunk the repository's stacks sit on, read from `.git/gh-stack`. Each
 * stack records its own trunk; the one most of them share wins, which is the
 * default branch in practice. Null when there are no stacks; callers fall back
 * to the configured base.
 */
export async function getStackTrunk(repoPath: string): Promise<string | null> {
  const counts = new Map<string, number>();
  for (const stack of await readGhStacks(repoPath)) {
    const trunk = stack.trunk?.branch;
    if (trunk) counts.set(trunk, (counts.get(trunk) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [trunk, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) best = trunk;
  }
  return best;
}

/** A file's content at `ref`, or empty when the ref has no such file. */
export async function showFileAtRef(
  repoPath: string,
  ref: string,
  filePath: string,
): Promise<string> {
  try {
    return await call<string>('showFile', { repo: repoPath, rev: ref, path: filePath });
  } catch {
    return '';
  }
}

/** Where the worktree's HEAD diverged from `base`. */
export async function resolveMergeBase(
  repoPath: string,
  base: string,
): Promise<string> {
  return mergeBaseOf(repoPath, 'HEAD', base);
}

/**
 * Where two refs diverged, which is the left side of the three-dot diff a pull
 * request shows. Unlike `resolveMergeBase` this names both refs, so it answers
 * for a branch no worktree has checked out.
 */
export async function mergeBaseOf(
  repoPath: string,
  a: string,
  b: string,
): Promise<string> {
  return call<string>('mergeBase', { repo: repoPath, left: a, right: b });
}

export interface StackInfo {
  /** Branches in this worktree's stack, ordered tip → bottom; trunk excluded. */
  branches: string[];
  /** Each branch's parent — the branch one step toward trunk from it. */
  parents: Map<string, string>;
  /** The current branch's parent, or null when it is in no stack. */
  parent: string | null;
}

/**
 * The stack holding `currentBranch`, read from `.git/gh-stack`. Branches whose
 * PR has merged are left out, and a branch above one sits on the nearest
 * unmerged branch below it (or the stack's trunk) — the parent `gt restack`
 * and `gh stack rebase` move it onto. The current branch stays in even once
 * merged, so a worktree still on it keeps its row.
 *
 * A trunk is shared by every stack, so only stacked branches are matched.
 * Returns an empty stack with a null parent when the branch is untracked —
 * callers fall back to the worktree's own branch.
 */
export async function getStack(
  worktreePath: string,
  currentBranch: string,
): Promise<StackInfo> {
  const stacks = await readGhStacks(worktreePath);
  const stack = stacks.find((s) =>
    (s.branches ?? []).some((b) => b.branch === currentBranch),
  );
  const trunk = stack?.trunk?.branch;
  if (!stack || !trunk) return { branches: [], parents: new Map(), parent: null };
  return stackFromGhStack(stack.branches ?? [], trunk, currentBranch);
}

/** Exported for tests: derives the listing from one stack's bottom-first entries. */
export function stackFromGhStack(
  entries: GhStackBranch[],
  trunk: string,
  currentBranch: string,
): StackInfo {
  const parents = new Map<string, string>();
  const bottomFirst: string[] = [];
  let below = trunk;
  for (const entry of entries) {
    const merged = entry.pullRequest?.merged === true;
    if (!merged || entry.branch === currentBranch) {
      parents.set(entry.branch, below);
      bottomFirst.push(entry.branch);
    }
    if (!merged) below = entry.branch;
  }
  return {
    branches: bottomFirst.reverse(),
    parents,
    parent: parents.get(currentBranch) ?? null,
  };
}

/** The checked-out branch's name, `HEAD` when detached, empty on failure. */
export async function getCurrentBranch(worktreePath: string): Promise<string> {
  try {
    return await call<string>('currentBranch', { repo: worktreePath });
  } catch {
    return '';
  }
}

/**
 * Every local branch in the repository. Branches are shared across all
 * worktrees of a repo, so one call covers them all — this is what decides
 * whether a branch's comments are still live or eligible for pruning.
 */
export async function listLocalBranches(repoPath: string): Promise<Set<string>> {
  return new Set(await call<string[]>('localBranches', { repo: repoPath }));
}

/** Used to attribute review comments. Empty when git has no configured name. */
export async function getGitUserName(repoPath: string): Promise<string> {
  try {
    return (await call<string | null>('config', { repo: repoPath, key: 'user.name' })) ?? '';
  } catch {
    return '';
  }
}

/**
 * Paths of files with staged, unstaged, or untracked changes, an untracked
 * directory as one entry. Switching a worktree's branch carries these along,
 * which is worth warning about before a review checkout moves the worktree off
 * the branch they were made on.
 */
export async function listUncommittedChanges(
  worktreePath: string,
): Promise<string[]> {
  return call<string[]>('uncommitted', { repo: worktreePath });
}

/**
 * Creates `branch` at `startPoint` and checks it out. Git refuses if the branch
 * already exists, which callers rule out first — an existing branch is checked
 * out where it stands rather than moved.
 */
export async function createBranchAt(
  worktreePath: string,
  branch: string,
  startPoint: string,
): Promise<void> {
  await git(['checkout', '-b', branch, startPoint], worktreePath);
}

export async function checkoutBranch(
  worktreePath: string,
  branch: string,
): Promise<void> {
  try {
    await git(['fetch', 'origin', branch], worktreePath);
  } catch {
    // fetch failure is non-fatal — branch may be local-only.
  }
  await git(['checkout', branch], worktreePath);
}
