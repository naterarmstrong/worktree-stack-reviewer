import { describe, expect, test } from 'vitest';
import { isExplainerEntry, isNoteEntry } from '../../src/commentStore';
import {
  type ExplainerEntry,
  explainerEntryProblem,
  nextExplainerState,
} from '../../src/explainers';
import { parseEntries } from '../../src/resolutionInbox';

const PAGE = '/private/tmp/x/scratchpad/wt-review/pr-46584.local.html';
const NOW = new Date('2026-10-16T21:00:00Z');
const entry = (e: Partial<ExplainerEntry>): ExplainerEntry => ({
  kind: 'explainer',
  pr: 46584,
  status: 'started',
  ...e,
});

describe('explainer inbox entries', () => {
  test('parse beside notes and resolutions, and are neither', () => {
    const entries = parseEntries(
      JSON.stringify([
        { kind: 'explainer', pr: 46584, status: 'started' },
        { kind: 'explainer', pr: '#46584', status: 'done', path: PAGE, title: ' Stream loop ' },
        { file: 'a.ts', body: 'note' },
        { id: 'abc', resolved: true },
      ]),
    );
    expect(entries).toHaveLength(4);
    expect(entries[1]).toEqual(entry({ status: 'done', path: PAGE, title: 'Stream loop' }));
    expect(entries.map((e) => [isExplainerEntry(e), isNoteEntry(e)])).toEqual([
      [true, false],
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  test('skip a bad PR number or status', () => {
    const entries = parseEntries(
      JSON.stringify([
        { kind: 'explainer', pr: 0, status: 'started' },
        { kind: 'explainer', pr: 12, status: 'finished' },
      ]),
    );
    expect(entries).toEqual([]);
  });

  test('a done entry needs a page the preview may open', () => {
    expect(explainerEntryProblem(entry({ status: 'done' }))).toMatch(/needs the path/);
    expect(explainerEntryProblem(entry({ status: 'done', path: '/etc/passwd' }))).toBeDefined();
    expect(explainerEntryProblem(entry({ status: 'done', path: PAGE }))).toBeUndefined();
    expect(explainerEntryProblem(entry({ status: 'started' }))).toBeUndefined();
  });
});

describe('explainer state', () => {
  test('started, then done, keeps when it started', () => {
    const started = nextExplainerState(undefined, entry({}), NOW);
    expect(started).toMatchObject({ status: 'started', startedAt: NOW.toISOString() });
    const later = new Date(NOW.getTime() + 60_000);
    const done = nextExplainerState(started, entry({ status: 'done', path: PAGE }), later);
    expect(done).toMatchObject({ status: 'done', path: PAGE, startedAt: NOW.toISOString() });
  });

  test('a restart or a failure keeps the last page to fall back on', () => {
    const done = nextExplainerState(undefined, entry({ status: 'done', path: PAGE, title: 'T' }), NOW);
    expect(nextExplainerState(done, entry({}), NOW)).toMatchObject({ status: 'started', path: PAGE, title: 'T' });
    const failed = nextExplainerState(done, entry({ status: 'failed', error: 'gh down' }), NOW);
    expect(failed).toMatchObject({ status: 'failed', path: PAGE, error: 'gh down' });
    expect(nextExplainerState(failed, entry({ status: 'done', path: PAGE }), NOW).error).toBeUndefined();
  });
});
