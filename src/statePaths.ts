import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { log } from './log';

const DIR_NAME = 'wt-review';

/** A worktree's gitdir never moves while the extension runs, so one read each. */
const gitDirs = new Map<string, string>();
let warnedAbsolute: string | undefined;

/**
 * The directory a worktree's review state lives in: comments, viewed marks and
 * the agent inbox, plus the repository-wide stores when it is the main
 * worktree.
 *
 * By default that is the worktree's own gitdir — `.git/wt-review/` in the main
 * checkout, `.git/worktrees/<name>/wt-review/` for a linked one. Git never
 * looks there, so nothing has to be ignored to keep the state out of a commit,
 * and every worktree still gets a directory of its own. The
 * `worktreeReview.stateDirectory` setting puts it at a path relative to each
 * worktree instead, for an agent that should find it beside the code.
 */
export function stateDirFor(worktreePath: string): string {
  const configured = vscode.workspace
    .getConfiguration('worktreeReview')
    .get<string>('stateDirectory', '')
    .trim();
  if (configured && !path.isAbsolute(configured)) {
    return path.join(worktreePath, configured);
  }
  if (configured && warnedAbsolute !== configured) {
    // One directory shared by every worktree would have them overwrite each
    // other's comments, so an absolute path is refused rather than honoured.
    warnedAbsolute = configured;
    log().warn(
      `stateDirectory '${configured}' is absolute; it must be relative to each worktree. Using the gitdir instead.`,
    );
  }
  return path.join(gitDirOf(worktreePath), DIR_NAME);
}

/**
 * The worktree's own gitdir, read from its `.git` entry: the directory itself
 * in the main checkout, or the `gitdir:` line of the file a linked worktree
 * has in its place.
 */
function gitDirOf(worktreePath: string): string {
  const known = gitDirs.get(worktreePath);
  if (known) return known;
  const dotGit = path.join(worktreePath, '.git');
  let gitDir = dotGit;
  try {
    if (fs.statSync(dotGit).isFile()) {
      const line = fs
        .readFileSync(dotGit, 'utf8')
        .split('\n')
        .find((l) => l.startsWith('gitdir:'));
      if (line) gitDir = path.resolve(worktreePath, line.slice('gitdir:'.length).trim());
    }
  } catch {
    // No `.git` to read: fall through to where it would be.
  }
  gitDirs.set(worktreePath, gitDir);
  return gitDir;
}
