import * as assert from 'node:assert';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'naterarmstrong.worktree-stack-reviewer';

const fixtureRoot = process.env.WT_FIXTURE ?? '';
const reviewWorktree = path.join(fixtureRoot, 'review');
const featureWorktree = path.join(fixtureRoot, 'feature');

const PREVIEW_VIEW_TYPE = 'worktreeReview.markdownPreview';

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function branchOf(worktreePath: string): string {
  return cp
    .execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
      encoding: 'utf8',
    })
    .trim();
}

suite('Worktree Stack Reviewer', () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
    await extension.activate();
    // The tree is built on demand, and the provider discovers worktrees while
    // building it — including which one is the review worktree. Nothing that
    // reads that state works until the view has been on screen.
    await vscode.commands.executeCommand(
      'workbench.view.extension.worktreeReview',
    );
    await vscode.commands.executeCommand('worktreeReview.refresh');
    await settle(3_000);
  });

  test('activates and registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    const ours = commands.filter((c) => c.startsWith('worktreeReview.'));
    assert.ok(ours.includes('worktreeReview.refresh'));
    assert.ok(ours.includes('worktreeReview.checkoutInReviewWorktree'));
    assert.ok(ours.includes('worktreeReview.resetReviewWorktree'));
    assert.ok(ours.includes('worktreeReview.nameWorktree'));
    assert.ok(ours.includes('worktreeReview.nameStack'));
  });

  test('exports the comments a worktree already carries', async () => {
    await vscode.commands.executeCommand('worktreeReview.copyAllComments');
    const payload = JSON.parse(await vscode.env.clipboard.readText()) as {
      worktrees: {
        branch: string;
        comments: {
          file: string;
          side: string;
          inDiff?: boolean;
          messages: { body: string }[];
        }[];
      }[];
    };
    const exported = payload.worktrees.flatMap((w) => w.comments);
    // Sorted by file, so the description sorts before the source file.
    assert.deepStrictEqual(
      exported.map((c) => c.file),
      ['PR-7.md', 'src/app.ts'],
    );
    const description = exported[0];
    assert.strictEqual(description.side, 'pr');
    assert.strictEqual(description.messages[0].body, 'seeded on the description');
    // Whether the diff touches a description is not a question with an answer.
    assert.ok(!('inDiff' in description));
    assert.strictEqual(
      exported[1].messages[0].body,
      'seeded by the fixture',
    );
  });

  /**
   * A pull request description is a virtual document — it is not a file in any
   * worktree — opened in the custom editor the review preview registers. What
   * that needs from VS Code is for a custom editor to accept a document served
   * by a content provider, which is what this checks. It uses the diff's base
   * side to do it, since the fixture repository has no pull requests: both
   * schemes reach the editor the same way.
   */
  test('opens a virtual markdown document in the review preview', async () => {
    const uri = vscode.Uri.from({
      scheme: 'wt-ext-git',
      path: '/docs/notes.md',
      query: new URLSearchParams({ wt: featureWorktree, ref: 'HEAD' }).toString(),
    });

    await vscode.commands.executeCommand('vscode.openWith', uri, PREVIEW_VIEW_TYPE);
    await settle(1_000);

    const tab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find(
        (t) =>
          t.input instanceof vscode.TabInputCustom &&
          t.input.viewType === PREVIEW_VIEW_TYPE,
      );
    assert.ok(tab, 'the review preview did not open');
    assert.strictEqual(
      (tab.input as vscode.TabInputCustom).uri.toString(),
      uri.toString(),
    );
  });

  /**
   * Following a link to another markdown file rests on two things only VS Code
   * can answer: that `openWith` takes the options that keep the tab from being
   * replaced by the next link, and that the engine stamps a heading with the
   * lowercased id a `#fragment` is looked up by.
   */
  test('a linked document opens in a permanent review preview tab', async () => {
    const uri = vscode.Uri.file(path.join(featureWorktree, 'docs', 'linked.md'));
    fs.writeFileSync(uri.fsPath, '# Linked\n');

    await vscode.commands.executeCommand('vscode.openWith', uri, PREVIEW_VIEW_TYPE, {
      preview: false,
    });
    await settle(1_000);

    const tab = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .find(
        (t) =>
          t.input instanceof vscode.TabInputCustom &&
          t.input.uri.toString() === uri.toString(),
      );
    assert.ok(tab, 'the linked document did not open in the review preview');
    assert.strictEqual(tab.isPreview, false);
    fs.rmSync(uri.fsPath);
  });

  test('renders a heading with the id a fragment resolves to', async () => {
    const html = await vscode.commands.executeCommand<string>(
      'markdown.api.render',
      '# Setup Guide\n',
    );

    assert.match(html, /id="setup-guide"/);
  });

  /**
   * The preview's typography defaults hold only if VS Code reports no chosen
   * value for the built-in preview's settings. `get` cannot say — it answers
   * with the built-in preview's own registered 14px whether or not anyone
   * asked for it — which is why the provider reads them with `inspect`.
   */
  test('an open left side follows a hidden change in and back out', async () => {
    const git = (args: string[], env: NodeJS.ProcessEnv = {}, input?: string): string =>
      cp
        .execFileSync('git', args, {
          cwd: featureWorktree,
          encoding: 'utf8',
          input,
          env: { ...process.env, ...env },
        })
        .trim();
    // The fixture has no origin, so the default base names nothing to diff from.
    const settings = vscode.workspace.getConfiguration('worktreeReview');
    await settings.update('fallbackBase', 'main', vscode.ConfigurationTarget.Workspace);
    await settle(3_000);

    const base = git(['merge-base', 'HEAD', 'main']);
    const index = { GIT_INDEX_FILE: path.join(fixtureRoot, 'hidden-index') };
    git(['read-tree', base], index);
    const blob = git(['hash-object', '-w', '--stdin'], {}, '// hidden\n');
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},src/app.ts`], index);
    const commit = git(['commit-tree', git(['write-tree'], index), '-p', base, '-m', 'Hide it']);

    const inbox = path.resolve(
      featureWorktree,
      git(['rev-parse', '--git-path', 'wt-review/resolutions.json']),
    );
    const post = async (entry: object): Promise<void> => {
      fs.writeFileSync(inbox, JSON.stringify([entry]));
      await settle(3_000);
    };
    await post({ kind: 'hiddenChange', commit, branch: 'feature' });

    const left = vscode.Uri.from({
      scheme: 'wt-ext-git',
      path: '/src/app.ts',
      query: new URLSearchParams({ wt: featureWorktree, ref: 'refs/wt-review/view/feature' }).toString(),
    });
    const doc = await vscode.workspace.openTextDocument(left);
    assert.strictEqual(doc.getText(), '// hidden\n');

    await post({ kind: 'hiddenChange', commit, branch: 'feature', action: 'remove' });
    assert.ok(doc.getText().includes('export const name'), `left side still reads ${doc.getText()}`);
    await settings.update('fallbackBase', undefined, vscode.ConfigurationTarget.Workspace);
  });

  test('reports no chosen value for a built-in preview setting', () => {
    const config = vscode.workspace.getConfiguration('markdown.preview');

    assert.strictEqual(config.get('fontSize'), 14);
    const inspected = config.inspect('fontSize');
    assert.strictEqual(inspected?.globalValue, undefined);
    assert.strictEqual(inspected?.workspaceValue, undefined);
  });

  /**
   * VS Code refuses to open modal dialogs while tests are running and rejects
   * the call instead, so a flow that confirms first can be driven up to its
   * confirmation and no further. What this checks is that the confirmation is
   * asked, that it names the branches involved, and that declining it leaves
   * the worktree where it was. Performing the switch is covered by the unit
   * tier, against the same git commands.
   */
  test('the review worktree reset asks before moving anything', async () => {
    assert.strictEqual(branchOf(reviewWorktree), 'scratch');
    await assert.rejects(
      async () =>
        vscode.commands.executeCommand('worktreeReview.resetReviewWorktree'),
      /Reset the review worktree from "scratch" to "review"/,
    );
    assert.strictEqual(branchOf(reviewWorktree), 'scratch');
  });
});
