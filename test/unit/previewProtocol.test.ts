import { describe, expect, test } from 'vitest';
import {
  asEditorSelection,
  asWebviewToEditorMessage,
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
