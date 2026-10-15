import { describe, expect, test } from 'vitest';
import { Uri } from 'vscode';
import { buildGitUri, parseGitUri } from '../../src/gitContentProvider';

/**
 * VS Code never hands a virtual document's URI back to the extension as the
 * object that built it. `ITextModelService` keys its models on
 * `resource.toString()` and rebuilds them with `URI.parse(key)`, so anything a
 * `wt-ext-git:` URI carries has to survive that trip — twice, since a document
 * can be resolved again from an already-round-tripped URI.
 */
const roundTrip = (uri: Uri): Uri => Uri.parse(Uri.parse(uri.toString()).toString());

const UPPERCASE_WORKTREE =
  '/workspaces/example-app/.claude/worktrees/bridge-cse_01MfmngbgvFw5ATvy47i9kob';

describe('git uris', () => {
  test('survives the round trip VS Code puts them through', () => {
    const uri = buildGitUri(UPPERCASE_WORKTREE, 'origin/main', 'pkg/src/pkg/Foo.py');

    expect(parseGitUri(roundTrip(uri))).toEqual({
      worktreePath: UPPERCASE_WORKTREE,
      ref: 'origin/main',
      file: 'pkg/src/pkg/Foo.py',
    });
  });

  test('keeps the worktree out of the authority, which VS Code lowercases', () => {
    const uri = buildGitUri(UPPERCASE_WORKTREE, 'HEAD', 'a.py');

    expect(uri.authority).toBe('');
    expect(roundTrip(uri).toString()).toBe(uri.toString());
  });

  test('distinguishes the same file in two worktrees', () => {
    const a = buildGitUri('/worktrees/one', 'HEAD', 'a.py');
    const b = buildGitUri('/worktrees/two', 'HEAD', 'a.py');

    expect(a.toString()).not.toBe(b.toString());
  });

  test('reads no worktree from a uri built by an older release', () => {
    const legacy = Uri.from({
      scheme: 'wt-ext-git',
      authority: encodeURIComponent(UPPERCASE_WORKTREE),
      path: '/a.py',
      query: 'ref=HEAD',
    });

    expect(parseGitUri(legacy)).toBeUndefined();
  });
});
