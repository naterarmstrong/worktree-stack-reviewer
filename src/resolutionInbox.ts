import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  INBOX_FILENAME,
  type InboxEntry,
  type NoteEntry,
  type ResolutionEntry,
  inboxPathFor,
  rejectedPathFor,
} from './commentStore';
import { describeError, log } from './log';

const DEBOUNCE_MS = 400;

export type InboxHandler = (
  worktreePath: string,
  entries: InboxEntry[],
) => Promise<void>;

/**
 * Watches each worktree's resolutions inbox and hands batches to the handler.
 *
 * A batch is claimed by renaming the inbox aside before it is read. The rename
 * is atomic, so an agent appending at that moment writes a fresh inbox rather
 * than racing the read — no entry is seen twice and none is lost between the
 * read and the delete.
 *
 * The directory is watched rather than the file itself because the inbox
 * usually does not exist yet, and `fs.watch` on a missing path throws. Events
 * are filtered by filename so the extension's own writes to comments.json in
 * the same directory don't trigger a drain.
 */
export class ResolutionInbox implements vscode.Disposable {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private draining = false;

  constructor(private readonly handler: InboxHandler) {}

  watch(worktreePaths: string[]): void {
    const live = new Set(worktreePaths);
    for (const [p, w] of Array.from(this.watchers.entries())) {
      if (live.has(p)) continue;
      w.close();
      this.watchers.delete(p);
    }
    for (const worktreePath of worktreePaths) {
      if (this.watchers.has(worktreePath)) continue;
      const dir = path.dirname(inboxPathFor(worktreePath));
      try {
        fs.mkdirSync(dir, { recursive: true });
        const watcher = fs.watch(dir, (_event, filename) => {
          if (filename && path.basename(filename) !== INBOX_FILENAME) return;
          this.schedule(worktreePath);
        });
        this.watchers.set(worktreePath, watcher);
      } catch (err) {
        log().warn(`inbox: cannot watch ${dir}: ${describeError(err)}`);
      }
    }
    // An inbox written while the window was closed is still waiting.
    for (const worktreePath of worktreePaths) this.schedule(worktreePath);
  }

  private schedule(worktreePath: string): void {
    const existing = this.timers.get(worktreePath);
    if (existing) clearTimeout(existing);
    this.timers.set(
      worktreePath,
      setTimeout(() => {
        this.timers.delete(worktreePath);
        void this.drain(worktreePath);
      }, DEBOUNCE_MS),
    );
  }

  /** Drains one worktree's inbox. Serialised so batches can't interleave. */
  async drain(worktreePath: string): Promise<void> {
    while (this.draining) await new Promise((r) => setTimeout(r, 50));
    this.draining = true;
    try {
      const entries = await claimBatch(worktreePath);
      if (entries.length === 0) return;
      log().info(`inbox: claimed ${entries.length} entry(s) from ${worktreePath}`);
      await this.handler(worktreePath, entries);
    } catch (err) {
      log().error(`inbox: drain failed for ${worktreePath}: ${describeError(err)}`);
    } finally {
      this.draining = false;
    }
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }
}

/**
 * Moves the inbox aside and parses it. Returns an empty list when there is
 * nothing to do. A malformed inbox is kept as `.rejected` rather than deleted,
 * so a bad write is visible instead of silently discarded.
 */
async function claimBatch(worktreePath: string): Promise<InboxEntry[]> {
  const inbox = inboxPathFor(worktreePath);
  const claimed = `${inbox}.claimed`;
  try {
    await fsp.rename(inbox, claimed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let raw: string;
  try {
    raw = await fsp.readFile(claimed, 'utf8');
  } finally {
    await fsp.rm(claimed, { force: true }).catch(() => undefined);
  }
  if (raw.trim().length === 0) return [];
  try {
    return parseEntries(raw);
  } catch (err) {
    log().error(`inbox: ${inbox} was not usable: ${describeError(err)}`);
    await fsp
      .writeFile(rejectedPathFor(worktreePath), raw, 'utf8')
      .catch(() => undefined);
    void vscode.window.showWarningMessage(
      'Worktree Stack Reviewer: resolutions.json could not be read; contents kept in resolutions.rejected.json.',
    );
    return [];
  }
}

/**
 * Accepts either `{ "entries": [...] }` or a bare array. Agents produce both
 * shapes readily and rejecting one on a technicality only creates a retry loop.
 *
 * An entry with an `id` is a resolution of that thread; one with a `file` and
 * a `body` and no `id` is a note to open. Anything else is skipped.
 */
export function parseEntries(raw: string): InboxEntry[] {
  const parsed = JSON.parse(raw) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) {
    throw new Error('expected an array of entries, or { "entries": [...] }');
  }
  const entries: InboxEntry[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const resolution = parseResolution(item as Record<string, unknown>);
    if (resolution) {
      entries.push(resolution);
      continue;
    }
    const note = parseNote(item as Record<string, unknown>);
    if (note) entries.push(note);
  }
  return entries;
}

function parseResolution(e: Record<string, unknown>): ResolutionEntry | undefined {
  if (typeof e.id !== 'string' || e.id.length === 0) return undefined;
  return {
    id: e.id,
    resolved: typeof e.resolved === 'boolean' ? e.resolved : undefined,
    reply: nonBlank(e.reply),
    author: nonBlank(e.author),
  };
}

function parseNote(e: Record<string, unknown>): NoteEntry | undefined {
  const file = nonBlank(e.file);
  const body = nonBlank(e.body);
  if (!file || !body) return undefined;
  const startLine = positiveInt(e.startLine);
  // An end without a start has nothing to be the end of.
  const endLine = startLine === undefined ? undefined : positiveInt(e.endLine);
  return {
    file,
    body,
    startLine,
    endLine,
    author: nonBlank(e.author),
    snippet: typeof e.snippet === 'string' ? e.snippet : undefined,
  };
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : undefined;
}
