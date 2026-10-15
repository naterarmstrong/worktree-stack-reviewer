import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ReviewCommentController } from './commentController';
import { GIT_SCHEME, parseGitUri } from './gitContentProvider';
import { describeError, log } from './log';
import { submitPrReview } from './gh';
import { type PrBodyContentProvider, parsePrBodyUri } from './prBody';
import {
  type EditorSelection,
  type ReviewVerdict,
  asWebviewToEditorMessage,
} from './previewProtocol';

export const PREVIEW_EDITOR_VIEW_TYPE = 'worktreeReview.markdownPreview';

/** Document edits are frequent while typing; re-render at most this often. */
const RENDER_DEBOUNCE_MS = 250;

/**
 * Typography for the page, used unless the built-in preview's own settings
 * have been set. These are GitHub's numbers for rendered markdown, which is
 * what a PR description is written against and read on.
 */
const DEFAULT_FONT_SIZE = 16;
const DEFAULT_LINE_HEIGHT = 1.5;

/** Fallback for the setting, in pixels; also GitHub's rough body width. */
const DEFAULT_COLUMN_WIDTH = 900;

/**
 * A markdown preview that review comments can be written in.
 *
 * The built-in preview cannot host this: its webview belongs to the built-in
 * markdown extension, which exposes no way for another extension to receive
 * messages from UI injected into it — the only inbound channel it offers is a
 * context-menu click. So this is a second preview, owned by this extension,
 * that renders through the same engine (the `markdown.api.render` command,
 * complete with the `data-line` source map and every contributed markdown-it
 * plugin) and styles the result with the built-in preview's own stylesheets.
 * Inside it, selection, composer, threads, replies, and resolution are all
 * ordinary webview UI.
 */
export class ReviewPreviewEditorProvider
  implements vscode.CustomTextEditorProvider, vscode.Disposable
{
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly pendingComposer = new Map<string, EditorSelection>();
  /** Thread to bring into view once a freshly opened panel is ready. */
  private readonly pendingReveal = new Map<string, string>();
  /** Review dialogs to open once a freshly opened panel is ready. */
  private readonly pendingReview = new Map<string, ReviewDialog>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly comments: ReviewCommentController,
    private readonly prBodies: PrBodyContentProvider,
  ) {
    this.disposables.push(
      vscode.window.registerCustomEditorProvider(PREVIEW_EDITOR_VIEW_TYPE, this, {
        // Keeps an unsent draft alive when the tab is moved to the background.
        webviewOptions: { retainContextWhenHidden: true },
      }),
      this.comments.onDidChange(() => {
        for (const [key, panel] of this.panels) {
          this.pushThreads(vscode.Uri.parse(key), panel);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          !e.affectsConfiguration('markdown.preview') &&
          !e.affectsConfiguration('worktreeReview.previewColumnWidth')
        ) {
          return;
        }
        this.restyle();
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  /**
   * Rebuilds each open page so a typography setting takes effect where it can
   * be seen. The webview reloads, then asks for its content again on `ready`;
   * an unsent draft survives because it is held in webview state rather than
   * in the DOM.
   */
  private restyle(): void {
    for (const [key, panel] of this.panels) {
      const document = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === key,
      );
      if (!document) continue;
      panel.webview.html = this.buildHtml(panel.webview, document);
    }
  }

  /**
   * Opens (or reveals) the review preview for a file, with the comment
   * composer already sitting at `selection`. This is where the context-menu
   * command in the built-in preview lands.
   */
  async openWithComposer(
    resource: vscode.Uri,
    selection: EditorSelection,
  ): Promise<void> {
    const key = resource.toString();
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal(undefined, false);
      void existing.webview.postMessage({ type: 'openComposer', ...selection });
      return;
    }
    // Delivered on the webview's `ready`, which a fresh panel has yet to send.
    this.pendingComposer.set(key, selection);
    await vscode.commands.executeCommand(
      'vscode.openWith',
      resource,
      PREVIEW_EDITOR_VIEW_TYPE,
      vscode.ViewColumn.Beside,
    );
  }

  /**
   * Opens (or reveals) the review preview for a document with one thread
   * scrolled into view — where a click on a thread row in the tree lands for a
   * document that has no source editor to open, such as a PR description.
   */
  async openAtThread(resource: vscode.Uri, threadId: string): Promise<void> {
    const key = resource.toString();
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal(undefined, false);
      void existing.webview.postMessage({ type: 'revealThread', threadId });
      return;
    }
    // Delivered on the webview's `ready`, which a fresh panel has yet to send.
    this.pendingReveal.set(key, threadId);
    await vscode.commands.executeCommand(
      'vscode.openWith',
      resource,
      PREVIEW_EDITOR_VIEW_TYPE,
    );
  }

  /**
   * Opens (or reveals) a PR description's preview with the review dialog
   * showing over it — where the tree's and the title bar's review action land.
   * The description and its conversation stay readable behind the dialog.
   */
  async openReviewDialog(resource: vscode.Uri, title?: string): Promise<void> {
    const pr = parsePrBodyUri(resource);
    if (!pr) return;
    const dialog: ReviewDialog = { type: 'openReview', number: pr.number, title };
    const key = resource.toString();
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal(undefined, false);
      void existing.webview.postMessage(dialog);
      return;
    }
    // Delivered on the webview's `ready`, which a fresh panel has yet to send.
    this.pendingReview.set(key, dialog);
    await vscode.commands.executeCommand(
      'vscode.openWith',
      resource,
      PREVIEW_EDITOR_VIEW_TYPE,
    );
  }

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const key = document.uri.toString();
    this.panels.set(key, panel);

    const root = documentRoot(document.uri);
    const roots = [
      vscode.Uri.joinPath(this.extensionUri, 'media'),
      ...(root ? [vscode.Uri.file(root)] : []),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
    ];
    const builtin = builtinMarkdownExtensionUri();
    if (builtin) roots.push(builtin);
    panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    panel.webview.html = this.buildHtml(panel.webview, document);

    let renderTimer: NodeJS.Timeout | undefined;
    const subscriptions = [
      panel.webview.onDidReceiveMessage((raw) => {
        void this.onMessage(document, panel, raw);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== key) return;
        if (renderTimer) clearTimeout(renderTimer);
        renderTimer = setTimeout(() => {
          void this.pushRender(document, panel);
        }, RENDER_DEBOUNCE_MS);
      }),
    ];
    panel.onDidDispose(() => {
      if (renderTimer) clearTimeout(renderTimer);
      for (const s of subscriptions) s.dispose();
      if (this.panels.get(key) === panel) this.panels.delete(key);
    });
  }

  private async onMessage(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    raw: unknown,
  ): Promise<void> {
    const msg = asWebviewToEditorMessage(raw);
    if (!msg) {
      log().warn(
        `preview editor: dropped malformed message: ${JSON.stringify(raw).slice(0, 200)}`,
      );
      return;
    }
    switch (msg.type) {
      case 'ready': {
        await this.pushRender(document, panel);
        this.pushThreads(document.uri, panel);
        const key = document.uri.toString();
        const pending = this.pendingComposer.get(key);
        if (pending) {
          this.pendingComposer.delete(key);
          void panel.webview.postMessage({ type: 'openComposer', ...pending });
        }
        const reveal = this.pendingReveal.get(key);
        if (reveal) {
          this.pendingReveal.delete(key);
          void panel.webview.postMessage({ type: 'revealThread', threadId: reveal });
        }
        const review = this.pendingReview.get(key);
        if (review) {
          this.pendingReview.delete(key);
          void panel.webview.postMessage(review);
        }
        return;
      }
      case 'submitReview':
        await this.submitReview(document, panel, msg.verdict, msg.body);
        return;
      case 'createThread':
        await this.comments.createThreadFromPreview(document.uri, msg, msg.body);
        return;
      case 'reply':
        await this.comments.replyToThread(msg.threadId, msg.body);
        return;
      case 'setResolved':
        await this.comments.setThreadResolved(msg.threadId, msg.resolved);
        return;
      case 'openSource': {
        const line = Math.min(msg.line ?? 0, Math.max(0, document.lineCount - 1));
        const selection = new vscode.Range(line, 0, line, 0);
        await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.Beside,
          selection,
        });
        return;
      }
      case 'openLink':
        await this.openLink(document, msg.href);
        return;
    }
  }

  /**
   * Posts a review from the dialog and tells the dialog how it went: it closes
   * on success and keeps the draft, with GitHub's reason shown, on failure.
   * The description's conversation is re-read so the review appears in it.
   */
  private async submitReview(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    verdict: ReviewVerdict,
    body: string,
  ): Promise<void> {
    const pr = parsePrBodyUri(document.uri);
    if (!pr) {
      void panel.webview.postMessage({
        type: 'reviewResult',
        ok: false,
        error: 'Only a pull request description can be reviewed.',
      });
      return;
    }
    try {
      await submitPrReview(pr.worktreePath, pr.number, verdict, body.trim());
    } catch (err) {
      log().error(`gh pr review #${pr.number} failed: ${describeError(err)}`);
      void panel.webview.postMessage({
        type: 'reviewResult',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    void panel.webview.postMessage({ type: 'reviewResult', ok: true });
    const done: Record<ReviewVerdict, string> = {
      approve: 'Approved',
      comment: 'Commented on',
      'request-changes': 'Requested changes on',
    };
    void vscode.window.showInformationMessage(`${done[verdict]} #${pr.number}.`);
    void this.prBodies.refresh(pr.number);
  }

  private async openLink(
    document: vscode.TextDocument,
    href: string,
  ): Promise<void> {
    let uri: vscode.Uri | undefined;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      try {
        uri = vscode.Uri.parse(href, true);
      } catch {
        uri = undefined;
      }
    } else {
      const dir = documentRoot(document.uri);
      uri = dir ? vscode.Uri.file(path.resolve(dir, href)) : undefined;
    }
    if (!uri) return;
    if (uri.scheme === 'http' || uri.scheme === 'https' || uri.scheme === 'mailto') {
      await vscode.env.openExternal(uri);
      return;
    }
    if (uri.scheme === 'file') {
      await vscode.commands.executeCommand('vscode.open', uri);
    }
  }

  private async pushRender(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    const html = await renderMarkdown(document);
    void panel.webview.postMessage({
      type: 'render',
      html,
      lineCount: document.lineCount,
    });
  }

  private pushThreads(resource: vscode.Uri, panel: vscode.WebviewPanel): void {
    void panel.webview.postMessage({
      type: 'threads',
      threads: this.comments.threadsForDocument(resource),
    });
  }

  private buildHtml(webview: vscode.Webview, document: vscode.TextDocument): string {
    const nonce = makeNonce();
    const mediaUri = (file: string): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
    const styles = [mediaUri('preview-editor.css')];
    const builtin = builtinMarkdownExtensionUri();
    if (builtin) {
      // The built-in preview's own typography and code-highlighting styles, so
      // the two previews read identically and track the user's VS Code version.
      styles.unshift(
        webview.asWebviewUri(vscode.Uri.joinPath(builtin, 'media', 'markdown.css')),
        webview.asWebviewUri(vscode.Uri.joinPath(builtin, 'media', 'highlight.css')),
      );
    }
    // Relative image and link paths in the document resolve against its
    // directory, through the webview resource scheme.
    const root = documentRoot(document.uri);
    const base = root
      ? webview.asWebviewUri(vscode.Uri.file(root)).toString()
      : undefined;
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    const config = vscode.workspace.getConfiguration('markdown.preview', document.uri);
    const bodyStyle = previewBodyStyle({
      fontFamily: config.get<string>('fontFamily', ''),
      fontSize: settingIfSet<number>(config, 'fontSize'),
      lineHeight: settingIfSet<number>(config, 'lineHeight'),
      columnWidth: vscode.workspace
        .getConfiguration('worktreeReview')
        .get<number>('previewColumnWidth', DEFAULT_COLUMN_WIDTH),
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  ${base ? `<base href="${base}/">` : ''}
  ${styles.map((s) => `<link rel="stylesheet" href="${s.toString()}">`).join('\n  ')}
</head>
<body class="markdown-body" style="${bodyStyle}">
  <div id="wt-content"></div>
  <script nonce="${nonce}" src="${mediaUri('preview-editor.js').toString()}"></script>
</body>
</html>`;
  }
}

/** The message that opens the review dialog over a PR description. */
interface ReviewDialog {
  type: 'openReview';
  number: number;
  title?: string;
}

/** What the page's typography is built from; see `previewBodyStyle`. */
export interface PreviewTypography {
  fontFamily: string;
  /** Only when the user set it; the GitHub-matching default applies otherwise. */
  fontSize?: number;
  /** Only when the user set it; see `fontSize`. */
  lineHeight?: number;
  /** Reading column width in pixels; 0 lets the page run full width. */
  columnWidth: number;
}

/**
 * The custom properties the page's stylesheets read, as an inline style for
 * `body`. The built-in preview's own settings win where they have been set,
 * and the defaults otherwise match how GitHub renders markdown.
 */
export function previewBodyStyle(typography: PreviewTypography): string {
  const rules = [
    `--markdown-font-family: ${typography.fontFamily};`,
    `--markdown-font-size: ${typography.fontSize ?? DEFAULT_FONT_SIZE}px;`,
    `--markdown-line-height: ${typography.lineHeight ?? DEFAULT_LINE_HEIGHT};`,
  ];
  if (typography.columnWidth > 0) {
    rules.push(`--wt-column-width: ${typography.columnWidth}px;`);
  }
  return rules.join('');
}

/**
 * A `markdown.preview` setting the user has actually chosen. `get` cannot
 * answer this: VS Code registers defaults for these settings, so it reports
 * the built-in preview's own 14px whether or not anyone asked for it.
 */
function settingIfSet<T>(
  config: vscode.WorkspaceConfiguration,
  key: string,
): T | undefined {
  const inspected = config.inspect<T>(key);
  return (
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue
  );
}

/**
 * The directory a document's relative links and images resolve against.
 *
 * A `file:` document has one of its own. A virtual document does not: the
 * base side of a diff and a pull request description both carry the worktree
 * they belong to in their URI, which is where their relative paths were
 * written to point. A URI carrying neither gets no base, so relative links in
 * it simply do not resolve.
 */
function documentRoot(uri: vscode.Uri): string | undefined {
  if (uri.scheme === 'file') return path.dirname(uri.fsPath);
  if (uri.scheme === GIT_SCHEME) {
    const parts = parseGitUri(uri);
    return parts ? path.dirname(path.join(parts.worktreePath, parts.file)) : undefined;
  }
  const pr = parsePrBodyUri(uri);
  return pr?.worktreePath;
}

/**
 * Renders through the built-in extension's engine so the output matches the
 * normal preview — same `data-line` source map, same contributed markdown-it
 * plugins. Falls back to escaped plain text if the command is unavailable.
 */
async function renderMarkdown(document: vscode.TextDocument): Promise<string> {
  try {
    const html = await vscode.commands.executeCommand<string>(
      'markdown.api.render',
      document.getText(),
    );
    if (typeof html === 'string') return html;
  } catch (err) {
    log().warn(`preview editor: markdown.api.render failed: ${describeError(err)}`);
  }
  return `<pre data-line="0" class="code-line">${escapeHtml(document.getText())}</pre>`;
}

function builtinMarkdownExtensionUri(): vscode.Uri | undefined {
  return vscode.extensions.getExtension('vscode.markdown-language-features')
    ?.extensionUri;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
