import * as cp from 'node:child_process';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { revParse } from '../../src/git';
import { type Fixture, git, makeFixture, write } from '../fixtures/repo';

// The same stand-ins as staleBase.test.ts, except that rows keep their label
// and `vscode.diff` calls are recorded.
const host = vi.hoisted(() => ({ repo: '', diffs: [] as unknown[][] }));
vi.mock('vscode', async (original) => {
  const vscode = await original<typeof import('vscode')>();
  class Item {
    label: unknown;
    constructor(label?: unknown) {
      this.label = label;
    }
  }
  return {
    ...vscode,
    TreeItem: Item,
    ThemeIcon: Item,
    ThemeColor: Item,
    MarkdownString: Item,
    commands: {
      executeCommand: async (...args: unknown[]) => void host.diffs.push(args),
    },
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    workspace: {
      get workspaceFolders() {
        return [{ uri: { fsPath: host.repo } }];
      },
      getConfiguration: () => ({
        get: <T>(key: string, fallback?: T): unknown =>
          ({
            fallbackBase: 'main',
            layout: 'flat',
            showPullRequests: false,
            useStackParent: false,
            includeUncommitted: false,
          })[key] ?? fallback,
      }),
    },
  };
});

interface Row {
  label?: string;
  file?: { path: string };
  worktreePath?: string;
  checkboxState?: number;
  description?: string;
  worktree?: { branch: string };
}

describe('the Hidden Changes section', () => {
  let fixture: Fixture;
  let provider: {
    getChildren(element?: Row): Promise<Row[]>;
    setHiddenEnabled(items: [Row, number][]): Promise<void>;
    openDiff(args: unknown): Promise<void>;
    dispose(): void;
  };
  let store: import('../../src/hiddenChanges').HiddenChangeStore;

  const feature = async (): Promise<Row[]> => {
    const roots = await provider.getChildren();
    return provider.getChildren(roots.find((n) => n.worktree?.branch === 'feature'));
  };
  const labels = (rows: Row[]): (string | undefined)[] => rows.map((r) => r.file?.path ?? r.label);

  beforeAll(async () => {
    fixture = makeFixture();
    host.repo = fixture.repo;
    write(fixture.repo, 'renamed.txt', 'before\n');
    git(fixture.repo, ['add', '.']);
    git(fixture.repo, ['commit', '-q', '-m', 'renamed.txt']);
    git(fixture.feature, ['rebase', '-q', 'main']);
    write(fixture.feature, 'renamed.txt', 'after\n');
    git(fixture.feature, ['add', '.']);
    git(fixture.feature, ['commit', '-q', '-m', 'rename']);

    const hiddenChanges = await import('../../src/hiddenChanges');
    store = new hiddenChanges.HiddenChangeStore(fixture.repo);
    const { WorktreeProvider } = await import('../../src/worktreeProvider');
    const Provider = WorktreeProvider as unknown as new (...args: unknown[]) => typeof provider;
    const inert = new Proxy({}, { get: () => async () => undefined });
    const thread = {
      id: 't',
      file: 'renamed.txt',
      side: 'working',
      resolved: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      comments: [],
    };
    const comments = new Proxy(
      {},
      { get: (_t, key) => (key === 'threadsFor' ? () => [thread] : async () => undefined) },
    );
    provider = new Provider(comments, inert, inert, inert, inert, store);
  });

  afterAll(() => {
    provider.dispose();
    store.dispose();
    fixture.remove();
  });

  test('is absent until something is hidden', async () => {
    expect(labels(await feature()).some((l) => l?.startsWith('Hidden Changes'))).toBe(false);
  });

  test('sits just below Comments, and its commit takes the file out of the list', async () => {
    const base = await revParse(fixture.feature, 'main');
    const index = `${fixture.root}/tmp-index`;
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const run = (args: string[], input?: string): string =>
      cp
        .execFileSync('git', args, { cwd: fixture.feature, encoding: 'utf8', input, env })
        .trim();
    run(['read-tree', base]);
    const blob = run(['hash-object', '-w', '--stdin'], 'after\n');
    run(['update-index', '--add', '--cacheinfo', `100644,${blob},renamed.txt`]);
    const commit = run(['commit-tree', run(['write-tree']), '-p', base, '-m', 'Rename the thing']);
    await store.apply(fixture.feature, { kind: 'hiddenChange', commit, action: 'add' });

    const rows = labels(await feature());
    const comments = rows.findIndex((l) => l?.startsWith('Comments'));
    expect(rows[comments + 1]).toBe('Hidden Changes (1 of 1 on)');
    expect(rows).not.toContain('renamed.txt');

    const section = (await feature())[comments + 1];
    const [row] = await provider.getChildren(section);
    expect(row.label).toBe('Rename the thing');
    expect(row.checkboxState).toBe(1);
    expect(labels(await provider.getChildren(row))).toEqual(['renamed.txt']);

    await provider.setHiddenEnabled([[row, 0]]);
    const off = labels(await feature());
    expect(off[comments + 1]).toBe('Hidden Changes (0 of 1 on)');
    expect(off).toContain('renamed.txt');
    const unticked = (await provider.getChildren((await feature())[comments + 1]))[0];
    expect(unticked.checkboxState).toBe(0);
  });

  test('a diff opens against the view ref, not the merge base', async () => {
    const row = (await feature()).find((r) => r.file?.path === 'renamed.txt');
    expect(row).toBeDefined();
    host.diffs.length = 0;
    await provider.openDiff({ worktreePath: row?.worktreePath, base: 'main', file: row?.file });
    const [command, left] = host.diffs[0] as [string, { query: string }];
    expect(command).toBe('vscode.diff');
    expect(new URLSearchParams(left.query).get('ref')).toBe('refs/wt-review/view/feature');
  });
});
