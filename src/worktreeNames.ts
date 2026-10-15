import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describeError, log } from './log';
import { stateDirFor } from './statePaths';

/**
 * One file for the whole repository rather than one per worktree, the way the
 * comments and viewed stores are laid out. It sits in the main worktree's
 * state directory, which every linked worktree can name and which does not
 * move when branches are checked out around it.
 */
const NAMES_FILENAME = 'worktree-names.json';

const STORE_VERSION = 1;

interface NamedWorktree {
  /** Absolute, as `git worktree list` reports it. */
  path: string;
  name: string;
}

interface StoreFile {
  version: number;
  worktrees: NamedWorktree[];
}

export function namesPathFor(mainWorktreePath: string): string {
  return path.join(stateDirFor(mainWorktreePath), NAMES_FILENAME);
}

/**
 * Names given to worktrees, keyed by worktree path.
 *
 * The name says what a worktree is being used for, which outlasts any one
 * branch: checking a different branch out keeps the name, and two worktrees on
 * the same stack are named separately.
 */
export class WorktreeNameStore {
  private root: string | undefined;
  private names = new Map<string, string>();

  /**
   * Points the store at a repository, reading its file the first time and on
   * any later change of root. Awaited before the tree builds its rows, so a
   * worktree never renders under its branch name only because the store had
   * not arrived yet.
   */
  async setRoot(mainWorktreePath: string): Promise<void> {
    if (this.root === mainWorktreePath) return;
    this.root = mainWorktreePath;
    await this.load();
  }

  async load(): Promise<void> {
    if (!this.root) return;
    this.names = await readStore(namesPathFor(this.root));
    if (this.names.size > 0) {
      log().info(`names: loaded ${this.names.size} name(s) from ${this.root}`);
    }
  }

  nameFor(worktreePath: string): string | undefined {
    return this.names.get(worktreePath);
  }

  /** Names a worktree, or removes its name when `name` is empty. */
  async setName(worktreePath: string, name: string): Promise<void> {
    // Re-read first: the file is shared by every window open on the repository,
    // and a name saved in another one since this store loaded would otherwise
    // be overwritten by this save.
    await this.load();
    if (name) {
      this.names.set(worktreePath, name);
    } else if (!this.names.delete(worktreePath)) {
      return;
    }
    await this.save();
  }

  /**
   * Drops names for worktrees that no longer exist. Worth doing because the key
   * is a path: the throwaway worktrees an agent session creates are gone for
   * good once removed, and their names would otherwise accumulate forever.
   */
  async prune(livePaths: string[]): Promise<void> {
    // Re-read for the same reason `setName` does, and more sharply: this saves
    // the whole map back, so a name written in another window since this store
    // loaded would be dropped from the file rather than merely overwritten.
    await this.load();
    const live = new Set(livePaths);
    const stale = Array.from(this.names.keys()).filter((p) => !live.has(p));
    if (stale.length === 0) return;
    for (const p of stale) this.names.delete(p);
    log().info(`names: dropped ${stale.length} name(s) for removed worktree(s)`);
    await this.save();
  }

  /** Forces a re-read of the file on the next render. */
  clear(): void {
    this.root = undefined;
    this.names = new Map();
  }

  private async save(): Promise<void> {
    if (!this.root) return;
    const target = namesPathFor(this.root);
    const worktrees = Array.from(this.names, ([p, name]) => ({ path: p, name }));
    const payload: StoreFile = { version: STORE_VERSION, worktrees };
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (err) {
      log().error(`names: failed to write ${target}: ${describeError(err)}`);
      throw err;
    }
  }
}

/**
 * A missing file is an empty store. A corrupt one is moved aside rather than
 * silently overwritten on the next save, matching how the comments and viewed
 * stores treat hand-edited JSON that has gone wrong.
 */
async function readStore(storePath: string): Promise<Map<string, string>> {
  let raw: string;
  try {
    raw = await fs.readFile(storePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log().warn(`names: cannot read ${storePath}: ${describeError(err)}`);
    }
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw) as StoreFile;
    const entries = Array.isArray(parsed?.worktrees) ? parsed.worktrees : [];
    return new Map(entries.filter(isUsable).map((w) => [w.path, w.name]));
  } catch (err) {
    const quarantine = `${storePath}.corrupt`;
    log().error(
      `names: ${storePath} is not valid JSON (${describeError(err)}); moving to ${quarantine}`,
    );
    await fs.rename(storePath, quarantine).catch(() => undefined);
    return new Map();
  }
}

function isUsable(w: NamedWorktree): boolean {
  return (
    typeof w?.path === 'string' &&
    w.path !== '' &&
    typeof w?.name === 'string' &&
    w.name !== ''
  );
}
