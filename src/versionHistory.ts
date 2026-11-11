import { GtError, runGt } from './gt';

// Field names are snake_case, after the JSON `gt history` prints; `fromGt`
// reshapes its listing into these.

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
  /**
   * The generated files left out of `files` and the totals. They still count
   * for which version last touched a file.
   */
  generated_files?: string[];
}

/**
 * One version of a stacked branch: an amend of its single commit, or, on a
 * branch with several commits, one of those commits.
 */
export interface BranchVersion {
  version: number;
  sha: string;
  date: string;
  action: string;
  subject: string;
  shas: string[];
  pushed: boolean;
  current: boolean;
  /**
   * False for a commit the branch only passed through: it arrived under a later
   * commit (a fetch that brought in several at once) and was never the tip in
   * this clone. Its date is the date of the move that brought it.
   */
  tip?: boolean;
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
 * `right_tree` is the honest interdiff — gt has already re-applied
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

/** Carries gt's own stderr message when it exits non-zero. */
export { GtError as VersionHistoryError };

/** gt's lines-changed split, as `gt loc` and `gt history` print it. */
interface GtLines {
  add: number;
  del: number;
}
type GtSplit = Record<'src' | 'test' | 'doc' | 'gen', GtLines>;

interface GtFile {
  path: string;
  kind: keyof GtSplit;
  lines: GtSplit;
}

/** One version as `gt history --json` prints it. */
interface GtVersion {
  version: number;
  sha: string;
  subject: string;
  date: string;
  action: string;
  current: boolean;
  /** Absent from gt versions that only knew single-commit branches. */
  tip?: boolean;
  remote: { pushed: boolean; fetched: boolean; tip: boolean };
  /** Every move onto this patch, oldest first. */
  moves: { sha: string }[];
  delta?: { conflict: boolean; files: GtFile[] } | null;
}

interface GtListing {
  branch: string;
  parent: string;
  versions: GtVersion[];
}

function sumLines(split: GtSplit): GtLines {
  const total = { add: 0, del: 0 };
  for (const lines of Object.values(split)) {
    total.add += lines.add;
    total.del += lines.del;
  }
  return total;
}

/**
 * Reshapes `gt history --json` into the listing the views read. Files gt
 * classes as generated (linguist-generated, lockfiles, vendored code) stay out
 * of the totals and the file list, the way the views have always shown them.
 */
export function fromGt(listing: GtListing): VersionListing {
  return {
    branch: listing.branch,
    parent: listing.parent,
    versions: listing.versions.map((v) => {
      const out: BranchVersion = {
        version: v.version,
        sha: v.sha,
        date: v.date,
        action: v.action,
        subject: v.subject,
        shas: v.moves.map((m) => m.sha),
        // On the remote at some point, as far as this clone has seen.
        pushed: v.remote.pushed || v.remote.fetched || v.remote.tip,
        current: v.current,
        tip: v.tip !== false,
      };
      if (v.delta?.conflict) {
        out.delta = { conflict: true };
      } else if (v.delta) {
        const files = v.delta.files
          .filter((f) => f.kind !== 'gen')
          .map((f) => {
            const lines = sumLines(f.lines);
            return { path: f.path, added: lines.add, removed: lines.del };
          })
          .sort((a, b) => b.added + b.removed - (a.added + a.removed));
        const generated = v.delta.files.filter((f) => f.kind === 'gen').map((f) => f.path);
        out.delta = {
          added: files.reduce((n, f) => n + f.added, 0),
          removed: files.reduce((n, f) => n + f.removed, 0),
          generated_hidden: generated.length,
          files,
          generated_files: generated,
        };
      }
      return out;
    }),
  };
}

export async function listVersions(
  worktreePath: string,
  branch: string,
): Promise<VersionListing> {
  const stdout = await runGt(worktreePath, ['history', branch, '--json']);
  return fromGt(JSON.parse(stdout) as GtListing);
}

/**
 * The newest version whose interdiff names each path — the version that last
 * changed that file. Versions arrive newest first, so the first one to name a
 * path is the answer for it.
 *
 * Generated files count here even though the views leave them out of a
 * version's file list. A version whose interdiff conflicts reports no files at
 * all, so a path it changed is missing from this map; callers show it as
 * unattributed rather than crediting whichever older version mentions it.
 */
export function lastTouchedVersions(
  listing: VersionListing,
): Map<string, number> {
  const lastTouched = new Map<string, number>();
  for (const version of listing.versions) {
    const delta = version.delta;
    const paths = [
      ...(delta?.files ?? []).map((f) => f.path),
      ...(delta?.generated_files ?? []),
    ];
    for (const p of paths) {
      if (!lastTouched.has(p)) lastTouched.set(p, version.version);
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
  // A commit the branch only passed through shares its date with the tip that
  // brought it, and nobody was looking at it then.
  const current = versions.find((v) => v.tip !== false && Date.parse(v.date) <= written);
  return (current ?? versions[versions.length - 1]).version;
}

/**
 * `a` and `b` are version numbers ("3"), shas, or "base" (the parent the
 * other side sits on).
 */
export async function compareVersions(
  worktreePath: string,
  branch: string,
  a: string,
  b: string,
): Promise<CompareResult> {
  const stdout = await runGt(worktreePath, [
    'history',
    'compare',
    a,
    b,
    '--branch',
    branch,
    '--json',
  ]);
  return JSON.parse(stdout) as CompareResult;
}
