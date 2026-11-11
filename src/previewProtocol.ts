/**
 * Message protocol between the review preview editor (`previewEditor.ts`) and
 * its webview (`media/preview-editor.js`). Pure types and validators, kept out
 * of the provider so the unit tier can exercise them without a `vscode` module.
 *
 * Everything arriving from the webview is validated before use — webview state
 * survives serialisation and restores, so a message is closer to external
 * input than to an internal call.
 */

export interface ThreadCommentView {
  author: string;
  body: string;
  createdAt: string;
  /** An agent's comment the reviewer has not seen yet. */
  unread?: boolean;
}

/** What the webview needs to draw one thread. A subset of `StoredThread`. */
export interface ThreadView {
  id: string;
  /** `note` for a thread an agent opened; absent for a review comment. */
  kind?: 'note';
  /** 1-based inclusive; both absent for a whole-file thread. */
  startLine?: number;
  endLine?: number;
  resolved: boolean;
  drifted?: boolean;
  /** On an explainer thread: the text it was written on, and the heading above it. */
  quote?: string;
  section?: string;
  comments: ThreadCommentView[];
}

/**
 * A selection in the rendered document, in the half-open 0-based convention
 * the preview's `data-line` attributes use. Same shape the built-in-preview
 * context menu ships, minus the resource (the editor knows its document).
 */
export interface EditorSelection {
  startLine: number;
  endLineExclusive: number;
  selectedText: string;
}

/** The verdicts a PR review can carry, as `gh pr review` spells them. */
export type ReviewVerdict = 'approve' | 'comment' | 'request-changes';

const REVIEW_VERDICTS: readonly string[] = ['approve', 'comment', 'request-changes'];

export type WebviewToEditorMessage =
  | { type: 'ready' }
  | ({ type: 'createThread'; body: string } & EditorSelection)
  | { type: 'reply'; threadId: string; body: string }
  | { type: 'setResolved'; threadId: string; resolved: boolean }
  | { type: 'openSource'; line?: number }
  | { type: 'openLink'; href: string }
  | { type: 'submitReview'; verdict: ReviewVerdict; body: string };

/** The parts of a relative link in a rendered document that name a target. */
export interface RelativeLink {
  /** Percent-decoded, with any query and fragment taken off. */
  path: string;
  /** Without the `#`, as written; empty when the link has none. */
  fragment: string;
}

export function parseRelativeLink(href: string): RelativeLink {
  const hash = href.indexOf('#');
  const fragment = hash < 0 ? '' : href.slice(hash + 1);
  const target = hash < 0 ? href : href.slice(0, hash);
  const query = target.indexOf('?');
  const raw = query < 0 ? target : target.slice(0, query);
  return { path: percentDecoded(raw), fragment };
}

/** Whether a path is one the review preview opens; see `customEditors`. */
export function isMarkdownPath(file: string): boolean {
  return /\.md$/i.test(file);
}

function percentDecoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    // A literal `%` in a hand-written link, not an escape.
    return text;
  }
}

export function asWebviewToEditorMessage(
  arg: unknown,
): WebviewToEditorMessage | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const msg = arg as Record<string, unknown>;
  switch (msg.type) {
    case 'ready':
      return { type: 'ready' };
    case 'createThread': {
      const selection = asEditorSelection(msg);
      if (!selection || !isNonEmptyString(msg.body)) return undefined;
      return { type: 'createThread', body: msg.body, ...selection };
    }
    case 'reply':
      if (!isNonEmptyString(msg.threadId) || !isNonEmptyString(msg.body)) {
        return undefined;
      }
      return { type: 'reply', threadId: msg.threadId, body: msg.body };
    case 'setResolved':
      if (!isNonEmptyString(msg.threadId) || typeof msg.resolved !== 'boolean') {
        return undefined;
      }
      return { type: 'setResolved', threadId: msg.threadId, resolved: msg.resolved };
    case 'openSource':
      return { type: 'openSource', line: isLine(msg.line) ? msg.line : undefined };
    case 'openLink':
      if (!isNonEmptyString(msg.href)) return undefined;
      return { type: 'openLink', href: msg.href };
    case 'submitReview': {
      if (typeof msg.verdict !== 'string' || !REVIEW_VERDICTS.includes(msg.verdict)) {
        return undefined;
      }
      if (typeof msg.body !== 'string') return undefined;
      const verdict = msg.verdict as ReviewVerdict;
      // GitHub refuses a comment or a change request with nothing said.
      if (verdict !== 'approve' && msg.body.trim() === '') return undefined;
      return { type: 'submitReview', verdict, body: msg.body };
    }
    default:
      return undefined;
  }
}

export function asEditorSelection(arg: unknown): EditorSelection | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const sel = arg as Record<string, unknown>;
  if (!isLine(sel.startLine) || !isLine(sel.endLineExclusive)) return undefined;
  if (sel.endLineExclusive <= sel.startLine) return undefined;
  return {
    startLine: sel.startLine,
    endLineExclusive: sel.endLineExclusive,
    selectedText: typeof sel.selectedText === 'string' ? sel.selectedText : '',
  };
}

function isLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Where a comment on an explainer page sits. The page is HTML with no source
 * lines, so the anchor is the text that was selected and the heading it sat
 * under, which the page finds again each time it is drawn.
 */
export interface ExplainerAnchor {
  quote: string;
  section?: string;
}

/** Longest quote kept; a long selection is anchored by how it begins. */
export const MAX_EXPLAINER_QUOTE = 500;

const MAX_EXPLAINER_SECTION = 200;

export type ExplainerToHostMessage =
  | { type: 'ready' }
  | { type: 'openLink'; href: string }
  | ({ type: 'createThread'; body: string } & ExplainerAnchor)
  | { type: 'reply'; threadId: string; body: string }
  | { type: 'setResolved'; threadId: string; resolved: boolean };

/**
 * Validates a message from an explainer page. The page is written by an agent
 * and its own scripts share the webview with the comment UI, so what arrives
 * is treated as untrusted input like everything else from a webview.
 */
export function asExplainerMessage(arg: unknown): ExplainerToHostMessage | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const msg = arg as Record<string, unknown>;
  switch (msg.type) {
    case 'ready':
      return { type: 'ready' };
    case 'openLink':
      return isNonEmptyString(msg.href) ? { type: 'openLink', href: msg.href } : undefined;
    case 'createThread': {
      if (typeof msg.body !== 'string' || msg.body.trim() === '') return undefined;
      if (typeof msg.quote !== 'string') return undefined;
      const quote = msg.quote.trim().slice(0, MAX_EXPLAINER_QUOTE);
      if (quote === '') return undefined;
      const section =
        typeof msg.section === 'string' && msg.section.trim()
          ? msg.section.trim().slice(0, MAX_EXPLAINER_SECTION)
          : undefined;
      return { type: 'createThread', body: msg.body.trim(), quote, section };
    }
    case 'reply':
    case 'setResolved': {
      const parsed = asWebviewToEditorMessage(msg);
      return parsed?.type === msg.type ? (parsed as ExplainerToHostMessage) : undefined;
    }
    default:
      return undefined;
  }
}
