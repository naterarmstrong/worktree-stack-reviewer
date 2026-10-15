import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describeError, log } from './log';
import { stateDirFor } from './statePaths';

/** Sits beside the comments store, in the worktree's state directory. */
const VIEWED_FILENAME = 'viewed.json';

const STORE_VERSION = 1;

/**
 * How many patch ids a file remembers. More than one so that flipping the
 * working-tree/committed-only toggle, or reverting an edit, restores the tick
 * rather than discarding the review. Old ids fall off the front.
 */
const MAX_MARKS = 10;

export interface ViewedMark {
  patchId: string;
  /**
   * Base blob at the moment this mark was made. Compared against the current
   * base to report that the change was rebased since it was reviewed; never
   * part of deciding whether the file counts as viewed.
   */
  baseBlob?: string;
  at: string;
}

export interface ViewedEntry {
  /**
   * Viewed state is scoped to the branch, not to the worktree holding the file:
   * checking the branch out elsewhere brings its review progress along.
   */
  branch: string;
  /** Worktree-relative, always posix-separated. */
  file: string;
  marks: ViewedMark[];
}

interface StoreFile {
  version: number;
  entries: ViewedEntry[];
}

function viewedPathFor(worktreePath: string): string {
  return path.join(stateDirFor(worktreePath), VIEWED_FILENAME);
}

export interface ViewedStatus {
  viewed: boolean;
  /** Viewed, but on a base the branch has since been rebased onto. */
  baseMoved: boolean;
}

const UNVIEWED: ViewedStatus = { viewed: false, baseMoved: false };

/**
 * Which changed files have been reviewed, backed by one JSON file per worktree.
 *
 * A file counts as viewed when its current patch id is one this branch has
 * been marked at before. Because the patch id ignores blob shas and hunk line
 * numbers, a restack that re-applies the same change onto a moved base leaves
 * the tick in place; amending the change itself clears it.
 */
export class ViewedStore {
  private readonly byWorktree = new Map<string, ViewedEntry[]>();

  async load(worktreePath: string, force = false): Promise<void> {
    if (!force && this.byWorktree.has(worktreePath)) return;
    const entries = await readStore(viewedPathFor(worktreePath));
    this.byWorktree.set(worktreePath, entries);
    if (entries.length > 0) {
      log().info(`viewed: loaded ${entries.length} entr(ies) for ${worktreePath}`);
    }
  }

  /**
   * Loads any worktree not already held and forgets the ones that have gone.
   * Awaited by the tree provider before it builds file rows, so a row never
   * renders unticked only because the store had not arrived yet.
   */
  async setWorktrees(worktreePaths: string[]): Promise<void> {
    const live = new Set(worktreePaths);
    for (const known of Array.from(this.byWorktree.keys())) {
      if (!live.has(known)) this.byWorktree.delete(known);
    }
    await Promise.all(worktreePaths.map((p) => this.load(p)));
  }

  /**
   * Every stored entry for a branch, wherever it was written. A branch moved
   * between worktrees leaves its entries in the file where they were made.
   */
  private entriesFor(branch: string, file: string): { storedIn: string; entry: ViewedEntry }[] {
    const found: { storedIn: string; entry: ViewedEntry }[] = [];
    for (const [storedIn, entries] of this.byWorktree) {
      for (const entry of entries) {
        if (entry.branch === branch && entry.file === file) {
          found.push({ storedIn, entry });
        }
      }
    }
    return found;
  }

  status(branch: string, file: string, patchId: string | undefined, baseBlob: string | undefined): ViewedStatus {
    // A file with no patch id — an unreadable diff — can never match a mark, so
    // it stays unticked rather than inheriting some earlier file's state.
    if (!patchId) return UNVIEWED;
    for (const { entry } of this.entriesFor(branch, file)) {
      const mark = entry.marks.find((m) => m.patchId === patchId);
      if (mark) {
        return {
          viewed: true,
          baseMoved: mark.baseBlob !== undefined && !sameBlob(mark.baseBlob, baseBlob),
        };
      }
    }
    return UNVIEWED;
  }

  /**
   * Records a file as viewed at its current patch id. Returns the worktree
   * whose store file needs writing.
   */
  mark(
    worktreePath: string,
    branch: string,
    file: string,
    patchId: string,
    baseBlob: string | undefined,
  ): string {
    const existing = this.entriesFor(branch, file);
    const target = existing[0] ?? {
      storedIn: worktreePath,
      entry: this.append(worktreePath, { branch, file, marks: [] }),
    };
    const marks = target.entry.marks.filter((m) => m.patchId !== patchId);
    marks.push({ patchId, baseBlob, at: new Date().toISOString() });
    target.entry.marks = marks.slice(-MAX_MARKS);
    return target.storedIn;
  }

  /**
   * Drops every mark for a file. Returns the worktrees whose store files need
   * writing — a branch reviewed in two worktrees can hold entries in both, and
   * clearing only one would let the tick come straight back.
   */
  unmark(branch: string, file: string): string[] {
    const touched = new Set<string>();
    for (const { storedIn, entry } of this.entriesFor(branch, file)) {
      if (entry.marks.length === 0) continue;
      entry.marks = [];
      touched.add(storedIn);
    }
    for (const worktreePath of touched) this.compact(worktreePath);
    return Array.from(touched);
  }

  /** Drops every mark on a branch, wherever it was stored. */
  unmarkBranch(branch: string): { cleared: number; touched: string[] } {
    const touched = new Set<string>();
    let cleared = 0;
    for (const [worktreePath, entries] of this.byWorktree) {
      const kept = entries.filter((e) => e.branch !== branch);
      if (kept.length === entries.length) continue;
      cleared += entries.length - kept.length;
      this.byWorktree.set(worktreePath, kept);
      touched.add(worktreePath);
    }
    return { cleared, touched: Array.from(touched) };
  }

  /** Forgets entries for branches that no longer exist locally. */
  prune(liveBranches: Set<string>): string[] {
    const touched: string[] = [];
    for (const [worktreePath, entries] of this.byWorktree) {
      const kept = entries.filter((e) => liveBranches.has(e.branch));
      if (kept.length === entries.length) continue;
      this.byWorktree.set(worktreePath, kept);
      touched.push(worktreePath);
    }
    return touched;
  }

  async save(worktreePath: string): Promise<void> {
    const entries = this.byWorktree.get(worktreePath) ?? [];
    const target = viewedPathFor(worktreePath);
    const payload: StoreFile = { version: STORE_VERSION, entries: sortEntries(entries) };
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (err) {
      log().error(`viewed: failed to write ${target}: ${describeError(err)}`);
      throw err;
    }
  }

  clear(): void {
    this.byWorktree.clear();
  }

  private append(worktreePath: string, entry: ViewedEntry): ViewedEntry {
    const entries = this.byWorktree.get(worktreePath);
    if (entries) {
      entries.push(entry);
    } else {
      this.byWorktree.set(worktreePath, [entry]);
    }
    return entry;
  }

  /** Removes entries left holding no marks, so the file does not grow forever. */
  private compact(worktreePath: string): void {
    const entries = this.byWorktree.get(worktreePath);
    if (!entries) return;
    this.byWorktree.set(
      worktreePath,
      entries.filter((e) => e.marks.length > 0),
    );
  }
}

function sortEntries(entries: ViewedEntry[]): ViewedEntry[] {
  return [...entries].sort(
    (a, b) => a.branch.localeCompare(b.branch) || a.file.localeCompare(b.file),
  );
}

/**
 * A missing file is an empty store. A corrupt one is moved aside rather than
 * silently overwritten on the next save, matching how the comments store treats
 * hand-edited JSON that has gone wrong.
 */
async function readStore(storePath: string): Promise<ViewedEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(storePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log().warn(`viewed: cannot read ${storePath}: ${describeError(err)}`);
    }
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as StoreFile;
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    return entries.filter(isUsableEntry);
  } catch (err) {
    const quarantine = `${storePath}.corrupt`;
    log().error(
      `viewed: ${storePath} is not valid JSON (${describeError(err)}); moving to ${quarantine}`,
    );
    await fs.rename(storePath, quarantine).catch(() => undefined);
    return [];
  }
}

function isUsableEntry(e: ViewedEntry): boolean {
  return (
    typeof e?.branch === 'string' &&
    typeof e?.file === 'string' &&
    Array.isArray(e?.marks) &&
    e.marks.every((m) => typeof m?.patchId === 'string')
  );
}

/**
 * Whether two abbreviated blob ids name the same blob. The abbreviation's
 * length is not fixed — git lengthens it as a repository grows, and marks
 * written before the core took over carry git's `--numstat --patch` length,
 * one longer than the plain diff's — so the shorter must be a prefix of the
 * longer rather than equal to it.
 */
export function sameBlob(a: string, b: string | undefined): boolean {
  if (b === undefined) return false;
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}
