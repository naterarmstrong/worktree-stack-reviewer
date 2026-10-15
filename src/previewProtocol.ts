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
