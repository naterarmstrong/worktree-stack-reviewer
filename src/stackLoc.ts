import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { execTimed } from './exec';

const DEFAULT_COMMAND = 'gt';

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

type GtSplit = Record<Bucket, GtLines>;

/** The fields of `gt loc --json` read here. */
export interface GtLoc {
  base: string;
  commit: string;
  files: { path: string; kind: Bucket; binary?: boolean; lines: GtSplit }[];
}

/** Carries gt's own stderr message when it exits non-zero. */
export class GtLocError extends Error {}

let workingCommand: string | undefined;

/**
 * What a branch changes, as `gt loc` measures it: the branch's own commits,
 * from just before the oldest one, so neither a stale local trunk nor work
 * below it in the stack is counted.
 */
export async function branchLocSummary(
  cwd: string,
  branch: string,
): Promise<LocSummary> {
  const stdout = await runGt(cwd, ['loc', branch, '--json']);
  return summarizeGtLoc(JSON.parse(stdout) as GtLoc);
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

/**
 * Runs gt. The configured command is tried first; when it's the default bare
 * name, `~/.cargo/bin/gt` is tried too, since the VS Code server process often
 * lacks the shell profile that puts cargo's bin directory on PATH. Whichever
 * command runs is remembered for subsequent calls.
 */
async function runGt(cwd: string, args: string[]): Promise<string> {
  const configured = vscode.workspace
    .getConfiguration('worktreeReview')
    .get<string>('gtCommand', DEFAULT_COMMAND);
  const candidates: string[] = [];
  if (workingCommand) candidates.push(workingCommand);
  candidates.push(configured);
  if (configured === DEFAULT_COMMAND) {
    candidates.push(path.join(os.homedir(), '.cargo', 'bin', DEFAULT_COMMAND));
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
      throw new GtLocError(gtError(err));
    }
  }
  throw new GtLocError(
    `'${configured}' not found — install gt or set worktreeReview.gtCommand to its path`,
  );
}

/** gt reports failures as `Error: …` on stderr before exiting 1. */
function gtError(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr?.trim() ?? '';
  if (stderr) return stderr.replace(/^Error:\s*/, '');
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}
