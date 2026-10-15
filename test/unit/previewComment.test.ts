import { describe, expect, test } from 'vitest';
import {
  asPreviewSelectionContext,
  resolvePreviewRange,
} from '../../src/previewComment';

describe('asPreviewSelectionContext', () => {
  const valid = {
    resource: 'file:///wt/docs/runbook.md',
    startLine: 4,
    endLineExclusive: 7,
    selectedText: 'some prose',
  };

  test('accepts a well-formed context', () => {
    expect(asPreviewSelectionContext(valid)).toEqual(valid);
  });

  test('defaults a missing selectedText to empty', () => {
    const { selectedText: _dropped, ...noText } = valid;
    expect(asPreviewSelectionContext(noText)?.selectedText).toBe('');
  });

  test.each([
    ['null', null],
    ['a string', 'nope'],
    ['missing resource', { ...valid, resource: undefined }],
    ['empty resource', { ...valid, resource: '' }],
    ['non-integer line', { ...valid, startLine: 1.5 }],
    ['negative line', { ...valid, startLine: -1 }],
    ['empty range', { ...valid, endLineExclusive: 4 }],
    ['inverted range', { ...valid, endLineExclusive: 2 }],
  ])('rejects %s', (_label, arg) => {
    expect(asPreviewSelectionContext(arg)).toBeUndefined();
  });
});

describe('resolvePreviewRange', () => {
  // 0-based lines of a small markdown document.
  const lines = [
    '# Title', //           0
    '', //                  1
    'First paragraph', //   2
    'continues here.', //   3
    '', //                  4
    '- item one', //        5
    '- item two', //        6
    '', //                  7
    'Last paragraph.', //   8
  ];

  test('returns the block as 1-based inclusive lines', () => {
    const range = resolvePreviewRange(lines, {
      startLine: 2,
      endLineExclusive: 5,
      selectedText: '',
    });
    expect(range).toEqual({ startLine: 3, endLine: 4 });
  });

  test('trims the blank separator lines off the end of the block', () => {
    const range = resolvePreviewRange(lines, {
      startLine: 0,
      endLineExclusive: 2,
      selectedText: '',
    });
    expect(range).toEqual({ startLine: 1, endLine: 1 });
  });

  test('narrows to the lines containing the selected text', () => {
    const range = resolvePreviewRange(lines, {
      startLine: 5,
      endLineExclusive: 8,
      selectedText: 'item two',
    });
    expect(range).toEqual({ startLine: 7, endLine: 7 });
  });

  test('narrows a multi-line selection by its first and last lines', () => {
    const range = resolvePreviewRange(lines, {
      startLine: 2,
      endLineExclusive: 9,
      selectedText: 'continues here.\n\nitem one',
    });
    expect(range).toEqual({ startLine: 4, endLine: 6 });
  });

  test('keeps the whole block when rendered text diverges from source', () => {
    const bold = ['Some **very bold** words.'];
    const range = resolvePreviewRange(bold, {
      startLine: 0,
      endLineExclusive: 1,
      // The preview renders without the asterisks, so no source line
      // contains this string.
      selectedText: 'very bold words',
    });
    expect(range).toEqual({ startLine: 1, endLine: 1 });
  });

  test('clamps a range that runs past the end of the file', () => {
    const range = resolvePreviewRange(lines, {
      startLine: 8,
      endLineExclusive: 50,
      selectedText: '',
    });
    expect(range).toEqual({ startLine: 9, endLine: 9 });
  });

  test('returns undefined when the start is past the end of the file', () => {
    const range = resolvePreviewRange(lines, {
      startLine: 20,
      endLineExclusive: 21,
      selectedText: '',
    });
    expect(range).toBeUndefined();
  });
});
