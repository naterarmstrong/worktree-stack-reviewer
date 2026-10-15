import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  StackNameStore,
  findStackIndex,
  reconcileMembers,
  stackPosition,
  stacksPathFor,
} from '../../src/stackNames';
import { type Fixture, makeFixture } from '../fixtures/repo';

describe('findStackIndex', () => {
  const stacks = [
    { name: 'auth', members: ['nate/a', 'nate/b'] },
    { name: 'sync', members: ['nate/g'] },
  ];

  test('matches on any shared branch', () => {
    expect(findStackIndex(stacks, ['nate/b', 'nate/c'])).toBe(0);
    expect(findStackIndex(stacks, ['nate/g'])).toBe(1);
  });

  test('reports no match when nothing is shared', () => {
    expect(findStackIndex(stacks, ['nate/z'])).toBe(-1);
    expect(findStackIndex(stacks, [])).toBe(-1);
  });
});

describe('reconcileMembers', () => {
  test('keeps a branch that has left the live chain', () => {
    expect(reconcileMembers(['a', 'b', 'c'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  test('inserts a new branch after the one it sits on', () => {
    expect(reconcileMembers(['a', 'c'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  test('appends branches stacked on top', () => {
    expect(reconcileMembers(['a', 'b'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  test('leaves its arguments alone', () => {
    const stored = ['a'];
    reconcileMembers(stored, ['a', 'b']);
    expect(stored).toEqual(['a']);
  });
});

describe('StackNameStore', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = makeFixture();
  });

  afterEach(() => {
    fixture.remove();
  });

  test('round-trips a name through the repository’s store file', async () => {
    const store = new StackNameStore();
    await store.setRoot(fixture.repo);
    await store.setName(['feature', 'scratch'], 'auth-refactor');

    expect(fs.existsSync(stacksPathFor(fixture.repo))).toBe(true);

    const reloaded = new StackNameStore();
    await reloaded.setRoot(fixture.repo);
    const resolved = reloaded.resolve(['feature', 'scratch']);
    expect(resolved.name).toBe('auth-refactor');
    expect(stackPosition(resolved, 'scratch')).toBe(2);
  });

  test('an unnamed stack resolves to the live chain', () => {
    const store = new StackNameStore();
    const resolved = store.resolve(['feature', 'scratch']);
    expect(resolved.name).toBeUndefined();
    expect(resolved.members).toEqual(['feature', 'scratch']);
  });

  test('holds the height when a branch merges out of the stack', async () => {
    const store = new StackNameStore();
    await store.setRoot(fixture.repo);
    await store.setName(['a', 'b', 'c'], 'auth');

    const resolved = store.resolve(['b', 'c']);
    expect(resolved.members).toEqual(['a', 'b', 'c']);
    expect(stackPosition(resolved, 'c')).toBe(3);
  });

  test('records a branch stacked on top', async () => {
    const store = new StackNameStore();
    await store.setRoot(fixture.repo);
    await store.setName(['a', 'b'], 'auth');
    await store.syncMembers(['a', 'b', 'c']);

    const reloaded = new StackNameStore();
    await reloaded.setRoot(fixture.repo);
    expect(reloaded.resolve(['a']).members).toEqual(['a', 'b', 'c']);
  });

  test('an empty name removes the record', async () => {
    const store = new StackNameStore();
    await store.setRoot(fixture.repo);
    await store.setName(['a', 'b'], 'auth');
    await store.setName(['a', 'b'], '');

    const reloaded = new StackNameStore();
    await reloaded.setRoot(fixture.repo);
    expect(reloaded.resolve(['a', 'b']).name).toBeUndefined();
  });

  test('a name saved in another window is not clobbered by this one', async () => {
    const first = new StackNameStore();
    const second = new StackNameStore();
    await first.setRoot(fixture.repo);
    await second.setRoot(fixture.repo);

    await first.setName(['a', 'b'], 'auth');
    // `second` loaded before that save and knows nothing about it.
    await second.setName(['x', 'y'], 'sync');

    const reloaded = new StackNameStore();
    await reloaded.setRoot(fixture.repo);
    expect(reloaded.resolve(['a']).name).toBe('auth');
    expect(reloaded.resolve(['x']).name).toBe('sync');
  });

  test('a corrupt file is moved aside rather than read', async () => {
    const target = stacksPathFor(fixture.repo);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{not json', 'utf8');

    const store = new StackNameStore();
    await store.setRoot(fixture.repo);
    expect(store.resolve(['a']).name).toBeUndefined();
    expect(fs.existsSync(`${target}.corrupt`)).toBe(true);
  });
});
