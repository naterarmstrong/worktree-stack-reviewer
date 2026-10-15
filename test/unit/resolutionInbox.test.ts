import { describe, expect, test } from 'vitest';
import { isNoteEntry } from '../../src/commentStore';
import { parseEntries } from '../../src/resolutionInbox';

describe('parseEntries', () => {
  test('reads resolutions from a bare array or an entries object', () => {
    const entry = { id: 'abc', resolved: true, reply: 'done', author: 'Claude' };
    expect(parseEntries(JSON.stringify([entry]))).toEqual([entry]);
    expect(parseEntries(JSON.stringify({ entries: [entry] }))).toEqual([entry]);
  });

  test('an entry with a file and body but no id is a note', () => {
    const [note] = parseEntries(
      JSON.stringify([
        { file: 'src/app.ts', startLine: 3, endLine: 5, body: 'renamed the helper' },
      ]),
    );
    expect(isNoteEntry(note)).toBe(true);
    expect(note).toEqual({
      file: 'src/app.ts',
      startLine: 3,
      endLine: 5,
      body: 'renamed the helper',
      author: undefined,
      snippet: undefined,
    });
  });

  test('an entry with an id is a resolution even when it also names a file', () => {
    const [entry] = parseEntries(
      JSON.stringify([{ id: 'abc', file: 'src/app.ts', body: 'x', resolved: true }]),
    );
    expect(isNoteEntry(entry)).toBe(false);
  });

  test('a note keeps no end line without a start line', () => {
    const [note] = parseEntries(
      JSON.stringify([{ file: 'src/app.ts', endLine: 5, body: 'whole file' }]),
    );
    expect(note).toMatchObject({ startLine: undefined, endLine: undefined });
  });

  test('non-positive and fractional line numbers are dropped', () => {
    const [note] = parseEntries(
      JSON.stringify([{ file: 'src/app.ts', startLine: 0, body: 'x' }]),
    );
    expect(note).toMatchObject({ startLine: undefined });
    const [fractional] = parseEntries(
      JSON.stringify([{ file: 'src/app.ts', startLine: 1.5, body: 'x' }]),
    );
    expect(fractional).toMatchObject({ startLine: undefined });
  });

  test('entries that are neither shape are skipped, not rejected', () => {
    const entries = parseEntries(
      JSON.stringify([
        { file: 'src/app.ts' },
        { body: 'no file' },
        { id: '' },
        null,
        'text',
        { id: 'ok' },
      ]),
    );
    expect(entries).toEqual([
      { id: 'ok', resolved: undefined, reply: undefined, author: undefined },
    ]);
  });

  test('a document that is not a list throws', () => {
    expect(() => parseEntries('{"id": "abc"}')).toThrow(/array of entries/);
  });
});
