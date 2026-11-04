import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { listWorktrees, revParse } from '../../src/git';
import { WorktreeWatcher, isBaseReflog } from '../../src/watcher';
import { type Fixture, git, makeFixture } from '../fixtures/repo';

/** Past the watcher's debounce, with room for the filesystem event to land. */
const SETTLE_MS = 2500;

describe('isBaseReflog', () => {
  const bases = new Set(['main', 'origin/main', 'stack/parent']);

  test('matches a local base, a remote-tracking base and a slashed name', () => {
    expect(isBaseReflog('heads/main', bases)).toBe(true);
    expect(isBaseReflog('remotes/origin/main', bases)).toBe(true);
    expect(isBaseReflog('heads/stack/parent', bases)).toBe(true);
  });

  test('drops every other ref, so a fetch does not refresh the tree', () => {
    expect(isBaseReflog('heads/feature', bases)).toBe(false);
    expect(isBaseReflog('remotes/origin/feature', bases)).toBe(false);
    expect(isBaseReflog(null, bases)).toBe(false);
  });
});

describe('WorktreeWatcher', () => {
  let fixture: Fixture;
  let watcher: WorktreeWatcher;
  const onChange = vi.fn();

  beforeAll(async () => {
    fixture = makeFixture();
    watcher = new WorktreeWatcher(onChange);
    // Checked out nowhere, as trunk is when every worktree is on a branch:
    // moving a checked-out branch would also write that worktree's `logs/HEAD`.
    git(fixture.repo, ['branch', 'trunk', 'main']);
    watcher.setBaseRefs(['trunk']);
    await watcher.update(await listWorktrees(fixture.repo));
    // fs.watch can report writes from just before it attached.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    onChange.mockClear();
  });

  afterAll(() => {
    watcher.dispose();
    fixture.remove();
  });

  test('ignores a branch nothing diffs against', async () => {
    git(fixture.repo, ['branch', 'unrelated', 'main']);
    git(fixture.repo, ['update-ref', '-m', 'move', 'refs/heads/unrelated', 'feature']);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    expect(onChange).not.toHaveBeenCalled();
  });

  test('fires when a base moves while no checked-out HEAD does', async () => {
    // What `gt sync` does to trunk from a worktree on another branch.
    const tip = await revParse(fixture.repo, 'feature');
    git(fixture.repo, ['update-ref', '-m', 'sync', 'refs/heads/trunk', tip]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 5000, interval: 100 });
  });
});
