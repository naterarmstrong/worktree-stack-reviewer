import { describe, expect, test } from 'vitest';
import { UNDECORATED_SCHEME, rowUri } from '../../src/rowUri';

// The stubbed `workspace.getConfiguration` reads every setting as its
// caller-supplied default, so `showFileDecorations` is off here — the shipped
// default, and the case the row URI is shaped for.
const WORKTREE = '/workspaces/example-app/.claude/worktrees/bridge-cse_01Mfmngb';
const FILE = `${WORKTREE}/infra/live/dev/environment.yaml`;

describe('row uris', () => {
  test('keeps decorations off the row', () => {
    expect(rowUri(FILE).scheme).toBe(UNDECORATED_SCHEME);
  });

  test('names a path inside no repository', () => {
    // Git's decoration provider resolves a row to a repository by `fsPath`
    // whatever the scheme, so escaping every repository root is what actually
    // keeps the row uncoloured.
    const roots = ['/workspaces/example-app', WORKTREE, '/worktrees/some-worktree'];
    const { fsPath } = rowUri(FILE);

    for (const root of roots) {
      expect(fsPath.startsWith(`${root}/`), `${fsPath} is inside ${root}`).toBe(false);
    }
  });

  test('ends in the file name, which is what draws the icon', () => {
    expect(rowUri(FILE).path.endsWith('/environment.yaml')).toBe(true);
  });

  test('tells apart the same relative path in two worktrees', () => {
    const a = rowUri('/worktrees/one/src/app.ts');
    const b = rowUri('/worktrees/two/src/app.ts');

    expect(a.toString()).not.toBe(b.toString());
  });
});
