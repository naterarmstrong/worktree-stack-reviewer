import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  type Worktree,
  checkoutBranch,
  createBranchAt,
  getCurrentBranch,
  getStack,
  getStackTrunk,
  isAgentWorktreeOnItsOwnBranch,
  listChangedFiles,
  listLocalBranches,
  listUncommittedChanges,
  listWorktrees,
  mainWorktreePath,
  mergeBaseOf,
  resolveMergeBase,
  revParse,
  stackFromGhStack,
} from '../../src/git';
import { type Fixture, git, makeFixture, write } from '../fixtures/repo';

describe('git', () => {
  let fixture: Fixture;

  beforeAll(() => {
    fixture = makeFixture();
  });

  afterAll(() => {
    fixture.remove();
  });

  test('names the main worktree from any worktree in the repository', async () => {
    const fromMain = await mainWorktreePath(fixture.repo);
    const fromLinked = await mainWorktreePath(fixture.feature);
    expect(fs.realpathSync(fromMain)).toBe(fs.realpathSync(fixture.repo));
    expect(fromLinked).toBe(fromMain);
  });

  test('lists every worktree with the branch it holds', async () => {
    const worktrees = await listWorktrees(fixture.repo);
    expect(
      worktrees.map((w) => [path.basename(w.path), w.branch]).sort(),
    ).toEqual([
      ['feature', 'feature'],
      ['repo', 'main'],
      ['review', 'scratch'],
    ]);
    expect(worktrees.every((w) => w.head.length === 40)).toBe(true);
  });

  test('lists a branch’s committed changes against its base', async () => {
    const files = await listChangedFiles(fixture.feature, 'main', false);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['src/app.ts', 'M'],
      ['src/models.gen.ts', 'A'],
      ['tests/app.test.ts', 'M'],
    ]);
    const app = files.find((f) => f.path === 'src/app.ts');
    expect(app?.added).toBe(1);
    expect(app?.removed).toBe(0);
    expect(app?.patchId).toMatch(/^[0-9a-f]+$/);
  });

  test('marks files carrying a linguist-generated attribute', async () => {
    const files = await listChangedFiles(fixture.feature, 'main', false);
    const generated = files.filter((f) => f.generated).map((f) => f.path);
    expect(generated).toEqual(['src/models.gen.ts']);
  });

  test('includes working-tree changes only when asked', async () => {
    write(fixture.feature, 'src/scratch.ts', 'export const draft = 1;\n');
    write(fixture.feature, 'src/app.ts', 'export const name = "edited";\n');

    const committed = await listChangedFiles(fixture.feature, 'main', false);
    expect(committed.map((f) => f.path)).not.toContain('src/scratch.ts');

    const working = await listChangedFiles(fixture.feature, 'main', true);
    const scratch = working.find((f) => f.path === 'src/scratch.ts');
    expect(scratch?.status).toBe('A');
    expect(scratch?.uncommitted).toBe(true);
    expect(working.find((f) => f.path === 'src/app.ts')?.uncommitted).toBe(true);

    git(fixture.feature, ['checkout', '--', 'src/app.ts']);
    git(fixture.feature, ['clean', '-qfd']);
  });

  test('reports staged, unstaged, and untracked paths as uncommitted', async () => {
    expect(await listUncommittedChanges(fixture.feature)).toEqual([]);

    write(fixture.feature, 'src/app.ts', 'export const name = "dirty";\n');
    write(fixture.feature, 'notes.md', 'wip\n');
    git(fixture.feature, ['add', 'notes.md']);

    expect((await listUncommittedChanges(fixture.feature)).sort()).toEqual([
      'notes.md',
      'src/app.ts',
    ]);

    git(fixture.feature, ['reset', '-q']);
    git(fixture.feature, ['checkout', '--', 'src/app.ts']);
    git(fixture.feature, ['clean', '-qfd']);
    expect(await listUncommittedChanges(fixture.feature)).toEqual([]);
  });

  test('lists local branches across every worktree', async () => {
    const branches = await listLocalBranches(fixture.repo);
    expect(Array.from(branches).sort()).toEqual(['feature', 'main', 'scratch']);
  });

  test('creates a branch at a start point and checks it back out', async () => {
    await createBranchAt(fixture.review, 'review', 'main');
    expect(await getCurrentBranch(fixture.review)).toBe('review');
    expect(await revParse(fixture.review, 'review')).toBe(
      await revParse(fixture.review, 'main'),
    );

    await checkoutBranch(fixture.review, 'scratch');
    expect(await getCurrentBranch(fixture.review)).toBe('scratch');

    git(fixture.repo, ['branch', '-q', '-D', 'review']);
  });

  test('resolves refs and merge bases, and rejects refs that do not exist', async () => {
    expect(await revParse(fixture.repo, 'main')).toMatch(/^[0-9a-f]{40}$/);
    await expect(revParse(fixture.repo, 'no-such-branch')).rejects.toThrow();
    expect(await resolveMergeBase(fixture.feature, 'main')).toBe(
      await revParse(fixture.repo, 'main'),
    );
  });

  test('names the merge base of two branches from a worktree on neither', async () => {
    expect(await mergeBaseOf(fixture.review, 'main', 'feature')).toBe(
      await revParse(fixture.repo, 'main'),
    );
  });

  test('reports no stack trunk for a repository with no stacks', async () => {
    expect(await getStackTrunk(fixture.repo)).toBeNull();
  });

  test('reads the stack a worktree is on from .git/gh-stack', async () => {
    const stateFile = path.join(fixture.repo, '.git', 'gh-stack');
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        schemaVersion: 1,
        stacks: [
          { trunk: { branch: 'main' }, branches: [{ branch: 'other' }] },
          {
            trunk: { branch: 'main' },
            branches: [{ branch: 'feature' }, { branch: 'feature-2' }],
          },
        ],
      }),
    );
    try {
      expect(await getStackTrunk(fixture.feature)).toBe('main');
      const stack = await getStack(fixture.feature, 'feature');
      expect(stack.branches).toEqual(['feature-2', 'feature']);
      expect(stack.parent).toBe('main');
      expect(stack.parents.get('feature-2')).toBe('feature');
      // A trunk is shared by every stack, so it is in none of them.
      expect((await getStack(fixture.repo, 'main')).parent).toBeNull();
    } finally {
      fs.rmSync(stateFile);
    }
  });
});

describe('stackFromGhStack', () => {
  const merged = (branch: string) => ({ branch, pullRequest: { number: 1, merged: true } });

  test('skips merged branches and sits the next one on what is below them', () => {
    const stack = stackFromGhStack([merged('a'), { branch: 'b' }, { branch: 'c' }], 'main', 'c');
    expect(stack.branches).toEqual(['c', 'b']);
    expect(stack.parents.get('b')).toBe('main');
    expect(stack.parent).toBe('b');
  });

  test('keeps the current branch once merged so its worktree keeps a row', () => {
    const stack = stackFromGhStack([{ branch: 'a' }, merged('b'), { branch: 'c' }], 'main', 'b');
    expect(stack.branches).toEqual(['c', 'b', 'a']);
    expect(stack.parent).toBe('a');
    expect(stack.parents.get('c')).toBe('a');
  });
});

describe('isAgentWorktreeOnItsOwnBranch', () => {
  const AGENT = '/workspaces/repo/.claude/worktrees/bridge-cse_01AB';

  test('recognises an agent worktree on the branch named after it', () => {
    expect(
      isAgentWorktreeOnItsOwnBranch(worktreeOn(AGENT, 'worktree-bridge-cse_01AB')),
    ).toBe(true);
  });

  test('an agent worktree holding another one’s branch is left alone', () => {
    expect(
      isAgentWorktreeOnItsOwnBranch(worktreeOn(AGENT, 'worktree-bridge-cse_01CD')),
    ).toBe(false);
  });

  test('an agent worktree doing work is left alone', () => {
    expect(
      isAgentWorktreeOnItsOwnBranch(worktreeOn(AGENT, 'alex/eng-1234-a-fix')),
    ).toBe(false);
  });

  test('a worktree made by hand is left alone however its branch is named', () => {
    // `wt switch -c` puts a worktree at /worktrees/<branch with slashes
    // flattened>, so its directory is named after the branch it holds.
    const byHand = '/worktrees/alex-eng-1234-a-fix';
    expect(
      isAgentWorktreeOnItsOwnBranch(worktreeOn(byHand, 'alex/eng-1234-a-fix')),
    ).toBe(false);
    expect(
      isAgentWorktreeOnItsOwnBranch(
        worktreeOn('/worktrees/worktree-foo', 'worktree-foo'),
      ),
    ).toBe(false);
  });

  test('a branch merely starting with the prefix does not count', () => {
    expect(isAgentWorktreeOnItsOwnBranch(worktreeOn(AGENT, 'worktree-'))).toBe(false);
    expect(
      isAgentWorktreeOnItsOwnBranch(worktreeOn(AGENT, 'worktree-bridge-cse_01ABCD')),
    ).toBe(false);
  });

  test('a trailing slash on the path does not hide the match', () => {
    expect(
      isAgentWorktreeOnItsOwnBranch(worktreeOn(`${AGENT}/`, 'worktree-bridge-cse_01AB')),
    ).toBe(true);
  });
});

function worktreeOn(path: string, branch: string): Worktree {
  return { path, branch, head: '0'.repeat(40) };
}
