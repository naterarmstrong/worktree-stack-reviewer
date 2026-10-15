import * as fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  CommentStore,
  type StoredThread,
  archivePathFor,
  storePathFor,
} from '../../src/commentStore';
import { ViewedStore } from '../../src/viewedStore';
import { type Fixture, makeFixture } from '../fixtures/repo';

function thread(id: string, overrides: Partial<StoredThread> = {}): StoredThread {
  return {
    id,
    branch: 'feature',
    file: 'src/app.ts',
    side: 'working',
    startLine: 1,
    endLine: 1,
    resolved: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    comments: [
      {
        id: `${id}-1`,
        author: 'Fixture',
        body: 'needs a test',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

describe('CommentStore', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fixture.remove();
  });

  test('round-trips threads through the worktree’s store file', async () => {
    const store = new CommentStore();
    await store.load(fixture.feature);
    store.add(fixture.feature, thread('a'));
    await store.save(fixture.feature);

    expect(fs.existsSync(storePathFor(fixture.feature))).toBe(true);

    const reloaded = new CommentStore();
    await reloaded.load(fixture.feature);
    expect(reloaded.threads(fixture.feature).map((t) => t.id)).toEqual(['a']);
    expect(reloaded.find(fixture.feature, 'a')?.comments[0].body).toBe(
      'needs a test',
    );
  });

  test('keeps a comment written on a PR description', async () => {
    const store = new CommentStore();
    await store.load(fixture.feature);
    store.add(
      fixture.feature,
      thread('pr', { file: 'PR-142.md', side: 'pr', startLine: 3, endLine: 4 }),
    );
    await store.save(fixture.feature);

    const reloaded = new CommentStore();
    await reloaded.load(fixture.feature);
    const stored = reloaded.find(fixture.feature, 'pr');
    expect(stored?.side).toBe('pr');
    expect(stored?.file).toBe('PR-142.md');
  });

  test('removal is durable and leaves the other threads alone', async () => {
    const store = new CommentStore();
    await store.load(fixture.feature);
    store.add(fixture.feature, thread('a'));
    store.add(fixture.feature, thread('b', { file: 'tests/app.test.ts' }));
    store.remove(fixture.feature, 'a');
    await store.save(fixture.feature);

    const reloaded = new CommentStore();
    await reloaded.load(fixture.feature);
    expect(reloaded.threads(fixture.feature).map((t) => t.id)).toEqual(['b']);
  });

  test('archiving appends rather than replacing what is already archived', async () => {
    const store = new CommentStore();
    await store.archive(fixture.feature, [thread('a')], 'branch deleted');
    await store.archive(fixture.feature, [thread('b')], 'branch deleted');

    const archived = JSON.parse(
      fs.readFileSync(archivePathFor(fixture.feature), 'utf8'),
    ) as { threads: { id: string; archivedReason: string }[] };
    expect(archived.threads.map((t) => t.id)).toEqual(['a', 'b']);
    expect(archived.threads[0].archivedReason).toBe('branch deleted');
  });

  test('a worktree with no store file loads as empty', async () => {
    const store = new CommentStore();
    await store.load(fixture.review);
    expect(store.threads(fixture.review)).toEqual([]);
  });
});

describe('ViewedStore', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fixture.remove();
  });

  test('a file counts as viewed at the patch id it was marked at', async () => {
    const store = new ViewedStore();
    await store.load(fixture.feature);

    expect(store.status('feature', 'src/app.ts', 'patch-1', 'blob-1').viewed).toBe(
      false,
    );
    store.mark(fixture.feature, 'feature', 'src/app.ts', 'patch-1', 'blob-1');
    expect(store.status('feature', 'src/app.ts', 'patch-1', 'blob-1').viewed).toBe(
      true,
    );
  });

  test('an amended change clears the tick; a moved base only flags it', async () => {
    const store = new ViewedStore();
    await store.load(fixture.feature);
    store.mark(fixture.feature, 'feature', 'src/app.ts', 'patch-1', 'blob-1');

    // Restacked: same change, new ground under it.
    const restacked = store.status('feature', 'src/app.ts', 'patch-1', 'blob-2');
    expect(restacked).toEqual({ viewed: true, baseMoved: true });

    // Amended: a different change entirely.
    expect(
      store.status('feature', 'src/app.ts', 'patch-2', 'blob-1').viewed,
    ).toBe(false);
  });

  test('a blob abbreviated to a different length is the same base', async () => {
    const store = new ViewedStore();
    await store.load(fixture.feature);
    // Written by `git diff --numstat --patch`, read back from a plain diff.
    store.mark(fixture.feature, 'feature', 'src/app.ts', 'patch-1', 'f02540eb657');
    expect(store.status('feature', 'src/app.ts', 'patch-1', 'f02540eb65')).toEqual({
      viewed: true,
      baseMoved: false,
    });
    expect(store.status('feature', 'src/app.ts', 'patch-1', 'f02540eb6a')).toEqual({
      viewed: true,
      baseMoved: true,
    });
  });

  test('marks are scoped to the branch and survive a reload', async () => {
    const store = new ViewedStore();
    await store.load(fixture.feature);
    store.mark(fixture.feature, 'feature', 'src/app.ts', 'patch-1', undefined);
    await store.save(fixture.feature);

    const reloaded = new ViewedStore();
    await reloaded.load(fixture.feature);
    expect(
      reloaded.status('feature', 'src/app.ts', 'patch-1', undefined).viewed,
    ).toBe(true);
    expect(
      reloaded.status('other-branch', 'src/app.ts', 'patch-1', undefined).viewed,
    ).toBe(false);
  });

  test('unmarking a file clears it in every worktree that holds a mark', async () => {
    const store = new ViewedStore();
    await store.setWorktrees([fixture.feature, fixture.review]);
    store.mark(fixture.feature, 'feature', 'src/app.ts', 'patch-1', undefined);

    expect(store.unmark('feature', 'src/app.ts')).toEqual([fixture.feature]);
    expect(
      store.status('feature', 'src/app.ts', 'patch-1', undefined).viewed,
    ).toBe(false);
  });

  test('pruning forgets branches that no longer exist', async () => {
    const store = new ViewedStore();
    await store.load(fixture.feature);
    store.mark(fixture.feature, 'gone', 'src/app.ts', 'patch-1', undefined);

    expect(store.prune(new Set(['main']))).toEqual([fixture.feature]);
    expect(store.status('gone', 'src/app.ts', 'patch-1', undefined).viewed).toBe(
      false,
    );
  });
});
