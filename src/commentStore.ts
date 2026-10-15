import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describeError, log } from './log';
import { stateDirFor } from './statePaths';

/**
 * What a comment is anchored to. `working` is the file on disk in the worktree;
 * `base` is the read-only left side of a diff (the `wt-ext-git:` virtual
 * document), which is the only way to comment on lines that the change
 * deleted; `pr` is a pull request description (the `wt-ext-pr:` virtual
 * document), which is text on GitHub rather than anywhere in the worktree.
 */
export type CommentSide = 'working' | 'base' | 'pr';

/**
 * One comments file per worktree, in its state directory (see `stateDirFor`).
 * "Copy Comments File Path" hands an agent the full path.
 */
const STORE_FILENAME = 'comments.json';

/**
 * Pruned threads land here rather than being deleted. A branch can go missing
 * for boring reasons — deleted after merge, or a mistyped `git branch -D` — and
 * losing review notes to a background timer is the kind of failure that is fine
 * until the once it isn't.
 */
const ARCHIVE_FILENAME = 'comments.archive.json';

const STORE_VERSION = 1;

export interface StoredComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

/**
 * A `note` is a thread an agent opened to describe part of a change, as
 * distinct from a review comment a person left asking for one. Absent on
 * review comments, which is also what every thread written before notes
 * existed is.
 */
export type ThreadKind = 'note';

export interface StoredThread {
  id: string;
  kind?: ThreadKind;
  /**
   * The branch the comment was written against. Comments are scoped globally by
   * branch, not by the worktree whose file happens to hold them: checking the
   * branch out in a different worktree brings its comments along. Optional only
   * to tolerate stores written before branch scoping existed; `hydrate` stamps
   * those on first load.
   */
  branch?: string;
  /**
   * Worktree-relative, always posix-separated. A `pr` thread has no file to
   * name, so it carries the description's name instead — `PR-142.md`, which is
   * also what its tab reads.
   */
  file: string;
  side: CommentSide;
  /**
   * Short sha of the branch tip when the comment was written, which is the
   * patch it was left on. Optional: threads written before this was recorded,
   * and any an agent adds to the file by hand, carry none — those are dated
   * back to a patch instead. See `versionForComment`.
   */
  sha?: string;
  /**
   * For `base` comments, the git ref whose content the comment was written
   * against. Recorded so the virtual document URI round-trips exactly and the
   * thread reappears on the same diff rather than on a second, near-identical
   * one. Unset for `working` comments.
   */
  baseRef?: string;
  /** 1-based inclusive. Both omitted for a whole-file comment. */
  startLine?: number;
  endLine?: number;
  /** Verbatim full-line text the range covered when the comment was written. */
  snippet?: string;
  /** Set when the snippet could no longer be found near its recorded line. */
  drifted?: boolean;
  resolved: boolean;
  createdAt: string;
  comments: StoredComment[];
}

interface StoreFile {
  version: number;
  threads: StoredThread[];
}

/**
 * Inbox an agent writes to and the extension drains: resolutions of existing
 * threads, and notes that open new ones. Deliberately a separate file from the
 * store so each has exactly one writer: the extension owns comments.json, the
 * agent owns this. A shared file could not offer that —
 * `save` serialises comments.json wholesale from memory, so any external edit
 * would be overwritten by the next UI action.
 */
export const INBOX_FILENAME = 'resolutions.json';

/** Entries the extension could not apply are parked here, each with a reason, not dropped. */
const REJECTED_FILENAME = 'resolutions.rejected.json';

export function storePathFor(worktreePath: string): string {
  return path.join(stateDirFor(worktreePath), STORE_FILENAME);
}

export function inboxPathFor(worktreePath: string): string {
  return path.join(stateDirFor(worktreePath), INBOX_FILENAME);
}

export function rejectedPathFor(worktreePath: string): string {
  return path.join(stateDirFor(worktreePath), REJECTED_FILENAME);
}

/** Acts on an existing thread, named by id. */
export interface ResolutionEntry {
  /** Thread id, as it appears in the exported JSON. */
  id: string;
  resolved?: boolean;
  reply?: string;
  author?: string;
}

/**
 * Opens a note thread on a file in the inbox's worktree. Notes attach to the
 * file on disk only; there is no way to write one against the base side.
 */
export interface NoteEntry {
  /** Worktree-relative, posix-separated. */
  file: string;
  /** 1-based inclusive. Both omitted for a whole-file note. */
  startLine?: number;
  endLine?: number;
  body: string;
  author?: string;
  /**
   * Verbatim full-line text the range covers. Read from the file on pickup
   * when omitted, so a writer that has the lines to hand can skip it.
   */
  snippet?: string;
}

export type InboxEntry = ResolutionEntry | NoteEntry;

export function isNoteEntry(entry: InboxEntry): entry is NoteEntry {
  return !('id' in entry);
}

export function archivePathFor(worktreePath: string): string {
  return path.join(stateDirFor(worktreePath), ARCHIVE_FILENAME);
}

export interface ArchivedThread extends StoredThread {
  archivedAt: string;
  archivedReason: string;
}

/**
 * In-memory model of every worktree's comments, backed by one JSON file per
 * worktree. Loads are idempotent; callers mutate the returned `StoredThread`
 * objects in place and then call `save`.
 */
export class CommentStore {
  private readonly byWorktree = new Map<string, StoredThread[]>();
  private seq = 0;

  async load(worktreePath: string, force = false): Promise<void> {
    if (!force && this.byWorktree.has(worktreePath)) return;
    const threads = await readStore(storePathFor(worktreePath));
    this.byWorktree.set(worktreePath, threads);
    if (threads.length > 0) {
      log().info(`comments: loaded ${threads.length} thread(s) for ${worktreePath}`);
    }
  }

  /** Worktrees whose comments are currently held in memory. */
  loadedWorktrees(): string[] {
    return Array.from(this.byWorktree.keys());
  }

  isLoaded(worktreePath: string): boolean {
    return this.byWorktree.has(worktreePath);
  }

  threads(worktreePath: string): StoredThread[] {
    return this.byWorktree.get(worktreePath) ?? [];
  }

  find(worktreePath: string, threadId: string): StoredThread | undefined {
    return this.threads(worktreePath).find((t) => t.id === threadId);
  }

  add(worktreePath: string, thread: StoredThread): void {
    const list = this.byWorktree.get(worktreePath);
    if (list) {
      list.push(thread);
    } else {
      this.byWorktree.set(worktreePath, [thread]);
    }
  }

  remove(worktreePath: string, threadId: string): void {
    const list = this.byWorktree.get(worktreePath);
    if (!list) return;
    const idx = list.findIndex((t) => t.id === threadId);
    if (idx >= 0) list.splice(idx, 1);
  }

  drop(worktreePath: string): void {
    this.byWorktree.delete(worktreePath);
  }

  clear(): void {
    this.byWorktree.clear();
  }

  async save(worktreePath: string): Promise<void> {
    const threads = this.threads(worktreePath);
    const target = storePathFor(worktreePath);
    const payload: StoreFile = { version: STORE_VERSION, threads: sortThreads(threads) };
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (err) {
      log().error(`comments: failed to write ${target}: ${describeError(err)}`);
      throw err;
    }
  }

  /** Appends to the worktree's archive, preserving anything already there. */
  async archive(
    worktreePath: string,
    threads: StoredThread[],
    reason: string,
  ): Promise<void> {
    if (threads.length === 0) return;
    const target = archivePathFor(worktreePath);
    const existing = await readArchive(target);
    const archivedAt = new Date().toISOString();
    const merged: ArchivedThread[] = [
      ...existing,
      ...threads.map((t) => ({ ...t, archivedAt, archivedReason: reason })),
    ];
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(
        target,
        `${JSON.stringify({ version: STORE_VERSION, threads: merged }, null, 2)}\n`,
        'utf8',
      );
    } catch (err) {
      log().error(`comments: failed to archive to ${target}: ${describeError(err)}`);
      throw err;
    }
  }

  newId(): string {
    this.seq += 1;
    return `${Date.now().toString(36)}${this.seq.toString(36)}`;
  }
}

export function sortThreads(threads: StoredThread[]): StoredThread[] {
  return [...threads].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      (a.startLine ?? 0) - (b.startLine ?? 0) ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

/**
 * Reads and shape-checks a store file. A missing file is an empty store. A
 * corrupt one is moved aside rather than silently overwritten on the next save,
 * so hand-edited JSON that goes wrong is recoverable.
 */
async function readStore(storePath: string): Promise<StoredThread[]> {
  let raw: string;
  try {
    raw = await fs.readFile(storePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log().warn(`comments: cannot read ${storePath}: ${describeError(err)}`);
    }
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as StoreFile;
    const threads = Array.isArray(parsed?.threads) ? parsed.threads : [];
    return threads.filter(isUsableThread);
  } catch (err) {
    const quarantine = `${storePath}.corrupt`;
    log().error(
      `comments: ${storePath} is not valid JSON (${describeError(err)}); moving to ${quarantine}`,
    );
    await fs.rename(storePath, quarantine).catch(() => undefined);
    return [];
  }
}

/**
 * Archive reads are best-effort: a damaged archive must never block a prune,
 * but it also must not be silently replaced, so a bad file is left alone and
 * the prune is skipped by the caller when this throws.
 */
async function readArchive(archivePath: string): Promise<ArchivedThread[]> {
  let raw: string;
  try {
    raw = await fs.readFile(archivePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return [];
  }
  const parsed = JSON.parse(raw) as { threads?: ArchivedThread[] };
  return Array.isArray(parsed?.threads) ? parsed.threads : [];
}

function isUsableThread(t: StoredThread): boolean {
  return (
    typeof t?.id === 'string' &&
    typeof t?.file === 'string' &&
    (t.side === 'working' || t.side === 'base' || t.side === 'pr') &&
    Array.isArray(t.comments)
  );
}
