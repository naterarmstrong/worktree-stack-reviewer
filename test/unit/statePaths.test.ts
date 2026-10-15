import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { stateDirFor } from '../../src/statePaths';
import { type Fixture, git, makeFixture } from '../fixtures/repo';

describe('stateDirFor', () => {
  let fixture: Fixture;

  beforeAll(() => {
    fixture = makeFixture();
  });

  afterAll(() => {
    fixture.remove();
  });

  test('keeps the main worktree’s state in its .git directory', () => {
    expect(stateDirFor(fixture.repo)).toBe(path.join(fixture.repo, '.git', 'wt-review'));
  });

  test('keeps a linked worktree’s state in its own gitdir', () => {
    const gitDir = path.resolve(
      fixture.feature,
      git(fixture.feature, ['rev-parse', '--git-dir']).trim(),
    );
    expect(stateDirFor(fixture.feature)).toBe(path.join(gitDir, 'wt-review'));
    expect(fs.realpathSync(path.dirname(gitDir))).toBe(
      fs.realpathSync(path.join(fixture.repo, '.git', 'worktrees')),
    );
  });

  test('is invisible to git status', () => {
    const dir = stateDirFor(fixture.feature);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'comments.json'), '{}\n');
    expect(git(fixture.feature, ['status', '--porcelain', '--ignored'])).not.toContain(
      'wt-review',
    );
  });
});
