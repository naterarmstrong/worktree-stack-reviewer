import { describe, expect, test } from 'vitest';
import {
  type BranchVersion,
  fromGt,
  lastTouchedVersions,
  versionForComment,
} from '../../src/versionHistory';

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

  test('never dates a comment back to a commit the branch only passed through', () => {
    // p2 arrived under p3 in one fetch, so both carry the fetch's date.
    const fetched = VERSIONS.map((v) =>
      v.version === 2 ? { ...v, tip: false, date: VERSIONS[0].date } : v,
    );
    const reordered = [fetched[1], fetched[0], fetched[2]];
    expect(versionForComment({ createdAt: '2026-09-02T15:00:00-07:00' }, reordered)).toBe(3);
    // A comment naming its sha still lands on it.
    expect(versionForComment({ sha: 'bbbbbbbbbbbb', createdAt: WHILE_P2 }, fetched)).toBe(2);
  });
});

const lines = (add: number, del: number) => ({ add, del });
const split = (src = lines(0, 0), test = lines(0, 0), gen = lines(0, 0)) => ({
  src,
  test,
  doc: lines(0, 0),
  gen,
});

/** `gt history --json` for a branch amended once after a restack, newest first. */
const GT_LISTING = {
  branch: 'feat',
  parent: 'main',
  tip: 'c2',
  versions: [
    {
      version: 2,
      sha: 'c2',
      subject: 'Add feature',
      time: 1,
      date: '2026-10-16T13:00:00-07:00',
      action: 'amend',
      current: true,
      remote: { pushed: false, fetched: false, tip: false },
      moves: [{ sha: 'b2' }, { sha: 'c2' }],
      delta: {
        vs: 1,
        conflict: false,
        total: split(),
        files: [
          { path: 'uv.lock', kind: 'gen', lines: split(undefined, undefined, lines(40, 2)) },
          { path: 'src/a.py', kind: 'src', lines: split(lines(3, 1)) },
          { path: 'tests/test_a.py', kind: 'test', lines: split(undefined, lines(10, 0)) },
        ],
      },
    },
    {
      version: 1,
      sha: 'a1',
      subject: 'Add feature',
      time: 0,
      date: '2026-10-16T12:00:00-07:00',
      action: 'commit',
      current: false,
      remote: { pushed: false, fetched: true, tip: true },
      moves: [{ sha: 'a1' }],
      delta: { vs: null, conflict: true, total: split(), files: [] },
    },
  ],
};

describe('fromGt', () => {
  const listing = fromGt(GT_LISTING);
  const [p2, p1] = listing.versions;

  test('keeps every sha a version held, oldest first', () => {
    expect(p2.shas).toEqual(['b2', 'c2']);
    expect(p2.current).toBe(true);
  });

  test('treats a listing from a gt without tip flags as all tips', () => {
    expect(p2.tip).toBe(true);
    expect(p1.tip).toBe(true);
  });

  test('marks a commit the branch only passed through', () => {
    const passed = fromGt({
      ...GT_LISTING,
      versions: GT_LISTING.versions.map((v) => (v.version === 1 ? { ...v, tip: false } : v)),
    });
    expect(passed.versions.map((v) => v.tip)).toEqual([true, false]);
  });

  test('counts a version seen on the remote by a fetch as pushed', () => {
    expect(p1.pushed).toBe(true);
    expect(p2.pushed).toBe(false);
  });

  test('leaves generated files out of the totals and file list, biggest first', () => {
    expect(p2.delta).toMatchObject({ added: 13, removed: 1, generated_hidden: 1 });
    expect(p2.delta?.files?.map((f) => f.path)).toEqual(['tests/test_a.py', 'src/a.py']);
  });

  test('reports a conflicting interdiff without files', () => {
    expect(p1.delta).toEqual({ conflict: true });
  });

  test('still attributes generated files to the version that changed them', () => {
    expect(lastTouchedVersions(listing).get('uv.lock')).toBe(2);
  });
});
