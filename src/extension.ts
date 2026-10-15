import * as vscode from 'vscode';
import { ReviewCommentController } from './commentController';
import { COMPARE_LINK_PATH, parseCompareLink } from './compareLink';
import { stopCore } from './core';
import { GIT_SCHEME, GitContentProvider } from './gitContentProvider';
import { initLog, log } from './log';
import { PR_BODY_SCHEME, PrBodyContentProvider } from './prBody';
import { asPreviewSelectionContext } from './previewComment';
import {
  PREVIEW_EDITOR_VIEW_TYPE,
  ReviewPreviewEditorProvider,
} from './previewEditor';
import { type OpenDiffArgs, WorktreeProvider } from './worktreeProvider';

export function activate(context: vscode.ExtensionContext): void {
  const logger = initLog(context);
  const version = String(context.extension.packageJSON.version);
  logger.info(`Worktree Stack Reviewer v${version} activating…`);

  const gitProvider = new GitContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, gitProvider),
  );

  const repoPath =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const comments = new ReviewCommentController(repoPath, context.extensionUri);
  context.subscriptions.push(comments);
  void comments.ready();

  const prBodies = new PrBodyContentProvider(repoPath);
  context.subscriptions.push(
    prBodies,
    vscode.workspace.registerTextDocumentContentProvider(PR_BODY_SCHEME, prBodies),
  );

  const previewEditor = new ReviewPreviewEditorProvider(
    context.extensionUri,
    comments,
    prBodies,
  );
  context.subscriptions.push(previewEditor);

  const worktreeProvider = new WorktreeProvider(comments, prBodies, previewEditor);
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        const link = parseCompareLink(uri);
        if (!link) {
          void vscode.window.showWarningMessage(
            `Worktree Stack Reviewer: unrecognised link ${uri.toString()}. Expected ${COMPARE_LINK_PATH}?branch=…&a=…&b=…`,
          );
          return;
        }
        void worktreeProvider.openCompareLink(link);
      },
    }),
  );
  context.subscriptions.push(worktreeProvider);
  context.subscriptions.push(comments.onDidChange(() => worktreeProvider.refresh()));

  registerCommentCommands(context, comments, worktreeProvider, previewEditor);

  const view = vscode.window.createTreeView('worktreeReview.changes', {
    treeDataProvider: worktreeProvider,
    showCollapseAll: true,
    // The viewed store is the only source of truth for a tick. Letting VS Code
    // track checkbox state as well would leave two copies to disagree after a
    // refresh recomputes patch ids.
    manageCheckboxStateManually: true,
  });
  context.subscriptions.push(view);
  context.subscriptions.push(
    view.onDidChangeCheckboxState((e) => worktreeProvider.setViewed(e.items)),
    view.onDidExpandElement((e) => worktreeProvider.setBranchExpanded(e.element, true)),
    view.onDidCollapseElement((e) =>
      worktreeProvider.setBranchExpanded(e.element, false),
    ),
  );
  syncToggleState(view);

  const setIncludeUncommitted = async (next: boolean): Promise<void> => {
    const config = vscode.workspace.getConfiguration('worktreeReview');
    await config.update(
      'includeUncommitted',
      next,
      vscode.ConfigurationTarget.Workspace,
    );
    log().info(`includeUncommitted → ${next}`);
  };

  const setHideViewed = async (next: boolean): Promise<void> => {
    const config = vscode.workspace.getConfiguration('worktreeReview');
    await config.update('hideViewed', next, vscode.ConfigurationTarget.Workspace);
    log().info(`hideViewed → ${next}`);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('worktreeReview.refresh', () => {
      log().info('refresh requested');
      gitProvider.invalidate();
      void comments.invalidate();
      worktreeProvider.invalidate();
    }),
    vscode.commands.registerCommand('worktreeReview.openDiff', (item) => {
      log().info(`openDiff invoked: ${formatOpenDiffArg(item)}`);
      return worktreeProvider.openDiff(item);
    }),
    vscode.commands.registerCommand('worktreeReview.openFile', (item) =>
      worktreeProvider.openFile(item),
    ),
    vscode.commands.registerCommand('worktreeReview.revealWorktree', (item) => {
      // Taken from the node rather than its `resourceUri`, which names a path
      // chosen to sit outside any repository and so cannot be revealed.
      const worktreePath = worktreeProvider.worktreePathFor(item);
      if (worktreePath) {
        void vscode.commands.executeCommand(
          'revealInExplorer',
          vscode.Uri.file(worktreePath),
        );
      }
    }),
    vscode.commands.registerCommand('worktreeReview.checkoutPrBranch', (item) =>
      worktreeProvider.checkoutPrBranch(item),
    ),
    vscode.commands.registerCommand(
      'worktreeReview.checkoutInReviewWorktree',
      (item) => worktreeProvider.checkoutInReviewWorktree(item),
    ),
    vscode.commands.registerCommand('worktreeReview.resetReviewWorktree', () =>
      worktreeProvider.resetReviewWorktree(),
    ),
    vscode.commands.registerCommand('worktreeReview.nameWorktree', (item) =>
      worktreeProvider.nameWorktree(item),
    ),
    vscode.commands.registerCommand('worktreeReview.nameStack', (item) =>
      worktreeProvider.nameStack(item),
    ),
    vscode.commands.registerCommand('worktreeReview.openPrInBrowser', (item) =>
      worktreeProvider.openPrInBrowser(item),
    ),
    vscode.commands.registerCommand('worktreeReview.copyPrUrl', (item) =>
      worktreeProvider.copyPrUrl(item),
    ),
    vscode.commands.registerCommand('worktreeReview.openPrBody', (item) =>
      worktreeProvider.openPrBody(item),
    ),
    vscode.commands.registerCommand('worktreeReview.reviewPr', (item) =>
      worktreeProvider.reviewPr(item),
    ),
    vscode.commands.registerCommand(
      'worktreeReview.compareVersionWithPrevious',
      (item) => worktreeProvider.compareWithPrevious(item),
    ),
    vscode.commands.registerCommand(
      'worktreeReview.compareVersionWithBase',
      (item) => worktreeProvider.compareWithBase(item),
    ),
    vscode.commands.registerCommand('worktreeReview.compareVersionWith', (item) =>
      worktreeProvider.compareWithPicked(item),
    ),
    vscode.commands.registerCommand(
      'worktreeReview.compareBranchVersions',
      (item) => worktreeProvider.compareBranchVersions(item),
    ),
    vscode.commands.registerCommand('worktreeReview.toggleLayout', async () => {
      const config = vscode.workspace.getConfiguration('worktreeReview');
      const current = config.get<string>('layout', 'tree');
      const next = current === 'tree' ? 'flat' : 'tree';
      await config.update('layout', next, vscode.ConfigurationTarget.Workspace);
      log().info(`layout: ${current} → ${next}`);
    }),
    vscode.commands.registerCommand('worktreeReview.hideUncommitted', () =>
      setIncludeUncommitted(false),
    ),
    vscode.commands.registerCommand('worktreeReview.showUncommitted', () =>
      setIncludeUncommitted(true),
    ),
    vscode.commands.registerCommand('worktreeReview.hideViewedFiles', () =>
      setHideViewed(true),
    ),
    vscode.commands.registerCommand('worktreeReview.showViewedFiles', () =>
      setHideViewed(false),
    ),
    vscode.commands.registerCommand('worktreeReview.markAllViewed', (item) =>
      worktreeProvider.markAllViewed(item, true),
    ),
    vscode.commands.registerCommand('worktreeReview.markAllUnviewed', (item) =>
      worktreeProvider.markAllViewed(item, false),
    ),
    vscode.commands.registerCommand('worktreeReview.resetViewed', async (item) => {
      const worktreePath = worktreeProvider.worktreePathFor(item);
      if (!worktreePath) return;
      const branch = worktreeProvider.branchFor(worktreePath);
      const confirmed = await vscode.window.showWarningMessage(
        `Clear viewed marks on "${branch ?? worktreePath}"?`,
        {
          modal: true,
          detail: 'Every file on this branch goes back to unviewed.',
        },
        'Clear',
      );
      if (confirmed !== 'Clear') return;
      const cleared = await worktreeProvider.resetViewed(worktreePath);
      void vscode.window.showInformationMessage(
        cleared === 0 ? 'Nothing was marked viewed.' : `Cleared ${cleared} file(s).`,
      );
    }),
    vscode.commands.registerCommand('worktreeReview.showLogs', () => {
      log().show(true);
    }),
    vscode.commands.registerCommand('worktreeReview.diagnostics', async () => {
      const all = await vscode.commands.getCommands(true);
      const ours = all.filter((c) => c.startsWith('worktreeReview.')).sort();
      log().info(`Diagnostics: Worktree Stack Reviewer v${version}`);
      log().info(`Registered commands (${ours.length}): ${ours.join(', ')}`);
      log().show(true);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('worktreeReview')) {
        log().info('config changed; invalidating cache and refreshing');
        syncToggleState(view);
        gitProvider.invalidate();
        worktreeProvider.invalidate();
      }
    }),
  );

  log().info('Commands registered.');
  log().info(`Worktree Stack Reviewer v${version} ready.`);
}

export function deactivate(): void {
  stopCore();
}

/**
 * Mirrors the two view toggles into context keys so the title bar can swap
 * between each pair of commands — VS Code renders view actions as icons only,
 * so the current state has to be carried by which icon is showing plus the
 * view's description.
 */
function syncToggleState(view: vscode.TreeView<unknown>): void {
  const config = vscode.workspace.getConfiguration('worktreeReview');
  const includeUncommitted = config.get<boolean>('includeUncommitted', true);
  const hideViewed = config.get<boolean>('hideViewed', false);
  void vscode.commands.executeCommand(
    'setContext',
    'worktreeReview.includeUncommitted',
    includeUncommitted,
  );
  void vscode.commands.executeCommand(
    'setContext',
    'worktreeReview.hideViewed',
    hideViewed,
  );
  const bits = [includeUncommitted ? 'working tree' : 'committed only'];
  if (hideViewed) bits.push('hiding viewed');
  view.description = bits.join(' · ');
}

function registerCommentCommands(
  context: vscode.ExtensionContext,
  comments: ReviewCommentController,
  provider: WorktreeProvider,
  previewEditor: ReviewPreviewEditorProvider,
): void {
  const resolveWorktree = async (item: unknown): Promise<string | undefined> => {
    const fromItem = provider.worktreePathFor(item);
    if (fromItem) return fromItem;
    const paths = await provider.worktreePaths();
    if (paths.length === 0) return undefined;
    if (paths.length === 1) return paths[0];
    return vscode.window.showQuickPick(paths, {
      title: 'Which worktree?',
      placeHolder: 'Select a worktree',
    });
  };

  const copy = async (payload: unknown, label: string): Promise<void> => {
    await vscode.env.clipboard.writeText(JSON.stringify(payload, null, 2));
    void vscode.window.showInformationMessage(`Copied ${label} to clipboard.`);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('worktreeReview.createComment', (reply) =>
      comments.createComment(reply),
    ),
    vscode.commands.registerCommand('worktreeReview.addCommentFromPreview', (ctx) => {
      const parsed = asPreviewSelectionContext(ctx);
      if (!parsed) {
        log().warn('addCommentFromPreview: unexpected webview context shape');
        return;
      }
      return previewEditor.openWithComposer(vscode.Uri.parse(parsed.resource), parsed);
    }),
    vscode.commands.registerCommand(
      'worktreeReview.openPreviewEditor',
      (uri?: vscode.Uri) => {
        const target = uri ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) return;
        return vscode.commands.executeCommand(
          'vscode.openWith',
          target,
          PREVIEW_EDITOR_VIEW_TYPE,
          vscode.ViewColumn.Beside,
        );
      },
    ),
    vscode.commands.registerCommand('worktreeReview.replyComment', (reply) =>
      comments.createComment(reply),
    ),
    vscode.commands.registerCommand('worktreeReview.editComment', (c) =>
      comments.editComment(c),
    ),
    vscode.commands.registerCommand('worktreeReview.saveComment', (c) =>
      comments.saveComment(c),
    ),
    vscode.commands.registerCommand('worktreeReview.cancelEdit', (c) =>
      comments.cancelEdit(c),
    ),
    vscode.commands.registerCommand('worktreeReview.deleteComment', (c) =>
      comments.deleteComment(c),
    ),
    vscode.commands.registerCommand('worktreeReview.deleteThread', (t) =>
      comments.deleteThread(t),
    ),
    vscode.commands.registerCommand('worktreeReview.toggleResolved', (t) =>
      comments.toggleResolved(t),
    ),
    vscode.commands.registerCommand('worktreeReview.revealComment', (item) =>
      provider.revealComment(item),
    ),
    vscode.commands.registerCommand('worktreeReview.copyComments', async (item) => {
      const worktreePath = await resolveWorktree(item);
      if (!worktreePath) return;
      const meta = await provider.exportMeta(worktreePath);
      const payload = comments.buildExport(worktreePath, meta);
      if (payload.comments.length === 0) {
        void vscode.window.showInformationMessage('No comments in this worktree.');
        return;
      }
      await copy(payload, `${payload.comments.length} comment(s)`);
    }),
    vscode.commands.registerCommand('worktreeReview.copyAllComments', async () => {
      const paths = await provider.worktreePaths();
      const payloads = [];
      for (const worktreePath of paths) {
        const meta = await provider.exportMeta(worktreePath);
        const payload = comments.buildExport(worktreePath, meta);
        if (payload.comments.length > 0) payloads.push(payload);
      }
      if (payloads.length === 0) {
        void vscode.window.showInformationMessage('No comments in any worktree.');
        return;
      }
      const total = payloads.reduce((n, p) => n + p.comments.length, 0);
      await copy({ worktrees: payloads }, `${total} comment(s) across ${payloads.length} worktree(s)`);
    }),
    vscode.commands.registerCommand('worktreeReview.openCommentsFile', async (item) => {
      const worktreePath = await resolveWorktree(item);
      if (!worktreePath) return;
      // A branch reviewed across two worktrees has its comments split between
      // their files, so open every one that holds this branch's comments.
      let opened = 0;
      for (const storePath of comments.storePathsFor(worktreePath)) {
        try {
          const doc = await vscode.workspace.openTextDocument(
            vscode.Uri.file(storePath),
          );
          await vscode.window.showTextDocument(doc, { preview: false });
          opened += 1;
        } catch {
          // File not written yet; reported below if nothing opened.
        }
      }
      if (opened === 0) {
        void vscode.window.showInformationMessage(
          `No comments file yet — created at ${comments.storePath(worktreePath)} on the first comment.`,
        );
      }
    }),
    vscode.commands.registerCommand('worktreeReview.copyCommentsPath', async (item) => {
      const worktreePath = await resolveWorktree(item);
      if (!worktreePath) return;
      const paths = comments.storePathsFor(worktreePath);
      await vscode.env.clipboard.writeText(paths.join('\n'));
      void vscode.window.showInformationMessage(
        paths.length === 1
          ? 'Copied comments file path.'
          : `Copied ${paths.length} comments file paths.`,
      );
    }),
    vscode.commands.registerCommand('worktreeReview.clearComments', async (item) => {
      const worktreePath = await resolveWorktree(item);
      if (!worktreePath) return;
      const branch = comments.branchFor(worktreePath);
      const { total } = comments.countFor(worktreePath);
      if (total === 0 || !branch) {
        void vscode.window.showInformationMessage('No comments to clear.');
        return;
      }
      const confirmed = await vscode.window.showWarningMessage(
        `Delete all ${total} comment(s) on "${branch}"?`,
        {
          modal: true,
          detail: 'They are deleted outright, not archived. This cannot be undone.',
        },
        'Delete',
      );
      if (confirmed !== 'Delete') return;
      const removed = await comments.clearBranch(worktreePath);
      void vscode.window.showInformationMessage(`Deleted ${removed} comment(s).`);
    }),
    vscode.commands.registerCommand('worktreeReview.applyResolutions', async () => {
      await comments.applyPendingResolutions();
    }),
    vscode.commands.registerCommand('worktreeReview.copyInboxPath', async (item) => {
      const worktreePath = await resolveWorktree(item);
      if (!worktreePath) return;
      await vscode.env.clipboard.writeText(comments.inboxPath(worktreePath));
      void vscode.window.showInformationMessage('Copied resolutions inbox path.');
    }),
    vscode.commands.registerCommand('worktreeReview.pruneComments', async () => {
      const { archived, branches } = await comments.prune();
      void vscode.window.showInformationMessage(
        archived === 0
          ? 'No comments on branches that have gone away.'
          : `Archived ${archived} comment(s) from ${branches.length} gone branch(es): ${branches.join(', ')}.`,
      );
    }),
  );

  schedulePrune(context, comments, provider);
}

const HOURS_TO_MS = 60 * 60 * 1000;

/**
 * Prunes at startup and then on an interval. Branches disappear between
 * sessions far more often than during one, so the startup pass does most of the
 * work; the timer covers long-lived windows.
 */
function schedulePrune(
  context: vscode.ExtensionContext,
  comments: ReviewCommentController,
  provider: WorktreeProvider,
): void {
  let timer: NodeJS.Timeout | undefined;

  const pruneAll = async (): Promise<void> => {
    await comments.prune();
    await provider.pruneViewed();
  };

  const apply = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
    const hours = vscode.workspace
      .getConfiguration('worktreeReview')
      .get<number>('pruneIntervalHours', 6);
    if (hours <= 0) {
      log().info('comments: periodic prune disabled');
      return;
    }
    timer = setInterval(() => void pruneAll(), hours * HOURS_TO_MS);
    log().info(`comments: pruning every ${hours}h`);
  };

  void pruneAll();
  apply();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('worktreeReview.pruneIntervalHours')) apply();
    }),
    new vscode.Disposable(() => {
      if (timer) clearInterval(timer);
    }),
  );
}

function formatOpenDiffArg(item: unknown): string {
  if (!item || typeof item !== 'object') return `<non-object: ${String(item)}>`;
  const a = item as Partial<OpenDiffArgs>;
  if (a.file && a.worktreePath && a.base) {
    return `${a.file.status} ${a.file.path} in ${a.worktreePath} vs ${a.base}`;
  }
  return `<unexpected shape: ${JSON.stringify(item).slice(0, 200)}>`;
}
