import { describe, expect, test } from 'vitest';
import { type GtLoc, summarizeGtLoc } from '../../src/stackLoc';

const none = { add: 0, del: 0 };

function file(
  path: string,
  kind: GtLoc['files'][number]['kind'],
  lines: Partial<GtLoc['files'][number]['lines']>,
  binary = false,
): GtLoc['files'][number] {
  return {
    path,
    kind,
    binary,
    lines: { src: none, test: none, doc: none, gen: none, ...lines },
  };
}

describe('summarizeGtLoc', () => {
  test('totals each bucket from gt’s per-file split', () => {
    const summary = summarizeGtLoc({
      base: 'b',
      commit: 'c',
      files: [
        file('src/app.ts', 'src', { src: { add: 3, del: 1 } }),
        file('tests/app.test.ts', 'test', { test: { add: 5, del: 0 } }),
        file('README.md', 'doc', { doc: { add: 2, del: 2 } }),
        file('uv.lock', 'gen', { gen: { add: 40, del: 10 } }),
      ],
    });

    expect(summary.files).toBe(4);
    expect(summary.added).toBe(50);
    expect(summary.removed).toBe(13);
    expect(summary.buckets).toEqual({
      src: { files: 1, added: 3, removed: 1 },
      test: { files: 1, added: 5, removed: 0 },
      doc: { files: 1, added: 2, removed: 2 },
      gen: { files: 1, added: 40, removed: 10 },
    });
  });

  test('counts a file toward every bucket it has lines in', () => {
    const summary = summarizeGtLoc({
      base: 'b',
      commit: 'c',
      files: [
        file('core/src/lib.rs', 'src', {
          src: { add: 4, del: 0 },
          test: { add: 9, del: 1 },
        }),
      ],
    });

    expect(summary.files).toBe(1);
    expect(summary.buckets.src).toEqual({ files: 1, added: 4, removed: 0 });
    expect(summary.buckets.test).toEqual({ files: 1, added: 9, removed: 1 });
  });

  test('puts a file with no lines under its own kind', () => {
    const summary = summarizeGtLoc({
      base: 'b',
      commit: 'c',
      files: [file('media/logo.png', 'src', {}, true)],
    });

    expect(summary.files).toBe(1);
    expect(summary.added).toBe(0);
    expect(summary.buckets.src).toEqual({ files: 1, added: 0, removed: 0 });
  });

  test('counts nothing for a branch with no commits of its own', () => {
    const summary = summarizeGtLoc({ base: 'c', commit: 'c', files: [] });
    expect(summary.files).toBe(0);
    expect(Object.values(summary.buckets).every((b) => b.files === 0)).toBe(true);
  });
});
