import * as path from 'node:path';
import * as vscode from 'vscode';
import { execTimed } from './exec';

const DEFAULT_COMMAND = 'gt-version-history';

// Field names are snake_case to mirror the script's JSON output verbatim.

export interface VersionDeltaFile {
  added: number;
  removed: number;
  path: string;
}

/**
 * What a version changed relative to the previous one (an interdiff, not a
 * tree diff). `conflict` is set when no clean interdiff exists.
 */
export interface VersionDelta {
  conflict?: boolean;
  added?: number;
  removed?: number;
  generated_hidden?: number;
  files?: VersionDeltaFile[];
}

/** One version (amend) of a stacked branch's single commit. */
export interface BranchVersion {
  version: number;
  sha: string;
  date: string;
  action: string;
  subject: string;
  shas: string[];
  pushed: boolean;
  current: boolean;
  push_seq?: number;
  push_sha?: string;
  delta?: VersionDelta;
}

export interface VersionListing {
  branch: string;
  parent: string;
  /** Newest first. */
  versions: BranchVersion[];
}

export interface CompareFile {
  status: string;
  path: string;
  old_path: string | null;
}

/**
 * A compare resolved to two tree objects. Diffing `left_tree` against
 * `right_tree` is the honest interdiff — the script has already re-applied
 * the older patch onto the newer version's parent.
 */
export interface CompareResult {
  branch: string;
  parent: string;
  a: { label: string; sha: string };
  b: { label: string; sha: string };
  left_tree: string;
  right_tree: string;
  files: CompareFile[];
}

/** Carries the script's own stderr message when it exits non-zero. */
export class VersionHistoryError extends Error {}

let workingCommand: string | undefined;

/**
 * Runs the gt-version-history script.
 *
 * Nothing provides that script yet. It has to construct the version history of
 * a branch's patch — every amend and restack of its single commit, and the
 * interdiffs between them — and report it in the shapes above; until a tool
 * does, every call here ends in the not-found error.
 *
 * The configured command is tried first; when it's the default bare name,
 * `scripts/gt-version-history` under the workspace repo is tried too, since
 * the VS Code server process often lacks the shell profile that puts the
 * script on PATH. Whichever command runs is remembered for subsequent calls.
 */
async function runVersionHistory(
  repoPath: string,
  cwd: string,
  args: string[],
): Promise<string> {
  const configured = vscode.workspace
    .getConfiguration('worktreeReview')
    .get<string>('versionHistoryCommand', DEFAULT_COMMAND);
  const candidates: string[] = [];
  if (workingCommand) candidates.push(workingCommand);
  candidates.push(configured);
  if (configured === DEFAULT_COMMAND) {
    candidates.push(path.join(repoPath, 'scripts', DEFAULT_COMMAND));
  }
  for (const command of new Set(candidates)) {
    try {
      const stdout = await execTimed(
        command,
        args,
        cwd,
        `${path.basename(command)} ${args.join(' ')}`,
      );
      workingCommand = command;
      return stdout;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (workingCommand === command) workingCommand = undefined;
        continue;
      }
      throw new VersionHistoryError(scriptError(err));
    }
  }
  throw new VersionHistoryError(
    `'${configured}' not found — set worktreeReview.versionHistoryCommand to the script's path`,
  );
}

/** The script reports failures as `Error: …` on stderr before exiting 1. */
function scriptError(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr?.trim() ?? '';
  if (stderr) return stderr.replace(/^Error:\s*/, '');
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}

export async function listVersions(
  repoPath: string,
  worktreePath: string,
  branch: string,
): Promise<VersionListing> {
  const stdout = await runVersionHistory(repoPath, worktreePath, [
    branch,
    '--json',
  ]);
  return JSON.parse(stdout) as VersionListing;
}

/**
 * The newest version whose interdiff names each path — the version that last
 * changed that file. Versions arrive newest first, so the first one to name a
 * path is the answer for it.
 *
 * Two things keep a genuinely changed path out of this map. Linguist-generated
 * files are excluded from every interdiff (the script reports only how many it
 * hid), and a version whose interdiff conflicts reports no files at all.
 * Callers show those files as unattributed rather than crediting whichever
 * older version happens to mention them.
 */
export function lastTouchedVersions(
  listing: VersionListing,
): Map<string, number> {
  const lastTouched = new Map<string, number>();
  for (const version of listing.versions) {
    for (const file of version.delta?.files ?? []) {
      if (!lastTouched.has(file.path)) lastTouched.set(file.path, version.version);
    }
  }
  return lastTouched;
}

/**
 * The patch a review comment was left on, or undefined when the branch has no
 * versions to attribute it to.
 *
 * A comment records the branch tip it was written against, which is matched
 * against every sha the version has held: a restack gives a version a new sha
 * without making it a new patch, so the sha a comment names may not be the one
 * the version currently shows.
 *
 * A comment with no sha — written before that was recorded, or added to the
 * store by hand — is dated back instead, to the newest patch that already
 * existed when it was written. One older than every patch still listed, which
 * is what a truncated reflog leaves behind, counts towards the oldest.
 */
export function versionForComment(
  comment: { sha?: string; createdAt: string },
  versions: BranchVersion[],
): number | undefined {
  if (versions.length === 0) return undefined;
  const sha = comment.sha;
  if (sha) {
    const named = versions.find((v) => v.shas.some((s) => s.startsWith(sha)));
    if (named) return named.version;
  }
  // Dates carry a timezone offset, so they are compared as instants rather
  // than as the strings they arrive in.
  const written = Date.parse(comment.createdAt);
  if (Number.isNaN(written)) return undefined;
  const current = versions.find((v) => Date.parse(v.date) <= written);
  return (current ?? versions[versions.length - 1]).version;
}

/**
 * `a` and `b` are version numbers ("3"), shas, or "base" (the parent the
 * other side sits on).
 */
export async function compareVersions(
  repoPath: string,
  worktreePath: string,
  branch: string,
  a: string,
  b: string,
): Promise<CompareResult> {
  const stdout = await runVersionHistory(repoPath, worktreePath, [
    'compare',
    a,
    b,
    branch,
    '--json',
  ]);
  return JSON.parse(stdout) as CompareResult;
}
