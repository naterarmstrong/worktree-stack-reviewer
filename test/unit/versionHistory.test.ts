import { describe, expect, test } from 'vitest';
import { type BranchVersion, versionForComment } from '../../src/versionHistory';

/**
 * A branch amended twice, as the listing arrives: newest first, each version
 * dated when its patch first appeared. `p2` has been restacked, so it holds a
 * second sha — the one it currently shows.
 */
const VERSIONS: BranchVersion[] = [
  {
    version: 3,
    sha: 'ccccccccccccccccccccccccccccccccccccccc3',
    date: '2026-09-02T14:00:00-07:00',
    action: 'amend',
    subject: 'third',
    shas: ['ccccccccccccccccccccccccccccccccccccccc3'],
    pushed: false,
    current: true,
  },
  {
    version: 2,
    sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2',
    date: '2026-09-02T12:00:00-07:00',
    action: 'amend',
    subject: 'second',
    shas: ['2222222222222222222222222222222222222222', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2'],
    pushed: true,
    current: false,
  },
  {
    version: 1,
    sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
    date: '2026-09-02T10:00:00-07:00',
    action: 'create',
    subject: 'first',
    shas: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1'],
    pushed: false,
    current: false,
  },
];

/** Written at a moment when p2 was the tip, in the other direction from UTC. */
const WHILE_P2 = '2026-09-02T20:30:00.000Z';

describe('versionForComment', () => {
  test('names the version holding the sha the comment recorded', () => {
    expect(
      versionForComment({ sha: 'cccccccccccc', createdAt: WHILE_P2 }, VERSIONS),
    ).toBe(3);
  });

  test('matches a sha the version held before a restack, not only its latest', () => {
    expect(
      versionForComment({ sha: '222222222222', createdAt: WHILE_P2 }, VERSIONS),
    ).toBe(2);
  });

  test('dates a comment with no sha back to the patch that was then the tip', () => {
    expect(versionForComment({ createdAt: WHILE_P2 }, VERSIONS)).toBe(2);
  });

  test('dates a comment back when its sha names no version the listing still holds', () => {
    expect(
      versionForComment({ sha: 'deadbeefdead', createdAt: WHILE_P2 }, VERSIONS),
    ).toBe(2);
  });

  test('counts a comment older than every patch towards the oldest', () => {
    expect(
      versionForComment({ createdAt: '2020-01-01T00:00:00.000Z' }, VERSIONS),
    ).toBe(1);
  });

  test('attributes nothing when the branch has no versions', () => {
    expect(versionForComment({ createdAt: WHILE_P2 }, [])).toBeUndefined();
  });

  test('attributes nothing when the comment carries no readable date', () => {
    expect(versionForComment({ createdAt: 'whenever' }, VERSIONS)).toBeUndefined();
  });
});
