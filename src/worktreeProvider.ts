import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  type ChangedFile,
  type StackInfo,
  type Worktree,
  checkoutBranch,
  createBranchAt,
  diffNameStatus,
  getCurrentBranch,
  getStackTrunk,
  getStack,
  isAgentWorktreeOnItsOwnBranch,
  listChangedFiles,
  listLocalBranches,
  listUncommittedChanges,
  listWorktrees,
  mainWorktreePath,
  mergeBaseOf,
  resolveMergeBase,
  revParse,
} from './git';
import { type ClaudeSession, liveSessionsIn } from './claudeSessions';
import type { ExportMeta, ReviewCommentController } from './commentController';
import type { StoredThread } from './commentStore';
import type { CompareLink } from './compareLink';
import {
  type OpenPr,
  listOpenPrs,
  prCommentCountsBySha,
} from './gh';
import { buildGitUri } from './gitContentProvider';
import { describeError, elapsed, log } from './log';
import {
  type PrBodyContentProvider,
  buildPrBodyUri,
  parsePrBodyUri,
  prBodyFileName,
  prBodySummary,
  prNumberFromFileName,
} from './prBody';
import {
  PREVIEW_EDITOR_VIEW_TYPE,
  type ReviewPreviewEditorProvider,
} from './previewEditor';
import { rowUri, undecoratedRowUri } from './rowUri';
import {
  type Bucket,
  type BucketTotals,
  type LocSummary,
  branchLocSummary,
} from './stackLoc';
import { type ResolvedStack, StackNameStore, stackPosition } from './stackNames';
import { WorktreeNameStore } from './worktreeNames';
import {
  type BranchVersion,
  type VersionDelta,
  type VersionListing,
  compareVersions,
  lastTouchedVersions,
  listVersions,
  versionForComment,
} from './versionHistory';
import { type ViewedStatus, ViewedStore } from './viewedStore';
import { WorktreeWatcher } from './watcher';

type Layout = 'flat' | 'tree';
type Node =
  | WorktreeNode
  | StackSectionNode
  | StackBranchNode
  | LocNode
  | PrBodyNode
  | VersionNode
  | CommentsSectionNode
  | CommentFileNode
  | CommentThreadNode
  | FolderNode
  | FileNode
  | MessageNode;

export interface OpenDiffArgs {
  worktreePath: string;
  base: string;
  file: ChangedFile;
}

interface TrieDir {
  files: ChangedFile[];
  dirs: Map<string, TrieDir>;
  /** Lines changed across this directory's whole subtree. */
  added: number;
  removed: number;
  /** Files in this subtree, and how many of them are marked viewed. */
  total: number;
  viewed: number;
}

/** Reports whether a changed file is marked viewed on its worktree's branch. */
type ViewedLookup = (file: ChangedFile) => ViewedStatus;

/**
 * Per-worktree computed state, keyed by HEAD sha. A branch switch moves only
 * that worktree's HEAD, so a refresh recomputes the changed worktree and reads
 * every other one from cache instead of re-running `git diff`.
 */
interface WorktreeCacheEntry {
  head: string;
  /** The checked-out branch, whose versions label the changed-file rows. */
  branch: string;
  stack?: StackInfo;
  changedFiles?: ChangedFile[];
  /** Diff base resolved for this worktree; retained for comment export. */
  base?: string;
}

/** A branch whose version listing the prefetcher still has to read. */
interface VersionTarget {
  worktreePath: string;
  branch: string;
  /** Some worktree is on this branch, so its listing labels that file list. */
  checkedOut: boolean;
}

/** A stack branch whose line counts the pass still has to work out. */
interface LocTarget {
  worktreePath: string;
  branch: string;
  parent: string;
}

const PR_CACHE_TTL_MS = 60_000;

/**
 * Quiet period after the last tree query before version prefetching starts.
 * The point is to stay out of the way of the initial worktree and diff load,
 * which is when the machine is busiest.
 */
const PREFETCH_SETTLE_MS = 2_000;

/**
 * How long the line-count pass waits before starting. Long enough to collect
 * the burst of expansions a single refresh produces, short enough that the
 * spinners on the LOC rows are not the first thing anyone reads.
 */
const LOC_COALESCE_MS = 50;

/**
 * How wide a collapsed branch row gets, name and line counts together. VS Code
 * drops a row's description before it truncates the label, so a long PR title
 * or branch name would push the line counts off the row entirely. The counts
 * are measured out of this budget first and the name takes what is left, so a
 * branch with wordier counts loses name rather than losing the counts. An
 * expanded row has the LOC row underneath carrying the same counts, so it gets
 * its name back in full.
 */
const BRANCH_ROW_MAX_CHARS = 70;

/** However wide the counts get, the name keeps enough to be recognisable. */
const BRANCH_NAME_MIN_CHARS = 24;

/**
 * Marks a row carrying inline review comments on its pull request.
 *
 * Both this and the mark below are plain typographic characters rather than
 * pictographs from the emoji block: no emoji font can claim them, so they stay
 * monochrome and take the row's own colour the way the checkout marks do.
 */
const GITHUB_COMMENT_MARK = '\u00B6';

/** Marks a row carrying review comments written in this extension. */
const LOCAL_COMMENT_MARK = '\u270E';

function branchNameBudget(description: string): number {
  return Math.max(BRANCH_NAME_MIN_CHARS, BRANCH_ROW_MAX_CHARS - description.length);
}

/**
 * The directory name that marks a worktree as the review checkout: any branch
 * in the tree can be checked out into it, so it can be read without disturbing
 * the worktree the branch is being written in. Empty disables the feature.
 */
function reviewWorktreeName(): string {
  return vscode.workspace
    .getConfiguration('worktreeReview')
    .get<string>('reviewWorktreeName', 'review')
    .trim();
}

/**
 * Matches on the directory name rather than the branch: checking a branch out
 * into the review worktree changes its branch, and the worktree has to stay
 * recognisable afterwards.
 */
function isReviewWorktree(worktreePath: string): boolean {
  const name = reviewWorktreeName();
  return name !== '' && path.basename(worktreePath) === name;
}

class WorktreeNode extends vscode.TreeItem {
  constructor(
    public readonly worktree: Worktree,
    public readonly base: string,
    public readonly baseSource: 'stack' | 'fallback',
    public readonly isReview: boolean,
    /** What this worktree's rows read: its own name, or its stack's. */
    name: string | undefined,
    /** The stack this worktree's branch belongs to, which numbers the row. */
    public readonly stack: ResolvedStack,
  ) {
    // A name is what the worktree is being thought of as, so it takes the row
    // and the branch moves into the description.
    super(name ?? worktree.branch, vscode.TreeItemCollapsibleState.Expanded);
    const baseLabel = base.replace(/^refs\/heads\//, '');
    this.id = `worktree:${worktree.path}`;
    const place = stackPlace(stack, worktree.branch, name !== undefined);
    const bits: string[] = [];
    // The branch is only spelt out here when the name has taken the row, but
    // its place in the stack is worth having either way. The base is left to
    // the tooltip: it is the same branch for every worktree in a stack, and
    // each branch row below says what it sits on.
    if (name) bits.push(`${place}${worktree.branch}`);
    else if (place) bits.push(place.trim());
    if (isReview) bits.push('review');
    this.description = bits.join('  ·  ');
    const tooltipLines = [worktree.path];
    if (name) tooltipLines.push(`branch: ${worktree.branch}`);
    tooltipLines.push(`base: ${baseLabel} (${baseSource})`);
    if (isReview) {
      tooltipLines.push(
        'Review worktree: any branch in the tree can be checked out here.',
      );
    }
    this.tooltip = tooltipLines.join('\n');
    // Menu entries that apply to any worktree match on the `worktree` prefix;
    // the review worktree's own reset action matches the whole value.
    this.contextValue = isReview ? 'worktree.review' : 'worktree';
    this.iconPath = new vscode.ThemeIcon(isReview ? 'eye' : 'git-branch');
    this.resourceUri = rowUri(worktree.path);
  }
}

class FolderNode extends vscode.TreeItem {
  constructor(
    public readonly worktreePath: string,
    public readonly base: string,
    public readonly relPath: string,
    public readonly trie: TrieDir,
    displayName: string,
  ) {
    super(displayName, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `folder:${worktreePath}:${relPath}`;
    this.iconPath = vscode.ThemeIcon.Folder;
    this.resourceUri = rowUri(path.join(worktreePath, relPath));
    const bits = [lineCountLabel(trie.added, trie.removed)];
    // Only once something in here has been reviewed: "0/5 viewed" on every
    // folder of an untouched worktree is noise.
    if (trie.viewed > 0) bits.push(`${trie.viewed}/${trie.total} viewed`);
    this.description = bits.filter((b) => b).join('  ·  ');
    this.tooltip = relPath;
    this.contextValue = 'folder';
  }
}

class FileNode extends vscode.TreeItem {
  constructor(
    public readonly worktreePath: string,
    public readonly base: string,
    public readonly file: ChangedFile,
    showDir: boolean,
    /** Version of the branch that last changed this file, when known. */
    lastVersion: number | undefined,
    viewedStatus: ViewedStatus,
  ) {
    super(path.basename(file.path), vscode.TreeItemCollapsibleState.None);
    this.id = `file:${worktreePath}:${file.path}`;
    const dir = path.dirname(file.path);
    const bits: string[] = [file.status];
    if (showDir && dir !== '.') bits.push(dir);
    const counts = lineCountLabel(file.added, file.removed);
    if (counts) bits.push(counts);
    const provenance = provenanceLabel(file, lastVersion);
    if (provenance) bits.push(provenance);
    if (viewedStatus.baseMoved) bits.push('rebased since viewed');
    this.description = bits.join('  ');
    this.tooltip = fileTooltip(file, lastVersion, viewedStatus);
    this.resourceUri = rowUri(path.join(worktreePath, file.path));
    // A file with no patch id has no identity to mark viewed against, so it
    // gets no checkbox rather than one that would never stay ticked.
    if (file.patchId) {
      this.checkboxState = viewedStatus.viewed
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
    }
    const args: OpenDiffArgs = { worktreePath, base, file };
    this.command = {
      command: 'worktreeReview.openDiff',
      title: 'Open Diff',
      arguments: [args],
    };
    // Deleted files have no working-tree copy, so they get no inline
    // open-file action.
    this.contextValue = file.status === 'D' ? 'fileDeleted' : 'file';
  }
}

class MessageNode extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'message';
  }
}

interface StackEntry {
  branch: string;
  /** The branch this one sits on, which its line counts are measured against. */
  parent: string;
  pr?: OpenPr;
}

/**
 * Pairs each branch in a stack with the branch it sits on. Trunk is dropped
 * from the result — it has no change of its own to show — but remains the
 * parent of whichever branches sit directly on it. A worktree whose stack
 * could not be read falls back to its own branch sitting on trunk.
 */
function stackEntries(
  stack: StackInfo | undefined,
  worktreeBranch: string,
  trunk: string,
): { branch: string; parent: string }[] {
  // A worktree sitting on trunk has no stack of its own: every stack shares
  // trunk, so it belongs to none of them in particular.
  if (worktreeBranch === trunk) return [];
  const branches =
    stack && stack.branches.length > 0 ? stack.branches : [worktreeBranch];
  return branches
    .filter((branch) => branch !== trunk)
    .map((branch) => ({ branch, parent: stack?.parents.get(branch) ?? trunk }));
}

/**
 * The stack's branches ordered bottom of stack first, which is how a stack's
 * membership is stored and how its rows are numbered. The tree draws them the
 * other way up, tip first, so the bottom row of a stack is `1/N`.
 */
function stackChain(
  stack: StackInfo | undefined,
  worktreeBranch: string,
  trunk: string,
): string[] {
  return stackEntries(stack, worktreeBranch, trunk)
    .map((entry) => entry.branch)
    .reverse();
}

/**
 * Where a branch sits in its stack, as a `2/3 ` prefix ready to lead a row —
 * empty when there is nothing to say. A lone branch is numbered only once a
 * name has taken the row and pushed the branch into the description: `1/1`
 * beside the branch itself says nothing the row does not already show.
 */
function stackPlace(stack: ResolvedStack, branch: string, named: boolean): string {
  const position = stackPosition(stack, branch);
  if (position === 0) return '';
  if (!named && stack.members.length === 1) return '';
  return `${position}/${stack.members.length} `;
}

class StackSectionNode extends vscode.TreeItem {
  constructor(
    public readonly worktreePath: string,
    public readonly currentBranch: string,
    public readonly entries: StackEntry[],
    /** What this worktree's rows read: its own name, or its stack's. */
    public readonly name: string | undefined,
    /** The pinned membership the branch rows are numbered against. */
    public readonly stack: ResolvedStack,
    public readonly errorMessage: string | undefined,
  ) {
    super('Stack', vscode.TreeItemCollapsibleState.Expanded);
    const prCount = entries.filter((e) => e.pr).length;
    this.id = `stack:${worktreePath}`;
    const bits: string[] = [];
    if (name) bits.push(name);
    bits.push(count(entries.length, 'branch', 'branches'));
    bits.push(
      errorMessage ? 'gh failed' : count(prCount, 'open PR', 'open PRs'),
    );
    this.description = bits.join(' · ');
    this.tooltip = stackTooltip(name, stack, entries.length);
    this.iconPath = new vscode.ThemeIcon('git-pull-request');
    this.contextValue = 'stack';
  }
}

/**
 * Says what the stack is called and, when branches it was named with have
 * since merged away, why the height is larger than the number of rows. A stack
 * whose rows read under no name has nothing to say that its row does not
 * already show.
 */
function stackTooltip(
  name: string | undefined,
  stack: ResolvedStack,
  liveBranches: number,
): string | undefined {
  if (!name) return undefined;
  const lines = [`Stack "${name}"`];
  const gone = stack.members.length - liveBranches;
  if (gone > 0) {
    lines.push(
      `${stack.members.length} branches counted, ${count(gone, 'branch', 'branches')} no longer in the stack.`,
    );
  }
  return lines.join('\n');
}

/**
 * A branch in the stack, whether or not it has an open PR. Expanding it gives
 * the branch's full line counts and its versions (its commit's amend history).
 *
 * The row itself carries only the source line counts. A tree item is a single
 * line, and a PR title has already used most of it — the other two buckets go
 * in the tooltip and on the LOC row underneath.
 */
class StackBranchNode extends vscode.TreeItem {
  /** The label in full, for restoring it when the row is expanded. */
  private readonly fullName: string;

  /** The label cut to what the line counts leave, for when it is collapsed. */
  private readonly shortName: string;

  constructor(
    public readonly worktreePath: string,
    public readonly currentBranch: string,
    public readonly branch: string,
    public readonly parent: string,
    public readonly pr: OpenPr | undefined,
    /** What the holding worktree's rows read: its own name, or its stack's. */
    rowName: string | undefined,
    /** The pinned membership this row is numbered against. */
    stack: ResolvedStack,
    loc: LocState,
    expanded: boolean,
    inReview: boolean,
    /** The worktree holding this branch, when it is not this row's own. */
    heldBy: Worktree | undefined,
    comments: BranchComments,
  ) {
    // The row's icon says PR or plain branch, so the marks for who has the
    // branch checked out go in the label: `★` for this worktree, `◉` for the
    // review worktree, `※` for any other worktree. All three are text-
    // presentation characters, so they take the row's own colour instead of
    // arriving as coloured emoji.
    const star = branch === currentBranch ? '★ ' : '';
    const eye = inReview ? '◉ ' : '';
    const elsewhere = heldBy ? '※ ' : '';
    // The two comment marks lead the rest: they are about the branch itself
    // rather than about where it happens to be checked out. Each source gets
    // its own character, since they are read in different places — the
    // paragraph mark on GitHub, the pencil in this extension.
    const github = comments.github > 0 ? `${GITHUB_COMMENT_MARK} ` : '';
    const local = comments.local > 0 ? `${LOCAL_COMMENT_MARK} ` : '';
    const marks = `${github}${local}${elsewhere}${eye}${star}`;
    // Where this branch sits in the stack, leading the row so it survives a
    // narrow view.
    const place = stackPlace(stack, branch, rowName !== undefined);
    const label = pr
      ? `${place}#${pr.number} ${marks}${pr.title.trim()}`
      : `${place}${marks}${branch}`;
    // A branch with no PR says so with the git-branch icon in place of a
    // pull-request one, so the description carries only the line counts.
    const rowCounts = sourceLabel(loc);
    const shortName = truncate(label, branchNameBudget(rowCounts));
    super(
      expanded ? label : shortName,
      expanded
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.fullName = label;
    this.shortName = shortName;
    this.id = `stackbranch:${worktreePath}:${branch}`;
    this.description = rowCounts;
    this.iconPath = new vscode.ThemeIcon(stackBranchIcon(pr));
    const counts = locDetail(loc);
    const reviewNote = inReview ? 'Checked out in the review worktree.' : '';
    const heldNote = heldBy
      ? `Checked out in the "${path.basename(heldBy.path)}" worktree.`
      : '';
    const prLink = pr ? pr.url : '';
    const commentNote = branchCommentNote(comments);
    // The label drops the ticket prefix, so the tooltip is where the whole title
    // stays readable.
    const stackNote = rowName
      ? `Stack "${rowName}" · ${stackPosition(stack, branch)}/${stack.members.length}`
      : '';
    this.tooltip = pr
      ? new vscode.MarkdownString(
          `**#${pr.number}** ${pr.title}\n\n` +
            `\`${pr.baseRefName}\` ← \`${pr.headRefName}\`` +
            (pr.author ? ` · @${pr.author}` : '') +
            (pr.isDraft ? ' · draft' : '') +
            (stackNote ? `\n\n${stackNote}` : '') +
            (reviewNote ? `\n\n${reviewNote}` : '') +
            (heldNote ? `\n\n${heldNote}` : '') +
            (commentNote ? `\n\n${commentNote}` : '') +
            `\n\n${counts}` +
            `\n\n[${prLink}](${prLink})`,
        )
      : [branch, stackNote, reviewNote, heldNote, commentNote, 'No open PR.', counts]
          .filter((line) => line)
          .join('\n');
    this.contextValue = pr ? 'pr' : 'branch';
  }

  /**
   * Swaps between the shortened and the full label without rebuilding the row,
   * so an expand or collapse can be reflected by re-reading this item alone.
   */
  showFullName(full: boolean): void {
    this.label = full ? this.fullName : this.shortName;
    this.collapsibleState = full
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
  }
}

/**
 * What a branch row has to say about comments: review notes written here, and
 * inline review comments on its pull request. Both are counted so the tooltip
 * can name which of the two put the mark on the row.
 */
interface BranchComments {
  local: number;
  localOpen: number;
  github: number;
}

/** Review comments this extension holds against one patch. */
interface PatchComments {
  total: number;
  open: number;
}

/** A branch's line counts, or how far along working them out has got. */
interface LocState {
  summary?: LocSummary;
  error?: string;
}

/**
 * Lines a branch's own commits change, as `gt loc` counts them, split into
 * source, test, docs, and generated. This counts committed work only, so every
 * row in a stack means the same thing — a worktree's changed-file list below
 * can show more when it is including uncommitted edits.
 */
class LocNode extends vscode.TreeItem {
  constructor(
    public readonly worktreePath: string,
    public readonly branch: string,
    parent: string,
    state: LocState,
  ) {
    super('LOC', vscode.TreeItemCollapsibleState.None);
    this.id = `loc:${worktreePath}:${branch}`;
    this.contextValue = 'loc';
    const parentLabel = parent.replace(/^refs\/heads\//, '');
    if (state.error) {
      this.iconPath = new vscode.ThemeIcon('warning');
      this.description = shortError(state.error);
      this.tooltip = `Could not count lines on ${branch}: ${state.error}`;
      return;
    }
    if (!state.summary) {
      this.iconPath = new vscode.ThemeIcon('loading~spin');
      this.description = '…';
      this.tooltip = `Counting what ${branch} changes vs ${parentLabel}…`;
      return;
    }
    this.iconPath = new vscode.ThemeIcon('diff');
    this.description =
      state.summary.files === 0
        ? `no changes vs ${parentLabel}`
        : locLabel(state.summary);
    this.tooltip = locTooltip(branch, parentLabel, state.summary);
  }
}

/**
 * A pull request's description, rendered on click in the review preview. The
 * row itself carries the description's opening paragraph, which is the part
 * that says what the branch is for.
 *
 * It appears in two places. Under a stack branch it is a `Description` row.
 * Under a worktree it stands at the top of the file list as the virtual file
 * `PR-<n>.md`, the same name its tab carries, since the description is the
 * first thing to read about the change the files below make.
 */
class PrBodyNode extends vscode.TreeItem {
  constructor(
    public readonly worktreePath: string,
    public readonly pr: OpenPr,
    asFile = false,
  ) {
    super(
      asFile ? prBodyFileName(pr.number) : 'Description',
      vscode.TreeItemCollapsibleState.None,
    );
    this.id = `${asFile ? 'prbodyfile' : 'prbody'}:${worktreePath}:${pr.number}`;
    this.contextValue = 'prBody';
    if (asFile) {
      // A `.md` name with the file theme icon draws the markdown file icon; the
      // path exists nowhere, so it is kept clear of decorations.
      this.resourceUri = undecoratedRowUri(
        path.join(worktreePath, prBodyFileName(pr.number)),
      );
      this.iconPath = vscode.ThemeIcon.File;
    } else {
      this.iconPath = new vscode.ThemeIcon('book');
    }
    // Opens even when empty: the conversation below the description can
    // still have something to read.
    if (pr.body.trim() === '') {
      this.description = 'no description';
      this.tooltip = `#${pr.number} has no description; open it for the PR's comments.`;
    } else {
      this.description = prBodySummary(pr.body);
      this.tooltip = `Open #${pr.number}'s description and comments in the review preview.`;
    }
    this.command = {
      command: 'worktreeReview.openPrBody',
      title: 'Open PR Description',
      arguments: [this],
    };
  }
}

class VersionNode extends vscode.TreeItem {
  constructor(
    public readonly worktreePath: string,
    public readonly branch: string,
    public readonly v: BranchVersion,
    /** Inline PR review comments written against this version's commit. */
    public readonly prComments: number,
    /** Comments written in this extension while this version was the tip. */
    public readonly localComments: PatchComments,
  ) {
    // The icon slot already carries current-vs-earlier, so the comment marks go
    // in the label, the way the stack rows mark a branch with a star. They are
    // the same two characters those rows use, in the same order.
    const github = prComments > 0 ? `${GITHUB_COMMENT_MARK} ` : '';
    const local = localComments.total > 0 ? `${LOCAL_COMMENT_MARK} ` : '';
    super(`${github}${local}p${v.version}`, vscode.TreeItemCollapsibleState.None);
    this.id = `version:${worktreePath}:${branch}:${v.version}`;
    const bits: string[] = [];
    if (v.current) bits.push('current');
    bits.push(v.action);
    if (v.pushed) {
      bits.push(v.push_seq !== undefined ? `push #${v.push_seq}` : 'pushed');
    }
    const delta = deltaLabel(v.delta);
    if (delta) bits.push(delta);
    bits.push(v.date.slice(0, 16).replace('T', ' '));
    this.description = bits.join(' · ');
    this.iconPath = new vscode.ThemeIcon(
      v.current ? 'circle-filled' : 'circle-outline',
    );
    this.tooltip = versionTooltip(branch, v, prComments, localComments);
    this.contextValue = v.version === 1 ? 'versionFirst' : 'version';
    this.command = {
      command: 'worktreeReview.compareVersionWithBase',
      title: 'Show Version Diff (vs Base)',
      arguments: [this],
    };
  }
}

/**
 * The two branches a comment row opens a diff between: the branch the comments
 * belong to and the branch it sits on. Carried by the Comments section under a
 * stack branch row, where the branch need not be checked out anywhere; absent
 * under a worktree row, where a comment opens the file on disk instead.
 */
interface CommentDiff {
  branch: string;
  parent: string;
}

class CommentsSectionNode extends vscode.TreeItem {
  constructor(
    public readonly worktreePath: string,
    public readonly base: string,
    public readonly branch: string,
    public readonly threads: StoredThread[],
    public readonly diff: CommentDiff | undefined,
  ) {
    const unresolved = threads.filter((t) => !t.resolved).length;
    super(
      `Comments (${unresolved} open / ${threads.length})`,
      // Collapsed under a branch row, which already carries several sections
      // and a version list; expanded under a worktree, where it is the review
      // list for the branch in hand.
      diff
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.Expanded,
    );
    this.id = diff
      ? `branchcomments:${worktreePath}:${branch}`
      : `comments:${worktreePath}`;
    this.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.tooltip = diff
      ? `Comments on "${branch}". Opening one shows it on the diff against ${diff.parent.replace(/^refs\/heads\//, '')}, so the branch needs no worktree of its own.`
      : `Comments on "${branch}". They follow the branch, so checking it out in another worktree brings them along.`;
    this.contextValue = diff ? 'branchComments' : 'comments';
  }
}

/**
 * Groups a worktree's comments by file. This is deliberately a separate subtree
 * rather than badges on the changed-file list: comments are allowed on files
 * that aren't in the diff, and those would otherwise have nowhere to appear.
 */
class CommentFileNode extends vscode.TreeItem {
  constructor(
    public readonly worktreePath: string,
    public readonly base: string,
    public readonly file: string,
    public readonly threads: StoredThread[],
    inDiff: boolean,
    public readonly diff: CommentDiff | undefined,
  ) {
    // Threads on a PR description are grouped under the PR rather than under a
    // path: the description is text on GitHub, and no file in the worktree
    // holds it.
    const prNumber = prNumberFromFileName(file);
    super(
      prNumber === undefined ? path.basename(file) : `#${prNumber}`,
      vscode.TreeItemCollapsibleState.Expanded,
    );
    this.id = diff
      ? `branchcommentfile:${worktreePath}:${diff.branch}:${file}`
      : `commentfile:${worktreePath}:${file}`;
    this.contextValue = 'commentFile';
    if (prNumber !== undefined) {
      this.description = 'description';
      this.tooltip = `Comments on #${prNumber}'s description.`;
      this.iconPath = new vscode.ThemeIcon('book');
      return;
    }
    const dir = path.dirname(file);
    const bits: string[] = [];
    if (dir !== '.') bits.push(dir);
    if (!inDiff) bits.push('not in diff');
    this.description = bits.join('  ·  ');
    const against = diff
      ? diff.parent.replace(/^refs\/heads\//, '')
      : base.replace(/^refs\/heads\//, '');
    this.tooltip = inDiff ? file : `${file}\n(unchanged vs ${against})`;
    this.resourceUri = rowUri(path.join(worktreePath, file));
    this.iconPath = vscode.ThemeIcon.File;
  }
}

class CommentThreadNode extends vscode.TreeItem {
  constructor(
    public readonly worktreePath: string,
    public readonly base: string,
    public readonly thread: StoredThread,
    public readonly diff: CommentDiff | undefined,
  ) {
    super(firstLine(thread.comments[0]?.body ?? '(empty)'), vscode.TreeItemCollapsibleState.None);
    this.id = diff
      ? `branchcommentthread:${worktreePath}:${diff.branch}:${thread.id}`
      : `commentthread:${worktreePath}:${thread.id}`;
    const where =
      thread.startLine === undefined
        ? 'file'
        : thread.startLine === thread.endLine
          ? `L${thread.startLine}`
          : `L${thread.startLine}-${thread.endLine}`;
    const flags: string[] = [where];
    if (thread.side === 'base') flags.push('base');
    if (thread.drifted) flags.push('drifted');
    if (thread.comments.length > 1) flags.push(`${thread.comments.length} replies`);
    this.description = flags.join(' · ');
    this.iconPath = new vscode.ThemeIcon(threadIcon(thread));
    this.tooltip = new vscode.MarkdownString(
      thread.comments.map((c) => `**${c.author}**\n\n${c.body}`).join('\n\n---\n\n'),
    );
    this.contextValue = 'commentThread';
    this.command = {
      command: 'worktreeReview.revealComment',
      title: 'Reveal Comment',
      arguments: [this],
    };
  }
}

export class WorktreeProvider
  implements vscode.TreeDataProvider<Node>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly repoPath: string;
  private readonly watcher: WorktreeWatcher;
  private readonly viewed = new ViewedStore();
  private readonly stackNames = new StackNameStore();
  private readonly worktreeNames = new WorktreeNameStore();
  /** The worktree the repository-wide stores live in; resolved once. */
  private mainWorktree: string | undefined;
  private readonly worktreeCache = new Map<string, WorktreeCacheEntry>();
  private prCache: OpenPr[] | undefined;
  private prCacheError: string | undefined;
  private prCacheAt = 0;
  /** Review-comment counts per commit sha, keyed by PR number. */
  private readonly prCommentCache = new Map<
    number,
    { at: number; counts: Map<string, number> }
  >();
  /**
   * The worktree named by `reviewWorktreeName`, when the repo has one. Kept
   * whole rather than as a path: the branch it holds is what marks a stack row
   * as the one under review.
   */
  private reviewWorktree: Worktree | undefined;
  /**
   * Which worktree has each branch checked out. Git allows a branch in only one
   * worktree at a time, so this is one worktree per branch, and it is what marks
   * a stack row as being held somewhere other than where it is being read.
   */
  private branchHolders = new Map<string, Worktree>();
  private trunk: string | null = null;
  /**
   * Version listings keyed by branch (branches are shared across worktrees).
   * Each entry remembers the branch tip it was computed at: an amend or
   * restack moves the tip, which is exactly when the reflog grew.
   */
  private readonly versionCache = new Map<
    string,
    { tip: string; listing: VersionListing }
  >();
  /**
   * Listings being fetched, keyed by branch and tip. Expanding a branch the
   * prefetcher is already working on joins that run instead of starting a
   * second one.
   */
  private readonly versionsInFlight = new Map<string, Promise<VersionListing>>();
  private prefetchTimer: NodeJS.Timeout | undefined;
  private prefetching = false;
  /**
   * PRs the background pass has already asked about, whether or not the answer
   * arrived. Attempts are recorded rather than results so a PR whose comments
   * `gh` could not read is not retried on every settle.
   */
  private readonly prCommentsPrefetched = new Set<number>();
  private prefetchingPrComments = false;
  /** Why a branch's version listing could not be read, so its row says so. */
  /**
   * Line counts keyed by branch, remembering the branch tip and its parent's
   * local and remote tips when they were read. An amend moves the first and a
   * restack or fetch the others, and any of them can change what gt counts the
   * branch as changing.
   */
  private readonly locCache = new Map<
    string,
    { branchTip: string; parentTip: string; summary: LocSummary }
  >();
  private readonly locErrors = new Map<string, string>();
  /**
   * Paths each branch changes relative to the branch it sits on, keyed by the
   * two revisions they were measured between. Read only by the branch Comments
   * sections, to say which commented files the change itself touches.
   */
  private readonly branchFileCache = new Map<string, Set<string>>();
  private locTimer: NodeJS.Timeout | undefined;
  private locRunning = false;
  private locRerun = false;
  /**
   * Branch rows the view currently has open, as `worktreePath:branch`. Tracked
   * here because a rebuilt row has to come back with the name at the width its
   * state calls for, and a `TreeItem` cannot ask the view whether it is open.
   */
  private readonly expandedBranches = new Set<string>();

  constructor(
    private readonly comments: ReviewCommentController,
    private readonly prBodies: PrBodyContentProvider,
    private readonly preview: ReviewPreviewEditorProvider,
  ) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    this.repoPath = folder?.uri.fsPath ?? process.cwd();
    this.watcher = new WorktreeWatcher(() => this.refresh());
  }

  getTreeItem(element: Node): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    this.deferVersionPrefetch();
    if (!element) return this.getRootNodes();
    if (element instanceof WorktreeNode) return this.getWorktreeChildren(element);
    if (element instanceof StackSectionNode) return this.getStackChildren(element);
    if (element instanceof StackBranchNode) return this.getStackBranchChildren(element);
    if (element instanceof CommentsSectionNode) {
      return getCommentFileNodes(element, await this.commentedFilesInDiff(element));
    }
    if (element instanceof CommentFileNode) {
      return element.threads.map(
        (t) =>
          new CommentThreadNode(
            element.worktreePath,
            element.base,
            t,
            element.diff,
          ),
      );
    }
    if (element instanceof FolderNode) {
      return buildNodes(
        element.worktreePath,
        element.base,
        element.relPath,
        element.trie,
        this.lastVersionsFor(element.worktreePath),
        this.viewedLookup(element.worktreePath),
      );
    }
    return [];
  }

  /**
   * Viewed state for a worktree's files, bound to whichever branch it currently
   * has checked out. Comparing against the file's live patch id is what makes a
   * restack keep the tick and an amend drop it.
   */
  private viewedLookup(worktreePath: string): ViewedLookup {
    const branch = this.worktreeCache.get(worktreePath)?.branch;
    if (!branch) return () => ({ viewed: false, baseMoved: false });
    return (file) => this.viewed.status(branch, file.path, file.patchId, file.baseBlob);
  }

  /**
   * Which version of the worktree's branch last changed each file, read from
   * the version cache without waiting on it. The listing costs a
   * `gt-version-history` run, so the file rows render without these labels and
   * pick them up when the background prefetch lands. A cached listing computed
   * at a different tip is ignored: an amend both moves the tip and rewrites the
   * versions, so those labels would name the wrong patches.
   */
  private lastVersionsFor(worktreePath: string): Map<string, number> {
    const entry = this.worktreeCache.get(worktreePath);
    if (!entry) return new Map();
    const cached = this.versionCache.get(entry.branch);
    if (!cached || cached.tip !== entry.head) return new Map();
    return lastTouchedVersions(cached.listing);
  }

  private getRootNodes(): Promise<Node[]> {
    return this.watcher.runSuppressed(() => this.computeRootNodes());
  }

  private async computeRootNodes(): Promise<Node[]> {
    const start = Date.now();
    const config = vscode.workspace.getConfiguration('worktreeReview');
    const fallbackBase = config.get<string>('fallbackBase', 'origin/main');
    const useStack = config.get<boolean>('useStackParent', true);
    const showPullRequests = config.get<boolean>('showPullRequests', true);
    const hideAgentWorktrees = config.get<boolean>(
      'hideAgentWorktreesOnTheirOwnBranch',
      true,
    );

    let worktrees: Worktree[];
    try {
      worktrees = await listWorktrees(this.repoPath);
      log().info(`listed ${worktrees.length} worktrees from ${this.repoPath}`);
    } catch (err) {
      log().error(`git worktree list failed: ${describeError(err)}`);
      return [new MessageNode(`git worktree list failed: ${describe(err)}`)];
    }

    void this.watcher.update(worktrees);
    this.comments.setWorktrees(worktrees);
    // Awaited, unlike the comment store's own load: file rows read viewed state
    // synchronously while they are built, and a row that rendered before the
    // store arrived would show an unticked box for a reviewed file.
    await this.viewed.setWorktrees(worktrees.map((w) => w.path));

    if (worktrees.length === 0) {
      this.worktreeCache.clear();
      return [new MessageNode('No worktrees with branches found.')];
    }

    const live = new Set(worktrees.map((w) => w.path));
    for (const cached of this.worktreeCache.keys()) {
      if (!live.has(cached)) this.worktreeCache.delete(cached);
    }

    // Awaited for the same reason as the viewed store: a named row would
    // otherwise render under its branch name on the first pass.
    await this.loadNames();
    await this.worktreeNames.prune(worktrees.map((w) => w.path)).catch((err) => {
      log().warn(`names: prune failed: ${describeError(err)}`);
    });

    this.setReviewWorktree(worktrees.find((w) => isReviewWorktree(w.path)));
    this.branchHolders = new Map(worktrees.map((w) => [w.branch, w] as const));

    this.trunk = await getStackTrunk(this.repoPath);

    if (showPullRequests) {
      await this.ensurePrCache();
    } else {
      this.prCache = undefined;
      this.prCacheError = undefined;
    }

    // Filtered here rather than above: the stores and the watcher above are
    // keyed by worktree, and a hidden worktree is still one of them — pruning
    // against a filtered list would throw away its name and its viewed marks.
    const shown = hideAgentWorktrees
      ? worktrees.filter((w) => !isAgentWorktreeOnItsOwnBranch(w))
      : worktrees;
    if (shown.length === 0) {
      return [
        new MessageNode('Every worktree is an agent’s, on the branch named after it.'),
      ];
    }

    const needStack = useStack || showPullRequests;
    const nodes = await Promise.all(
      shown.map(async (w) => {
        const entry = this.cacheEntry(w);
        // Not asked for on trunk: nothing reads the answer there. Re-read on
        // every pass rather than cached by HEAD: `gh stack add` or `gt track`
        // changes a stack without moving any worktree's HEAD, and the read is
        // one small file.
        if (needStack && w.branch !== this.trunkBranch()) {
          entry.stack = await getStack(w.path, w.branch);
        }
        const parent = useStack ? (entry.stack?.parent ?? null) : null;
        const base = parent ?? fallbackBase;
        const source: 'stack' | 'fallback' = parent ? 'stack' : 'fallback';
        entry.base = base;
        const stack = this.resolveStackName(w.path);
        return new WorktreeNode(
          w,
          base,
          source,
          isReviewWorktree(w.path),
          this.rowNameFor(w.path, stack),
          stack,
        );
      }),
    );
    // Started from here rather than only from the branch rows: a refresh the
    // watcher fired because a branch moved re-renders those rows with counts
    // that are now stale, and nothing on the row itself knows that.
    if (showPullRequests) this.scheduleLocRefresh();
    log().info(`root: ${nodes.length} worktree node(s) in ${elapsed(start)}`);
    return nodes;
  }

  /**
   * Returns the cached entry for a worktree when its HEAD is unchanged, or a
   * fresh empty one otherwise. Branch switches move HEAD, so only the changed
   * worktree misses the cache.
   */
  private cacheEntry(w: Worktree): WorktreeCacheEntry {
    const existing = this.worktreeCache.get(w.path);
    if (existing?.head === w.head) {
      // Two branches can point at the same commit, so checking one out leaves
      // HEAD where it was and only the name changes.
      existing.branch = w.branch;
      return existing;
    }
    const fresh: WorktreeCacheEntry = { head: w.head, branch: w.branch };
    this.worktreeCache.set(w.path, fresh);
    return fresh;
  }

  /**
   * Fetches open PRs at most once per TTL. The PR list is independent of which
   * branch each worktree is on, so a branch switch should not re-hit the
   * network — only an explicit refresh (via `invalidate`) does.
   */
  private async ensurePrCache(): Promise<void> {
    const fresh = Date.now() - this.prCacheAt < PR_CACHE_TTL_MS;
    if (fresh && (this.prCache !== undefined || this.prCacheError !== undefined)) {
      return;
    }
    const start = Date.now();
    try {
      this.prCache = await listOpenPrs(this.repoPath);
      this.prCacheError = undefined;
      this.prBodies.setBodies(this.prCache);
      log().info(
        `fetched ${this.prCache.length} open PRs from gh in ${elapsed(start)}`,
      );
    } catch (err) {
      this.prCache = undefined;
      this.prCacheError = describe(err);
      log().error(`gh pr list failed: ${describeError(err)}`);
    }
    this.prCacheAt = Date.now();
  }

  private async getWorktreeChildren(parent: WorktreeNode): Promise<Node[]> {
    const config = vscode.workspace.getConfiguration('worktreeReview');
    const showPullRequests = config.get<boolean>('showPullRequests', true);
    // Runs first so `changedFiles` is populated before the comments section
    // asks which commented files are outside the diff.
    const fileNodes = await this.getFileNodes(parent);
    const sections: Node[] = [];
    if (showPullRequests) {
      // Omitted rather than shown empty: the only worktree with no stack is one
      // sitting on trunk, and an empty section there is a row saying nothing.
      const stack = this.buildStackSection(parent);
      if (stack.entries.length > 0) sections.push(stack);
      // The worktree's own PR, read at the top of its files.
      const pr = this.prCache?.find((p) => p.headRefName === parent.worktree.branch);
      if (pr) sections.push(new PrBodyNode(parent.worktree.path, pr, true));
    }
    const commentsSection = this.buildCommentsSection(parent);
    if (commentsSection) sections.push(commentsSection);
    return [...sections, ...fileNodes];
  }

  /**
   * Rendered only when the worktree has comments — an always-present empty
   * section is noise, and the copy/clear actions live on the worktree node so
   * they stay reachable either way.
   */
  private buildCommentsSection(parent: WorktreeNode): CommentsSectionNode | undefined {
    const threads = this.comments.threadsFor(parent.worktree.path);
    if (threads.length === 0) return undefined;
    return new CommentsSectionNode(
      parent.worktree.path,
      parent.base,
      parent.worktree.branch,
      threads,
      undefined,
    );
  }

  /**
   * The comments on a stack branch, which is where a branch nobody has checked
   * out shows its review notes. Rendered only when the branch has any, for the
   * same reason the worktree's own section is.
   */
  private buildBranchCommentsSection(
    node: StackBranchNode,
  ): CommentsSectionNode | undefined {
    const threads = this.comments.threadsOnBranch(node.branch);
    if (threads.length === 0) return undefined;
    return new CommentsSectionNode(
      node.worktreePath,
      node.parent,
      node.branch,
      threads,
      { branch: node.branch, parent: node.parent },
    );
  }

  /**
   * Which of a section's commented files the change itself touches, so the rest
   * can be marked as sitting outside the diff. A worktree's section reads the
   * changed-file list the tree already computed; a branch's section is measured
   * against the branch it sits on, which costs one `git diff` the first time
   * the section is opened.
   */
  private async commentedFilesInDiff(
    section: CommentsSectionNode,
  ): Promise<Set<string>> {
    if (!section.diff) {
      const entry = this.worktreeCache.get(section.worktreePath);
      return new Set((entry?.changedFiles ?? []).map((f) => f.path));
    }
    try {
      return await this.branchChangedFiles(section.worktreePath, section.diff);
    } catch (err) {
      log().warn(
        `comments: cannot diff ${section.diff.branch} vs ${section.diff.parent}: ${describeError(err)}`,
      );
      // An empty set would mark every commented file "not in diff", which reads
      // as a finding rather than as a failed lookup.
      return new Set(section.threads.map((t) => t.file));
    }
  }

  /**
   * Paths a branch changes relative to the branch it sits on, cached against
   * both revisions the answer was measured between — the same pair the line
   * counts are keyed on, so an amend or a restack drops the entry.
   */
  private async branchChangedFiles(
    worktreePath: string,
    diff: CommentDiff,
  ): Promise<Set<string>> {
    const [tip, base] = await Promise.all([
      revParse(worktreePath, `refs/heads/${diff.branch}`),
      this.branchDiffBase(worktreePath, diff),
    ]);
    const key = `${base}..${tip}`;
    const cached = this.branchFileCache.get(key);
    if (cached) return cached;
    const files = await diffNameStatus(worktreePath, base, diff.branch);
    const paths = new Set(files.map((f) => f.path));
    this.branchFileCache.set(key, paths);
    return paths;
  }

  /**
   * The revision a branch's own change is measured from: where it diverged from
   * the branch it sits on, which is the left side of the three-dot range its PR
   * shows. Falls back to the parent's tip when the two share no history.
   */
  private async branchDiffBase(
    worktreePath: string,
    diff: CommentDiff,
  ): Promise<string> {
    const base = await mergeBaseOf(worktreePath, diff.parent, diff.branch).catch(
      () => '',
    );
    return base || diff.parent;
  }

  /**
   * The section lists every branch in the stack (tip → trunk order, trunk
   * itself excluded), attaching each branch's open PR when one exists — a
   * not-yet-submitted branch still shows up.
   */
  private buildStackSection(parent: WorktreeNode): StackSectionNode {
    const byHead = new Map(
      (this.prCache ?? []).map((p) => [p.headRefName, p] as const),
    );
    const entries: StackEntry[] = stackEntries(
      this.cacheEntry(parent.worktree).stack,
      parent.worktree.branch,
      this.trunkBranch(),
    ).map((entry) => ({ ...entry, pr: byHead.get(entry.branch) }));
    const stack = this.resolveStackName(parent.worktree.path);
    return new StackSectionNode(
      parent.worktree.path,
      parent.worktree.branch,
      entries,
      this.rowNameFor(parent.worktree.path, stack),
      stack,
      this.prCacheError,
    );
  }

  /** Points both name stores at the repository, reading their files the first time. */
  private async loadNames(): Promise<void> {
    if (!this.mainWorktree) {
      this.mainWorktree = await mainWorktreePath(this.repoPath).catch((err) => {
        log().warn(`names: cannot locate the main worktree: ${describeError(err)}`);
        return undefined;
      });
    }
    if (!this.mainWorktree) return;
    await this.stackNames.setRoot(this.mainWorktree);
    await this.worktreeNames.setRoot(this.mainWorktree);
  }

  /**
   * What a worktree's rows read instead of its branch: its own name when it has
   * one, otherwise its stack's, so naming a stack still names every worktree on
   * it that has not been named itself.
   */
  private rowNameFor(
    worktreePath: string,
    stack: ResolvedStack,
  ): string | undefined {
    return this.worktreeNames.nameFor(worktreePath) ?? stack.name;
  }

  /**
   * The name and pinned membership of a worktree's stack. Branches the stack
   * has gained since it was named are written back here, which is the only
   * place that sees both the stored membership and the live one.
   */
  private resolveStackName(worktreePath: string): ResolvedStack {
    const chain = this.stackChainFor(worktreePath);
    const resolved = this.stackNames.resolve(chain);
    if (resolved.name) {
      void this.stackNames.syncMembers(chain).catch((err) => {
        log().error(`stacks: could not record new members: ${describeError(err)}`);
      });
    }
    return resolved;
  }

  private stackChainFor(worktreePath: string): string[] {
    const entry = this.worktreeCache.get(worktreePath);
    if (!entry) return [];
    return stackChain(entry.stack, entry.branch, this.trunkBranch());
  }

  /**
   * Names the worktree a row belongs to, or clears the name when the box is
   * left empty. The name takes the row from its stack's name, which goes on
   * naming every other worktree on the stack.
   */
  async nameWorktree(item: unknown): Promise<void> {
    const worktreePath = this.worktreePathFor(item);
    if (!worktreePath) return;
    const current = this.worktreeNames.nameFor(worktreePath);
    const opening = await this.openingName(worktreePath, current);
    if (opening === undefined) return;
    const branch = this.worktreeCache.get(worktreePath)?.branch ?? '';
    const entered = await vscode.window.showInputBox({
      title: 'Name this worktree',
      prompt:
        `Takes the row in place of ${branch ? `\`${branch}\`` : 'the branch'}, ` +
        'and stays put when a different branch is checked out here. ' +
        'Leave empty to remove the name.',
      placeHolder: 'Worktree name',
      value: opening,
    });
    if (entered === undefined) return;
    const name = entered.trim();
    try {
      await this.worktreeNames.setName(worktreePath, name);
      log().info(
        name
          ? `names: named ${worktreePath} "${name}"`
          : `names: removed the name from ${worktreePath}`,
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Worktree Stack Reviewer: could not save the worktree name — ${describe(err)}`,
      );
      return;
    }
    this.refresh();
  }

  /**
   * What the name box opens on. A worktree with titled Claude conversations
   * running in it gets a list of their titles first, and picking one fills the
   * box with it; the title is copied at that moment rather than followed, so a
   * conversation renamed later leaves the worktree's name where it was.
   *
   * Returns undefined when the list is dismissed, which cancels the command the
   * way dismissing the box does.
   */
  private async openingName(
    worktreePath: string,
    current: string | undefined,
  ): Promise<string | undefined> {
    const sessions = await liveSessionsIn(worktreePath).catch((err) => {
      log().warn(`names: cannot read Claude sessions: ${describeError(err)}`);
      return [] as ClaudeSession[];
    });
    if (sessions.length === 0) return current ?? '';
    const ownName: vscode.QuickPickItem = { label: 'Type a name…' };
    const picked = await vscode.window.showQuickPick(
      [
        ...sessions.map((s) => ({ label: s.name, description: s.status })),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        ownName,
      ],
      {
        title: 'Name this worktree',
        placeHolder: 'Take the name from a Claude conversation running here',
      },
    );
    if (picked === undefined) return undefined;
    return picked === ownName ? (current ?? '') : picked.label;
  }

  /**
   * Names the stack a row belongs to, or clears the name when the box is left
   * empty.
   */
  async nameStack(item: unknown): Promise<void> {
    const worktreePath = this.worktreePathFor(item);
    if (!worktreePath) return;
    const chain = this.stackChainFor(worktreePath);
    if (chain.length === 0) {
      void vscode.window.showInformationMessage(
        'This worktree is on trunk, so it has no stack to name.',
      );
      return;
    }
    const current = this.stackNames.resolve(chain);
    const branch = this.worktreeCache.get(worktreePath)?.branch ?? '';
    const place = `${stackPosition(current, branch)}/${current.members.length}`;
    const entered = await vscode.window.showInputBox({
      title: 'Name this stack',
      prompt:
        `${count(current.members.length, 'branch', 'branches')} in this stack, ` +
        `this worktree is on ${place}. Leave empty to remove the name.`,
      placeHolder: 'Stack name',
      value: current.name ?? '',
    });
    if (entered === undefined) return;
    const name = entered.trim();
    try {
      const saved = await this.stackNames.setName(chain, name);
      log().info(
        name
          ? `stacks: named ${saved.members.length} branch(es) "${name}"`
          : `stacks: removed the name from ${chain.join(', ')}`,
      );
      void vscode.window.showInformationMessage(
        name
          ? `Named — rows on this stack now read "n/${saved.members.length} ${name}".`
          : 'Name removed; the rows keep position-only numbering.',
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `Worktree Stack Reviewer: could not save the stack name — ${describe(err)}`,
      );
      return;
    }
    this.refresh();
  }

  private getStackChildren(section: StackSectionNode): Node[] {
    this.scheduleLocRefresh();
    const nodes: Node[] = [];
    if (section.errorMessage) {
      nodes.push(new MessageNode(`gh: ${section.errorMessage}`));
    }
    if (section.entries.length === 0) {
      nodes.push(new MessageNode('No branches in stack.'));
      return nodes;
    }
    for (const entry of section.entries) {
      nodes.push(
        new StackBranchNode(
          section.worktreePath,
          section.currentBranch,
          entry.branch,
          entry.parent,
          entry.pr,
          section.name,
          section.stack,
          this.locState(entry.branch),
          this.expandedBranches.has(`${section.worktreePath}:${entry.branch}`),
          entry.branch === this.reviewWorktree?.branch,
          this.heldElsewhere(entry.branch, section.worktreePath),
          this.branchComments(entry.branch),
        ),
      );
    }
    return nodes;
  }

  /**
   * How many comments a branch carries, from either source. The GitHub side is
   * whatever the review-comment cache already holds: it is filled in the
   * background, so a row can render before its PR has been asked about and
   * gains the paragraph mark on the refresh that follows.
   */
  private branchComments(branch: string): BranchComments {
    const local = this.comments.threadsOnBranch(branch);
    return {
      local: local.length,
      localOpen: local.filter((t) => !t.resolved).length,
      github: this.cachedPrCommentTotal(branch),
    };
  }

  /** Inline review comments on the branch's PR, counted from cache alone. */
  private cachedPrCommentTotal(branch: string): number {
    const pr = this.prCache?.find((p) => p.headRefName === branch);
    if (!pr) return 0;
    const cached = this.prCommentCache.get(pr.number);
    if (!cached) return 0;
    let total = 0;
    for (const n of cached.counts.values()) total += n;
    return total;
  }

  /**
   * The worktree holding a branch, when that is neither the worktree the row is
   * being read from nor the review worktree — both of those already have a mark
   * of their own.
   */
  private heldElsewhere(branch: string, worktreePath: string): Worktree | undefined {
    const holder = this.branchHolders.get(branch);
    if (!holder) return undefined;
    if (holder.path === worktreePath) return undefined;
    if (holder.path === this.reviewWorktree?.path) return undefined;
    return holder;
  }

  /**
   * The branch a stack bottoms out on. The trunk `.git/gh-stack` records when
   * the repo has stacks, and the configured fallback base stripped of its remote
   * otherwise — a stack's parent branches are local refs either way.
   */
  private trunkBranch(): string {
    if (this.trunk) return this.trunk;
    return vscode.workspace
      .getConfiguration('worktreeReview')
      .get<string>('fallbackBase', 'origin/main')
      .replace(/^origin\//, '');
  }

  /**
   * Records that the view opened or closed a branch row and re-reads that row,
   * which is what widens or shortens its name. Only the row itself is
   * re-rendered — a full refresh here would re-query every worktree's diff on
   * a click that changed nothing about the data.
   */
  setBranchExpanded(element: unknown, expanded: boolean): void {
    if (!(element instanceof StackBranchNode)) return;
    const key = `${element.worktreePath}:${element.branch}`;
    if (this.expandedBranches.has(key) === expanded) return;
    if (expanded) {
      this.expandedBranches.add(key);
    } else {
      this.expandedBranches.delete(key);
    }
    element.showFullName(expanded);
    this._onDidChangeTreeData.fire(element);
  }

  /**
   * What sits under a branch: its line counts, the PR description when it has
   * one, its comments, then one row per patch. The LOC row does not wait on its
   * own count — it appears with a spinner and fills in when the background pass
   * lands — but the whole list waits on the version listing, which the prefetch
   * has usually already cached.
   */
  private async getStackBranchChildren(node: StackBranchNode): Promise<Node[]> {
    const rows: Node[] = [
      new LocNode(
        node.worktreePath,
        node.branch,
        node.parent,
        this.locState(node.branch),
      ),
    ];
    if (node.pr) {
      rows.push(new PrBodyNode(node.worktreePath, node.pr));
    }
    const comments = this.buildBranchCommentsSection(node);
    if (comments) rows.push(comments);
    return [...rows, ...(await this.getVersionNodes(node))];
  }

  /**
   * A branch's counts as currently known. A cached summary is shown even while
   * the pass is re-checking it: the alternative is blanking a correct number
   * back to a spinner every time the tree refreshes.
   */
  private locState(branch: string): LocState {
    return {
      summary: this.locCache.get(branch)?.summary,
      error: this.locErrors.get(branch),
    };
  }

  private async getVersionNodes(node: StackBranchNode): Promise<Node[]> {
    try {
      const [listing, comments] = await Promise.all([
        this.ensureVersions(node.worktreePath, node.branch),
        this.prCommentCounts(node.branch),
      ]);
      if (listing.versions.length === 0) {
        return [new MessageNode('No versions (branch has no commits of its own).')];
      }
      const local = commentsByVersion(
        this.comments.threadsOnBranch(node.branch),
        listing.versions,
      );
      return listing.versions.map(
        (v) =>
          new VersionNode(
            node.worktreePath,
            node.branch,
            v,
            commentsOnVersion(comments, v),
            local.get(v.version) ?? { total: 0, open: 0 },
          ),
      );
    } catch (err) {
      log().warn(`versions for ${node.branch}: ${describeError(err)}`);
      return [new MessageNode(describe(err))];
    }
  }

  /**
   * Review-comment counts for the branch's PR, or an empty map when it has no
   * open PR or `gh` fails. Comments are fetched per PR rather than for the
   * whole stack, since only an expanded branch needs them.
   */
  private async prCommentCounts(branch: string): Promise<Map<string, number>> {
    const pr = this.prCache?.find((p) => p.headRefName === branch);
    if (!pr) return new Map();
    const cached = this.prCommentCache.get(pr.number);
    if (cached && Date.now() - cached.at < PR_CACHE_TTL_MS) return cached.counts;
    const start = Date.now();
    try {
      const counts = await prCommentCountsBySha(this.repoPath, pr.number);
      this.prCommentCache.set(pr.number, { at: Date.now(), counts });
      log().info(
        `fetched review comments on #${pr.number} for ${counts.size} shas in ${elapsed(start)}`,
      );
      return counts;
    } catch (err) {
      log().warn(`gh api pr comments #${pr.number}: ${describeError(err)}`);
      return new Map();
    }
  }

  private async ensureVersions(
    worktreePath: string,
    branch: string,
    origin: 'expand' | 'prefetch' = 'expand',
  ): Promise<VersionListing> {
    const start = Date.now();
    const tip = await revParse(worktreePath, `refs/heads/${branch}`).catch(
      () => '',
    );
    if (!tip) throw new Error(`no local branch '${branch}'`);
    const cached = this.versionCache.get(branch);
    if (cached && cached.tip === tip) {
      log().info(`versions: ${branch} from cache in ${elapsed(start)}`);
      return cached.listing;
    }

    // Keyed by tip as well as branch: a listing fetched for a tip the branch
    // has since moved off is not the one a later caller is asking for.
    const key = `${branch}@${tip}`;
    const pending = this.versionsInFlight.get(key);
    if (pending) {
      log().info(`versions: ${branch} joined an in-flight fetch`);
      return pending;
    }

    const fetch = listVersions(this.repoPath, worktreePath, branch)
      .then((listing) => {
        this.versionCache.set(branch, { tip, listing });
        log().info(
          `versions: ${branch} has ${listing.versions.length} (tip ${tip.slice(0, 7)}) in ${elapsed(start)}${origin === 'prefetch' ? ' [prefetch]' : ''}`,
        );
        return listing;
      })
      .finally(() => {
        this.versionsInFlight.delete(key);
      });
    this.versionsInFlight.set(key, fetch);
    return fetch;
  }

  /**
   * Restarts the quiet-period timer that gates prefetching. Every tree query
   * pushes it out, so prefetching waits for the view to stop asking for
   * things rather than competing with it.
   */
  private deferVersionPrefetch(): void {
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = undefined;
      void this.prefetch();
    }, PREFETCH_SETTLE_MS);
  }

  /**
   * The two background reads, in the order the tree needs them: the version
   * listings a branch row expands into, then the review-comment counts that mark
   * the rows themselves.
   */
  private async prefetch(): Promise<void> {
    await this.prefetchVersions();
    await this.prefetchPrComments();
  }

  /**
   * Reads inline review-comment counts for the stack's open PRs, which is what
   * puts the paragraph mark on a branch row. Without this they arrive only when
   * a branch is expanded, and a collapsed row would never say that its PR has
   * comments waiting.
   *
   * One PR at a time, and once per PR until the next explicit refresh: these
   * are network calls, and the count is not what anyone is watching for.
   */
  private async prefetchPrComments(): Promise<void> {
    if (this.prefetchingPrComments) return;
    const shown = new Set(this.stackLocTargets().map((t) => t.branch));
    const pending = (this.prCache ?? []).filter(
      (pr) => shown.has(pr.headRefName) && !this.prCommentsPrefetched.has(pr.number),
    );
    if (pending.length === 0) return;

    this.prefetchingPrComments = true;
    const start = Date.now();
    try {
      for (const pr of pending) {
        this.prCommentsPrefetched.add(pr.number);
        await this.prCommentCounts(pr.headRefName);
      }
    } finally {
      this.prefetchingPrComments = false;
    }
    log().info(
      `comments: prefetched review comments for ${pending.length} PR(s) in ${elapsed(start)}`,
    );
    this.refresh();
  }

  /**
   * Fills the version cache for the branches already shown in the stack.
   *
   * Expanding a branch otherwise costs a full gt-version-history run, which is
   * around a second on an idle machine and several times that on a busy one.
   * Fetching ahead of the click turns the expansion into a cache read.
   *
   * Strictly one branch at a time: these listings are not urgent, and
   * concurrent git processes against this repository measurably slow each
   * other down.
   */
  private async prefetchVersions(): Promise<void> {
    if (this.prefetching) return;
    const showPullRequests = vscode.workspace
      .getConfiguration('worktreeReview')
      .get<boolean>('showPullRequests', true);
    if (!showPullRequests) return;
    const targets = await this.pendingVersionTargets();
    if (targets.length === 0) return;

    this.prefetching = true;
    const start = Date.now();
    let fetched = 0;
    try {
      for (const target of targets) {
        try {
          await this.ensureVersions(target.worktreePath, target.branch, 'prefetch');
          fetched += 1;
        } catch (err) {
          // A branch with no reflog of its own has no versions to read.
          // Expanding it runs the script again and shows what it said.
          log().debug(
            `versions: prefetch skipped ${target.branch}: ${describeError(err)}`,
          );
        }
      }
    } finally {
      this.prefetching = false;
    }
    if (fetched > 0) {
      log().info(
        `versions: prefetched ${fetched} of ${targets.length} branch(es) in ${elapsed(start)}`,
      );
    }
    // An expanded branch shows its patches straight from this cache, and a
    // checked-out branch's listing also labels the changed-file rows below it
    // with the version that last touched each file. This waits until the whole
    // pass is done: a refresh re-queries every expanded node and can re-run
    // `gh pr list`, and doing that between fetches would put that work in the
    // same moment as the version-history runs it sits between.
    if (fetched > 0) this.refresh();
  }

  /**
   * Stack branches whose cached listing is missing or out of date,
   * deduplicated — branches are shared across worktrees, and so is the cache.
   * The branches are exactly the ones the stack section shows, so nothing is
   * read ahead for a row that will never ask for it.
   *
   * Cached entries are checked against the branch's current tip rather than
   * merely for presence. An amend moves the tip, which is both what makes the
   * entry stale and the moment the versions are worth having ready.
   *
   * Branches a worktree is checked out on come first. Those are the ones the
   * changed-file rows read to label each file with the version that last
   * touched it, so fetching them first is what shortens the gap between the
   * files appearing and their labels appearing.
   */
  private async pendingVersionTargets(): Promise<VersionTarget[]> {
    const trunk = this.trunkBranch();
    const checkedOutBranches = new Set(
      Array.from(this.worktreeCache.values(), (e) => e.branch),
    );
    const checkedOut: VersionTarget[] = [];
    const rest: VersionTarget[] = [];
    const seen = new Set<string>();
    for (const [worktreePath, entry] of this.worktreeCache) {
      for (const { branch } of stackEntries(entry.stack, entry.branch, trunk)) {
        if (seen.has(branch)) continue;
        seen.add(branch);
        const cached = this.versionCache.get(branch);
        if (cached) {
          const tip = await revParse(worktreePath, `refs/heads/${branch}`).catch(
            () => '',
          );
          if (!tip || tip === cached.tip) continue;
        }
        const target: VersionTarget = {
          worktreePath,
          branch,
          checkedOut: checkedOutBranches.has(branch),
        };
        (target.checkedOut ? checkedOut : rest).push(target);
      }
    }
    return [...checkedOut, ...rest];
  }

  /**
   * Starts the line-count pass, or asks the running one to go round again when
   * a branch has appeared since it read its targets.
   */
  private scheduleLocRefresh(): void {
    if (this.locRunning) {
      this.locRerun = true;
      return;
    }
    if (this.locTimer) return;
    this.locTimer = setTimeout(() => {
      this.locTimer = undefined;
      void this.refreshStackLoc();
    }, LOC_COALESCE_MS);
  }

  /**
   * Brings every stack branch's line counts up to date, then refreshes once.
   *
   * Strictly one branch at a time, for the same reason the version prefetch is:
   * concurrent git processes against one repository measurably slow each other
   * down, and several worktrees' stacks expand at the same moment.
   */
  private async refreshStackLoc(): Promise<void> {
    const targets = this.stackLocTargets();
    if (targets.length === 0) return;
    this.locRunning = true;
    const start = Date.now();
    let counted = 0;
    try {
      // A stack's branches are each other's parents, so resolving tips once for
      // the whole pass reads each of them once instead of twice. Refs are
      // shared across every worktree of a repository, so one lookup answers for
      // all of them.
      const tips = new Map<string, string>();
      const tipOf = async (ref: string): Promise<string> => {
        const known = tips.get(ref);
        if (known !== undefined) return known;
        const tip = await revParse(this.repoPath, ref).catch(() => '');
        tips.set(ref, tip);
        return tip;
      };
      for (const target of targets) {
        if (await this.updateLoc(target, tipOf)) counted += 1;
      }
    } finally {
      this.locRunning = false;
    }
    if (counted > 0) {
      log().info(`loc: counted ${counted} branch(es) in ${elapsed(start)}`);
      this.refresh();
    }
    if (this.locRerun) {
      this.locRerun = false;
      this.scheduleLocRefresh();
    }
  }

  /**
   * Every stack branch currently in the tree, deduplicated — branches are
   * shared across worktrees, and so is the cache.
   */
  private stackLocTargets(): LocTarget[] {
    const trunk = this.trunkBranch();
    const targets: LocTarget[] = [];
    const seen = new Set<string>();
    for (const [worktreePath, entry] of this.worktreeCache) {
      const branches = stackEntries(entry.stack, entry.branch, trunk);
      for (const { branch, parent } of branches) {
        if (seen.has(branch)) continue;
        seen.add(branch);
        targets.push({ worktreePath, branch, parent });
      }
    }
    return targets;
  }

  /**
   * Recounts one branch when its cached counts no longer apply. Reports
   * whether anything the tree shows changed.
   */
  private async updateLoc(
    target: LocTarget,
    tipOf: (ref: string) => Promise<string>,
  ): Promise<boolean> {
    const branchTip = await tipOf(`refs/heads/${target.branch}`);
    if (!branchTip) {
      return this.recordLocError(target.branch, `no local branch '${target.branch}'`);
    }
    // gt picks the base itself; these tips only say when to ask it again. Its
    // base excludes the parent's remote tip as well as the local one, so a
    // fetch that moves either can change the answer.
    const parentName = target.parent.replace(/^refs\/heads\//, '');
    const parentTip = [
      await tipOf(target.parent),
      await tipOf(`refs/remotes/origin/${parentName}`),
    ].join(':');
    const cached = this.locCache.get(target.branch);
    if (cached && cached.branchTip === branchTip && cached.parentTip === parentTip) {
      return false;
    }
    try {
      const summary = await branchLocSummary(target.worktreePath, target.branch);
      this.locCache.set(target.branch, { branchTip, parentTip, summary });
      this.locErrors.delete(target.branch);
      return true;
    } catch (err) {
      log().warn(`loc: ${target.branch}: ${describeError(err)}`);
      return this.recordLocError(target.branch, describe(err));
    }
  }

  /**
   * Records why a branch has no counts. Reports whether this is new, so a
   * branch that fails the same way on every pass does not refresh the tree into
   * asking again forever.
   */
  private recordLocError(branch: string, message: string): boolean {
    if (this.locErrors.get(branch) === message && !this.locCache.has(branch)) {
      return false;
    }
    this.locErrors.set(branch, message);
    this.locCache.delete(branch);
    return true;
  }

  private getFileNodes(parent: WorktreeNode): Promise<Node[]> {
    return this.watcher.runSuppressed(() => this.computeFileNodes(parent));
  }

  private async computeFileNodes(parent: WorktreeNode): Promise<Node[]> {
    const config = vscode.workspace.getConfiguration('worktreeReview');
    const includeUncommitted = config.get<boolean>('includeUncommitted', true);
    const layout = config.get<Layout>('layout', 'tree');
    const entry = this.cacheEntry(parent.worktree);
    if (entry.changedFiles === undefined) {
      const start = Date.now();
      try {
        entry.changedFiles = await listChangedFiles(
          parent.worktree.path,
          parent.base,
          includeUncommitted,
        );
        log().info(
          `worktree ${parent.worktree.branch}: ${entry.changedFiles.length} changed files vs ${parent.base} in ${elapsed(start)}`,
        );
      } catch (err) {
        log().error(
          `git diff failed for ${parent.worktree.path} vs ${parent.base}: ${describeError(err)}`,
        );
        return [new MessageNode(`git diff failed: ${describe(err)}`)];
      }
    }
    const all = entry.changedFiles;
    if (all.length === 0) return [new MessageNode('No changes vs base.')];
    const lastVersions = this.lastVersionsFor(parent.worktree.path);
    const viewedOf = this.viewedLookup(parent.worktree.path);
    const hideViewed = config.get<boolean>('hideViewed', false);
    const files = hideViewed ? all.filter((f) => !viewedOf(f).viewed) : all;
    if (files.length === 0) {
      return [new MessageNode(`All ${all.length} changed file(s) viewed.`)];
    }
    if (layout === 'flat') {
      return files.map(
        (f) =>
          new FileNode(
            parent.worktree.path,
            parent.base,
            f,
            true,
            lastVersions.get(f.path),
            viewedOf(f),
          ),
      );
    }
    const trie = buildTrie(files, viewedOf);
    return buildNodes(
      parent.worktree.path,
      parent.base,
      '',
      trie,
      lastVersions,
      viewedOf,
    );
  }

  async openDiff(args: OpenDiffArgs): Promise<void> {
    try {
      const { worktreePath, base, file } = args;
      log().info(`openDiff: ${file.status} ${file.path} in ${worktreePath} vs ${base}`);
      const baseRef = await resolveMergeBase(worktreePath, base).catch(() => base);
      const leftPath = file.oldPath ?? file.path;
      const left = buildGitUri(worktreePath, baseRef, leftPath);

      // The right side must match what the file list was built from: with
      // uncommitted changes hidden, a file only appears here because of its
      // commits, so diffing against the working copy would show edits the list
      // claims aren't there.
      const includeUncommitted = vscode.workspace
        .getConfiguration('worktreeReview')
        .get<boolean>('includeUncommitted', true);
      const rightFsPath = path.join(worktreePath, file.path);
      const right =
        includeUncommitted && fs.existsSync(rightFsPath)
          ? vscode.Uri.file(rightFsPath)
          : buildGitUri(worktreePath, 'HEAD', file.path);

      // A file that exists on only one side has nothing to compare against, so
      // it opens as a single editor. The side it opens on still decides which
      // side a comment lands on, the same as it would inside a diff.
      if (file.status === 'A') {
        await vscode.window.showTextDocument(right, { preview: true });
        return;
      }
      if (file.status === 'D') {
        await vscode.window.showTextDocument(left, { preview: true });
        return;
      }

      const baseLabel = base.replace(/^refs\/heads\//, '');
      const rightLabel = includeUncommitted ? 'working' : 'HEAD';
      const title = `${path.basename(file.path)} (${baseLabel} ↔ ${rightLabel})`;
      await vscode.commands.executeCommand('vscode.diff', left, right, title);
    } catch (err) {
      log().error(`openDiff failed: ${describeError(err)}`);
      void vscode.window.showErrorMessage(
        `Worktree Stack Reviewer: failed to open file — ${describe(err)}. See "Worktree Stack Reviewer" output for details.`,
      );
    }
  }

  async openFile(item: unknown): Promise<void> {
    if (!(item instanceof FileNode)) {
      log().warn('openFile: unexpected item shape');
      return;
    }
    const { worktreePath, file } = item;
    try {
      // resourceUri may carry the undecorated wt-ext-row scheme, which no
      // provider serves, so the working-tree uri is rebuilt from the path.
      const uri = vscode.Uri.file(path.join(worktreePath, file.path));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      log().error(`openFile failed: ${describeError(err)}`);
      void vscode.window.showErrorMessage(
        `Worktree Stack Reviewer: could not open ${file.path} — ${describe(err)}`,
      );
    }
  }

  async checkoutPrBranch(item: unknown): Promise<void> {
    if (!(item instanceof StackBranchNode)) {
      log().warn('checkoutPrBranch: unexpected item shape');
      return;
    }
    await this.switchWorktree(item.worktreePath, item.branch, item.currentBranch);
  }

  /**
   * Checks a branch out into the review worktree, leaving the worktree the
   * branch belongs to alone. Comments and viewed marks are keyed on the branch,
   * so they come along and any review done here is still recorded against the
   * branch once it is checked out somewhere else.
   */
  async checkoutInReviewWorktree(item: unknown): Promise<void> {
    if (!(item instanceof StackBranchNode)) {
      log().warn('checkoutInReviewWorktree: unexpected item shape');
      return;
    }
    if (!this.reviewWorktree) {
      void vscode.window.showInformationMessage(
        `No worktree named "${reviewWorktreeName()}". Create one with \`git worktree add\` to review branches without moving the worktree they live in.`,
      );
      return;
    }
    await this.switchWorktree(this.reviewWorktree.path, item.branch);
  }

  /**
   * Puts the review worktree back on the branch of the same name, which frees
   * whatever branch it was holding for the worktree that branch is written in.
   */
  async resetReviewWorktree(): Promise<void> {
    const reviewWorktree = this.reviewWorktree;
    const branch = reviewWorktreeName();
    if (!reviewWorktree) {
      void vscode.window.showInformationMessage(
        `No worktree named "${branch}". Create one with \`git worktree add\` to review branches without moving the worktree they live in.`,
      );
      return;
    }
    const current = await getCurrentBranch(reviewWorktree.path);
    if (current === branch) {
      void vscode.window.showInformationMessage(
        `Review worktree is already on ${branch}.`,
      );
      return;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `Reset the review worktree from "${current || 'detached HEAD'}" to "${branch}"?`,
      {
        modal: true,
        detail: await this.switchDetail(reviewWorktree.path, branch),
      },
      'Reset',
    );
    if (confirmed !== 'Reset') return;
    await this.checkoutReviewBranch(reviewWorktree.path, branch);
  }

  /**
   * Checks the review branch out in the review worktree, creating it on trunk
   * when the repository has no branch by that name — a branch with no commits
   * of its own, so the review worktree shows no changes until something is
   * checked out into it. An existing branch is checked out where it stands.
   *
   * Reports whether the worktree got there, which is what says the branch it
   * was holding is free for another worktree to take.
   */
  private async checkoutReviewBranch(
    worktreePath: string,
    branch: string,
  ): Promise<boolean> {
    const branches = await listLocalBranches(this.repoPath).catch(
      () => new Set<string>(),
    );
    let checkout: () => Promise<void>;
    let done: string;
    if (branches.has(branch)) {
      checkout = () => checkoutBranch(worktreePath, branch);
      done = `Review worktree switched to ${branch}.`;
    } else {
      const startPoint = await this.resolveTrunkRef();
      if (!startPoint) {
        void vscode.window.showErrorMessage(
          `Worktree Stack Reviewer: cannot create "${branch}" — neither "${this.trunkBranch()}" nor the configured fallback base resolves to a commit.`,
        );
        return false;
      }
      checkout = () => createBranchAt(worktreePath, branch, startPoint);
      done = `Created ${branch} on ${startPoint} in the review worktree.`;
    }

    try {
      log().info(`review reset: ${worktreePath} → ${branch}`);
      await this.watcher.runSuppressed(checkout);
      this.refresh();
      void vscode.window.showInformationMessage(done);
      return true;
    } catch (err) {
      log().error(`review reset failed: ${describeError(err)}`);
      void vscode.window.showErrorMessage(
        `Review worktree reset failed: ${describe(err)}`,
      );
      return false;
    }
  }

  /**
   * Where a new review branch starts: the trunk branch, or the configured
   * fallback base when the repo has no local trunk. Undefined when neither
   * names a commit.
   */
  private async resolveTrunkRef(): Promise<string | undefined> {
    const fallback = vscode.workspace
      .getConfiguration('worktreeReview')
      .get<string>('fallbackBase', 'origin/main');
    for (const ref of [this.trunkBranch(), fallback]) {
      const tip = await revParse(this.repoPath, ref).catch(() => '');
      if (tip) return ref;
    }
    return undefined;
  }

  /**
   * Moves one worktree onto a branch, after confirming anything the switch
   * would disturb. `currentHint` names the branch the tree last showed, used
   * when git cannot report the current one.
   */
  private async switchWorktree(
    worktreePath: string,
    target: string,
    currentHint?: string,
  ): Promise<void> {
    const what = isReviewWorktree(worktreePath) ? 'review worktree' : 'worktree';
    const current = (await getCurrentBranch(worktreePath)) || currentHint;
    if (current === target) {
      void vscode.window.showInformationMessage(`Already on ${target}.`);
      return;
    }

    // Git allows a branch in only one worktree at a time, so deal with whoever
    // holds it rather than letting checkout fail with a path the user then has
    // to match against the tree.
    const holder = await this.worktreeHolding(target);
    if (holder && holder !== worktreePath) {
      const freed = await this.freeBranch(holder, target);
      if (!freed) return;
    }

    const confirmed = await vscode.window.showWarningMessage(
      `Switch ${what} from "${current ?? 'detached HEAD'}" to "${target}"?`,
      { modal: true, detail: await this.switchDetail(worktreePath, target) },
      'Switch',
    );
    if (confirmed !== 'Switch') return;

    try {
      log().info(`checkout: ${worktreePath} → ${target}`);
      await this.watcher.runSuppressed(() => checkoutBranch(worktreePath, target));
      this.refresh();
      void vscode.window.showInformationMessage(`Switched to ${target}.`);
    } catch (err) {
      log().error(`checkout failed: ${describeError(err)}`);
      void vscode.window.showErrorMessage(`Checkout failed: ${describe(err)}`);
    }
  }

  /**
   * The modal detail for a checkout: which worktree moves, and how much
   * uncommitted work moves with it.
   */
  private async switchDetail(
    worktreePath: string,
    target: string,
  ): Promise<string> {
    const dirty = await listUncommittedChanges(worktreePath).catch(() => []);
    return [
      worktreePath,
      dirty.length > 0
        ? `${count(dirty.length, 'uncommitted change', 'uncommitted changes')} here will move to "${target}" with the switch.`
        : '',
    ]
      .filter((line) => line)
      .join('\n\n');
  }

  /**
   * Deals with the worktree that already has `target` checked out, and reports
   * whether the branch came free. The review worktree exists to be moved off a
   * branch, so it offers the reset; any other worktree is where that branch is
   * being written, and the checkout stops there.
   */
  private async freeBranch(holder: string, target: string): Promise<boolean> {
    const reviewBranch = reviewWorktreeName();
    // The reset frees nothing when the review branch itself is what is wanted.
    const canReset =
      holder === this.reviewWorktree?.path && target !== reviewBranch;
    if (!canReset) {
      void vscode.window.showWarningMessage(
        `"${target}" is checked out in ${holder}. A branch can only be checked out in one worktree, so review it there or switch that worktree to another branch first.`,
      );
      return false;
    }
    const confirmed = await vscode.window.showWarningMessage(
      `"${target}" is checked out in the review worktree. Reset it to "${reviewBranch}" first?`,
      { modal: true, detail: await this.switchDetail(holder, reviewBranch) },
      'Reset and Continue',
    );
    if (confirmed !== 'Reset and Continue') return false;
    return this.checkoutReviewBranch(holder, reviewBranch);
  }

  /** The worktree that currently has `branch` checked out, if any. */
  private async worktreeHolding(branch: string): Promise<string | undefined> {
    const worktrees = await listWorktrees(this.repoPath).catch(() => []);
    return worktrees.find((w) => w.branch === branch)?.path;
  }

  /**
   * Publishes whether the repository has a review worktree, so the tree's
   * context menu only offers the review checkout when there is somewhere to
   * check out to.
   */
  private setReviewWorktree(worktree: Worktree | undefined): void {
    const wasSameWorktree = this.reviewWorktree?.path === worktree?.path;
    this.reviewWorktree = worktree;
    // The branch it holds changes on every review checkout; the context key
    // only answers whether the worktree is there at all.
    if (wasSameWorktree) return;
    log().info(`review worktree: ${worktree?.path ?? 'none'}`);
    void vscode.commands.executeCommand(
      'setContext',
      'worktreeReview.hasReviewWorktree',
      worktree !== undefined,
    );
  }

  /**
   * Opens the review dialog over a PR's description, from a PR's branch row,
   * its description row, or the title bar of its open description. The dialog
   * approves, comments, or requests changes; see `openReviewDialog`.
   */
  async reviewPr(item: unknown): Promise<void> {
    if (item instanceof vscode.Uri) {
      const parts = parsePrBodyUri(item);
      if (!parts) return;
      const pr = this.prCache?.find((p) => p.number === parts.number);
      await this.preview.openReviewDialog(item, pr?.title);
      return;
    }
    const target =
      item instanceof StackBranchNode || item instanceof PrBodyNode ? item : undefined;
    if (!target?.pr) return;
    const uri = buildPrBodyUri(target.worktreePath, target.pr.number, target.pr.headRefName);
    await this.preview.openReviewDialog(uri, target.pr.title);
  }

  async openPrInBrowser(item: unknown): Promise<void> {
    if (!(item instanceof StackBranchNode) || !item.pr) return;
    await vscode.env.openExternal(vscode.Uri.parse(item.pr.url));
  }

  async copyPrUrl(item: unknown): Promise<void> {
    if (!(item instanceof StackBranchNode) || !item.pr) return;
    await vscode.env.clipboard.writeText(item.pr.url);
    void vscode.window.showInformationMessage(`Copied #${item.pr.number} URL.`);
  }

  /**
   * Opens a PR's description in the review preview — the same rendered
   * markdown view a file gets, over a read-only document served from the PR
   * list the tree already holds.
   */
  async openPrBody(item: unknown): Promise<void> {
    if (!(item instanceof PrBodyNode)) return;
    const uri = buildPrBodyUri(
      item.worktreePath,
      item.pr.number,
      item.pr.headRefName,
    );
    try {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        PREVIEW_EDITOR_VIEW_TYPE,
      );
    } catch (err) {
      log().error(`openPrBody #${item.pr.number}: ${describeError(err)}`);
      void vscode.window.showErrorMessage(
        `Worktree Stack Reviewer: could not open #${item.pr.number}'s description — ${describe(err)}`,
      );
    }
  }

  async compareWithPrevious(item: unknown): Promise<void> {
    if (!(item instanceof VersionNode) || item.v.version <= 1) return;
    await this.openVersionCompare(
      item.worktreePath,
      item.branch,
      String(item.v.version - 1),
      String(item.v.version),
    );
  }

  async compareWithBase(item: unknown): Promise<void> {
    if (!(item instanceof VersionNode)) return;
    await this.openVersionCompare(
      item.worktreePath,
      item.branch,
      'base',
      String(item.v.version),
    );
  }

  async compareWithPicked(item: unknown): Promise<void> {
    if (!(item instanceof VersionNode)) return;
    try {
      const other = await this.pickVersion(
        item.worktreePath,
        item.branch,
        `Compare p${item.v.version} with…`,
        item.v.version,
      );
      if (other === undefined) return;
      const mine = item.v.version;
      // Order the pair oldest → newest so the diff reads as "a became b".
      let a: string;
      let b: string;
      if (other === 'base') {
        a = 'base';
        b = String(mine);
      } else if (other < mine) {
        a = String(other);
        b = String(mine);
      } else {
        a = String(mine);
        b = String(other);
      }
      await this.openVersionCompare(item.worktreePath, item.branch, a, b);
    } catch (err) {
      void vscode.window.showErrorMessage(`Worktree Stack Reviewer: ${describe(err)}`);
    }
  }

  async compareBranchVersions(item: unknown): Promise<void> {
    if (!(item instanceof StackBranchNode)) return;
    try {
      const older = await this.pickVersion(
        item.worktreePath,
        item.branch,
        `${item.branch}: older side (left)`,
      );
      if (older === undefined) return;
      const newer = await this.pickVersion(
        item.worktreePath,
        item.branch,
        `${item.branch}: newer side (right)`,
        older === 'base' ? undefined : older,
      );
      if (newer === undefined) return;
      if (older === 'base' && newer === 'base') {
        void vscode.window.showInformationMessage('Pick at least one version.');
        return;
      }
      await this.openVersionCompare(
        item.worktreePath,
        item.branch,
        String(older),
        String(newer),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`Worktree Stack Reviewer: ${describe(err)}`);
    }
  }

  private async pickVersion(
    worktreePath: string,
    branch: string,
    title: string,
    exclude?: number,
  ): Promise<number | 'base' | undefined> {
    const listing = await this.ensureVersions(worktreePath, branch);
    interface PickItem extends vscode.QuickPickItem {
      value: number | 'base';
    }
    const items: PickItem[] = listing.versions
      .filter((v) => v.version !== exclude)
      .map((v) => ({
        label: `p${v.version}${v.current ? ' (current)' : ''}`,
        description: `${v.sha.slice(0, 7)} · ${v.date.slice(0, 16).replace('T', ' ')} · ${v.action}${v.pushed ? ' · pushed' : ''}`,
        value: v.version,
      }));
    items.push({
      label: 'base',
      description: 'the parent the other version sits on',
      value: 'base',
    });
    const picked = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: 'Select a version',
    });
    return picked?.value;
  }

  /**
   * Opens the compare a link names. The branch need not be checked out
   * anywhere: refs are shared across a repository's worktrees, so the compare
   * runs in whichever worktree holds the branch, and otherwise in the main one.
   */
  async openCompareLink(link: CompareLink): Promise<void> {
    const worktreePath = (await this.worktreeHolding(link.branch)) ?? this.repoPath;
    await this.openVersionCompare(worktreePath, link.branch, link.a, link.b, link.file);
  }

  /**
   * `file` narrows the compare to one path. A file the compare does not name
   * did not change between the two versions, so the whole compare opens
   * instead, with a message saying so.
   */
  private async openVersionCompare(
    worktreePath: string,
    branch: string,
    a: string,
    b: string,
    file?: string,
  ): Promise<void> {
    const start = Date.now();
    try {
      const result = await compareVersions(
        this.repoPath,
        worktreePath,
        branch,
        a,
        b,
      );
      log().info(
        `compare ${branch} ${result.a.label} → ${result.b.label}: ${result.files.length} files in ${elapsed(start)}`,
      );
      if (result.files.length === 0) {
        void vscode.window.showInformationMessage(
          `${result.a.label} and ${result.b.label} have identical trees.`,
        );
        return;
      }
      const title = `${branch}: ${result.a.label} → ${result.b.label}`;
      const only = file ? result.files.find((f) => f.path === file) : undefined;
      if (only) {
        await vscode.commands.executeCommand(
          'vscode.diff',
          buildGitUri(worktreePath, result.left_tree, only.old_path ?? only.path),
          buildGitUri(worktreePath, result.right_tree, only.path),
          `${path.basename(only.path)} (${title})`,
        );
        return;
      }
      if (file) {
        void vscode.window.showInformationMessage(
          `${file} did not change between ${result.a.label} and ${result.b.label}; showing the whole compare.`,
        );
      }
      await openMultiDiff(
        worktreePath,
        title,
        result.left_tree,
        result.right_tree,
        result.files.map((f) => ({ path: f.path, oldPath: f.old_path ?? undefined })),
      );
    } catch (err) {
      const message = describe(err);
      log().error(`compare ${branch} ${a} ${b} failed: ${describeError(err)}`);
      if (message.includes('no clean interdiff')) {
        const direct = 'Diff Commits Directly';
        const choice = await vscode.window.showWarningMessage(
          `Worktree Stack Reviewer: ${message}`,
          direct,
        );
        if (choice === direct) {
          await this.openDirectDiff(worktreePath, branch, a, b);
        }
        return;
      }
      void vscode.window.showErrorMessage(`Worktree Stack Reviewer: ${message}`);
    }
  }

  /**
   * Fallback when no clean interdiff exists: diff the two version commits
   * directly, which also shows whatever landed on the base between them.
   */
  private async openDirectDiff(
    worktreePath: string,
    branch: string,
    a: string,
    b: string,
  ): Promise<void> {
    try {
      const listing = await this.ensureVersions(worktreePath, branch);
      const shaOf = (arg: string): string | undefined =>
        listing.versions.find(
          (v) => String(v.version) === arg.replace(/^p/i, ''),
        )?.sha;
      const aSha = shaOf(a);
      const bSha = shaOf(b);
      if (!aSha || !bSha) {
        void vscode.window.showErrorMessage(
          'Worktree Stack Reviewer: could not resolve version shas for a direct diff.',
        );
        return;
      }
      const files = await diffNameStatus(worktreePath, aSha, bSha);
      if (files.length === 0) {
        void vscode.window.showInformationMessage('The commits have identical trees.');
        return;
      }
      await openMultiDiff(
        worktreePath,
        `${branch}: p${a.replace(/^p/i, '')} → p${b.replace(/^p/i, '')} (direct)`,
        aSha,
        bSha,
        files.map((f) => ({ path: f.path, oldPath: f.oldPath })),
      );
    } catch (err) {
      void vscode.window.showErrorMessage(`Worktree Stack Reviewer: ${describe(err)}`);
    }
  }

  /** Worktree paths as currently known to the tree, for command pickers. */
  async worktreePaths(): Promise<string[]> {
    const worktrees = await listWorktrees(this.repoPath);
    return worktrees.map((w) => w.path);
  }

  /**
   * Resolves the worktree path a command was invoked against — either from the
   * tree node that was right-clicked, or from the active editor's file.
   */
  worktreePathFor(item: unknown): string | undefined {
    if (item instanceof WorktreeNode) return item.worktree.path;
    if (
      item instanceof StackSectionNode ||
      item instanceof StackBranchNode ||
      item instanceof CommentsSectionNode ||
      item instanceof CommentFileNode ||
      item instanceof CommentThreadNode
    ) {
      return item.worktreePath;
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    return active ? this.comments.resolveTarget(active)?.worktreePath : undefined;
  }

  /**
   * Gathers the review context that accompanies exported comments. The changed
   * file list is computed on demand rather than read from the cache alone: a
   * worktree whose node was never expanded has no cached diff, and guessing
   * would mislabel every comment as in-diff.
   */
  async exportMeta(worktreePath: string): Promise<ExportMeta> {
    const config = vscode.workspace.getConfiguration('worktreeReview');
    const entry = this.worktreeCache.get(worktreePath);
    const base = entry?.base ?? config.get<string>('fallbackBase', 'origin/main');
    const branch = (await getCurrentBranch(worktreePath)) || undefined;
    const baseSha = await resolveMergeBase(worktreePath, base).catch(() => undefined);
    const files =
      entry?.changedFiles ??
      (await listChangedFiles(
        worktreePath,
        base,
        config.get<boolean>('includeUncommitted', true),
      ).catch((err) => {
        log().warn(
          `exportMeta: diff failed for ${worktreePath}: ${describeError(err)}`,
        );
        return undefined;
      }));
    return {
      branch,
      base,
      baseSha,
      changed: files ? new Set(files.map((f) => f.path)) : undefined,
    };
  }

  async revealComment(item: unknown): Promise<void> {
    if (!(item instanceof CommentThreadNode)) return;
    const { worktreePath, base, thread, diff } = item;
    try {
      // A description has no source editor to open at a line, so its thread is
      // revealed where it was written: in the rendered preview. This holds
      // wherever the row was clicked — a description is text on GitHub, and no
      // diff between two branches shows it.
      if (thread.side === 'pr') {
        const prNumber = prNumberFromFileName(thread.file);
        if (prNumber === undefined || !thread.branch) {
          throw new Error('the thread names no pull request');
        }
        await this.preview.openAtThread(
          buildPrBodyUri(worktreePath, prNumber, thread.branch),
          thread.id,
        );
        return;
      }
      if (diff) {
        await this.revealCommentOnBranchDiff(item, diff);
        return;
      }
      // Back to the file on disk, in case the thread was last read on a branch
      // diff — a pin left in place would keep it off the working copy.
      this.comments.unpinThread(thread.id);
      // Base comments must open the exact revision they were written against,
      // so the existing thread overlays the document instead of a sibling one.
      const uri =
        thread.side === 'base'
          ? buildGitUri(
              worktreePath,
              thread.baseRef ??
                (await resolveMergeBase(worktreePath, base).catch(() => base)),
              thread.file,
            )
          : vscode.Uri.file(path.join(worktreePath, thread.file));
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      this.comments.expandThread(thread.id);
      revealLine(editor, thread.startLine);
    } catch (err) {
      log().error(`revealComment failed: ${describeError(err)}`);
      void vscode.window.showErrorMessage(
        `Worktree Stack Reviewer: could not open ${thread.file} — ${describe(err)}`,
      );
    }
  }

  /**
   * Opens the branch's own change — where it diverged from the branch it sits
   * on, against its tip — with the comment showing on it. Neither side is a
   * file on disk, so this reads a branch no worktree has checked out.
   *
   * The thread goes on whichever side it was written against: a base comment
   * marks a line the change removed, which only the left side still has.
   */
  private async revealCommentOnBranchDiff(
    item: CommentThreadNode,
    diff: CommentDiff,
  ): Promise<void> {
    const { worktreePath, thread } = item;
    // Both sides name a commit rather than a branch: the virtual documents are
    // cached by URI, and a branch name would go on serving the content it had
    // before the last amend.
    const [baseRef, tip] = await Promise.all([
      this.branchDiffBase(worktreePath, diff),
      revParse(worktreePath, `refs/heads/${diff.branch}`),
    ]);
    const left = buildGitUri(worktreePath, baseRef, thread.file);
    const right = buildGitUri(worktreePath, tip, thread.file);
    const parentLabel = diff.parent.replace(/^refs\/heads\//, '');
    const title = `${path.basename(thread.file)} (${parentLabel} ↔ ${diff.branch})`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title);
    const host = thread.side === 'base' ? left : right;
    await this.comments.pinThread(thread.id, host);
    const editor = vscode.window.visibleTextEditors.find(
      (e) => e.document.uri.toString() === host.toString(),
    );
    if (editor) revealLine(editor, thread.startLine);
  }

  /**
   * Applies checkbox changes from the view. VS Code batches these, so a single
   * click and a shift-click over a run of files arrive the same way.
   */
  async setViewed(
    items: readonly (readonly [unknown, vscode.TreeItemCheckboxState])[],
  ): Promise<void> {
    const touched = new Set<string>();
    for (const [node, state] of items) {
      if (!(node instanceof FileNode)) continue;
      const branch = this.worktreeCache.get(node.worktreePath)?.branch;
      if (!branch || !node.file.patchId) continue;
      if (state === vscode.TreeItemCheckboxState.Checked) {
        touched.add(
          this.viewed.mark(
            node.worktreePath,
            branch,
            node.file.path,
            node.file.patchId,
            node.file.baseBlob,
          ),
        );
      } else {
        for (const p of this.viewed.unmark(branch, node.file.path)) touched.add(p);
      }
    }
    await this.persistViewed(touched);
  }

  /**
   * Ticks or clears every changed file under a worktree or folder row. A folder
   * covers its own subtree; a worktree covers all of its changed files,
   * including any the "hide viewed" filter is keeping off screen.
   */
  async markAllViewed(item: unknown, viewed: boolean): Promise<void> {
    const target = this.markTarget(item);
    if (!target) return;
    const branch = this.worktreeCache.get(target.worktreePath)?.branch;
    if (!branch) return;
    const touched = new Set<string>();
    let changed = 0;
    for (const file of target.files) {
      if (!file.patchId) continue;
      if (viewed) {
        touched.add(
          this.viewed.mark(
            target.worktreePath,
            branch,
            file.path,
            file.patchId,
            file.baseBlob,
          ),
        );
      } else {
        for (const p of this.viewed.unmark(branch, file.path)) touched.add(p);
      }
      changed += 1;
    }
    if (changed === 0) {
      void vscode.window.showInformationMessage('No files to mark here.');
      return;
    }
    await this.persistViewed(touched);
    log().info(`viewed: marked ${changed} file(s) ${viewed ? 'viewed' : 'unviewed'}`);
  }

  private markTarget(
    item: unknown,
  ): { worktreePath: string; files: ChangedFile[] } | undefined {
    if (item instanceof FolderNode) {
      return { worktreePath: item.worktreePath, files: collectFiles(item.trie) };
    }
    if (item instanceof WorktreeNode) {
      return {
        worktreePath: item.worktree.path,
        files: this.cacheEntry(item.worktree).changedFiles ?? [],
      };
    }
    return undefined;
  }

  /** Drops every viewed mark on the worktree's branch. */
  async resetViewed(worktreePath: string): Promise<number> {
    const branch = this.worktreeCache.get(worktreePath)?.branch;
    if (!branch) return 0;
    const { cleared, touched } = this.viewed.unmarkBranch(branch);
    await this.persistViewed(new Set(touched));
    return cleared;
  }

  branchFor(worktreePath: string): string | undefined {
    return this.worktreeCache.get(worktreePath)?.branch;
  }

  /**
   * Forgets viewed marks for branches that no longer exist locally. Unlike
   * comments these are not archived — a tick records that someone read a diff,
   * which is worth nothing once the branch holding it is gone.
   */
  async pruneViewed(): Promise<void> {
    const worktrees = await listWorktrees(this.repoPath).catch(() => []);
    if (worktrees.length === 0) return;
    await this.viewed.setWorktrees(worktrees.map((w) => w.path));
    const branches = await listLocalBranches(this.repoPath).catch(() => undefined);
    if (!branches) return;
    const touched = this.viewed.prune(branches);
    if (touched.length === 0) return;
    for (const worktreePath of touched) {
      await this.viewed.save(worktreePath).catch(() => undefined);
    }
    log().info(`viewed: pruned gone branches from ${touched.length} store file(s)`);
    this.refresh();
  }

  private async persistViewed(touched: Set<string>): Promise<void> {
    for (const worktreePath of touched) {
      try {
        await this.viewed.save(worktreePath);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Worktree Stack Reviewer: could not save viewed state — ${describe(err)}`,
        );
      }
    }
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  /**
   * Hard refresh: drop all caches before re-querying. Use for explicit user
   * refreshes and config changes; the watcher uses the plain `refresh` so a
   * branch switch reuses the still-valid caches of unchanged worktrees.
   */
  invalidate(): void {
    this.worktreeCache.clear();
    this.versionCache.clear();
    this.locCache.clear();
    this.locErrors.clear();
    this.branchFileCache.clear();
    // Re-read from disk rather than merely re-render: an agent working in the
    // worktree can have rewritten viewed.json since the last load, and another
    // window on the same repository can have renamed a stack.
    this.viewed.clear();
    this.stackNames.clear();
    this.worktreeNames.clear();
    this.prCache = undefined;
    this.prCacheError = undefined;
    this.prCacheAt = 0;
    this.prCommentCache.clear();
    this.prCommentsPrefetched.clear();
    this.refresh();
  }

  dispose(): void {
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    if (this.locTimer) clearTimeout(this.locTimer);
    this.watcher.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

function getCommentFileNodes(
  section: CommentsSectionNode,
  changed: Set<string>,
): CommentFileNode[] {
  const byFile = new Map<string, StoredThread[]>();
  for (const t of section.threads) {
    const list = byFile.get(t.file);
    if (list) {
      list.push(t);
    } else {
      byFile.set(t.file, [t]);
    }
  }
  return Array.from(byFile.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([file, threads]) =>
        new CommentFileNode(
          section.worktreePath,
          section.base,
          file,
          threads,
          changed.has(file),
          section.diff,
        ),
    );
}

const LABEL_MAX_CHARS = 80;

/**
 * A row's description has far less room than its tooltip, and these errors
 * repeat on every branch in every stack — a missing `gt-version-history` puts
 * the same sentence on all of them. The tooltip keeps the whole message.
 */
const ROW_ERROR_MAX_CHARS = 48;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function shortError(message: string): string {
  return truncate(message.split('\n')[0].trim(), ROW_ERROR_MAX_CHARS);
}

/** Puts the cursor on a comment's line. A whole-file comment names none. */
function revealLine(editor: vscode.TextEditor, startLine: number | undefined): void {
  if (startLine === undefined) return;
  const line = Math.min(Math.max(0, startLine - 1), editor.document.lineCount - 1);
  const position = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(
    new vscode.Range(position, position),
    vscode.TextEditorRevealType.InCenterIfOutsideViewport,
  );
}

function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim().length > 0)?.trim() ?? '(empty)';
  return truncate(line, LABEL_MAX_CHARS);
}

function buildTrie(files: ChangedFile[], viewedOf: ViewedLookup): TrieDir {
  const root: TrieDir = {
    files: [],
    dirs: new Map(),
    added: 0,
    removed: 0,
    total: 0,
    viewed: 0,
  };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    const viewed = viewedOf(f).viewed ? 1 : 0;
    // Totals accumulate on every directory the file sits under, so a folder
    // row sums its whole subtree rather than only its direct children.
    node.added += f.added ?? 0;
    node.removed += f.removed ?? 0;
    node.total += 1;
    node.viewed += viewed;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      let child = node.dirs.get(part);
      if (!child) {
        child = {
          files: [],
          dirs: new Map(),
          added: 0,
          removed: 0,
          total: 0,
          viewed: 0,
        };
        node.dirs.set(part, child);
      }
      node = child;
      node.added += f.added ?? 0;
      node.removed += f.removed ?? 0;
      node.total += 1;
      node.viewed += viewed;
    }
    node.files.push(f);
  }
  return root;
}

/**
 * Renders trie children for `prefix`. Collapses single-child folder chains
 * (e.g. `src/main/java` becomes one node) so deeply-nested changes don't
 * require many clicks to reach.
 */
function buildNodes(
  worktreePath: string,
  base: string,
  prefix: string,
  trie: TrieDir,
  lastVersions: Map<string, number>,
  viewedOf: ViewedLookup,
): Node[] {
  const nodes: Node[] = [];
  const dirNames = Array.from(trie.dirs.keys()).sort();
  for (const name of dirNames) {
    let displayName = name;
    let relPath = prefix ? `${prefix}/${name}` : name;
    let sub = trie.dirs.get(name)!;
    while (sub.files.length === 0 && sub.dirs.size === 1) {
      const [childName, childTrie] = sub.dirs.entries().next().value!;
      displayName = `${displayName}/${childName}`;
      relPath = `${relPath}/${childName}`;
      sub = childTrie;
    }
    nodes.push(new FolderNode(worktreePath, base, relPath, sub, displayName));
  }
  for (const f of trie.files) {
    nodes.push(
      new FileNode(
        worktreePath,
        base,
        f,
        false,
        lastVersions.get(f.path),
        viewedOf(f),
      ),
    );
  }
  return nodes;
}

function collectFiles(trie: TrieDir): ChangedFile[] {
  const files = [...trie.files];
  for (const child of trie.dirs.values()) files.push(...collectFiles(child));
  return files;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message.split('\n')[0];
  return String(err);
}

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * What a branch row's comment marks stand for, naming each source separately:
 * they live in different places, and which one a reader should open differs.
 */
function branchCommentNote(comments: BranchComments): string {
  const bits: string[] = [];
  if (comments.local > 0) {
    bits.push(
      `${count(comments.local, 'review comment', 'review comments')} here (${comments.localOpen} open)`,
    );
  }
  if (comments.github > 0) {
    bits.push(count(comments.github, 'inline PR comment', 'inline PR comments'));
  }
  return bits.join(' · ');
}

function stackBranchIcon(pr: OpenPr | undefined): string {
  if (!pr) return 'git-branch';
  return pr.isDraft ? 'git-pull-request-draft' : 'git-pull-request';
}

/** Empty when counts are unavailable, which is the case for binary files. */
function lineCountLabel(
  added: number | undefined,
  removed: number | undefined,
): string {
  if (added === undefined || removed === undefined) return '';
  return `+${added}/-${removed}`;
}

/**
 * Where the file's most recent change came from. Working-tree and staged edits
 * outrank any version: they happened after every commit on the branch. A
 * generated file has no version because version history leaves it out of every
 * interdiff, and saying so beats an empty cell. Anything still unlabelled is a
 * version that could not be worked out — see `lastTouchedVersions`.
 */
function provenanceLabel(
  file: ChangedFile,
  lastVersion: number | undefined,
): string {
  if (file.uncommitted) return 'uncommitted';
  if (lastVersion !== undefined) return `p${lastVersion}`;
  if (file.generated) return 'generated';
  return '';
}

function fileTooltip(
  file: ChangedFile,
  lastVersion: number | undefined,
  viewedStatus: ViewedStatus,
): string {
  const lines = [
    file.oldPath
      ? `${file.status}: ${file.oldPath} → ${file.path}`
      : `${file.status}: ${file.path}`,
  ];
  const counts = lineCountLabel(file.added, file.removed);
  lines.push(counts ? `${counts} vs base` : 'binary or uncounted');
  lines.push(`last changed: ${lastChangedDetail(file, lastVersion)}`);
  lines.push(`review: ${reviewDetail(file, viewedStatus)}`);
  return lines.join('\n');
}

function reviewDetail(file: ChangedFile, viewedStatus: ViewedStatus): string {
  if (!file.patchId) return 'cannot be tracked — no readable diff for this file';
  if (!viewedStatus.viewed) return 'not viewed';
  if (viewedStatus.baseMoved) {
    return 'viewed, and restacked onto a new base since — the change itself is unaltered';
  }
  return 'viewed at this exact change';
}

function lastChangedDetail(
  file: ChangedFile,
  lastVersion: number | undefined,
): string {
  if (file.uncommitted) {
    if (lastVersion !== undefined) {
      return `uncommitted edit (committed through p${lastVersion})`;
    }
    return 'uncommitted edit';
  }
  if (lastVersion !== undefined) return `p${lastVersion}`;
  if (file.generated) {
    return 'unknown — generated files are excluded from version interdiffs';
  }
  return 'unknown — no version reported a change to this path';
}

function bucketEntries(summary: LocSummary): [Bucket, BucketTotals][] {
  return Object.entries(summary.buckets) as [Bucket, BucketTotals][];
}

/**
 * The one number that fits beside a PR title. Source is the bucket the split
 * exists to isolate — a branch's real size, with the lockfiles and the test
 * scaffolding taken out — so it is the one that goes on the row.
 */
function sourceLabel(loc: LocState): string {
  if (loc.error) return '⚠';
  if (!loc.summary) return '…';
  if (loc.summary.files === 0) return 'no changes';
  const src = loc.summary.buckets.src;
  return `src +${src.added}/-${src.removed}`;
}

/** The full breakdown, for a tooltip on a row that shows only part of it. */
function locDetail(loc: LocState): string {
  if (loc.error) return `Line counts unavailable: ${loc.error}`;
  if (!loc.summary) return 'Counting lines changed…';
  if (loc.summary.files === 0) return 'No changes vs the branch below.';
  return locLabel(loc.summary);
}

/** Empty buckets are left out: a branch that touches no tests should not say so. */
function locLabel(summary: LocSummary): string {
  const bits = [count(summary.files, 'file', 'files')];
  for (const [bucket, totals] of bucketEntries(summary)) {
    if (totals.files === 0) continue;
    bits.push(`${bucket} +${totals.added}/-${totals.removed}`);
  }
  return bits.join('  ');
}

function locTooltip(
  branch: string,
  parentLabel: string,
  summary: LocSummary,
): string {
  const lines = [
    `${branch} vs ${parentLabel}`,
    `total: +${summary.added}/-${summary.removed} (${count(summary.files, 'file', 'files')})`,
  ];
  for (const [bucket, totals] of bucketEntries(summary)) {
    lines.push(
      `${bucket}: +${totals.added}/-${totals.removed} (${count(totals.files, 'file', 'files')})`,
    );
  }
  lines.push('Committed changes only. Binary files are not counted.');
  return lines.join('\n');
}

function deltaLabel(delta: VersionDelta | undefined): string {
  if (!delta) return '';
  if (delta.conflict) return 'Δ n/a';
  return `+${delta.added ?? 0}/-${delta.removed ?? 0}`;
}

const TOOLTIP_MAX_FILES = 5;

/**
 * A version can hold several shas over its life (a restack rewrites the commit
 * without making it a new patch), so every sha it ever had counts toward it.
 */
function commentsOnVersion(
  counts: Map<string, number>,
  v: BranchVersion,
): number {
  let total = 0;
  // A version can list the same sha twice, when a restack lands back on a
  // commit it already held.
  for (const sha of new Set(v.shas)) total += counts.get(sha) ?? 0;
  return total;
}

/**
 * How many of a branch's review comments were left on each of its patches, so a
 * patch row can be marked the way it is for comments on the pull request.
 *
 * Comments on a pull request description are left out: they are about text on
 * GitHub rather than about the change, so no patch carries them.
 */
function commentsByVersion(
  threads: StoredThread[],
  versions: BranchVersion[],
): Map<number, PatchComments> {
  const counts = new Map<number, PatchComments>();
  for (const thread of threads) {
    if (thread.side === 'pr') continue;
    const version = versionForComment(thread, versions);
    if (version === undefined) continue;
    const entry = counts.get(version) ?? { total: 0, open: 0 };
    entry.total += 1;
    if (!thread.resolved) entry.open += 1;
    counts.set(version, entry);
  }
  return counts;
}

function versionTooltip(
  branch: string,
  v: BranchVersion,
  prComments: number,
  localComments: PatchComments,
): vscode.MarkdownString {
  const pushed = v.pushed
    ? ` · pushed${v.push_seq !== undefined ? ` (#${v.push_seq})` : ''}`
    : '';
  const lines = [
    `**p${v.version}**${v.current ? ' (current tip)' : ''} on \`${branch}\``,
    '',
    v.subject,
    '',
    `\`${v.sha.slice(0, 7)}\` · ${v.date.slice(0, 16).replace('T', ' ')} · ${v.action}${pushed}`,
  ];
  const files = v.delta?.files ?? [];
  if (files.length > 0) {
    lines.push('');
    for (const f of files.slice(0, TOOLTIP_MAX_FILES)) {
      lines.push(`- \`${f.path}\` +${f.added}/-${f.removed}`);
    }
    if (files.length > TOOLTIP_MAX_FILES) {
      lines.push(`- … ${files.length - TOOLTIP_MAX_FILES} more`);
    }
  }
  const hidden = v.delta?.generated_hidden ?? 0;
  if (hidden > 0) {
    lines.push('', `${count(hidden, 'generated file', 'generated files')} excluded`);
  }
  if (prComments > 0) {
    lines.push('', `${count(prComments, 'PR comment', 'PR comments')} on this patch`);
  }
  if (localComments.total > 0) {
    lines.push(
      '',
      `${count(localComments.total, 'review comment', 'review comments')} left on this patch (${localComments.open} open)`,
    );
  }
  const prior = v.shas.slice(0, -1);
  if (prior.length > 0) {
    lines.push('', `prior shas: ${prior.map((s) => s.slice(0, 7)).join(' ')}`);
  }
  return new vscode.MarkdownString(lines.join('\n'));
}

function threadIcon(thread: StoredThread): string {
  if (thread.resolved) return 'check';
  return thread.kind === 'note' ? 'note' : 'comment';
}

/**
 * Opens VS Code's multi-file diff editor over two revisions (commits or bare
 * trees). A side where the file doesn't exist renders as empty content via
 * the git content provider, which the diff editor shows as a full addition
 * or deletion.
 */
async function openMultiDiff(
  worktreePath: string,
  title: string,
  leftRef: string,
  rightRef: string,
  files: { path: string; oldPath?: string }[],
): Promise<void> {
  const resources = files.map((f) => [
    vscode.Uri.file(path.join(worktreePath, f.path)),
    buildGitUri(worktreePath, leftRef, f.oldPath ?? f.path),
    buildGitUri(worktreePath, rightRef, f.path),
  ]);
  await vscode.commands.executeCommand('vscode.changes', title, resources);
}
