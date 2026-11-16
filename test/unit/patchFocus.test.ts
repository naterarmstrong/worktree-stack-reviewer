import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { revParse } from '../../src/git';
import { type Fixture, git, makeFixture, write } from '../fixtures/repo';

// The same stand-ins as hiddenSection.test.ts, with the stack section on so the
// branch's patch rows are reachable. `gt` and `gh` are answered here: the
// listing and the compare are what this test feeds the tree, not what it tests.
const host = vi.hoisted(() => ({
  repo: '',
  compares: [] as string[][],
  compare: undefined as unknown,
  listing: undefined as unknown,
}));
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
    commands: { executeCommand: async () => undefined },
    window: { showErrorMessage: async () => undefined },
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
            showPullRequests: true,
            useStackParent: false,
            includeUncommitted: false,
          })[key] ?? fallback,
      }),
    },
  };
});
vi.mock('../../src/gh', () => ({
  listOpenPrs: async () => [],
  listOpenPrsForBranches: async () => [],
  prBaseCommits: async () => new Map(),
  prCommentCountsBySha: async () => new Map(),
}));
vi.mock('../../src/stackLoc', async (original) => ({
  ...(await original<typeof import('../../src/stackLoc')>()),
  readGtLoc: async () => {
    throw new Error('no gt here');
  },
}));
vi.mock('../../src/versionHistory', async (original) => ({
  ...(await original<typeof import('../../src/versionHistory')>()),
  listVersions: async () => host.listing,
  compareVersions: async (_wt: string, _branch: string, a: string, b: string) => {
    host.compares.push([a, b]);
    return host.compare;
  },
}));

interface Row {
  label?: string;
  description?: string;
  contextValue?: string;
  file?: { path: string };
  worktree?: { branch: string };
  branch?: string;
  checkboxState?: number;
  command?: { command: string; arguments?: unknown[] };
}

describe('showing one patch in the changed files', () => {
  let fixture: Fixture;
  let provider: {
    getChildren(element?: Row): Promise<Row[]>;
    showPatchInTree(item: Row): Promise<void>;
    showWholeBranch(item: Row): void;
    dispose(): void;
  };

  const feature = async (): Promise<Row[]> => {
    const roots = await provider.getChildren();
    return provider.getChildren(roots.find((n) => n.worktree?.branch === 'feature'));
  };
  const files = (rows: Row[]): string[] =>
    rows.flatMap((r) => (r.file ? [r.file.path] : []));
  const patchRow = async (n: number): Promise<Row> => {
    const stack = (await feature()).find((r) => r.label === 'Stack');
    const branch = (await provider.getChildren(stack)).find((r) => r.branch === 'feature');
    const rows = await provider.getChildren(branch);
    const row = rows.find((r) => typeof r.label === 'string' && r.label.endsWith(`p${n}`));
    if (!row) throw new Error(`no p${n} row among ${rows.map((r) => r.label).join(', ')}`);
    return row;
  };

  beforeAll(async () => {
    fixture = makeFixture();
    host.repo = fixture.repo;
    const first = await revParse(fixture.feature, 'HEAD');
    write(fixture.feature, 'src/second.ts', 'export const second = 2;\n');
    git(fixture.feature, ['add', '.']);
    git(fixture.feature, ['commit', '-q', '-m', 'second']);
    const second = await revParse(fixture.feature, 'HEAD');
    const version = (n: number, sha: string, current: boolean) => ({
      version: n,
      sha,
      date: '2026-11-16T10:00:00-08:00',
      action: 'commit',
      subject: `p${n}`,
      shas: [sha],
      pushed: false,
      current,
      tip: true,
    });
    host.listing = {
      branch: 'feature',
      parent: 'main',
      versions: [version(2, second, true), version(1, first, false)],
    };
    host.compare = {
      branch: 'feature',
      parent: 'main',
      a: { label: 'p1', sha: first },
      b: { label: 'p2', sha: second },
      left_tree: `${first}^{tree}`,
      right_tree: `${second}^{tree}`,
      files: [{ status: 'A', path: 'src/second.ts', old_path: null }],
    };

    const { WorktreeProvider } = await import('../../src/worktreeProvider');
    const Provider = WorktreeProvider as unknown as new (...args: unknown[]) => typeof provider;
    const inert = new Proxy({}, { get: () => async () => undefined });
    const comments = new Proxy(
      {},
      { get: (_t, key) => (key.toString().startsWith('threads') ? () => [] : async () => undefined) },
    );
    const hidden = new Proxy(
      {},
      { get: (_t, key) => (key === 'list' ? () => [] : async () => undefined) },
    );
    provider = new Provider(comments, inert, inert, inert, inert, hidden);
  });

  afterAll(() => {
    provider.dispose();
    fixture.remove();
  });

  test('lists the whole branch until a patch is picked', async () => {
    expect(files(await feature())).toContain('src/app.ts');
    expect((await feature()).some((r) => r.contextValue === 'patchFocus')).toBe(false);
  });

  test('narrows the list to what the patch changed over the one before it', async () => {
    await provider.showPatchInTree(await patchRow(2));
    expect(host.compares.at(-1)).toEqual(['1', '2']);

    const rows = await feature();
    const banner = rows.find((r) => r.contextValue === 'patchFocus');
    expect(banner?.label).toBe('Showing p2 only');
    expect(banner?.description).toBe('feature · p1 → p2 · 1 file');
    expect(files(rows)).toEqual(['src/second.ts']);

    const file = rows.find((r) => r.file?.path === 'src/second.ts');
    expect(file?.checkboxState).toBeUndefined();
    expect(file?.contextValue).toBe('patchFile');
    const [left, right] = (file?.command?.arguments ?? []) as { query: string }[];
    const trees = host.compare as { left_tree: string; right_tree: string };
    expect(new URLSearchParams(left.query).get('ref')).toBe(trees.left_tree);
    expect(new URLSearchParams(right.query).get('ref')).toBe(trees.right_tree);

    expect((await patchRow(2)).description).toContain('in changed files');
    expect((await patchRow(1)).description).not.toContain('in changed files');
  });

  test('measures the first patch from its base', async () => {
    await provider.showPatchInTree(await patchRow(1));
    expect(host.compares.at(-1)).toEqual(['base', '1']);
  });

  test('the banner puts the whole branch back', async () => {
    const banner = (await feature()).find((r) => r.contextValue === 'patchFocus');
    expect(banner?.command?.command).toBe('worktreeReview.showWholeBranch');
    provider.showWholeBranch(banner as Row);
    const rows = await feature();
    expect(rows.some((r) => r.contextValue === 'patchFocus')).toBe(false);
    expect(files(rows)).toContain('src/app.ts');
  });
});
