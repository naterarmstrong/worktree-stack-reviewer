import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { revParse } from '../../src/git';
import { type Fixture, git, makeFixture, write } from '../fixtures/repo';

// The provider builds tree items and reads the view's settings, which the
// shared stub leaves out because no other unit test needs them.
const host = vi.hoisted(() => ({ repo: '' }));
vi.mock('vscode', async (original) => {
  const vscode = await original<typeof import('vscode')>();
  class Item {}
  return {
    ...vscode,
    TreeItem: Item,
    ThemeIcon: Item,
    ThemeColor: Item,
    MarkdownString: Item,
    commands: { executeCommand: async () => undefined },
    TreeItemCheckboxState: { Unchecked: 0, Checked: 1 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    EventEmitter: class {
      event = (): void => {};
      fire = (): void => {};
      dispose = (): void => {};
    },
    workspace: {
      get workspaceFolders() {
        return [{ uri: { fsPath: host.repo } }];
      },
      getConfiguration: () => ({
        get: <T>(key: string, fallback?: T): unknown =>
          ({ fallbackBase: 'main', layout: 'flat', showPullRequests: false, useStackParent: false })[key] ??
          fallback,
      }),
    },
  };
});

describe('changed files after the base moves', () => {
  let fixture: Fixture;
  let provider: {
    getChildren(): Promise<{ worktree: { branch: string } }[]>;
    getFileNodes(node: unknown): Promise<unknown[]>;
    dispose(): void;
  };

  const filesOnFeature = async (): Promise<string[]> => {
    const nodes = await provider.getChildren();
    const node = nodes.find((n) => n.worktree.branch === 'feature');
    const rows = (await provider.getFileNodes(node)) as { file?: { path: string } }[];
    return rows.map((r) => r.file?.path ?? '');
  };

  beforeAll(async () => {
    fixture = makeFixture();
    host.repo = fixture.repo;
    const { WorktreeProvider } = await import('../../src/worktreeProvider');
    const Provider = WorktreeProvider as unknown as new (...args: unknown[]) => typeof provider;
    // Collaborators the file list doesn't read: every method is a no-op.
    const inert = new Proxy({}, { get: () => async () => undefined });
    provider = new Provider(inert, inert, inert, inert, inert);
  });

  afterAll(() => {
    provider.dispose();
    fixture.remove();
  });

  test('drops the cached list when trunk catches up to what HEAD sits on', async () => {
    // A branch rebased onto a newer trunk than the local `main`, as a review
    // checkout of a remote branch leaves it.
    write(fixture.repo, 'src/upstream.ts', 'export const upstream = 1;\n');
    git(fixture.repo, ['add', '.']);
    git(fixture.repo, ['commit', '-q', '-m', 'upstream']);
    const upstream = await revParse(fixture.repo, 'HEAD');
    git(fixture.repo, ['reset', '-q', '--hard', 'HEAD~1']);
    git(fixture.feature, ['rebase', '-q', upstream]);

    const stale = await filesOnFeature();
    expect(stale.join()).toContain('upstream.ts');

    // `gt sync` fast-forwards trunk. No worktree's HEAD sha changes except
    // the one on `main`, which is not the one being read.
    git(fixture.repo, ['merge', '-q', '--ff-only', upstream]);

    expect((await filesOnFeature()).join()).not.toContain('upstream.ts');
  });
});
