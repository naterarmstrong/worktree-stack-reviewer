import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { diffNameStatus, listChangedFiles, listUncommittedChanges } from '../../src/git';
import { parseFilePatches } from '../../src/patchId';
import { type Fixture, git, makeFixture, write } from '../fixtures/repo';

/**
 * The core answers in-process with gix what the extension used to ask the git
 * CLI. These tests put a worktree through every kind of change a review sees
 * and check the core's answer against git's own.
 */
describe('core matches git', () => {
  let fixture: Fixture;
  let wt: string;

  beforeAll(() => {
    fixture = makeFixture();
    wt = fixture.feature;
    // Committed on the branch: a rename with an edit, a deletion, a file with
    // no final newline, a binary file, an executable.
    const body = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    write(fixture.repo, 'src/moved.ts', `${body}\n`);
    write(fixture.repo, 'src/gone.ts', 'export {};\n');
    git(fixture.repo, ['add', '.']);
    git(fixture.repo, ['commit', '-q', '-m', 'more files']);
    git(wt, ['rebase', '-q', 'main']);
    git(wt, ['mv', 'src/moved.ts', 'src/renamed.ts']);
    write(wt, 'src/renamed.ts', `${body.replace('line 3', 'line three')}\n`);
    git(wt, ['rm', '-q', 'src/gone.ts']);
    write(wt, 'src/no-newline.ts', 'a\nb');
    fs.writeFileSync(path.join(wt, 'assets.bin'), Buffer.from([1, 0, 2, 0, 3]));
    write(wt, 'run.sh', '#!/bin/sh\necho hi\n');
    fs.chmodSync(path.join(wt, 'run.sh'), 0o755);
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-q', '-m', 'branch changes']);

    // Uncommitted: staged, unstaged, both, a working-tree deletion, a mode
    // change, and untracked files.
    write(wt, 'staged.ts', 'export const staged = 1;\n');
    git(wt, ['add', 'staged.ts']);
    write(wt, 'src/app.ts', 'export const name = "renamed";\nexport const v = 3;\n');
    write(wt, 'src/no-newline.ts', 'a\nb\nc');
    git(wt, ['add', 'src/no-newline.ts']);
    write(wt, 'src/no-newline.ts', 'a\nB\nc\n');
    fs.rmSync(path.join(wt, 'tests/app.test.ts'));
    fs.chmodSync(path.join(wt, 'run.sh'), 0o644);
    write(wt, 'notes/todo.txt', 'one\ntwo\n');
    write(wt, 'scratch.md', 'draft');
  });

  afterAll(() => {
    fixture?.remove();
  });

  /** What the extension computed from the git CLI before the core existed. */
  function fromGit(range: string): Map<string, { status: string; added?: number; removed?: number; patchId?: string }> {
    const out = new Map<string, { status: string; added?: number; removed?: number; patchId?: string }>();
    for (const line of git(wt, ['diff', '--name-status', '--find-renames', range]).split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      out.set(parts[parts.length - 1], { status: parts[0][0] });
    }
    for (const line of git(wt, ['diff', '--numstat', '--find-renames', range]).split('\n')) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
      if (!m || m[1] === '-') continue;
      const p = m[3].includes(' => ') ? m[3].replace(/\{?[^{}]* => ([^{}]*)\}?/, '$1').replace('//', '/') : m[3];
      const entry = out.get(p);
      if (entry) Object.assign(entry, { added: Number(m[1]), removed: Number(m[2]) });
    }
    const patches = parseFilePatches(git(wt, ['diff', '-U0', '--patch', '--find-renames', range]));
    for (const [p, patch] of patches) {
      const entry = out.get(p);
      if (entry) entry.patchId = patch.patchId;
    }
    return out;
  }

  test('committed changes, base...HEAD', async () => {
    const files = await listChangedFiles(wt, 'main', false);
    const expected = fromGit('main...HEAD');
    expect(new Map(files.map((f) => [f.path, { status: f.status, added: f.added, removed: f.removed, patchId: f.patchId }]))).toEqual(
      new Map([...expected].map(([p, e]) => [p, { status: e.status, added: e.added, removed: e.removed, patchId: e.patchId }])),
    );
    expect(new Set([...expected.values()].map((e) => e.status))).toEqual(new Set(['A', 'D', 'M', 'R']));
    expect(files.find((f) => f.path === 'src/renamed.ts')).toMatchObject({ status: 'R', oldPath: 'src/moved.ts' });
    expect(files.find((f) => f.path === 'assets.bin')?.added).toBeUndefined();
  });

  test('with uncommitted changes, against the files on disk', async () => {
    const files = await listChangedFiles(wt, 'main', true);
    const mergeBase = git(wt, ['merge-base', 'HEAD', 'main']).trim();
    const expected = fromGit(mergeBase);
    const tracked = files.filter((f) => !['notes/todo.txt', 'scratch.md'].includes(f.path));
    expect(new Map(tracked.map((f) => [f.path, { status: f.status, added: f.added, removed: f.removed, patchId: f.patchId }]))).toEqual(
      new Map([...expected].map(([p, e]) => [p, { status: e.status, added: e.added, removed: e.removed, patchId: e.patchId }])),
    );

    // Every kind of uncommitted change made it into the comparison.
    expect(expected.get('staged.ts')?.status).toBe('A');
    expect(expected.get('tests/app.test.ts')?.status).toBe('D');
    expect(expected.get('run.sh')?.status).toBe('A');
    expect(expected.get('src/no-newline.ts')?.patchId).toBeDefined();
    expect(tracked.find((f) => f.path === 'src/app.ts')?.added).toBe(2);

    const dirty = new Set(git(wt, ['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean));
    for (const f of tracked) expect(!!f.uncommitted, f.path).toBe(dirty.has(f.path));

    expect(files.find((f) => f.path === 'notes/todo.txt')).toMatchObject({ status: 'A', added: 2, removed: 0, uncommitted: true });
    expect(files.find((f) => f.path === 'scratch.md')).toMatchObject({ status: 'A', added: 1, uncommitted: true });
    expect(files.find((f) => f.path === 'scratch.md')?.patchId).toMatch(/^[0-9a-f]{40}$/);
  });

  test('marks generated files from .gitattributes', async () => {
    const files = await listChangedFiles(wt, 'main', true);
    expect(files.find((f) => f.path === 'src/models.gen.ts')?.generated).toBe(true);
    expect(files.find((f) => f.path === 'src/app.ts')?.generated).toBeFalsy();
  });

  test('names what differs between two trees', async () => {
    const files = await diffNameStatus(wt, 'main', 'feature');
    const expected = git(wt, ['diff', '--name-status', '--find-renames', 'main', 'feature'])
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'))
      .map((parts) => [parts[parts.length - 1], parts[0][0]]);
    expect(files.map((f) => [f.path, f.status])).toEqual(expected);
  });

  test('lists uncommitted paths like git status', async () => {
    const expected = git(wt, ['status', '--porcelain'])
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3))
      .sort();
    expect([...(await listUncommittedChanges(wt))].sort()).toEqual(expected);
  });
});
