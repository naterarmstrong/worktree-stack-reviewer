import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { WorktreeNameStore, namesPathFor } from '../../src/worktreeNames';
import { type Fixture, makeFixture } from '../fixtures/repo';

describe('WorktreeNameStore', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fixture.remove();
  });

  test('round-trips a name through the repository’s store file', async () => {
    const store = new WorktreeNameStore();
    await store.setRoot(fixture.repo);
    await store.setName(fixture.feature, 'auth-refactor');

    expect(fs.existsSync(namesPathFor(fixture.repo))).toBe(true);

    const reloaded = new WorktreeNameStore();
    await reloaded.setRoot(fixture.repo);
    expect(reloaded.nameFor(fixture.feature)).toBe('auth-refactor');
  });

  test('names two worktrees on one stack separately', async () => {
    const store = new WorktreeNameStore();
    await store.setRoot(fixture.repo);
    await store.setName(fixture.feature, 'upper');
    await store.setName(fixture.review, 'lower');

    expect(store.nameFor(fixture.feature)).toBe('upper');
    expect(store.nameFor(fixture.review)).toBe('lower');
  });

  test('an unnamed worktree has no name', () => {
    expect(new WorktreeNameStore().nameFor(fixture.feature)).toBeUndefined();
  });

  test('an empty name removes the record', async () => {
    const store = new WorktreeNameStore();
    await store.setRoot(fixture.repo);
    await store.setName(fixture.feature, 'auth');
    await store.setName(fixture.feature, '');

    const reloaded = new WorktreeNameStore();
    await reloaded.setRoot(fixture.repo);
    expect(reloaded.nameFor(fixture.feature)).toBeUndefined();
  });

  test('drops names for worktrees that are gone', async () => {
    const store = new WorktreeNameStore();
    await store.setRoot(fixture.repo);
    await store.setName(fixture.feature, 'auth');
    await store.setName(fixture.review, 'scratch-pad');

    await store.prune([fixture.repo, fixture.feature]);

    const reloaded = new WorktreeNameStore();
    await reloaded.setRoot(fixture.repo);
    expect(reloaded.nameFor(fixture.feature)).toBe('auth');
    expect(reloaded.nameFor(fixture.review)).toBeUndefined();
  });

  test('a name saved in another window survives a prune here', async () => {
    const removed = path.join(fixture.root, 'removed');
    const first = new WorktreeNameStore();
    const second = new WorktreeNameStore();
    await first.setRoot(fixture.repo);
    await second.setRoot(fixture.repo);
    // Something for the prune to actually drop, so it reaches its save.
    await first.setName(removed, 'gone');

    await second.setName(fixture.review, 'scratch-pad');
    // `first` has not seen that save, and pruning writes its whole map back.
    await first.prune([fixture.repo, fixture.feature, fixture.review]);

    const reloaded = new WorktreeNameStore();
    await reloaded.setRoot(fixture.repo);
    expect(reloaded.nameFor(fixture.review)).toBe('scratch-pad');
    expect(reloaded.nameFor(removed)).toBeUndefined();
  });

  test('a name saved in another window is not clobbered by this one', async () => {
    const first = new WorktreeNameStore();
    const second = new WorktreeNameStore();
    await first.setRoot(fixture.repo);
    await second.setRoot(fixture.repo);

    await first.setName(fixture.feature, 'auth');
    // `second` loaded before that save and knows nothing about it.
    await second.setName(fixture.review, 'scratch-pad');

    const reloaded = new WorktreeNameStore();
    await reloaded.setRoot(fixture.repo);
    expect(reloaded.nameFor(fixture.feature)).toBe('auth');
    expect(reloaded.nameFor(fixture.review)).toBe('scratch-pad');
  });

  test('a corrupt file is moved aside rather than read', async () => {
    const target = namesPathFor(fixture.repo);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{not json', 'utf8');

    const store = new WorktreeNameStore();
    await store.setRoot(fixture.repo);

    expect(store.nameFor(fixture.feature)).toBeUndefined();
    expect(fs.existsSync(`${target}.corrupt`)).toBe(true);
  });
});
