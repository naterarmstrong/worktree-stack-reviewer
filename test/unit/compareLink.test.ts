import { describe, expect, test } from 'vitest';
import { Uri } from 'vscode';
import { parseCompareLink } from '../../src/compareLink';

const EXTENSION_ID = 'naterarmstrong.worktree-stack-reviewer';

describe('compare links', () => {
  test('reads the branch, both sides, and a percent-encoded file', () => {
    const uri = Uri.parse(
      `vscode://${EXTENSION_ID}/compare?branch=alex%2Feng-1234-x&a=abc1234&b=def5678&file=src%2Fa%20b.ts`,
    );
    expect(parseCompareLink(uri)).toEqual({
      branch: 'alex/eng-1234-x',
      a: 'abc1234',
      b: 'def5678',
      file: 'src/a b.ts',
    });
  });

  test('file is optional and blank values read as absent', () => {
    const uri = Uri.parse(`vscode://${EXTENSION_ID}/compare?branch=b&a=3&b=4&file=`);
    expect(parseCompareLink(uri)).toEqual({ branch: 'b', a: '3', b: '4', file: undefined });
  });

  test('a link missing a side is rejected', () => {
    expect(parseCompareLink(Uri.parse(`vscode://${EXTENSION_ID}/compare?branch=b&a=3`))).toBeUndefined();
    expect(parseCompareLink(Uri.parse(`vscode://${EXTENSION_ID}/compare?a=3&b=4`))).toBeUndefined();
  });

  test('other paths are not compare links', () => {
    expect(parseCompareLink(Uri.parse(`vscode://${EXTENSION_ID}/open?branch=b&a=3&b=4`))).toBeUndefined();
  });

  test('base is accepted as a side', () => {
    const uri = Uri.parse(`vscode://${EXTENSION_ID}/compare?branch=b&a=base&b=2`);
    expect(parseCompareLink(uri)).toMatchObject({ a: 'base', b: '2' });
  });
});
