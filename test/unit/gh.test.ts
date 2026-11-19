import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { listOpenPrsForBranches, prBaseCommits, submitPrReview } from '../../src/gh';

describe('submitPrReview', () => {
  let dir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    // A stand-in `gh` that records each call's arguments, one per line with a
    // blank line after each call, answers the pending-review lookup with the
    // `pending` file, and fails the way gh does when told to.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
    fs.writeFileSync(
      path.join(dir, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$@" '' >> "${dir}/calls"\n` +
        `case "$*" in *"states: PENDING"*) cat "${dir}/pending" 2>/dev/null; exit 0;; esac\n` +
        `if [ -n "$FAKE_GH_FAIL" ]; then echo "$FAKE_GH_FAIL" >&2; exit 1; fi\n`,
      { mode: 0o755 },
    );
    originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_GH_FAIL;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Each call's arguments, in order. */
  const calls = () =>
    fs
      .readFileSync(path.join(dir, 'calls'), 'utf8')
      .split('\n\n')
      .filter((c) => c.trim() !== '')
      .map((c) => c.replace(/^\n/, '').split('\n'));
  /** The call that posted the review, after the lookup. */
  const posted = () => calls().at(-1);

  const pendingReviews = (nodes: unknown[]) =>
    fs.writeFileSync(
      path.join(dir, 'pending'),
      JSON.stringify({ data: { repository: { pullRequest: { reviews: { nodes } } } } }),
    );

  test('sends the verdict and the comment as they were typed', async () => {
    pendingReviews([]);
    const result = await submitPrReview(
      dir,
      142,
      'request-changes',
      'Please split `foo`; $(rm -rf /) stays text',
    );
    expect(result).toEqual({ pendingComments: 0 });
    expect(posted()).toEqual([
      'pr',
      'review',
      '142',
      '--request-changes',
      '--body',
      'Please split `foo`; $(rm -rf /) stays text',
    ]);
  });

  test('approves without a body when none was given', async () => {
    pendingReviews([]);
    await submitPrReview(dir, 7, 'approve', '');
    expect(posted()).toEqual(['pr', 'review', '7', '--approve']);
  });

  test("rejects with gh's own message", async () => {
    pendingReviews([]);
    process.env.FAKE_GH_FAIL = 'failed to create review: Can not approve your own pull request';
    await expect(submitPrReview(dir, 7, 'approve', '')).rejects.toThrow(
      'Can not approve your own pull request',
    );
  });

  test('submits the pending review started on GitHub, with its comments', async () => {
    pendingReviews([{ id: 'PRR_kwDOabc', viewerDidAuthor: true, comments: { totalCount: 3 } }]);
    const result = await submitPrReview(dir, 142, 'request-changes', 'See inline; $(x) stays text');

    expect(result).toEqual({ pendingComments: 3 });
    const lookup = calls()[0];
    expect(lookup).toContain('n=142');
    const submit = posted() ?? [];
    expect(submit.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(submit.join('\n')).toContain('submitPullRequestReview');
    expect(submit).toContain('id=PRR_kwDOabc');
    expect(submit).toContain('event=REQUEST_CHANGES');
    expect(submit).toContain('body=See inline; $(x) stays text');
    expect(calls().some((c) => c[0] === 'pr')).toBe(false);
  });

  test("leaves the pending review's own summary alone when no body is given", async () => {
    pendingReviews([{ id: 'PRR_1', viewerDidAuthor: true, comments: { totalCount: 1 } }]);
    await submitPrReview(dir, 142, 'approve', '');

    const submit = posted() ?? [];
    expect(submit).toContain('event=APPROVE');
    expect(submit.some((a) => a.startsWith('body='))).toBe(false);
    expect(submit.join('\n')).not.toContain('$body');
  });

  test("ignores a pending review that is not the gh user's", async () => {
    pendingReviews([{ id: 'PRR_other', viewerDidAuthor: false, comments: { totalCount: 2 } }]);
    await submitPrReview(dir, 7, 'comment', 'LGTM');
    expect(posted()).toEqual(['pr', 'review', '7', '--comment', '--body', 'LGTM']);
  });

  test('posts a new review when the lookup cannot be read', async () => {
    fs.writeFileSync(path.join(dir, 'pending'), 'not json');
    await submitPrReview(dir, 7, 'approve', '');
    expect(posted()).toEqual(['pr', 'review', '7', '--approve']);
  });
});

describe('listOpenPrsForBranches', () => {
  let dir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    // A stand-in `gh` that records its arguments and prints a canned response.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
    fs.writeFileSync(
      path.join(dir, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat "${dir}/response"\n`,
      { mode: 0o755 },
    );
    originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const node = (number: number, head: string, owner: string) => ({
    number,
    title: `PR ${number}`,
    isDraft: true,
    url: `https://github.com/acme/widgets/pull/${number}`,
    headRefName: head,
    baseRefName: 'main',
    body: 'body',
    author: { login: 'someone' },
    headRepositoryOwner: { login: owner },
  });

  test("passes branch names as variables and prefers the repository's own head", async () => {
    fs.writeFileSync(
      path.join(dir, 'response'),
      JSON.stringify({
        data: {
          repository: {
            owner: { login: 'acme' },
            b0: { nodes: [node(9, 'feature/a', 'a-fork'), node(4, 'feature/a', 'acme')] },
            b1: { nodes: [] },
          },
        },
      }),
    );
    const prs = await listOpenPrsForBranches(dir, ['feature/a', '123']);
    expect(prs.map((p) => p.number)).toEqual([4]);
    const args = fs.readFileSync(path.join(dir, 'args'), 'utf8');
    expect(args).toContain('h0=feature/a\n');
    expect(args).toContain('-f\nh1=123\n');
    expect(args).not.toContain('"feature/a"');
  });

  test('asks nothing for no branches', async () => {
    expect(await listOpenPrsForBranches(dir, [])).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'args'))).toBe(false);
  });
});

describe('prBaseCommits', () => {
  let dir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
    fs.writeFileSync(
      path.join(dir, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\ncat "${dir}/response"\n`,
      { mode: 0o755 },
    );
    originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reads the parent of each PR’s oldest commit, skipping PRs without one', async () => {
    const sits = (oid: string) => ({
      commits: { nodes: [{ commit: { parents: { nodes: [{ oid }] } } }] },
    });
    fs.writeFileSync(
      path.join(dir, 'response'),
      JSON.stringify({
        data: { repository: { p0: sits('abc123'), p1: { commits: { nodes: [] } }, p2: null } },
      }),
    );
    const bases = await prBaseCommits(dir, [12, 34, 56]);
    expect([...bases]).toEqual([[12, 'abc123']]);
    const args = fs.readFileSync(path.join(dir, 'args'), 'utf8');
    expect(args).toContain('-F\nn0=12\n');
    expect(args).toContain('-F\nn2=56\n');
  });

  test('asks nothing for no PRs', async () => {
    expect((await prBaseCommits(dir, [])).size).toBe(0);
    expect(fs.existsSync(path.join(dir, 'args'))).toBe(false);
  });
});
