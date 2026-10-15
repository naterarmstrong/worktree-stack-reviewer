import { describe, expect, test } from 'vitest';
import { Uri } from 'vscode';
import {
  buildPrBodyUri,
  conversationFrom,
  parsePrBodyUri,
  prBodyFileName,
  prBodySummary,
  prNumberFromFileName,
  renderPrDocument,
} from '../../src/prBody';

/** The trip VS Code puts a virtual document's URI through before returning it. */
const roundTrip = (uri: Uri): Uri => Uri.parse(Uri.parse(uri.toString()).toString());

const UPPERCASE_WORKTREE =
  '/workspaces/example-app/.claude/worktrees/bridge-cse_01MfmngbgvFw5ATvy47i9kob';

/** The shape our PR template produces, headings and Linear link included. */
const TEMPLATE_BODY = `## Project Management

*Linear Ticket*: https://linear.app/example/issue/ENG-3522/count-warm-up-misses

## Description

Requests that arrive while the cache is still warming are served straight from the origin, but
the router records every one of them as a cache miss.

- [ ] Include in changelog
`;

describe('pr body uris', () => {
  test('survives the round trip VS Code puts them through', () => {
    const uri = buildPrBodyUri(UPPERCASE_WORKTREE, 142, 'alex/eng-1234-index');

    expect(parsePrBodyUri(roundTrip(uri))).toEqual({
      worktreePath: UPPERCASE_WORKTREE,
      number: 142,
      branch: 'alex/eng-1234-index',
    });
  });

  test('names the tab after the PR and keeps the markdown extension', () => {
    expect(buildPrBodyUri('/wt', 142, 'feature').path).toBe('/PR-142.md');
  });

  test('distinguishes the same PR read from two worktrees', () => {
    const a = buildPrBodyUri('/worktrees/one', 142, 'feature');
    const b = buildPrBodyUri('/worktrees/two', 142, 'feature');

    expect(a.toString()).not.toBe(b.toString());
  });

  test('reads no branch from a uri built before comments could be written', () => {
    const legacy = Uri.from({
      scheme: 'wt-ext-pr',
      path: '/PR-142.md',
      query: 'wt=/worktrees/one&pr=142',
    });

    expect(parsePrBodyUri(legacy)?.branch).toBeUndefined();
  });

  test('reads nothing from a uri of another scheme carrying a worktree', () => {
    const gitUri = Uri.from({
      scheme: 'wt-ext-git',
      path: '/a.md',
      query: 'wt=/worktrees/one&ref=HEAD',
    });

    expect(parsePrBodyUri(gitUri)).toBeUndefined();
  });

  test('reads nothing from a uri naming no pull request', () => {
    const uri = Uri.from({ scheme: 'wt-ext-pr', path: '/PR-1.md', query: 'wt=/wt' });

    expect(parsePrBodyUri(uri)).toBeUndefined();
  });
});

describe('pr description file names', () => {
  test('round-trips the PR number a comment is stored against', () => {
    expect(prNumberFromFileName(prBodyFileName(142))).toBe(142);
  });

  test('reads no PR from a file in the worktree', () => {
    expect(prNumberFromFileName('src/PR-142.md.ts')).toBeUndefined();
    expect(prNumberFromFileName('docs/PR-142.md')).toBeUndefined();
  });
});

describe('pr body summaries', () => {
  test('reads the prose under the Description heading, not the first line', () => {
    expect(prBodySummary(TEMPLATE_BODY)).toBe(
      'Requests that arrive while the cache is still warming are served straight from the origin, ' +
        'but the router records every…',
    );
  });

  test('joins a hard-wrapped paragraph rather than stopping at the wrap', () => {
    const body = '## Description\n\nCarries a set of boards\nthey created for triage.\n';

    expect(prBodySummary(body)).toBe('Carries a set of boards they created for triage.');
  });

  test('stops at the next bullet, which is a separate point', () => {
    const body = '## Description\n\n- Adds an index.\n- Drops the retry loop.\n';

    expect(prBodySummary(body)).toBe('Adds an index.');
  });

  test('falls back to the first prose line when there is no such section', () => {
    expect(prBodySummary('## Summary\n\nRenames the sync job.\n')).toBe(
      'Renames the sync job.',
    );
  });

  test('shows the text of inline markup rather than its markers', () => {
    const body = '## Description\n\n**Fixes** the [flaky test](https://x/y) in `sync`.\n';

    expect(prBodySummary(body)).toBe('Fixes the flaky test in sync.');
  });

  test('skips comments the template leaves in the body', () => {
    const body = '## Description\n\n<!-- what changed -->\nDrops the retry loop.\n';

    expect(prBodySummary(body)).toBe('Drops the retry loop.');
  });

  test('reads a bullet as its text, without the marker', () => {
    expect(prBodySummary('## Description\n\n- Adds an index.\n')).toBe('Adds an index.');
  });

  test('falls back to a heading when the body is nothing but structure', () => {
    expect(prBodySummary('## Project Management\n\n---\n')).toBe('Project Management');
  });

  test('has nothing to say about an empty body', () => {
    expect(prBodySummary('   \n')).toBe('');
  });

  test('cuts a long opening line short', () => {
    const summary = prBodySummary(`## Description\n\n${'word '.repeat(60)}\n`);

    expect(summary.length).toBe(120);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('pr conversation', () => {
  const view = {
    comments: [
      {
        author: { login: 'codecov' },
        body: '## Codecov Report\r\n\n```md\n# not a heading\n```',
        createdAt: '2026-10-14T19:11:10Z',
        url: 'https://github.com/o/r/pull/1#issuecomment-2',
      },
      {
        author: { login: 'alice' },
        body: 'First!',
        createdAt: '2026-10-14T18:54:35Z',
        url: 'https://github.com/o/r/pull/1#issuecomment-1',
      },
    ],
    reviews: [
      { author: { login: 'bob' }, body: 'Looks good', state: 'APPROVED', submittedAt: '2026-10-14T20:00:00Z' },
      { author: { login: 'carol' }, body: '', state: 'APPROVED', submittedAt: '2026-10-14T21:00:00Z' },
    ],
  };

  test('orders comments and review summaries by when they were posted', () => {
    expect(conversationFrom(view).map((e) => e.author)).toEqual(['alice', 'codecov', 'bob']);
  });

  test('leaves a review with nothing said out', () => {
    expect(conversationFrom(view).some((e) => e.author === 'carol')).toBe(false);
  });

  test('renders the conversation after the description, which stays line for line', () => {
    const body = 'Line one\nLine two\n';
    const doc = renderPrDocument(body, conversationFrom(view));

    expect(doc.split('\n').slice(0, 2)).toEqual(['Line one', 'Line two']);
    expect(doc).toContain('## Comments (3)');
    expect(doc).toContain('### @alice commented · 2026-10-14 18:54 UTC');
    expect(doc).toContain('### @bob approved · 2026-10-14 20:00 UTC');
    expect(doc).toContain('[View on GitHub](https://github.com/o/r/pull/1#issuecomment-1)');
  });

  test("demotes a comment's headings below its own, but not inside code", () => {
    const doc = renderPrDocument('', conversationFrom(view));

    expect(doc).toContain('\n##### Codecov Report\n');
    expect(doc).toContain('\n# not a heading\n');
    expect(doc).not.toContain('\r');
  });

  test('a PR with no conversation reads as its description alone', () => {
    expect(renderPrDocument('Just the body\n', [])).toBe('Just the body\n');
  });
});
