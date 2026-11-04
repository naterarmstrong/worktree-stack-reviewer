import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { mainWorktreePath } from './git';
import { previewPathProblem } from './htmlPreview';
import { describeError, log } from './log';
import { stateDirFor } from './statePaths';

/**
 * A PR's explainer: a self-contained HTML page an agent (the wt-review skill)
 * writes about the change. The agent reports through the inbox when it starts
 * and when the page is written, and the tree shows that under the PR's
 * description: a spinner while it works, then a row that opens the page.
 *
 * One file for the whole repository, beside stacks.json in the main worktree's
 * state directory, since the PR can be shown under any worktree's stack and
 * every window on the repository should agree on how far along it is.
 */
const EXPLAINERS_FILENAME = 'explainers.json';
const STORE_VERSION = 1;

/**
 * A `started` that has heard nothing for this long is shown as stalled rather
 * than spinning forever: the agent that sent it has most likely stopped.
 */
export const EXPLAINER_STALL_MS = 30 * 60 * 1000;

export type ExplainerStatus = 'started' | 'done' | 'failed';

/** An inbox entry reporting on a PR's explainer. */
export interface ExplainerEntry {
  kind: 'explainer';
  pr: number;
  status: ExplainerStatus;
  /** Absolute path of the page; required for `done`. */
  path?: string;
  /** Shown on the row; the page's own <title> names its tab. */
  title?: string;
  /** Why a `failed` explainer failed. */
  error?: string;
}

export interface ExplainerState {
  status: ExplainerStatus;
  path?: string;
  title?: string;
  error?: string;
  /** ISO times. */
  startedAt?: string;
  updatedAt: string;
}

/** The entry an inbox item describes, or undefined when it is not an explainer entry. */
export function parseExplainerEntry(e: Record<string, unknown>): ExplainerEntry | undefined {
  if (e.kind !== 'explainer') return undefined;
  const pr = typeof e.pr === 'string' ? Number(e.pr.replace(/^#/, '')) : e.pr;
  if (typeof pr !== 'number' || !Number.isInteger(pr) || pr < 1) return undefined;
  if (e.status !== 'started' && e.status !== 'done' && e.status !== 'failed') {
    return undefined;
  }
  const text = (v: unknown) =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  return {
    kind: 'explainer',
    pr,
    status: e.status,
    path: text(e.path),
    title: text(e.title),
    error: text(e.error),
  };
}

/** Why an entry can't be applied, or undefined when it can. */
export function explainerEntryProblem(entry: ExplainerEntry): string | undefined {
  if (entry.status !== 'done') return undefined;
  if (!entry.path) return 'a done explainer needs the path of its page';
  return previewPathProblem(entry.path);
}

/** The state `entry` moves an explainer to, from what it was. */
export function nextExplainerState(
  previous: ExplainerState | undefined,
  entry: ExplainerEntry,
  now: Date,
): ExplainerState {
  const updatedAt = now.toISOString();
  if (entry.status === 'started') {
    // A restart keeps the last finished page until the new one replaces it.
    return {
      status: 'started',
      path: previous?.path,
      title: entry.title ?? previous?.title,
      startedAt: updatedAt,
      updatedAt,
    };
  }
  if (entry.status === 'failed') {
    return { ...previous, status: 'failed', error: entry.error ?? 'no reason given', updatedAt };
  }
  return {
    status: 'done',
    path: entry.path,
    title: entry.title ?? previous?.title,
    startedAt: previous?.startedAt,
    updatedAt,
  };
}

interface StoreFile {
  version: number;
  /** Keyed by PR number. */
  explainers: Record<string, ExplainerState>;
}

export class ExplainerStore implements vscode.Disposable {
  private root: Promise<string | undefined> | undefined;
  private states = new Map<number, ExplainerState>();
  private loaded = false;
  private readonly _onDidChange = new vscode.EventEmitter<number>();
  /** Fires with the PR number whose explainer changed. */
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly repoPath: string) {}

  get(pr: number): ExplainerState | undefined {
    return this.states.get(pr);
  }

  /** Reads the file, on first use or after `clear`. Awaited before the tree builds rows. */
  async load(): Promise<void> {
    if (this.loaded) return;
    const file = await this.filePath();
    this.loaded = true;
    if (!file) return;
    this.states = await readStore(file);
  }

  /** Forces a re-read on the next load: another window may have written the file. */
  clear(): void {
    this.loaded = false;
  }

  /** Applies an inbox entry; returns why it was refused, if it was. */
  async apply(entry: ExplainerEntry): Promise<string | undefined> {
    const problem = explainerEntryProblem(entry);
    if (problem) return problem;
    // Re-read first, so a change another window saved isn't overwritten.
    this.loaded = false;
    await this.load();
    const next = nextExplainerState(this.states.get(entry.pr), entry, new Date());
    this.states.set(entry.pr, next);
    await this.save();
    log().info(`explainers: #${entry.pr} ${entry.status}${entry.path ? ` (${entry.path})` : ''}`);
    this._onDidChange.fire(entry.pr);
    return undefined;
  }

  private filePath(): Promise<string | undefined> {
    this.root ??= mainWorktreePath(this.repoPath).catch((err) => {
      log().warn(`explainers: cannot locate the main worktree: ${describeError(err)}`);
      return undefined;
    });
    return this.root.then((root) => (root ? path.join(stateDirFor(root), EXPLAINERS_FILENAME) : undefined));
  }

  private async save(): Promise<void> {
    const file = await this.filePath();
    if (!file) return;
    const payload: StoreFile = {
      version: STORE_VERSION,
      explainers: Object.fromEntries([...this.states].map(([pr, s]) => [String(pr), s])),
    };
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp${process.pid}`;
      await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await fs.rename(tmp, file);
    } catch (err) {
      log().error(`explainers: failed to write ${file}: ${describeError(err)}`);
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/** A missing file is an empty store; a corrupt one is moved aside, as the other stores do. */
async function readStore(file: string): Promise<Map<number, ExplainerState>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log().warn(`explainers: cannot read ${file}: ${describeError(err)}`);
    }
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw) as StoreFile;
    const states = new Map<number, ExplainerState>();
    for (const [pr, s] of Object.entries(parsed?.explainers ?? {})) {
      if (s && ['started', 'done', 'failed'].includes(s.status)) states.set(Number(pr), s);
    }
    return states;
  } catch (err) {
    const quarantine = `${file}.corrupt`;
    log().error(`explainers: ${file} is not valid JSON (${describeError(err)}); moving to ${quarantine}`);
    await fs.rename(file, quarantine).catch(() => undefined);
    return new Map();
  }
}
