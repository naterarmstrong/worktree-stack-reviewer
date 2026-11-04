import { runGt } from './gt';

/**
 * Buckets as `gt loc` names them, in the order they are displayed. gt owns the
 * rules that sort a line into one, so a branch reads the same here as it does
 * in `gt ls` and `gt loc`.
 */
export const BUCKETS = ['src', 'test', 'doc', 'gen'] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface BucketTotals {
  files: number;
  added: number;
  removed: number;
}

export interface LocSummary {
  files: number;
  added: number;
  removed: number;
  /** Iteration order is the order the buckets are displayed in. */
  buckets: Record<Bucket, BucketTotals>;
}

interface GtLines {
  add: number;
  del: number;
}

export type GtSplit = Record<Bucket, GtLines>;

/** The fields of `gt loc --json` read here. */
export interface GtLoc {
  base: string;
  commit: string;
  files: { path: string; kind: Bucket; binary?: boolean; lines: GtSplit }[];
}

/** Carries gt's own stderr message when it exits non-zero. */
export { GtError as GtLocError } from './gt';

/**
 * What a branch changes, as `gt loc` measures it: the branch's own commits,
 * from just before the oldest one, so neither a stale local trunk nor work
 * below it in the stack is counted.
 */
export async function branchLocSummary(
  cwd: string,
  branch: string,
): Promise<LocSummary> {
  return summarizeGtLoc(await readGtLoc(cwd, branch));
}

/** `gt loc --json` for a branch, or for a commit when there is no branch. */
export async function readGtLoc(cwd: string, target: string): Promise<GtLoc> {
  const stdout = await runGt(cwd, ['loc', target, '--json']);
  return JSON.parse(stdout) as GtLoc;
}

/** gt's split for each file it counted, keyed by path. */
export function fileSplits(loc: GtLoc): Map<string, GtSplit> {
  return new Map(loc.files.map((f) => [f.path, f.lines]));
}

/**
 * A file row's lines by bucket, in display order with empty buckets left out.
 * Only when gt's lines add up to the row's own counts: the row may measure
 * from a different base than gt does, or include uncommitted edits gt never
 * sees, and a split of some other change would put the wrong numbers beside
 * the file. Undefined means the row keeps its overall count.
 */
export function fileBuckets(
  added: number | undefined,
  removed: number | undefined,
  split: GtSplit | undefined,
): [Bucket, BucketTotals][] | undefined {
  if (!split || added === undefined || removed === undefined) return undefined;
  const buckets: [Bucket, BucketTotals][] = [];
  let add = 0;
  let del = 0;
  for (const bucket of BUCKETS) {
    const lines = split[bucket];
    add += lines.add;
    del += lines.del;
    if (lines.add === 0 && lines.del === 0) continue;
    buckets.push([bucket, { files: 1, added: lines.add, removed: lines.del }]);
  }
  if (add !== added || del !== removed || buckets.length === 0) return undefined;
  return buckets;
}

/**
 * Folds gt's per-file split into per-bucket totals. A file counts toward every
 * bucket it has lines in — a Rust file's `#[cfg(test)]` lines are test while
 * the rest are src — and one with no lines at all (binary, or a pure rename)
 * counts toward its own kind.
 */
export function summarizeGtLoc(loc: GtLoc): LocSummary {
  const summary = emptySummary();
  for (const file of loc.files) {
    let counted = false;
    for (const bucket of BUCKETS) {
      const { add, del } = file.lines[bucket];
      if (add === 0 && del === 0) continue;
      const totals = summary.buckets[bucket];
      totals.files += 1;
      totals.added += add;
      totals.removed += del;
      summary.added += add;
      summary.removed += del;
      counted = true;
    }
    if (!counted) summary.buckets[file.kind].files += 1;
    summary.files += 1;
  }
  return summary;
}

function emptySummary(): LocSummary {
  const buckets = {} as Record<Bucket, BucketTotals>;
  for (const bucket of BUCKETS) buckets[bucket] = { files: 0, added: 0, removed: 0 };
  return { files: 0, added: 0, removed: 0, buckets };
}

