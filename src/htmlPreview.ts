import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { describeError, log } from './log';
import {
  type ExplainerAnchor,
  type ThreadView,
  asExplainerMessage,
} from './previewProtocol';

/**
 * A `vscode://<extension id>/preview?path=<percent-encoded absolute path>`
 * link opens a local HTML page rendered in a VS Code tab. The wt-review skill
 * writes a self-contained explainer for each PR and prints one of these.
 *
 * Any website can fire a `vscode://` link, so the handler renders only the
 * pages that skill writes: an `.html` file directly inside a directory named
 * `wt-review`, checked again after symlinks are resolved. Everything else is
 * refused with a warning.
 */
export const HTML_PREVIEW_LINK_PATH = '/preview';

const PREVIEW_DIR_NAME = 'wt-review';
const VIEW_TYPE = 'worktreeReview.htmlPreview';
const RERENDER_DEBOUNCE_MS = 150;

export type HtmlPreviewLink = { path: string } | { rejected: string };

/** The page a `/preview` link names, why it is refused, or undefined for other paths. */
export function parseHtmlPreviewLink(uri: vscode.Uri): HtmlPreviewLink | undefined {
  if (uri.path !== HTML_PREVIEW_LINK_PATH) return undefined;
  const requested = new URLSearchParams(uri.query).get('path')?.trim();
  if (!requested) return { rejected: 'the link names no path' };
  const problem = previewPathProblem(requested);
  return problem ? { rejected: problem } : { path: path.normalize(requested) };
}

/** Why `p` may not be previewed, or undefined when it may. */
export function previewPathProblem(p: string): string | undefined {
  if (!path.isAbsolute(p)) return `${p} is not an absolute path`;
  // A `..` could climb out of the wt-review directory the rest of the path names.
  if (p.split(/[\\/]/).includes('..')) return `${p} contains '..'`;
  if (path.extname(p).toLowerCase() !== '.html') return `${p} is not an .html file`;
  if (path.basename(path.dirname(p)) !== PREVIEW_DIR_NAME) {
    return `${p} is not in a ${PREVIEW_DIR_NAME} directory`;
  }
  return undefined;
}

/**
 * What the page may load: its own inline styles and scripts, Google Fonts,
 * scripts from the three CDNs the explainers use, and data: images. Inline SVG
 * needs no source. No connect-src, so the page can't send anything anywhere.
 */
export const PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com",
  'img-src data:',
].join('; ');

/**
 * Runs before the page's own scripts. It mirrors VS Code's theme onto
 * `data-theme` and `color-scheme`, which is what the pages' dark tokens key
 * off, and keeps following it when the theme changes. It also sends every
 * link click to the extension, since navigating the webview itself would
 * replace the page with one it can't show.
 *
 * On a page whose PR is known, the comment UI (`media/explainer-comments.js`)
 * is inlined into the same closure: the webview API can be acquired only
 * once, and keeping it in here keeps it out of reach of the page's own
 * scripts. Inlining rather than loading it also leaves the CSP as it is.
 */
function bridgeScript(comments?: string): string {
  const commentUi = comments ? `\n${comments}\n  wtExplainerComments(vscode);` : '';
  return `<script>
(() => {
  const vscode = acquireVsCodeApi();
  const root = document.documentElement;
  const sync = () => {
    const cls = document.body ? document.body.classList : null;
    if (!cls) return;
    const dark = cls.contains('vscode-dark') || cls.contains('vscode-high-contrast');
    root.dataset.theme = dark ? 'dark' : 'light';
    root.style.colorScheme = dark ? 'dark' : 'light';
  };
  document.addEventListener('DOMContentLoaded', () => {
    sync();
    new MutationObserver(sync).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  });
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) return;
    e.preventDefault();
    vscode.postMessage({ type: 'openLink', href });
  }, true);${commentUi}
})();
</script>`;
}

/**
 * The page with the CSP and the bridge script placed first in its `<head>`,
 * and with the comment UI when `comments` carries its script.
 */
export function withPreviewHead(html: string, comments?: string): string {
  const head = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">\n${bridgeScript(comments)}\n`;
  const open = /<head(\s[^>]*)?>/i.exec(html);
  if (open) {
    const at = open.index + open[0].length;
    return `${html.slice(0, at)}\n${head}${html.slice(at)}`;
  }
  // No <head>: the browser makes one, and a meta CSP still counts while it
  // comes before any content it should govern.
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return `${html.slice(0, at)}\n<head>\n${head}</head>\n${html.slice(at)}`;
}

/** The page's `<title>`, or undefined when it has none. */
export function pageTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const text = m?.[1]
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text || undefined;
}

function escapeHtml(text: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return text.replace(/[&<>"]/g, (c) => entities[c]);
}

function errorPage(file: string, reason: string): string {
  return `<!doctype html>
<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:2em}code{font-family:var(--vscode-editor-font-family)}</style>
</head><body><h3>Can't show this page</h3><p>${escapeHtml(reason)}</p><p><code>${escapeHtml(file)}</code></p>
<p>It will appear here as soon as the file is written.</p></body></html>`;
}

/** The PR a page explains, which is who comments written on it belong to. */
export interface PageOwner {
  pr: number;
  branch: string;
}

/** What the preview needs from the comment store to host comments on a page. */
export interface PageComments {
  /** The PR the page at `file` explains, or undefined when no PR can be named. */
  ownerOf(file: string): Promise<PageOwner | undefined>;
  threads(owner: PageOwner): ThreadView[];
  create(owner: PageOwner, anchor: ExplainerAnchor, body: string): Promise<void>;
  reply(threadId: string, body: string): Promise<void>;
  setResolved(threadId: string, resolved: boolean): Promise<void>;
  readonly onDidChange: vscode.Event<void>;
}

interface OpenPreview {
  panel: vscode.WebviewPanel;
  watcher?: fs.FSWatcher;
  timer?: NodeJS.Timeout;
  /** Set once the page's PR is known; a page without one takes no comments. */
  owner?: PageOwner;
  /** Thread to bring into view once the page says it is ready. */
  pendingReveal?: string;
}

/** One webview panel per previewed file, re-rendered whenever the file changes. */
export class HtmlPreviews implements vscode.Disposable {
  private readonly open = new Map<string, OpenPreview>();
  private readonly disposables: vscode.Disposable[] = [];
  private commentScript: Promise<string | undefined> | undefined;

  constructor(
    private readonly extensionUri?: vscode.Uri,
    private readonly comments?: PageComments,
  ) {
    if (comments) {
      this.disposables.push(comments.onDidChange(() => this.pushAllThreads()));
    }
  }

  /**
   * Opens `file`, or reveals its panel. `preserveFocus` keeps the cursor where
   * it is, for a page that opens because an agent finished it rather than
   * because the reviewer asked. `threadId` names a comment to scroll to, which
   * is where a click on its row in the tree lands.
   */
  async show(file: string, preserveFocus = false, threadId?: string): Promise<void> {
    const existing = this.open.get(file);
    if (existing) {
      existing.panel.reveal(undefined, preserveFocus);
      if (threadId) void existing.panel.webview.postMessage({ type: 'revealThread', threadId });
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      path.basename(file),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus },
      {
        enableScripts: true,
        enableFindWidget: true,
        // The page loads nothing from disk.
        localResourceRoots: [],
        // Keeps scroll position and drawn diagrams when the tab is switched away from.
        retainContextWhenHidden: true,
      },
    );
    const entry: OpenPreview = { panel, pendingReveal: threadId };
    this.open.set(file, entry);
    panel.webview.onDidReceiveMessage((msg: unknown) => void this.onMessage(entry, msg));
    panel.onDidDispose(() => {
      entry.watcher?.close();
      if (entry.timer) clearTimeout(entry.timer);
      if (this.open.get(file) === entry) this.open.delete(file);
    });
    entry.watcher = this.watch(file, entry);
    await this.render(file, entry);
  }

  /**
   * Watches the directory rather than the file: a page rewritten by renaming a
   * temp file over it would leave a watch on the file bound to the old inode.
   */
  private watch(file: string, entry: OpenPreview): fs.FSWatcher | undefined {
    const name = path.basename(file);
    try {
      return fs.watch(path.dirname(file), (_event, changed) => {
        if (changed && changed.toString() !== name) return;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(
          () => void this.render(file, entry),
          RERENDER_DEBOUNCE_MS,
        );
      });
    } catch (err) {
      log().warn(`html preview: can't watch ${file}: ${describeError(err)}`);
      return undefined;
    }
  }

  private async render(file: string, entry: OpenPreview): Promise<void> {
    const { panel } = entry;
    let html: string;
    try {
      // The rule is checked again on the real path, so a symlink named like a
      // wt-review page can't point the preview at some other file.
      const real = await fs.promises.realpath(file);
      const problem = previewPathProblem(real);
      if (problem) {
        panel.webview.html = errorPage(
          file,
          `It resolves to a path that isn't allowed: ${problem}.`,
        );
        return;
      }
      html = await fs.promises.readFile(real, 'utf8');
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      panel.title = path.basename(file);
      const reason = missing ? 'The file does not exist.' : describeError(err);
      panel.webview.html = errorPage(file, reason);
      return;
    }
    panel.title = pageTitle(html) ?? path.basename(file);
    // Asked on every render, so a page opened before its PR could be named
    // takes comments once it is rewritten.
    entry.owner = (await this.comments?.ownerOf(file).catch((err) => {
      log().warn(`html preview: can't tell which PR ${file} explains: ${describeError(err)}`);
      return undefined;
    })) ?? entry.owner;
    const script = entry.owner ? await this.loadCommentScript() : undefined;
    panel.webview.html = withPreviewHead(html, script);
  }

  private loadCommentScript(): Promise<string | undefined> {
    if (!this.extensionUri) return Promise.resolve(undefined);
    const file = vscode.Uri.joinPath(this.extensionUri, 'media', 'explainer-comments.js').fsPath;
    this.commentScript ??= fs.promises.readFile(file, 'utf8').catch((err) => {
      log().error(`html preview: can't read ${file}: ${describeError(err)}`);
      this.commentScript = undefined;
      return undefined;
    });
    return this.commentScript;
  }

  private async onMessage(entry: OpenPreview, raw: unknown): Promise<void> {
    const msg = asExplainerMessage(raw);
    if (!msg) return;
    if (msg.type === 'openLink') {
      await this.openLink(msg.href);
      return;
    }
    const { owner } = entry;
    if (!owner || !this.comments) return;
    switch (msg.type) {
      case 'ready':
        this.pushThreads(entry);
        if (entry.pendingReveal) {
          void entry.panel.webview.postMessage({
            type: 'revealThread',
            threadId: entry.pendingReveal,
          });
          entry.pendingReveal = undefined;
        }
        return;
      case 'createThread':
        await this.comments.create(owner, { quote: msg.quote, section: msg.section }, msg.body);
        return;
      case 'reply':
        await this.comments.reply(msg.threadId, msg.body);
        return;
      case 'setResolved':
        await this.comments.setResolved(msg.threadId, msg.resolved);
        return;
    }
  }

  private pushThreads(entry: OpenPreview): void {
    if (!entry.owner || !this.comments) return;
    void entry.panel.webview.postMessage({
      type: 'threads',
      threads: this.comments.threads(entry.owner),
    });
  }

  private pushAllThreads(): void {
    for (const entry of this.open.values()) this.pushThreads(entry);
  }

  private async openLink(href: string): Promise<void> {
    let uri: vscode.Uri;
    try {
      uri = vscode.Uri.parse(href, true);
    } catch {
      return;
    }
    if (uri.scheme === 'http' || uri.scheme === 'https' || uri.scheme === 'mailto') {
      await vscode.env.openExternal(uri);
    } else {
      log().info(`html preview: ignored link ${href}`);
    }
  }

  dispose(): void {
    for (const { panel } of [...this.open.values()]) panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
