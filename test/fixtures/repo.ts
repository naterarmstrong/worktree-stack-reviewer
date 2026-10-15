import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A throwaway repository laid out the way the extension expects to find one:
 * a main worktree on trunk, a worktree with a branch ahead of it, and a
 * worktree whose directory is named `review`.
 *
 * Tests write to these — branches get created, files get edited — so every run
 * builds its own rather than sharing one.
 */
export interface Fixture {
  /** The directory holding every worktree. */
  root: string;
  /** The main worktree, on `main`. */
  repo: string;
  /** A worktree on `feature`, one commit ahead of `main`. */
  feature: string;
  /** A worktree named `review`, on `scratch` — what the review actions move. */
  review: string;
  remove(): void;
}

const GENERATED_FILE = 'src/models.gen.ts';

export function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-review-fixture-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);

  git(repo, ['init', '-q', '-b', 'main', '.']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Fixture']);
  // Commit hooks and signing come from the developer's global config, which
  // the fixture must not depend on.
  git(repo, ['config', 'commit.gpgsign', 'false']);
  write(repo, '.gitattributes', '*.gen.ts linguist-generated=true\n');
  write(repo, 'src/app.ts', 'export const name = "app";\n');
  write(repo, 'tests/app.test.ts', 'test("app", () => {});\n');
  // Markdown the review preview can be pointed at, from a ref rather than the
  // working tree.
  write(repo, 'docs/notes.md', '# Notes\n\nWhat the change does.\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'initial']);

  const feature = path.join(root, 'feature');
  git(repo, ['worktree', 'add', '-q', feature, '-b', 'feature']);
  write(feature, 'src/app.ts', 'export const name = "app";\nexport const v = 2;\n');
  write(feature, 'tests/app.test.ts', 'test("app", () => {});\ntest("v", () => {});\n');
  write(feature, GENERATED_FILE, 'export type Row = { id: number };\n');
  git(feature, ['add', '.']);
  git(feature, ['commit', '-q', '-m', 'add v']);

  const review = path.join(root, 'review');
  git(repo, ['worktree', 'add', '-q', review, '-b', 'scratch']);

  return {
    root,
    repo,
    feature,
    review,
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Runs git in a worktree, throwing with git's own message on failure. */
export function git(cwd: string, args: string[]): string {
  return cp.execFileSync('git', args, { cwd, encoding: 'utf8' });
}

export function write(worktreePath: string, relPath: string, body: string): void {
  const target = path.join(worktreePath, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, 'utf8');
}

/**
 * Writes a comment store by hand, in the shape the extension reads. Lets a test
 * start from a worktree that already has review comments on it without driving
 * the UI to create them.
 */
export function seedComments(
  worktreePath: string,
  threads: {
    id: string;
    branch: string;
    /** Worktree-relative, or `PR-142.md` for a comment on a description. */
    file: string;
    startLine: number;
    body: string;
    side?: 'working' | 'base' | 'pr';
  }[],
): void {
  const payload = {
    version: 1,
    threads: threads.map((thread) => ({
      id: thread.id,
      branch: thread.branch,
      file: thread.file,
      side: thread.side ?? 'working',
      startLine: thread.startLine,
      endLine: thread.startLine,
      resolved: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      comments: [
        {
          id: `${thread.id}-1`,
          author: 'Fixture',
          body: thread.body,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    })),
  };
  // Where the extension keeps it by default: the worktree's own gitdir.
  const gitDir = path.resolve(
    worktreePath,
    git(worktreePath, ['rev-parse', '--git-dir']).trim(),
  );
  const target = path.join(gitDir, 'wt-review', 'comments.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`);
}
