import * as cp from 'node:child_process';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { listChangedFiles, revParse, showFileAtRef } from '../../src/git';
import { HiddenChangeStore, parseHiddenChangeEntry, viewRefFor } from '../../src/hiddenChanges';
import { type Fixture, git, makeFixture, write } from '../fixtures/repo';

describe('parseHiddenChangeEntry', () => {
  test('takes a commit and defaults to adding it', () => {
    expect(parseHiddenChangeEntry({ kind: 'hiddenChange', commit: 'abc' })).toEqual({
      kind: 'hiddenChange',
      commit: 'abc',
      branch: undefined,
      action: 'add',
    });
  });

  test('leaves out what is not a hidden change', () => {
    expect(parseHiddenChangeEntry({ kind: 'explainer', commit: 'abc' })).toBeUndefined();
    expect(parseHiddenChangeEntry({ kind: 'hiddenChange' })).toBeUndefined();
    expect(parseHiddenChangeEntry({ kind: 'hiddenChange', commit: 'a', action: 'x' })).toBeUndefined();
  });
});

test('view refs of a branch and a branch beneath it cannot collide', () => {
  expect(viewRefFor('a/b')).toBe('refs/wt-review/view/a%2Fb');
  expect(viewRefFor('a')).toBe('refs/wt-review/view/a');
});

describe('hidden changes against a real repository', () => {
  let fixture: Fixture;
  let store: HiddenChangeStore;
  let mergeBase: string;

  const lines = (from: string, to: string) => ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']
    .map((l) => (l === from ? to : l))
    .join('\n');

  /** A commit holding one edit to shared.txt, on `onto` and off every branch. */
  const hiddenCommit = (from: string, to: string, onto = mergeBase): string => {
    const run = (args: string[], input?: string): string =>
      cp
        .execFileSync('git', args, {
          cwd: fixture.feature,
          encoding: 'utf8',
          input,
          env: { ...process.env, GIT_INDEX_FILE: path.join(fixture.root, 'tmp-index') },
        })
        .trim();
    run(['read-tree', onto]);
    const blob = run(['hash-object', '-w', '--stdin'], lines(from, to));
    run(['update-index', '--add', '--cacheinfo', `100644,${blob},shared.txt`]);
    return run(['commit-tree', run(['write-tree']), '-p', onto, '-m', `hide ${from}`]);
  };

  const changed = async (left: string): Promise<string[]> =>
    (await listChangedFiles(fixture.feature, left, false, true)).map((f) => f.path);

  const add = (commit: string) =>
    store.apply(fixture.feature, { kind: 'hiddenChange', commit, action: 'add' });

  beforeEach(async () => {
    fixture = makeFixture();
    write(fixture.repo, 'shared.txt', lines('', ''));
    git(fixture.repo, ['add', '.']);
    git(fixture.repo, ['commit', '-q', '-m', 'shared']);
    git(fixture.feature, ['rebase', '-q', 'main']);
    mergeBase = await revParse(fixture.feature, 'main');
    // The rename on line one is what gets hidden; line eight is the real change.
    write(fixture.feature, 'shared.txt', lines('one', 'ONE').replace('eight', 'EIGHT'));
    git(fixture.feature, ['commit', '-q', '-am', 'rename and a real change']);
    store = new HiddenChangeStore(fixture.repo);
  });

  afterEach(() => {
    store.dispose();
    fixture.remove();
  });

  test('a branch with nothing hidden keeps the plain merge base', async () => {
    expect(await store.viewFor(fixture.feature, 'feature', mergeBase)).toBeUndefined();
  });

  test('the left side takes on the commit, leaving only the rest of the change', async () => {
    expect(await add(hiddenCommit('one', 'ONE'))).toBeUndefined();
    const view = await store.viewFor(fixture.feature, 'feature', mergeBase);
    expect(view?.applied).toBe(1);
    const left = await showFileAtRef(fixture.feature, view!.ref, 'shared.txt');
    expect(left.split('\n')[0]).toBe('ONE');
    expect(left).toContain('eight');
    const row = (await listChangedFiles(fixture.feature, view!.ref, false, true)).find(
      (f) => f.path === 'shared.txt',
    );
    expect([row?.added, row?.removed]).toEqual([1, 1]);
  });

  test('a file whose whole change is hidden drops out of the list', async () => {
    await add(hiddenCommit('one', 'ONE'));
    write(fixture.feature, 'shared.txt', lines('one', 'ONE'));
    git(fixture.feature, ['commit', '-q', '-am', 'drop the real change']);
    const view = await store.viewFor(fixture.feature, 'feature', mergeBase);
    expect(await changed(view!.ref)).not.toContain('shared.txt');
  });

  test('toggling off puts the change back and moves the ref in place', async () => {
    const commit = hiddenCommit('one', 'ONE');
    await add(commit);
    const on = await store.viewFor(fixture.feature, 'feature', mergeBase);
    let moved = 0;
    store.onDidMoveView(() => (moved += 1));
    await store.setEnabled('feature', new Map([[commit, false]]));
    const off = await store.viewFor(fixture.feature, 'feature', mergeBase);
    expect(off?.applied).toBe(0);
    expect(off?.ref).toBe(on?.ref);
    expect(off?.left).toBe(mergeBase);
    expect(moved).toBe(1);
    expect(await store.viewFor(fixture.feature, 'feature', mergeBase)).toEqual(off);
    expect(moved).toBe(1);
  });

  test('two commits apply together, and either can be turned off alone', async () => {
    const first = hiddenCommit('one', 'ONE');
    const second = hiddenCommit('eight', 'EIGHT', first);
    await add(first);
    await add(second);
    const both = await store.viewFor(fixture.feature, 'feature', mergeBase);
    expect(both?.applied).toBe(2);
    await store.setEnabled('feature', new Map([[first, false]]));
    const onlySecond = await store.viewFor(fixture.feature, 'feature', mergeBase);
    expect(onlySecond?.applied).toBe(1);
    const left = await showFileAtRef(fixture.feature, onlySecond!.ref, 'shared.txt');
    expect(left.split('\n')[0]).toBe('one');
    expect(left).toContain('EIGHT');
  });

  test('a commit that conflicts is reported and hides nothing', async () => {
    const first = hiddenCommit('one', 'ONE');
    const clash = hiddenCommit('one', 'uno');
    await add(first);
    await add(clash);
    const view = await store.viewFor(fixture.feature, 'feature', mergeBase);
    expect(view?.applied).toBe(1);
    expect(view?.failed.get(clash)).toContain('conflicts');
  });

  test('a commit follows the branch onto a moved base', async () => {
    await add(hiddenCommit('one', 'ONE'));
    write(fixture.repo, 'src/upstream.ts', 'export const upstream = 1;\n');
    git(fixture.repo, ['add', '.']);
    git(fixture.repo, ['commit', '-q', '-m', 'upstream']);
    git(fixture.feature, ['rebase', '-q', 'main']);
    const moved = await revParse(fixture.feature, 'main');
    const view = await store.viewFor(fixture.feature, 'feature', moved);
    expect(view?.applied).toBe(1);
    expect(await changed(view!.ref)).not.toContain('src/upstream.ts');
  });

  test('a removed commit leaves the view ref standing at the merge base', async () => {
    const commit = hiddenCommit('one', 'ONE');
    await add(commit);
    const { ref } = (await store.viewFor(fixture.feature, 'feature', mergeBase))!;
    expect(await store.apply(fixture.feature, { kind: 'hiddenChange', commit, action: 'remove' }))
      .toBeUndefined();
    expect(await store.viewFor(fixture.feature, 'feature', mergeBase)).toBeUndefined();
    expect(await revParse(fixture.feature, ref)).toBe(mergeBase);
  });

  test('a commit survives gc, and the list survives a reload', async () => {
    const commit = hiddenCommit('one', 'ONE');
    await add(commit);
    await store.viewFor(fixture.feature, 'feature', mergeBase);
    git(fixture.repo, ['gc', '-q', '--prune=now']);
    const reloaded = new HiddenChangeStore(fixture.repo);
    await reloaded.load();
    expect(reloaded.list('feature').map((c) => c.commit)).toEqual([commit]);
    expect(reloaded.list('feature')[0].subject).toBe('hide one');
    expect((await reloaded.viewFor(fixture.feature, 'feature', mergeBase))?.applied).toBe(1);
    reloaded.dispose();
  });

  test('refuses what it cannot register', async () => {
    expect(await add('0000000')).toContain('no commit');
    const root = git(fixture.repo, ['rev-list', '--max-parents=0', 'HEAD']).trim();
    expect(await add(root)).toContain('no parent');
    expect(
      await store.apply(fixture.feature, {
        kind: 'hiddenChange',
        commit: mergeBase,
        branch: 'gone',
        action: 'add',
      }),
    ).toContain('no branch');
    expect(store.list('feature')).toEqual([]);
  });
});
