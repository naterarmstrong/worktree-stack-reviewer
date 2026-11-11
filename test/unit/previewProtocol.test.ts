import { describe, expect, test } from 'vitest';
import {
  MAX_EXPLAINER_QUOTE,
  asEditorSelection,
  asExplainerMessage,
  asWebviewToEditorMessage,
  isMarkdownPath,
  parseRelativeLink,
} from '../../src/previewProtocol';

describe('asEditorSelection', () => {
  const valid = { startLine: 2, endLineExclusive: 5, selectedText: 'words' };

  test('accepts a well-formed selection', () => {
    expect(asEditorSelection(valid)).toEqual(valid);
  });

  test('defaults a missing selectedText to empty', () => {
    expect(
      asEditorSelection({ startLine: 0, endLineExclusive: 1 })?.selectedText,
    ).toBe('');
  });

  test.each([
    ['null', null],
    ['non-integer line', { ...valid, startLine: 1.5 }],
    ['negative line', { ...valid, startLine: -1 }],
    ['empty range', { ...valid, endLineExclusive: 2 }],
  ])('rejects %s', (_label, arg) => {
    expect(asEditorSelection(arg)).toBeUndefined();
  });
});

describe('asWebviewToEditorMessage', () => {
  test('accepts each message type', () => {
    expect(asWebviewToEditorMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(
      asWebviewToEditorMessage({
        type: 'createThread',
        body: 'note',
        startLine: 1,
        endLineExclusive: 3,
        selectedText: 'quoted',
      }),
    ).toEqual({
      type: 'createThread',
      body: 'note',
      startLine: 1,
      endLineExclusive: 3,
      selectedText: 'quoted',
    });
    expect(
      asWebviewToEditorMessage({ type: 'reply', threadId: 't1', body: 'ok' }),
    ).toEqual({ type: 'reply', threadId: 't1', body: 'ok' });
    expect(
      asWebviewToEditorMessage({ type: 'setResolved', threadId: 't1', resolved: true }),
    ).toEqual({ type: 'setResolved', threadId: 't1', resolved: true });
    expect(asWebviewToEditorMessage({ type: 'openSource', line: 4 })).toEqual({
      type: 'openSource',
      line: 4,
    });
    expect(asWebviewToEditorMessage({ type: 'openLink', href: './a.md' })).toEqual({
      type: 'openLink',
      href: './a.md',
    });
  });

  test('drops an invalid line from openSource rather than the message', () => {
    expect(asWebviewToEditorMessage({ type: 'openSource', line: -3 })).toEqual({
      type: 'openSource',
      line: undefined,
    });
  });

  test.each([
    ['null', null],
    ['unknown type', { type: 'detonate' }],
    ['createThread without a body', { type: 'createThread', startLine: 0, endLineExclusive: 1 }],
    ['createThread with a bad range', { type: 'createThread', body: 'x', startLine: 3, endLineExclusive: 3 }],
    ['reply without a thread id', { type: 'reply', body: 'x' }],
    ['setResolved with a non-boolean', { type: 'setResolved', threadId: 't', resolved: 'yes' }],
    ['openLink without an href', { type: 'openLink' }],
    ['a review with an unknown verdict', { type: 'submitReview', verdict: 'merge', body: 'x' }],
    ['a review with no body field', { type: 'submitReview', verdict: 'approve' }],
    ['a comment review with nothing said', { type: 'submitReview', verdict: 'comment', body: '  ' }],
    ['a change request with nothing said', { type: 'submitReview', verdict: 'request-changes', body: '' }],
  ])('rejects %s', (_label, arg) => {
    expect(asWebviewToEditorMessage(arg)).toBeUndefined();
  });
});

describe('submitReview', () => {
  test('accepts each verdict with a comment, and an approval without one', () => {
    for (const verdict of ['approve', 'comment', 'request-changes']) {
      expect(asWebviewToEditorMessage({ type: 'submitReview', verdict, body: 'Nice' })).toEqual({
        type: 'submitReview',
        verdict,
        body: 'Nice',
      });
    }
    expect(asWebviewToEditorMessage({ type: 'submitReview', verdict: 'approve', body: '' })).toEqual({
      type: 'submitReview',
      verdict: 'approve',
      body: '',
    });
  });
});

describe('asExplainerMessage', () => {
  test('accepts each message type', () => {
    expect(asExplainerMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(asExplainerMessage({ type: 'openLink', href: 'https://x' })).toEqual({
      type: 'openLink',
      href: 'https://x',
    });
    expect(
      asExplainerMessage({ type: 'createThread', body: ' why? ', quote: ' yields ', section: ' Loop ' }),
    ).toEqual({ type: 'createThread', body: 'why?', quote: 'yields', section: 'Loop' });
    expect(asExplainerMessage({ type: 'reply', threadId: 't1', body: 'ok' })).toEqual({
      type: 'reply',
      threadId: 't1',
      body: 'ok',
    });
    expect(asExplainerMessage({ type: 'setResolved', threadId: 't1', resolved: false })).toEqual({
      type: 'setResolved',
      threadId: 't1',
      resolved: false,
    });
  });

  test('a comment needs a body and the text it is on; the heading is optional', () => {
    expect(asExplainerMessage({ type: 'createThread', body: '', quote: 'q' })).toBeUndefined();
    expect(asExplainerMessage({ type: 'createThread', body: 'b', quote: '  ' })).toBeUndefined();
    expect(asExplainerMessage({ type: 'createThread', body: 'b' })).toBeUndefined();
    expect(asExplainerMessage({ type: 'createThread', body: 'b', quote: 'q', section: 3 })).toEqual({
      type: 'createThread',
      body: 'b',
      quote: 'q',
      section: undefined,
    });
  });

  test('a long quote is kept by how it begins', () => {
    const msg = asExplainerMessage({ type: 'createThread', body: 'b', quote: 'x'.repeat(5000) });
    expect(msg).toMatchObject({ quote: 'x'.repeat(MAX_EXPLAINER_QUOTE) });
  });

  test('refuses what only the markdown preview sends', () => {
    expect(asExplainerMessage({ type: 'openSource', line: 1 })).toBeUndefined();
    expect(asExplainerMessage({ type: 'submitReview', verdict: 'approve', body: '' })).toBeUndefined();
    expect(asExplainerMessage({ type: 'reply', threadId: 't1' })).toBeUndefined();
    expect(asExplainerMessage(null)).toBeUndefined();
  });
});

describe('parseRelativeLink', () => {
  test.each([
    ['./a.md', { path: './a.md', fragment: '' }],
    ['./a.md#setup', { path: './a.md', fragment: 'setup' }],
    ['./a.md?plain=1#setup', { path: './a.md', fragment: 'setup' }],
    ['../my%20docs/a.md', { path: '../my docs/a.md', fragment: '' }],
    ['./a.md#caf%C3%A9', { path: './a.md', fragment: 'caf%C3%A9' }],
    ['./100%.md', { path: './100%.md', fragment: '' }],
  ])('splits %s', (href, expected) => {
    expect(parseRelativeLink(href)).toEqual(expected);
  });
});

describe('isMarkdownPath', () => {
  test.each([
    ['/repo/docs/a.md', true],
    ['/repo/README.MD', true],
    ['/repo/a.md.txt', false],
    ['/repo/a.png', false],
  ])('%s', (file, expected) => {
    expect(isMarkdownPath(file)).toBe(expected);
  });
});
