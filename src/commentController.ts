import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  type CommentSide,
  CommentStore,
  type InboxEntry,
  type NoteEntry,
  type StoredThread,
  type ThreadKind,
  inboxPathFor,
  isNoteEntry,
  rejectedPathFor,
  sortThreads,
  storePathFor,
} from './commentStore';
import { resolvePreviewRange } from './previewComment';
import type { EditorSelection, ThreadView } from './previewProtocol';
import { ResolutionInbox } from './resolutionInbox';
import {
  type Worktree,
  getGitUserName,
  listLocalBranches,
  listWorktrees,
  revParse,
} from './git';
import { GIT_SCHEME, buildGitUri, parseGitUri } from './gitContentProvider';
import { describeError, log } from './log';
import {
  PR_BODY_SCHEME,
  buildPrBodyUri,
  parsePrBodyUri,
  prBodyFileName,
  prNumberFromFileName,
} from './prBody';

const CONTROLLER_ID = 'worktreeReview.comments';

/**
 * How far from a comment's recorded line to search for its snippet when
 * re-anchoring. Wide enough to survive an edit or two above the comment,
 * narrow enough that a repeated line elsewhere in the file won't capture it.
 */
const REANCHOR_WINDOW_LINES = 40;

/** Cap on stored snippet size, so a whole-file selection can't bloat the JSON. */
const MAX_SNIPPET_LINES = 40;

/**
 * How much of the branch tip's sha a comment records. Long enough to be unique
 * within one branch's history, short enough to leave the store readable by
 * whoever opens it — which is half of why the comments live in a JSON file.
 */
const HEAD_SHA_CHARS = 12;

/** Who a note is from when the entry that opened it does not say. */
const DEFAULT_AGENT_AUTHOR = 'Claude';

export interface CommentTarget {
  worktreePath: string;
  /** Worktree-relative, posix-separated. */
  file: string;
  side: CommentSide;
  /** Set only for `base` targets; see `StoredThread.baseRef`. */
  baseRef?: string;
  /**
   * The branch a comment written here belongs to, when the document names one
   * itself. Only a `pr` target does: a description belongs to the PR's branch
   * whichever worktree it was opened from. Everything else takes the branch
   * the worktree has checked out.
   */
  branch?: string;
}

export interface ExportMeta {
  branch?: string;
  base?: string;
  baseSha?: string;
  /** Paths changed vs. base, used to flag comments that sit outside the diff. */
  changed?: Set<string>;
}

export interface ExportedComment {
  id: string;
  kind?: ThreadKind;
  file: string;
  side: CommentSide;
  startLine?: number;
  endLine?: number;
  /** Undefined when the diff could not be computed, rather than guessed. */
  inDiff?: boolean;
  resolved: boolean;
  anchorDrifted?: boolean;
  snippet?: string;
  messages: { author: string; body: string }[];
}

interface LiveThread {
  thread: vscode.CommentThread;
  /**
   * The document the thread is attached to, as `Uri.toString()`. Usually a file
   * in whichever worktree currently has the comment's branch checked out, and
   * otherwise whatever a pin named. Distinct from the worktree whose JSON file
   * stores the comment, which never moves once written.
   */
  uri: string;
}

/** A stored thread together with the worktree file that owns it. */
export interface LocatedThread {
  storedIn: string;
  thread: StoredThread;
}

class ReviewComment implements vscode.Comment {
  contextValue = 'editable';
  savedBody: string | vscode.MarkdownString;

  constructor(
    readonly id: string,
    public body: string | vscode.MarkdownString,
    public mode: vscode.CommentMode,
    readonly author: vscode.CommentAuthorInformation,
    public parent?: vscode.CommentThread,
  ) {
    this.savedBody = body;
  }
}

/**
 * Wires the native `vscode.comments` API to the per-worktree JSON store.
 *
 * Commenting is offered on any file inside any worktree, not just files in the
 * diff: `createCommentController` takes no document selector, so the only gate
 * is what `provideCommentingRanges` returns. Restricting to changed files would
 * be extra work rather than less, and comments on unchanged files are useful
 * ("this helper should have been touched too").
 */
export class ReviewCommentController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly store = new CommentStore();
  private readonly live = new Map<string, LiveThread>();
  /**
   * Documents a thread has been pinned to, keyed by thread id. A pin is how a
   * comment is shown somewhere other than the file its branch is checked out
   * in — on the diff a stack branch row opens, which is the only way to read a
   * comment on a branch no worktree holds.
   */
  private readonly pins = new Map<string, vscode.Uri>();
  private readonly threadIds = new Map<vscode.CommentThread, string>();
  private readonly reanchored = new Set<string>();
  private readonly hydrating = new Map<string, Promise<void>>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private readonly inbox: ResolutionInbox;
  private worktrees: Worktree[] = [];
  private authorName = 'reviewer';
  private initPromise: Promise<void> | undefined;

  /**
   * Avatar for comments an agent wrote. The reviewer's own carry none, so the
   * icon alone tells the two apart in a thread.
   */
  private readonly agentIcon: vscode.Uri;

  constructor(
    private readonly repoPath: string,
    extensionUri: vscode.Uri,
  ) {
    this.agentIcon = vscode.Uri.joinPath(extensionUri, 'media', 'agent.svg');
    this.inbox = new ResolutionInbox((worktreePath, entries) =>
      this.applyInbox(worktreePath, entries),
    );
    this.controller = vscode.comments.createCommentController(
      CONTROLLER_ID,
      'Worktree Stack Reviewer',
    );
    this.controller.options = {
      prompt: 'Note for Claude',
      placeHolder: 'Comment (exported as JSON for Claude)',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => this.provideCommentingRanges(document),
    };

    this.disposables.push(
      this.controller,
      this._onDidChange,
      this.inbox,
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) this.reanchor(editor.document);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        void this.persistRangesFor(document);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.dropPinsOn(document.uri);
      }),
    );
  }

  /**
   * Loads every worktree's comments and materialises their threads up front, so
   * the Comments panel is a complete review list rather than only showing files
   * that happen to be open. Snippet re-anchoring is deferred until a document is
   * actually visible — that keeps startup from opening every commented file.
   */
  ready(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.init().catch((err) => {
        log().error(`comments: init failed: ${describeError(err)}`);
      });
    }
    return this.initPromise;
  }

  private async init(): Promise<void> {
    this.authorName = (await getGitUserName(this.repoPath)) || 'reviewer';
    this.worktrees = await listWorktrees(this.repoPath);
    await Promise.all(this.worktrees.map((w) => this.hydrate(w.path)));
    this.reconcile();
    this.inbox.watch(this.worktrees.map((w) => w.path));
    for (const editor of vscode.window.visibleTextEditors) {
      this.reanchor(editor.document);
    }
  }

  /**
   * Keeps the worktree list current so path attribution stays correct. Called
   * from the tree provider, which already shells out to `git worktree list` —
   * `provideCommentingRanges` runs on every editor open and must not shell out
   * itself.
   */
  setWorktrees(worktrees: Worktree[]): void {
    const unchanged =
      worktrees.length === this.worktrees.length &&
      worktrees.every(
        (w, i) =>
          this.worktrees[i]?.path === w.path && this.worktrees[i]?.branch === w.branch,
      );
    this.worktrees = worktrees;
    if (unchanged) return;

    const paths = new Set(worktrees.map((w) => w.path));
    for (const known of this.store.loadedWorktrees()) {
      if (!paths.has(known)) this.dropWorktree(known);
    }
    this.inbox.watch(worktrees.map((w) => w.path));
    const pending = worktrees
      .filter((w) => !this.store.isLoaded(w.path))
      .map((w) => this.hydrate(w.path));
    if (pending.length === 0) {
      this.reconcile();
      return;
    }
    void Promise.all(pending).then(() => this.reconcile());
  }

  /**
   * De-duplicated per worktree: the tree provider's first render can call
   * `setWorktrees` while `init` is still loading, and two concurrent loads would
   * leave the store holding a different set of objects than the live threads
   * were built from.
   */
  private hydrate(worktreePath: string): Promise<void> {
    const inFlight = this.hydrating.get(worktreePath);
    if (inFlight) return inFlight;
    const task = (async () => {
      await this.store.load(worktreePath);
      if (await this.stampLegacyBranches(worktreePath)) {
        await this.store.save(worktreePath);
      }
    })().finally(() => this.hydrating.delete(worktreePath));
    this.hydrating.set(worktreePath, task);
    return task;
  }

  /**
   * Assigns a branch to threads written before comments were branch-scoped.
   * Their only defensible owner is whatever the storing worktree is on now,
   * which is where they were being shown under the old worktree-scoped model.
   */
  private async stampLegacyBranches(worktreePath: string): Promise<boolean> {
    const branch = this.branchOf(worktreePath);
    if (!branch) return false;
    let stamped = 0;
    for (const t of this.store.threads(worktreePath)) {
      if (!t.branch) {
        t.branch = branch;
        stamped += 1;
      }
    }
    if (stamped > 0) {
      log().info(
        `comments: stamped ${stamped} pre-branch-scoping thread(s) in ${worktreePath} as "${branch}"`,
      );
    }
    return stamped > 0;
  }

  private dropWorktree(worktreePath: string): void {
    this.store.drop(worktreePath);
  }

  /**
   * The patch a comment written now is being left on: the branch's tip. Refs
   * are shared across a repository's worktrees, so this answers from whichever
   * worktree the comment is being stored in, checked out there or not.
   *
   * Undefined when the branch has no tip to name, which leaves the thread to be
   * dated back to a patch instead of pointing at one that is not there.
   */
  private async headShaOf(
    worktreePath: string,
    branch: string,
  ): Promise<string | undefined> {
    const tip = await revParse(worktreePath, `refs/heads/${branch}`).catch(
      () => '',
    );
    return tip ? tip.slice(0, HEAD_SHA_CHARS) : undefined;
  }

  // ------------------------------------------------------------ branch lookup

  private branchOf(worktreePath: string): string | undefined {
    return this.worktrees.find((w) => w.path === worktreePath)?.branch;
  }

  /**
   * The branch comments on a target belong to: the one the document names, and
   * otherwise the one its worktree has checked out.
   */
  private branchForTarget(target: CommentTarget): string | undefined {
    return target.branch ?? this.branchOf(target.worktreePath);
  }

  /** Every stored thread for a branch, from whichever files hold them. */
  private threadsForBranch(branch: string): LocatedThread[] {
    const out: LocatedThread[] = [];
    for (const storedIn of this.store.loadedWorktrees()) {
      for (const thread of this.store.threads(storedIn)) {
        if (thread.branch === branch) out.push({ storedIn, thread });
      }
    }
    return out;
  }

  /**
   * Brings live comment threads in line with what each worktree currently has
   * checked out, and with any pins. Called after any branch switch, worktree
   * add/remove, pin change, or store mutation.
   *
   * Recomputing the whole desired set is deliberate: branch switches, worktree
   * removals, and comments arriving in another worktree's file all change which
   * threads should exist and where they point, and reconciling each of those
   * incrementally is far more error-prone than rebuilding a small map.
   */
  private reconcile(): void {
    const desired = new Map<string, { stored: StoredThread; uri: vscode.Uri }>();
    for (const w of this.worktrees) {
      for (const { thread } of this.threadsForBranch(w.branch)) {
        desired.set(thread.id, { stored: thread, uri: this.uriFor(w.path, thread) });
      }
    }
    // Pins are applied last so they outrank the checked-out placement: a
    // comment opened on a branch diff belongs on that diff, not in two places.
    // A pin naming a thread that has since been deleted is dropped here, which
    // is the only pass that sees both the pins and the store.
    for (const [id, uri] of Array.from(this.pins)) {
      const found = this.findAnywhere(id);
      if (!found) {
        this.pins.delete(id);
        continue;
      }
      desired.set(id, { stored: found.thread, uri });
    }

    let changed = false;
    for (const [id, entry] of Array.from(this.live.entries())) {
      const want = desired.get(id);
      if (!want || want.uri.toString() !== entry.uri) {
        this.disposeThread(id);
        changed = true;
      }
    }
    for (const [id, want] of desired) {
      if (this.live.has(id)) continue;
      this.materialise(want.uri, want.stored);
      changed = true;
    }

    if (changed) {
      // Anchors were resolved against the previous branch's file contents.
      this.reanchored.clear();
      for (const editor of vscode.window.visibleTextEditors) {
        this.reanchor(editor.document);
      }
      this._onDidChange.fire();
    }
  }

  // ---------------------------------------------------------------- targeting

  /**
   * Maps a document URI back to the worktree whose store file owns comments on
   * it.
   *
   * `file:` URIs are matched by longest containing worktree root — the main
   * checkout is itself an entry in `git worktree list`, so it needs no special
   * case. `wt-ext-git:` and `wt-ext-pr:` URIs carry the worktree path in their
   * query. Anything else (untitled, output channels, other schemes) is not
   * commentable.
   */
  resolveTarget(uri: vscode.Uri): CommentTarget | undefined {
    if (uri.scheme === PR_BODY_SCHEME) {
      const parts = parsePrBodyUri(uri);
      if (!parts) return undefined;
      if (!this.worktrees.some((w) => w.path === parts.worktreePath)) {
        return undefined;
      }
      // A description belongs to the PR rather than to any worktree, so the
      // store file it goes in is chosen the way it is for everything else: the
      // one beside the branch. The worktree the description was opened from
      // holds it only when nothing has that branch checked out.
      const holder = this.worktrees.find((w) => w.branch === parts.branch);
      return {
        worktreePath: holder?.path ?? parts.worktreePath,
        file: prBodyFileName(parts.number),
        side: 'pr',
        branch: parts.branch,
      };
    }
    if (uri.scheme === GIT_SCHEME) {
      const parts = parseGitUri(uri);
      if (!parts) return undefined;
      if (!this.worktrees.some((w) => w.path === parts.worktreePath)) {
        return undefined;
      }
      return {
        worktreePath: parts.worktreePath,
        file: parts.file,
        side: 'base',
        baseRef: parts.ref,
      };
    }
    if (uri.scheme !== 'file') return undefined;
    let best: CommentTarget | undefined;
    for (const w of this.worktrees) {
      const rel = path.relative(w.path, uri.fsPath);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (best && best.worktreePath.length >= w.path.length) continue;
      const file = rel.split(path.sep).join('/');
      // Commenting on the store itself would write the comment into the file
      // being commented on. Exclude it rather than explain the loop later.
      if (uri.fsPath === storePathFor(w.path)) continue;
      best = { worktreePath: w.path, file, side: 'working' };
    }
    return best;
  }

  private async provideCommentingRanges(
    document: vscode.TextDocument,
  ): Promise<vscode.CommentingRanges | undefined> {
    await this.ready();
    if (!this.resolveTarget(document.uri)) return undefined;
    const lastLine = Math.max(0, document.lineCount - 1);
    return {
      enableFileComments: true,
      ranges: [new vscode.Range(0, 0, lastLine, 0)],
    };
  }

  // ------------------------------------------------------------------- create

  async createComment(arg: unknown): Promise<void> {
    const reply = asCommentReply(arg);
    if (!reply) {
      log().warn('comments: createComment called with unexpected argument shape');
      return;
    }
    await this.ready();
    const thread = reply.thread;
    const target = this.resolveTarget(thread.uri);
    if (!target) {
      log().warn(`comments: ignoring reply on unowned uri ${thread.uri.toString()}`);
      return;
    }
    const existingId = this.threadIds.get(thread);
    if (existingId) {
      await this.appendComment(target.worktreePath, existingId, thread, reply.text);
      return;
    }
    const branch = this.branchForTarget(target);
    if (!branch) {
      void vscode.window.showWarningMessage(
        'Worktree Stack Reviewer: cannot comment here — this worktree has no branch checked out.',
      );
      return;
    }
    const range = normalizeRange(thread.uri, thread.range);
    const stored: StoredThread = {
      id: this.store.newId(),
      branch,
      sha: await this.headShaOf(target.worktreePath, branch),
      file: target.file,
      side: target.side,
      baseRef: target.baseRef,
      startLine: range ? range.start.line + 1 : undefined,
      endLine: range ? range.end.line + 1 : undefined,
      snippet: range ? snippetFor(thread.uri, range) : undefined,
      resolved: false,
      createdAt: new Date().toISOString(),
      comments: [],
    };
    this.store.add(target.worktreePath, stored);
    if (range) thread.range = range;
    this.decorate(thread, stored);
    this.track(thread, stored.id, thread.uri);
    this.pushComment(thread, stored, reply.text);
    await this.commit(target.worktreePath);
  }

  private async appendComment(
    worktreePath: string,
    threadId: string,
    thread: vscode.CommentThread,
    text: string,
  ): Promise<void> {
    const stored = this.store.find(worktreePath, threadId);
    if (!stored) return;
    this.pushComment(thread, stored, text);
    await this.commit(worktreePath);
  }

  private pushComment(
    thread: vscode.CommentThread,
    stored: StoredThread,
    text: string,
  ): void {
    const id = this.store.newId();
    stored.comments.push({
      id,
      author: this.authorName,
      body: text,
      createdAt: new Date().toISOString(),
    });
    const comment = new ReviewComment(
      id,
      text,
      vscode.CommentMode.Preview,
      { name: this.authorName },
      thread,
    );
    thread.comments = [...thread.comments, comment];
  }

  /**
   * Creates a thread from a selection in a rendered markdown preview — the
   * review preview editor's composer, or the built-in preview's context menu
   * routed through it. Returns false when the file has no worktree or branch
   * to attach the comment to.
   */
  async createThreadFromPreview(
    uri: vscode.Uri,
    selection: EditorSelection,
    body: string,
  ): Promise<boolean> {
    await this.ready();
    const target = this.resolveTarget(uri);
    if (!target) {
      void vscode.window.showWarningMessage(
        'Worktree Stack Reviewer: this markdown file is not inside a worktree.',
      );
      return false;
    }
    const branch = this.branchForTarget(target);
    if (!branch) {
      void vscode.window.showWarningMessage(
        'Worktree Stack Reviewer: cannot comment here — this worktree has no branch checked out.',
      );
      return false;
    }

    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch (err) {
      log().warn(`comments: cannot open ${uri.toString()}: ${describeError(err)}`);
      return false;
    }
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      lines.push(document.lineAt(i).text);
    }
    // A stale preview can point past the end of the file; degrade to a
    // whole-file comment rather than anchoring to lines that are not there.
    let range = resolvePreviewRange(lines, selection);
    if (range) {
      const cappedEnd = Math.min(
        range.endLine,
        range.startLine + MAX_SNIPPET_LINES - 1,
      );
      range = { startLine: range.startLine, endLine: cappedEnd };
    }

    const stored: StoredThread = {
      id: this.store.newId(),
      branch,
      sha: await this.headShaOf(target.worktreePath, branch),
      file: target.file,
      side: target.side,
      baseRef: target.baseRef,
      startLine: range?.startLine,
      endLine: range?.endLine,
      snippet: range
        ? lines.slice(range.startLine - 1, range.endLine).join('\n')
        : undefined,
      resolved: false,
      createdAt: new Date().toISOString(),
      comments: [],
    };
    stored.comments.push({
      id: this.store.newId(),
      author: this.authorName,
      body,
      createdAt: new Date().toISOString(),
    });
    this.store.add(target.worktreePath, stored);
    this.materialise(this.uriFor(target.worktreePath, stored), stored);
    await this.commit(target.worktreePath);
    return true;
  }

  /** Threads on this document for the review preview editor, sorted by line. */
  threadsForDocument(uri: vscode.Uri): ThreadView[] {
    const target = this.resolveTarget(uri);
    if (!target) return [];
    const branch = this.branchForTarget(target);
    if (!branch) return [];
    return sortThreads(
      this.threadsForBranch(branch)
        .map((l) => l.thread)
        .filter((t) => t.file === target.file && t.side === target.side),
    ).map((t) => ({
      id: t.id,
      kind: t.kind,
      startLine: t.startLine,
      endLine: t.endLine,
      resolved: t.resolved,
      drifted: t.drifted,
      comments: t.comments.map((c) => ({
        author: c.author,
        body: c.body,
        createdAt: c.createdAt,
      })),
    }));
  }

  /** Appends a reply from the review preview editor, as the git user. */
  async replyToThread(threadId: string, body: string): Promise<void> {
    await this.ready();
    const found = this.findAnywhere(threadId);
    if (!found) {
      log().warn(`comments: reply targets unknown thread ${threadId}`);
      return;
    }
    found.thread.comments.push({
      id: this.store.newId(),
      author: this.authorName,
      body,
      createdAt: new Date().toISOString(),
    });
    // Rebuild the live thread so the reply reaches the editor widget too; its
    // comment list is not re-read from the store otherwise.
    this.disposeThread(threadId);
    await this.commit(found.storedIn);
    this.reconcile();
  }

  async setThreadResolved(threadId: string, resolved: boolean): Promise<void> {
    await this.ready();
    const found = this.findAnywhere(threadId);
    if (!found) {
      log().warn(`comments: resolve targets unknown thread ${threadId}`);
      return;
    }
    if (found.thread.resolved === resolved) return;
    found.thread.resolved = resolved;
    const live = this.live.get(threadId)?.thread;
    if (live) this.decorate(live, found.thread);
    await this.commit(found.storedIn);
  }

  // ------------------------------------------------------------------- mutate

  async editComment(arg: unknown): Promise<void> {
    const comment = asReviewComment(arg);
    const thread = comment?.parent;
    if (!comment || !thread) return;
    thread.comments = thread.comments.map((c) => {
      if (c instanceof ReviewComment && c.id === comment.id) {
        c.mode = vscode.CommentMode.Editing;
      }
      return c;
    });
  }

  async saveComment(arg: unknown): Promise<void> {
    const comment = asReviewComment(arg);
    const thread = comment?.parent;
    if (!comment || !thread) return;
    const located = this.locate(thread);
    thread.comments = thread.comments.map((c) => {
      if (c instanceof ReviewComment && c.id === comment.id) {
        c.savedBody = c.body;
        c.mode = vscode.CommentMode.Preview;
        const record = located?.stored.comments.find((sc) => sc.id === c.id);
        if (record) record.body = bodyText(c.body);
      }
      return c;
    });
    if (located) await this.commit(located.worktreePath);
  }

  async cancelEdit(arg: unknown): Promise<void> {
    const comment = asReviewComment(arg);
    const thread = comment?.parent;
    if (!comment || !thread) return;
    thread.comments = thread.comments.map((c) => {
      if (c instanceof ReviewComment && c.id === comment.id) {
        c.body = c.savedBody;
        c.mode = vscode.CommentMode.Preview;
      }
      return c;
    });
  }

  async deleteComment(arg: unknown): Promise<void> {
    const comment = asReviewComment(arg);
    const thread = comment?.parent;
    if (!comment || !thread) return;
    const located = this.locate(thread);
    thread.comments = thread.comments.filter(
      (c) => !(c instanceof ReviewComment && c.id === comment.id),
    );
    if (!located) return;
    located.stored.comments = located.stored.comments.filter((c) => c.id !== comment.id);
    if (located.stored.comments.length === 0) {
      this.store.remove(located.worktreePath, located.stored.id);
      this.disposeThread(located.stored.id);
    }
    await this.commit(located.worktreePath);
  }

  async deleteThread(arg: unknown): Promise<void> {
    const thread = asCommentThread(arg);
    if (!thread) return;
    const located = this.locate(thread);
    if (!located) {
      thread.dispose();
      return;
    }
    this.store.remove(located.worktreePath, located.stored.id);
    this.disposeThread(located.stored.id);
    await this.commit(located.worktreePath);
  }

  async toggleResolved(arg: unknown): Promise<void> {
    const thread = asCommentThread(arg);
    if (!thread) return;
    const located = this.locate(thread);
    if (!located) return;
    located.stored.resolved = !located.stored.resolved;
    this.decorate(thread, located.stored);
    await this.commit(located.worktreePath);
  }

  /**
   * Opens a thread's widget in whatever editor shows its file. Threads are
   * created collapsed, and VS Code collapses one again when it is resolved, so
   * a click in the tree would otherwise land on a line with the comment still
   * folded into the gutter.
   */
  expandThread(id: string): void {
    const entry = this.live.get(id);
    if (!entry) return;
    entry.thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }

  /**
   * Shows a thread on a document of the caller's choosing and opens its widget.
   * Used by the branch rows, whose comments open on the diff between the branch
   * and the one it sits on rather than on a file in any worktree.
   *
   * A pin outranks the placement `reconcile` would otherwise pick, so a comment
   * whose branch is also checked out moves to the diff rather than appearing
   * twice; `unpinThread` puts it back.
   */
  async pinThread(threadId: string, uri: vscode.Uri): Promise<void> {
    await this.ready();
    this.pins.set(threadId, uri);
    this.reconcile();
    this.expandThread(threadId);
  }

  /** Returns a pinned thread to the file its branch is checked out in. */
  unpinThread(threadId: string): void {
    if (!this.pins.delete(threadId)) return;
    this.reconcile();
  }

  /**
   * Drops every pin onto a document that has been closed. A pin exists to put a
   * comment on a diff someone is reading; once that diff is gone the thread
   * belongs back on the file its branch is checked out in.
   */
  private dropPinsOn(uri: vscode.Uri): void {
    const key = uri.toString();
    let dropped = false;
    for (const [id, pinned] of Array.from(this.pins)) {
      if (pinned.toString() !== key) continue;
      this.pins.delete(id);
      dropped = true;
    }
    if (dropped) this.reconcile();
  }

  /** Deletes every comment on a worktree's current branch, wherever stored. */
  async clearBranch(worktreePath: string): Promise<number> {
    await this.ready();
    const branch = this.branchOf(worktreePath);
    if (!branch) return 0;
    const located = this.threadsForBranch(branch);
    if (located.length === 0) return 0;
    const touched = new Set<string>();
    for (const { storedIn, thread } of located) {
      this.store.remove(storedIn, thread.id);
      this.disposeThread(thread.id);
      touched.add(storedIn);
    }
    await this.commitAll(touched);
    return located.length;
  }

  // -------------------------------------------------------------- persistence

  private async commit(worktreePath: string): Promise<void> {
    this.syncRanges(worktreePath);
    try {
      await this.store.save(worktreePath);
    } catch {
      void vscode.window.showErrorMessage(
        `Worktree Stack Reviewer: could not save comments to ${storePathFor(worktreePath)}.`,
      );
    }
    this._onDidChange.fire();
  }

  private async commitAll(worktreePaths: Iterable<string>): Promise<void> {
    for (const p of worktreePaths) await this.commit(p);
  }

  /**
   * Copies live thread positions back into the model. VS Code shifts a thread's
   * range as the document is edited, so reading it at save time is what keeps
   * stored line numbers honest without polling for document changes.
   */
  private syncRanges(worktreePath: string): void {
    for (const stored of this.store.threads(worktreePath)) {
      if (stored.startLine === undefined) continue;
      const range = this.live.get(stored.id)?.thread.range;
      if (!range) continue;
      stored.startLine = range.start.line + 1;
      stored.endLine = range.end.line + 1;
    }
  }

  /**
   * Saves after an edit to a file that has comments. The threads shown in this
   * worktree may live in another worktree's store — a branch reviewed elsewhere
   * and since checked out here — so every hosting file is written, not just the
   * one belonging to the worktree the document sits in.
   */
  private async persistRangesFor(document: vscode.TextDocument): Promise<void> {
    const target = this.resolveTarget(document.uri);
    if (!target) return;
    const branch = this.branchOf(target.worktreePath);
    if (!branch) return;
    const hosts = new Set(
      this.threadsForBranch(branch)
        .filter(({ thread }) => thread.file === target.file)
        .map(({ storedIn }) => storedIn),
    );
    await this.commitAll(hosts);
  }

  // ------------------------------------------------------------------ anchors

  /**
   * Re-finds each thread's snippet in the document the first time it becomes
   * visible. Threads are created at their recorded line, which is right until
   * the file changes underneath them — a rebase, a `git checkout`, or an edit
   * made while the file was closed. Searching outward from the recorded line
   * recovers the common cases and flags the rest as drifted rather than pointing
   * confidently at the wrong code.
   */
  private reanchor(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    if (this.reanchored.has(key)) return;
    const target = this.resolveTarget(document.uri);
    if (!target) return;
    const branch = this.branchForTarget(target);
    if (!branch) return;
    this.reanchored.add(key);
    const touched = new Set<string>();
    for (const { storedIn, thread: stored } of this.threadsForBranch(branch)) {
      if (stored.file !== target.file || stored.side !== target.side) continue;
      if (stored.startLine === undefined || !stored.snippet) continue;
      // Matched on the exact document, not just file and side: two base-side
      // revisions of one file are different documents, and a thread written
      // against one must not be re-anchored against the other's content.
      const entry = this.live.get(stored.id);
      if (!entry || entry.uri !== key) continue;
      const thread = entry.thread;
      const origin = thread.range?.start.line ?? stored.startLine - 1;
      const found = findSnippet(document, stored.snippet, origin);
      const wasDrifted = stored.drifted === true;
      if (found) {
        thread.range = found;
        stored.startLine = found.start.line + 1;
        stored.endLine = found.end.line + 1;
        stored.drifted = undefined;
      } else {
        stored.drifted = true;
      }
      if (wasDrifted !== (stored.drifted === true)) touched.add(storedIn);
      this.decorate(thread, stored);
    }
    if (touched.size > 0) void this.commitAll(touched);
  }

  // -------------------------------------------------------------------- state

  /** `uri` is the document the thread attaches to; see `LiveThread`. */
  private materialise(uri: vscode.Uri, stored: StoredThread): void {
    if (this.live.has(stored.id)) return;
    const line = Math.max(0, (stored.startLine ?? 1) - 1);
    const endLine = Math.max(line, (stored.endLine ?? stored.startLine ?? 1) - 1);
    const thread = this.controller.createCommentThread(
      uri,
      new vscode.Range(line, 0, endLine, 0),
      stored.comments.map(
        (c) =>
          new ReviewComment(
            c.id,
            c.body,
            vscode.CommentMode.Preview,
            this.authorInfo(c.author),
          ),
      ),
    );
    if (stored.startLine === undefined) thread.range = undefined;
    for (const c of thread.comments) {
      if (c instanceof ReviewComment) c.parent = thread;
    }
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    this.decorate(thread, stored);
    this.track(thread, stored.id, uri);
  }

  /**
   * Base-side comments point at the virtual document rather than the file on
   * disk, so a comment on a line the change deleted still resolves. The URI must
   * reproduce the one `openDiff` builds — including its ref — or the thread
   * lands on a second virtual document instead of overlaying the diff.
   *
   * If the merge-base later moves, `openDiff` opens a newer ref and the thread
   * stays attached to the revision it was written against. It remains visible in
   * the Comments panel and in the export; it just no longer overlays the
   * refreshed diff.
   */
  private uriFor(worktreePath: string, stored: StoredThread): vscode.Uri {
    if (stored.side === 'base') {
      return buildGitUri(worktreePath, stored.baseRef ?? 'HEAD', stored.file);
    }
    if (stored.side === 'pr') {
      // The PR number is what identifies a description, and the file name is
      // where it is kept.
      const number = prNumberFromFileName(stored.file);
      const branch = stored.branch ?? this.branchOf(worktreePath);
      if (number !== undefined && branch !== undefined) {
        return buildPrBodyUri(worktreePath, number, branch);
      }
      log().warn(`comments: thread ${stored.id} names no pull request`);
    }
    return vscode.Uri.file(path.join(worktreePath, stored.file));
  }

  private decorate(thread: vscode.CommentThread, stored: StoredThread): void {
    thread.contextValue = 'reviewThread';
    thread.state = stored.resolved
      ? vscode.CommentThreadState.Resolved
      : vscode.CommentThreadState.Unresolved;
    // Names the destination rather than the activity: the GitHub PR extension
    // registers its own controllers on these same documents, and a header
    // reading "Review" is indistinguishable from one of its threads. A note
    // names its source instead, since it travels the other way.
    const heading =
      stored.kind === 'note'
        ? `From ${stored.comments[0]?.author ?? DEFAULT_AGENT_AUTHOR}`
        : 'For Claude';
    const parts: string[] = [];
    if (stored.side === 'base') parts.push('base');
    if (stored.startLine === undefined) parts.push('whole file');
    if (stored.drifted) parts.push('anchor drifted');
    thread.label = parts.length > 0 ? `${heading} (${parts.join(', ')})` : heading;
  }

  private authorInfo(name: string): vscode.CommentAuthorInformation {
    if (name === this.authorName) return { name };
    return { name, iconPath: this.agentIcon };
  }

  private track(thread: vscode.CommentThread, id: string, uri: vscode.Uri): void {
    this.live.set(id, { thread, uri: uri.toString() });
    this.threadIds.set(thread, id);
  }

  private disposeThread(id: string): void {
    const entry = this.live.get(id);
    if (!entry) return;
    this.live.delete(id);
    this.threadIds.delete(entry.thread);
    entry.thread.dispose();
  }

  /** Resolves a live thread to the store file that owns it, not the one shown. */
  private locate(
    thread: vscode.CommentThread,
  ): { worktreePath: string; stored: StoredThread } | undefined {
    const id = this.threadIds.get(thread);
    if (!id) return undefined;
    for (const worktreePath of this.store.loadedWorktrees()) {
      const stored = this.store.find(worktreePath, id);
      if (stored) return { worktreePath, stored };
    }
    return undefined;
  }

  // ------------------------------------------------------------------- readers

  /**
   * Comments on the worktree's current branch, gathered from every store file
   * that holds them — a branch reviewed in one worktree keeps its comments when
   * checked out in another.
   */
  threadsFor(worktreePath: string): StoredThread[] {
    const branch = this.branchOf(worktreePath);
    if (!branch) return [];
    return this.threadsOnBranch(branch);
  }

  /**
   * Comments on a named branch, whether or not any worktree has it checked out.
   * Every store file is searched, since a comment stays in the file of the
   * worktree it was written in.
   */
  threadsOnBranch(branch: string): StoredThread[] {
    return sortThreads(this.threadsForBranch(branch).map((l) => l.thread));
  }

  countFor(worktreePath: string): { total: number; unresolved: number } {
    const threads = this.threadsFor(worktreePath);
    return {
      total: threads.length,
      unresolved: threads.filter((t) => !t.resolved).length,
    };
  }

  branchFor(worktreePath: string): string | undefined {
    return this.branchOf(worktreePath);
  }

  storePath(worktreePath: string): string {
    return storePathFor(worktreePath);
  }

  inboxPath(worktreePath: string): string {
    return inboxPathFor(worktreePath);
  }

  /**
   * Store files holding comments for this worktree's branch. Usually just the
   * worktree's own, but a branch moved between worktrees leaves its comments in
   * the file where they were written.
   */
  storePathsFor(worktreePath: string): string[] {
    const branch = this.branchOf(worktreePath);
    if (!branch) return [storePathFor(worktreePath)];
    const hosts = new Set(this.threadsForBranch(branch).map((l) => l.storedIn));
    if (hosts.size === 0) hosts.add(worktreePath);
    return Array.from(hosts).sort().map(storePathFor);
  }

  buildExport(
    worktreePath: string,
    meta: ExportMeta,
  ): {
    worktree: string;
    branch?: string;
    base?: string;
    baseSha?: string;
    generatedAt: string;
    comments: ExportedComment[];
  } {
    for (const p of this.store.loadedWorktrees()) this.syncRanges(p);
    const comments = this.threadsFor(worktreePath).map<ExportedComment>((t) => ({
      id: t.id,
      kind: t.kind,
      file: t.file,
      side: t.side,
      startLine: t.startLine,
      endLine: t.endLine,
      // A description is not a file in the worktree, so whether the diff
      // touches it is not a question with an answer.
      inDiff: t.side === 'pr' ? undefined : meta.changed?.has(t.file),
      resolved: t.resolved,
      anchorDrifted: t.drifted ? true : undefined,
      snippet: t.snippet,
      messages: t.comments.map((c) => ({ author: c.author, body: c.body })),
    }));
    return {
      worktree: worktreePath,
      // Comments are scoped by branch, so this names what the export covers
      // rather than merely describing the worktree it was taken from.
      branch: this.branchOf(worktreePath) ?? meta.branch,
      base: meta.base,
      baseSha: meta.baseSha,
      generatedAt: new Date().toISOString(),
      comments,
    };
  }

  // ------------------------------------------------------------- agent inbox

  /**
   * Applies a batch an agent wrote to the inbox: resolutions of existing
   * threads, and notes that open new ones.
   *
   * Resolutions are matched by thread id against every loaded store, not just
   * the inbox's own worktree: comments follow their branch, so the thread an
   * agent read from one worktree's export may be stored in another's file. A
   * note goes on the branch the inbox's worktree has checked out, and is
   * stored there.
   *
   * Entries that cannot be applied — an id that matches nothing, a note on a
   * file that is not there — are written to `resolutions.rejected.json` with
   * the reason instead of being dropped. An agent that resolves a deleted or
   * mistyped id would otherwise get silence and assume success.
   */
  private async applyInbox(
    worktreePath: string,
    entries: InboxEntry[],
  ): Promise<void> {
    await this.ready();
    const touched = new Set<string>();
    const rebuilt: string[] = [];
    const rejected: (InboxEntry & { reason: string })[] = [];
    let resolvedCount = 0;
    let replyCount = 0;
    let noteCount = 0;

    for (const entry of entries) {
      if (isNoteEntry(entry)) {
        const outcome = await this.openNote(worktreePath, entry);
        if (typeof outcome === 'string') {
          rejected.push({ ...entry, reason: outcome });
          continue;
        }
        this.store.add(worktreePath, outcome);
        touched.add(worktreePath);
        noteCount += 1;
        continue;
      }
      const found = this.findAnywhere(entry.id);
      if (!found) {
        rejected.push({ ...entry, reason: 'no thread with this id' });
        continue;
      }
      const { storedIn, thread: stored } = found;
      if (entry.resolved !== undefined && stored.resolved !== entry.resolved) {
        stored.resolved = entry.resolved;
        resolvedCount += 1;
      }
      if (entry.reply) {
        const author = entry.author ?? DEFAULT_AGENT_AUTHOR;
        const last = stored.comments[stored.comments.length - 1];
        // A claim/append race can only ever replay the tail; skip an identical
        // repeat rather than posting the same reply twice.
        if (!last || last.body !== entry.reply || last.author !== author) {
          stored.comments.push({
            id: this.store.newId(),
            author,
            body: entry.reply,
            createdAt: new Date().toISOString(),
          });
          replyCount += 1;
        }
      }
      touched.add(storedIn);
      rebuilt.push(stored.id);
    }

    if (rejected.length > 0) {
      log().warn(
        `inbox: ${rejected.length} entry(s) could not be applied: ${rejected.map((r) => r.reason).join('; ')}`,
      );
      await fsp
        .writeFile(
          rejectedPathFor(worktreePath),
          `${JSON.stringify({ entries: rejected }, null, 2)}\n`,
          'utf8',
        )
        .catch(() => undefined);
    }

    if (touched.size === 0) {
      if (rejected.length > 0) {
        void vscode.window.showWarningMessage(
          `Worktree Stack Reviewer: ${rejected.length} inbox entry(s) could not be applied. See resolutions.rejected.json.`,
        );
      }
      return;
    }

    // Rebuild the affected threads so replies and resolved state reach the UI;
    // a live thread's comment list is not re-read from the store otherwise.
    // New notes have no live thread yet; `reconcile` materialises them.
    for (const id of rebuilt) this.disposeThread(id);
    await this.commitAll(touched);
    this.reconcile();

    const parts: string[] = [];
    if (noteCount > 0) parts.push(`${noteCount} note(s) added`);
    if (resolvedCount > 0) parts.push(`resolved ${resolvedCount}`);
    if (replyCount > 0) parts.push(`replied to ${replyCount}`);
    if (rejected.length > 0) parts.push(`${rejected.length} rejected`);
    void vscode.window.showInformationMessage(
      `Worktree Stack Reviewer: ${parts.join(', ') || 'no changes'} from agent.`,
    );
  }

  /**
   * Builds the thread a note entry describes, or returns the reason it cannot
   * be built. The range is checked against the file as it is on disk, since
   * the file need not be open — and a note whose lines are past the end of the
   * file is a wrong line number, which the writer should hear about rather
   * than have quietly moved.
   */
  private async openNote(
    worktreePath: string,
    entry: NoteEntry,
  ): Promise<StoredThread | string> {
    const branch = this.branchOf(worktreePath);
    if (!branch) return 'the worktree has no branch checked out';
    if (path.isAbsolute(entry.file) || entry.file.split('/').includes('..')) {
      return `file must be a path inside the worktree: ${entry.file}`;
    }
    let lines: string[];
    try {
      const raw = await fsp.readFile(path.join(worktreePath, entry.file), 'utf8');
      lines = raw.split('\n');
    } catch (err) {
      return `cannot read ${entry.file}: ${describeError(err)}`;
    }
    let startLine: number | undefined;
    let endLine: number | undefined;
    let snippet: string | undefined;
    if (entry.startLine !== undefined) {
      startLine = entry.startLine;
      endLine = Math.max(startLine, entry.endLine ?? startLine);
      endLine = Math.min(endLine, startLine + MAX_SNIPPET_LINES - 1);
      if (endLine > lines.length) {
        return `${entry.file} has ${lines.length} lines; the note names line ${endLine}`;
      }
      snippet = entry.snippet ?? lines.slice(startLine - 1, endLine).join('\n');
    }
    const now = new Date().toISOString();
    return {
      id: this.store.newId(),
      kind: 'note',
      branch,
      sha: await this.headShaOf(worktreePath, branch),
      file: entry.file,
      side: 'working',
      startLine,
      endLine,
      snippet,
      resolved: false,
      createdAt: now,
      comments: [
        {
          id: this.store.newId(),
          author: entry.author ?? DEFAULT_AGENT_AUTHOR,
          body: entry.body,
          createdAt: now,
        },
      ],
    };
  }

  private findAnywhere(threadId: string): LocatedThread | undefined {
    for (const storedIn of this.store.loadedWorktrees()) {
      const thread = this.store.find(storedIn, threadId);
      if (thread) return { storedIn, thread };
    }
    return undefined;
  }

  /** Drains any pending inbox immediately; used by the manual command. */
  async applyPendingResolutions(): Promise<void> {
    await this.ready();
    for (const w of this.worktrees) await this.inbox.drain(w.path);
  }

  // ------------------------------------------------------------------ pruning

  /**
   * Archives comments whose branch no longer exists locally. Branches are
   * repo-wide, so a comment survives as long as its branch is checked out or
   * merely present in any worktree. Nothing is deleted outright — see
   * `ARCHIVE_REL_PATH`.
   */
  async prune(): Promise<{ archived: number; branches: string[] }> {
    await this.ready();
    let branches: Set<string>;
    try {
      branches = await listLocalBranches(this.repoPath);
    } catch (err) {
      log().error(`comments: prune skipped, git branch failed: ${describeError(err)}`);
      return { archived: 0, branches: [] };
    }
    // A repo with no branches means something went wrong reading git, not that
    // every comment is stale. Refuse to archive everything on that basis.
    if (branches.size === 0) {
      log().warn('comments: prune skipped, git reported no local branches');
      return { archived: 0, branches: [] };
    }

    const removed: string[] = [];
    let archived = 0;
    for (const storedIn of this.store.loadedWorktrees()) {
      const stale = this.store
        .threads(storedIn)
        .filter((t) => t.branch && !branches.has(t.branch));
      if (stale.length === 0) continue;
      try {
        await this.store.archive(storedIn, stale, 'branch no longer exists locally');
      } catch {
        // Archiving failed; leave the comments in place rather than lose them.
        continue;
      }
      for (const t of stale) {
        this.store.remove(storedIn, t.id);
        this.disposeThread(t.id);
        if (t.branch && !removed.includes(t.branch)) removed.push(t.branch);
      }
      archived += stale.length;
      await this.commit(storedIn);
    }
    if (archived > 0) {
      log().info(
        `comments: archived ${archived} thread(s) from gone branches: ${removed.join(', ')}`,
      );
      this.reconcile();
    }
    return { archived, branches: removed };
  }

  /** Drops every thread and reloads from disk; used by the explicit refresh. */
  async invalidate(): Promise<void> {
    await this.ready();
    for (const id of Array.from(this.live.keys())) this.disposeThread(id);
    this.reanchored.clear();
    const worktrees = this.worktrees.map((w) => w.path);
    this.store.clear();
    await Promise.all(worktrees.map((p) => this.hydrate(p)));
    this.reconcile();
    for (const editor of vscode.window.visibleTextEditors) {
      this.reanchor(editor.document);
    }
    this._onDidChange.fire();
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}

function bodyText(body: string | vscode.MarkdownString): string {
  return typeof body === 'string' ? body : body.value;
}

/**
 * Command arguments arrive from VS Code's menu contributions, which are matched
 * by `when` clause rather than by type. These narrow at that boundary so a
 * misrouted invocation is a logged no-op instead of a crash.
 */
function asReviewComment(arg: unknown): ReviewComment | undefined {
  return arg instanceof ReviewComment ? arg : undefined;
}

function asCommentThread(arg: unknown): vscode.CommentThread | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const candidate = arg as vscode.CommentThread;
  return candidate.uri instanceof vscode.Uri && Array.isArray(candidate.comments)
    ? candidate
    : undefined;
}

function asCommentReply(arg: unknown): vscode.CommentReply | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const candidate = arg as vscode.CommentReply;
  return typeof candidate.text === 'string' && asCommentThread(candidate.thread)
    ? candidate
    : undefined;
}

/**
 * Expands a range to whole lines so the stored snippet and the re-anchor search
 * compare like for like, and caps it at the snippet limit so the two always
 * describe the same span — otherwise re-anchoring a truncated snippet would
 * silently shrink the comment's range. Returns undefined for file-level
 * comments.
 */
function normalizeRange(
  uri: vscode.Uri,
  range: vscode.Range | undefined,
): vscode.Range | undefined {
  if (!range) return undefined;
  const doc = findDocument(uri);
  if (!doc) return new vscode.Range(range.start.line, 0, range.end.line, 0);
  const start = Math.min(range.start.line, doc.lineCount - 1);
  let end = Math.min(range.end.line, doc.lineCount - 1);
  // A selection dragged to the start of the following line shouldn't claim it.
  if (end > start && range.end.character === 0) end -= 1;
  end = Math.min(end, start + MAX_SNIPPET_LINES - 1);
  return new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
}

function snippetFor(uri: vscode.Uri, range: vscode.Range): string | undefined {
  const doc = findDocument(uri);
  if (!doc) return undefined;
  const lines: string[] = [];
  for (let i = range.start.line; i <= range.end.line; i++) {
    lines.push(doc.lineAt(i).text);
  }
  return lines.join('\n');
}

function findDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
}

/**
 * Searches outward from `origin` for an exact full-line match of `snippet`,
 * preferring the closest hit so a repeated line elsewhere in the file doesn't
 * steal the anchor.
 */
function findSnippet(
  document: vscode.TextDocument,
  snippet: string,
  origin: number,
): vscode.Range | undefined {
  const lines = snippet.split('\n');
  const maxStart = document.lineCount - lines.length;
  if (maxStart < 0) return undefined;
  for (let delta = 0; delta <= REANCHOR_WINDOW_LINES; delta++) {
    for (const start of delta === 0 ? [origin] : [origin - delta, origin + delta]) {
      if (start < 0 || start > maxStart) continue;
      if (!matchesAt(document, lines, start)) continue;
      const endLine = start + lines.length - 1;
      return new vscode.Range(start, 0, endLine, document.lineAt(endLine).text.length);
    }
  }
  return undefined;
}

function matchesAt(
  document: vscode.TextDocument,
  lines: string[],
  start: number,
): boolean {
  for (let i = 0; i < lines.length; i++) {
    if (document.lineAt(start + i).text !== lines[i]) return false;
  }
  return true;
}
