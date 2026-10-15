import * as vscode from 'vscode';
import { execTimed } from './exec';
import { describeError, log } from './log';

export const PR_BODY_SCHEME = 'wt-ext-pr';

/** How much of the description a tree row shows before it is cut short. */
const SUMMARY_MAX_CHARS = 120;

/**
 * What a description is called wherever a file name is what identifies it: the
 * document tab, and the `file` field of a comment written on it. It carries
 * the PR number because that is the only thing that identifies a description.
 */
export function prBodyFileName(prNumber: number): string {
  return `PR-${prNumber}.md`;
}

/** The PR a description file name belongs to, or undefined for another name. */
export function prNumberFromFileName(file: string): number | undefined {
  const match = /^PR-(\d+)\.md$/.exec(file);
  return match ? Number(match[1]) : undefined;
}

export interface PrBodyUriParts {
  worktreePath: string;
  number: number;
  /** Absent only on a URI built before descriptions could be commented on. */
  branch?: string;
}

/**
 * A document URI for a pull request's description.
 *
 * The path ends in `.md` because that is what the review preview's editor
 * selector matches on, and its basename is what the tab reads. The worktree
 * rides in the query rather than the authority for the same reason it does on
 * a `wt-ext-git:` URI — VS Code lowercases an authority when it rebuilds a
 * virtual document's URI from its string form. It is carried at all because a
 * comment written here has to be written to some worktree's store file.
 *
 * The branch is the PR's own, not whatever the opening worktree has checked
 * out. Comments are scoped by branch, so this is what makes a comment on a
 * description belong to the branch it describes however it was reached.
 */
export function buildPrBodyUri(
  worktreePath: string,
  prNumber: number,
  branch: string,
): vscode.Uri {
  return vscode.Uri.from({
    scheme: PR_BODY_SCHEME,
    path: `/${prBodyFileName(prNumber)}`,
    query: new URLSearchParams({
      wt: worktreePath,
      pr: String(prNumber),
      branch,
    }).toString(),
  });
}

/** Reads back what `buildPrBodyUri` encoded, or undefined for a malformed URI. */
export function parsePrBodyUri(uri: vscode.Uri): PrBodyUriParts | undefined {
  if (uri.scheme !== PR_BODY_SCHEME) return undefined;
  const query = new URLSearchParams(uri.query);
  const worktreePath = query.get('wt');
  const number = Number(query.get('pr'));
  if (!worktreePath || !Number.isInteger(number) || number <= 0) return undefined;
  return { worktreePath, number, branch: query.get('branch') ?? undefined };
}

/**
 * A top-level entry in a PR's conversation: a comment on the PR itself, or the
 * summary a reviewer left with a review. Inline review comments live on lines
 * of the diff and are not among these.
 */
export interface PrConversationEntry {
  author: string;
  body: string;
  /** ISO 8601, as GitHub reports it. */
  createdAt: string;
  /** Set on comments; GitHub gives a review summary no URL of its own. */
  url?: string;
  /** The review's verdict, set only on review summaries. */
  review?: string;
}

/**
 * Serves pull request descriptions as read-only markdown documents, with the
 * PR's top-level conversation rendered after the description.
 *
 * Bodies arrive with the PR list the tree already fetches, so opening one
 * normally costs only the conversation's `gh` call. Fetching the body too
 * covers the case where a document is resolved before that list has loaded —
 * a tab restored by a window reload is the one that happens.
 */
export class PrBodyContentProvider implements vscode.TextDocumentContentProvider {
  private readonly bodies = new Map<number, string>();
  private readonly conversations = new Map<number, PrConversationEntry[]>();
  /** What each PR's document last read, so a refresh re-renders only on change. */
  private readonly rendered = new Map<number, string>();
  /** URIs already served, so a changed PR can re-render the tabs holding it. */
  private readonly served = new Map<string, number>();
  private readonly refreshing = new Set<number>();
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly repoPath: string) {}

  /**
   * Takes the bodies from a PR list refresh, and re-reads the conversation of
   * every PR a tab has open. A description edited or a comment posted on
   * GitHub reaches an open tab through this: the content provider announces
   * the change, VS Code re-reads the document, and the preview re-renders.
   */
  setBodies(prs: { number: number; body: string }[]): void {
    const open = new Set(this.served.values());
    for (const pr of prs) {
      this.bodies.set(pr.number, pr.body);
      if (open.has(pr.number)) void this.refreshConversation(pr.number);
    }
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const parts = parsePrBodyUri(uri);
    if (!parts) {
      throw new Error(
        `Worktree Stack Reviewer: ${uri.toString()} names no pull request — close the tab and reopen the description.`,
      );
    }
    this.served.set(uri.toString(), parts.number);
    if (!this.bodies.has(parts.number) || !this.conversations.has(parts.number)) {
      await this.load(parts.number, !this.bodies.has(parts.number));
    }
    return this.render(parts.number);
  }

  private render(prNumber: number): string {
    const text = renderPrDocument(
      this.bodies.get(prNumber) ?? '',
      this.conversations.get(prNumber) ?? [],
    );
    this.rendered.set(prNumber, text);
    return text;
  }

  /**
   * Reads the conversation, and the body when the PR list has not supplied it.
   * A conversation that cannot be read leaves the description on its own
   * rather than failing the document; a body that cannot be read fails it.
   */
  private async load(prNumber: number, withBody: boolean): Promise<void> {
    try {
      const view = await fetchPrView(this.repoPath, prNumber, withBody);
      if (view.body !== undefined) this.bodies.set(prNumber, view.body);
      this.conversations.set(prNumber, view.conversation);
    } catch (err) {
      log().error(`gh pr view #${prNumber} failed: ${describeError(err)}`);
      if (withBody) {
        throw new Error(`Could not read #${prNumber}'s description: ${describeError(err)}`);
      }
    }
  }

  /** Re-reads a PR's conversation now, e.g. right after a review was posted. */
  refresh(prNumber: number): Promise<void> {
    return this.refreshConversation(prNumber);
  }

  private async refreshConversation(prNumber: number): Promise<void> {
    if (this.refreshing.has(prNumber)) return;
    this.refreshing.add(prNumber);
    try {
      await this.load(prNumber, false);
    } finally {
      this.refreshing.delete(prNumber);
    }
    const before = this.rendered.get(prNumber);
    if (before === this.render(prNumber)) return;
    for (const [key, number] of this.served) {
      if (number === prNumber) this._onDidChange.fire(vscode.Uri.parse(key));
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

export interface GhPrView {
  body?: string;
  comments?: { author?: { login?: string }; body?: string; createdAt?: string; url?: string }[];
  reviews?: { author?: { login?: string }; body?: string; state?: string; submittedAt?: string }[];
}

async function fetchPrView(
  repoPath: string,
  prNumber: number,
  withBody: boolean,
): Promise<{ body?: string; conversation: PrConversationEntry[] }> {
  const fields = withBody ? 'body,comments,reviews' : 'comments,reviews';
  const stdout = await execTimed(
    'gh',
    ['pr', 'view', String(prNumber), '--json', fields],
    repoPath,
    `gh pr view #${prNumber}`,
  );
  const view = JSON.parse(stdout) as GhPrView;
  return {
    body: withBody ? (view.body ?? '') : undefined,
    conversation: conversationFrom(view),
  };
}

/**
 * Comments and review summaries in the order they were posted. A review with
 * no summary — an approval with nothing said, or one whose only content is
 * inline comments — has nothing to show here.
 */
export function conversationFrom(view: GhPrView): PrConversationEntry[] {
  const entries: PrConversationEntry[] = [];
  for (const c of view.comments ?? []) {
    entries.push({
      author: c.author?.login ?? 'ghost',
      body: c.body ?? '',
      createdAt: c.createdAt ?? '',
      url: c.url,
    });
  }
  for (const r of view.reviews ?? []) {
    if (!r.body?.trim()) continue;
    entries.push({
      author: r.author?.login ?? 'ghost',
      body: r.body,
      createdAt: r.submittedAt ?? '',
      review: r.state,
    });
  }
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const REVIEW_VERBS: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'requested changes',
  COMMENTED: 'reviewed',
  DISMISSED: 'reviewed (dismissed)',
};

/**
 * The description followed by its conversation, one entry per heading. The
 * description comes first and unchanged, so a comment written against one of
 * its lines still lands on that line once the conversation is added below.
 */
export function renderPrDocument(body: string, conversation: PrConversationEntry[]): string {
  if (conversation.length === 0) return body;
  const parts = [body.replace(/\s+$/, ''), '', '---', '', `## Comments (${conversation.length})`];
  for (const entry of conversation) {
    const verb = entry.review ? (REVIEW_VERBS[entry.review] ?? 'reviewed') : 'commented';
    parts.push('', `### @${entry.author} ${verb} · ${formatDate(entry.createdAt)}`, '');
    parts.push(demoteHeadings(entry.body.replace(/\r\n/g, '\n').trim()));
    if (entry.url) parts.push('', `[View on GitHub](${entry.url})`);
  }
  return `${parts.join('\n')}\n`;
}

/** `2026-10-14 18:54 UTC`, or the input as given when it is not a date. */
function formatDate(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}

/**
 * Pushes a comment's own headings below the `###` that introduces it, so a
 * bot's `## Coverage report` reads as part of its comment rather than as a
 * section of the document. Fenced code is left alone.
 */
function demoteHeadings(markdown: string): string {
  let fence: string | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const opening = /^\s*(`{3,}|~{3,})/.exec(line);
      if (opening) {
        if (!fence) fence = opening[1][0];
        else if (opening[1][0] === fence) fence = undefined;
        return line;
      }
      if (fence) return line;
      const heading = /^(#{1,6})(\s.*)$/.exec(line);
      if (!heading) return line;
      return `${'#'.repeat(Math.min(6, heading[1].length + 3))}${heading[2]}`;
    })
    .join('\n');
}

/**
 * The one line of a description a tree row has space for.
 *
 * Our PR template opens with headings and a Linear link, so the first line of
 * the body says nothing about the change. The section headed "Description" is
 * where the prose is, so that is read first, and the whole body is only fallen
 * back on when there is no such section.
 */
export function prBodySummary(body: string): string {
  const text = body.replace(/<!--[\s\S]*?-->/g, '');
  const described = describedSection(text);
  const line =
    firstProseParagraph(described) ??
    firstProseParagraph(text) ??
    firstHeadingText(text);
  if (!line) return '';
  const plain = stripInlineMarkdown(line);
  return plain.length > SUMMARY_MAX_CHARS
    ? `${plain.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : plain;
}

/** The lines under a `## Description` heading, up to the next heading. */
function describedSection(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s+description\b/i.test(l.trim()));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,6}\s/.test(l.trim()));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * The first paragraph carrying prose, as one line. Bodies are hard-wrapped, so
 * reading a single source line would cut the sentence off wherever the author
 * happened to wrap it.
 */
function firstProseParagraph(text: string): string | undefined {
  const lines = text.split('\n').map((l) => l.trim());
  const start = lines.findIndex(isProse);
  if (start === -1) return undefined;
  const paragraph = [lines[start]];
  for (const line of lines.slice(start + 1)) {
    // A following list item is a separate point, not a continuation.
    if (!isProse(line) || isListItem(line)) break;
    paragraph.push(line);
  }
  return paragraph.join(' ');
}

/**
 * Whether a line carries content. Headings, horizontal rules, and raw HTML are
 * structure, and a row that showed them would read the same on every PR
 * written from the template.
 */
function isProse(line: string): boolean {
  if (line === '') return false;
  if (/^#{1,6}\s/.test(line)) return false;
  if (/^([-*_])\1{2,}$/.test(line)) return false;
  return !line.startsWith('<');
}

function isListItem(line: string): boolean {
  return /^([-*+]|\d+\.)\s/.test(line);
}

/**
 * The text of the first heading, for a description made entirely of structure.
 * A row reading "Project Management" says little, but it beats a blank one.
 */
function firstHeadingText(text: string): string | undefined {
  for (const raw of text.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(raw.trim());
    if (heading) return heading[1];
  }
  return undefined;
}

/** Renders inline markup as the text it displays, which is all a row can show. */
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/^[>\s]*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}
