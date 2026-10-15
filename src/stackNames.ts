import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describeError, log } from './log';
import { stateDirFor } from './statePaths';

/**
 * One file for the whole repository rather than one per worktree, the way the
 * comments and viewed stores are laid out: a stack spans branches that are
 * checked out in different worktrees, and its name has to read the same from
 * every one of them. It sits in the main worktree's state directory, which
 * every linked worktree can name and which does not move when branches are
 * checked out around it.
 */
const STACKS_FILENAME = 'stacks.json';

const STORE_VERSION = 1;

export interface NamedStack {
  name: string;
  /** Branches in the stack, ordered bottom (closest to trunk) first. */
  members: string[];
}

interface StoreFile {
  version: number;
  stacks: NamedStack[];
}

export function stacksPathFor(mainWorktreePath: string): string {
  return path.join(stateDirFor(mainWorktreePath), STACKS_FILENAME);
}

/**
 * A stack matches a stored record when the two share any branch, so the name
 * survives both a branch merging out of the stack (the record has extras) and
 * a branch being added on top (the live chain has extras).
 */
export function findStackIndex(stacks: NamedStack[], chain: string[]): number {
  const branches = new Set(chain);
  return stacks.findIndex((stack) =>
    stack.members.some((member) => branches.has(member)),
  );
}

/**
 * Merges the live chain into a stored member list, keeping members that have
 * left the chain and inserting new ones after the member they sit on. Both
 * arguments and the result are ordered bottom of stack first; neither input is
 * modified.
 *
 * Keeping departed members is what holds the numbering still: a branch that
 * merges and is deleted leaves the live chain, and without this the branch
 * above it would go from `4/6` to `3/5` on the next render.
 */
export function reconcileMembers(stored: string[], chain: string[]): string[] {
  const merged = [...stored];
  let insertAfter = -1;
  for (const branch of chain) {
    const index = merged.indexOf(branch);
    if (index !== -1) {
      insertAfter = index;
    } else {
      merged.splice(insertAfter + 1, 0, branch);
      insertAfter += 1;
    }
  }
  return merged;
}

/** A stack as the tree should draw it: its name, if any, and its full height. */
export interface ResolvedStack {
  name?: string;
  /** Every branch counted in the height, ordered bottom of stack first. */
  members: string[];
}

/** Where a branch sits in its stack, counted from the bottom as `gt log` does. */
export function stackPosition(resolved: ResolvedStack, branch: string): number {
  return resolved.members.indexOf(branch) + 1;
}

/**
 * Names given to stacks, keyed by the branches in them.
 *
 * Naming a stack also pins its membership: the branches it held when it was
 * named stay counted even after they merge and their branches are deleted, so
 * `4/6` keeps saying `4/6` instead of collapsing as the stack lands. Branches
 * added on top extend the height and are written back the next time the stack
 * is drawn.
 */
export class StackNameStore {
  private root: string | undefined;
  private stacks: NamedStack[] = [];

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
    this.stacks = await readStore(stacksPathFor(this.root));
    if (this.stacks.length > 0) {
      log().info(`stacks: loaded ${this.stacks.length} name(s) from ${this.root}`);
    }
  }

  /**
   * The name and height of the stack holding `chain`, which is the live branch
   * list ordered bottom of stack first. An unnamed stack resolves to the chain
   * itself, so rows can still be numbered.
   */
  resolve(chain: string[]): ResolvedStack {
    const index = findStackIndex(this.stacks, chain);
    if (index === -1) return { members: chain };
    const stored = this.stacks[index];
    return { name: stored.name, members: reconcileMembers(stored.members, chain) };
  }

  /**
   * Writes back a named stack that has gained branches since it was named.
   * Called as the tree renders, and does nothing when the membership is
   * already what is on disk.
   */
  async syncMembers(chain: string[]): Promise<void> {
    const index = findStackIndex(this.stacks, chain);
    if (index === -1) return;
    const stored = this.stacks[index];
    const members = reconcileMembers(stored.members, chain);
    if (sameMembers(stored.members, members)) return;
    this.stacks[index] = { name: stored.name, members };
    await this.save();
  }

  /**
   * Names the stack holding `chain`, or removes its name when `name` is empty.
   * Returns how the stack now resolves.
   */
  async setName(chain: string[], name: string): Promise<ResolvedStack> {
    // Re-read first: the file is shared by every window open on the repository,
    // and a name saved in another one since this store loaded would otherwise
    // be overwritten by this save.
    await this.load();
    const index = findStackIndex(this.stacks, chain);
    if (!name) {
      if (index !== -1) {
        this.stacks.splice(index, 1);
        await this.save();
      }
      return { members: chain };
    }
    const members =
      index === -1 ? chain : reconcileMembers(this.stacks[index].members, chain);
    const record: NamedStack = { name, members };
    if (index === -1) {
      this.stacks.push(record);
    } else {
      this.stacks[index] = record;
    }
    await this.save();
    return { name, members };
  }

  /** Forces a re-read of the file on the next render. */
  clear(): void {
    this.root = undefined;
    this.stacks = [];
  }

  private async save(): Promise<void> {
    if (!this.root) return;
    const target = stacksPathFor(this.root);
    const payload: StoreFile = { version: STORE_VERSION, stacks: this.stacks };
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (err) {
      log().error(`stacks: failed to write ${target}: ${describeError(err)}`);
      throw err;
    }
  }
}

function sameMembers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((member, i) => member === b[i]);
}

/**
 * A missing file is an empty store. A corrupt one is moved aside rather than
 * silently overwritten on the next save, matching how the comments and viewed
 * stores treat hand-edited JSON that has gone wrong.
 */
async function readStore(storePath: string): Promise<NamedStack[]> {
  let raw: string;
  try {
    raw = await fs.readFile(storePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log().warn(`stacks: cannot read ${storePath}: ${describeError(err)}`);
    }
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as StoreFile;
    const stacks = Array.isArray(parsed?.stacks) ? parsed.stacks : [];
    return stacks.filter(isUsableStack);
  } catch (err) {
    const quarantine = `${storePath}.corrupt`;
    log().error(
      `stacks: ${storePath} is not valid JSON (${describeError(err)}); moving to ${quarantine}`,
    );
    await fs.rename(storePath, quarantine).catch(() => undefined);
    return [];
  }
}

function isUsableStack(s: NamedStack): boolean {
  return (
    typeof s?.name === 'string' &&
    s.name !== '' &&
    Array.isArray(s?.members) &&
    s.members.length > 0 &&
    s.members.every((member) => typeof member === 'string')
  );
}
