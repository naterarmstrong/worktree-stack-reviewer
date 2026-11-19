import { execTimed } from './exec';
import { describeError, log } from './log';
import type { ReviewVerdict } from './previewProtocol';

export interface OpenPr {
  number: number;
  title: string;
  isDraft: boolean;
  url: string;
  headRefName: string;
  baseRefName: string;
  author: string;
  /** The description, as markdown. Empty when the PR has none. */
  body: string;
}

interface GhPrJson {
  number: number;
  title: string;
  isDraft: boolean;
  url: string;
  headRefName: string;
  baseRefName: string;
  author?: { login?: string };
  body?: string;
}

export async function listOpenPrs(repoPath: string): Promise<OpenPr[]> {
  const stdout = await execTimed(
    'gh',
    [
      'pr',
      'list',
      '--state',
      'open',
      '--limit',
      '200',
      '--json',
      'number,title,isDraft,url,headRefName,baseRefName,author,body',
    ],
    repoPath,
    'gh pr list',
  );
  return (JSON.parse(stdout) as GhPrJson[]).map(toOpenPr);
}

/** The branch PR `prNumber` merges from, for a PR the open-PR list does not hold. */
export async function prHeadBranch(repoPath: string, prNumber: number): Promise<string> {
  const stdout = await execTimed(
    'gh',
    ['pr', 'view', String(prNumber), '--json', 'headRefName'],
    repoPath,
    `gh pr view #${prNumber}`,
  );
  return (JSON.parse(stdout) as { headRefName: string }).headRefName;
}

/**
 * PR `prNumber`'s description as GitHub holds it now, read fresh rather than
 * from the PR list so an edit starts from, and is checked against, the latest.
 */
export async function prBody(repoPath: string, prNumber: number): Promise<string> {
  const stdout = await execTimed(
    'gh',
    ['pr', 'view', String(prNumber), '--json', 'body'],
    repoPath,
    `gh pr view #${prNumber} body`,
  );
  return (JSON.parse(stdout) as { body?: string }).body ?? '';
}

/**
 * Replaces PR `prNumber`'s description. Goes through the REST endpoint rather
 * than `gh pr edit`, which also reads the PR's classic projects and fails on
 * GitHub's deprecation of them. `-f` sends the body as a raw string, so text
 * opening with `@` is never read as a file name.
 */
export async function setPrBody(repoPath: string, prNumber: number, body: string): Promise<void> {
  try {
    await execTimed(
      'gh',
      ['api', '-X', 'PATCH', `repos/{owner}/{repo}/pulls/${prNumber}`, '-f', `body=${body}`, '--silent'],
      repoPath,
      `gh pr edit #${prNumber} body`,
    );
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (err instanceof Error ? err.message : String(err)));
  }
}

function toOpenPr(p: GhPrJson): OpenPr {
  return {
    number: p.number,
    title: p.title,
    isDraft: p.isDraft,
    url: p.url,
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    author: p.author?.login ?? '',
    body: p.body ?? '',
  };
}

/** Branches per GraphQL request; each is one aliased lookup in the query. */
const BRANCH_LOOKUP_CHUNK = 100;

interface GhPrNode extends GhPrJson {
  headRepositoryOwner?: { login?: string } | null;
}

/**
 * The open PR for each of `branches`, looked up by head branch name. A backup
 * for `listOpenPrs`: its newest-200 window misses older PRs in a busy
 * repository, and paging through every open PR costs seconds per refresh.
 * Each branch is an aliased `pullRequests(headRefName:)` field, so one request
 * covers a whole chunk. Branch names travel as variables, never spliced into
 * the query text. A branch with no open PR is simply absent from the result.
 */
export async function listOpenPrsForBranches(
  repoPath: string,
  branches: string[],
): Promise<OpenPr[]> {
  const found: OpenPr[] = [];
  for (let i = 0; i < branches.length; i += BRANCH_LOOKUP_CHUNK) {
    found.push(...(await lookUpChunk(repoPath, branches.slice(i, i + BRANCH_LOOKUP_CHUNK))));
  }
  return found;
}

async function lookUpChunk(repoPath: string, branches: string[]): Promise<OpenPr[]> {
  const vars = branches.map((_, i) => `, $h${i}: String!`).join('');
  // `first: 5` rather than 1: a fork can open a PR from a branch of the same
  // name, and the one wanted is the PR whose head lives in this repository.
  const fields = branches
    .map((_, i) => `b${i}: pullRequests(headRefName: $h${i}, states: OPEN, first: 5) { ...pr }`)
    .join('\n    ');
  const query = `query($owner: String!, $name: String!${vars}) {
  repository(owner: $owner, name: $name) {
    owner { login }
    ${fields}
  }
}
fragment pr on PullRequestConnection {
  nodes { number title isDraft url headRefName baseRefName body author { login } headRepositoryOwner { login } }
}`;
  // `-F` so gh fills in the placeholders; branches go through `-f` so a name
  // like `123` or `true` stays a string.
  const args = ['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-f', `query=${query}`];
  branches.forEach((b, i) => args.push('-f', `h${i}=${b}`));
  const stdout = await execTimed('gh', args, repoPath, `gh pr lookup (${branches.length} branches)`);
  const repo = (JSON.parse(stdout) as {
    data: { repository: Record<string, unknown> & { owner: { login: string } } };
  }).data.repository;
  const owner = repo.owner.login;
  const found: OpenPr[] = [];
  branches.forEach((_, i) => {
    const nodes = (repo[`b${i}`] as { nodes: GhPrNode[] } | undefined)?.nodes ?? [];
    const pr = nodes.find((n) => n.headRepositoryOwner?.login === owner) ?? nodes[0];
    if (pr) found.push(toOpenPr(pr));
  });
  return found;
}

/**
 * The commit each PR sits on: the first parent of its oldest commit, keyed by
 * PR number. It lies on the head branch's own history, so a clone holding the
 * branch has it even when its copy of the base branch was never fetched past
 * it. A PR with no commits is absent from the result.
 */
export async function prBaseCommits(
  repoPath: string,
  numbers: number[],
): Promise<Map<number, string>> {
  const bases = new Map<number, string>();
  if (numbers.length === 0) return bases;
  const vars = numbers.map((_, i) => `, $n${i}: Int!`).join('');
  const fields = numbers
    .map(
      (_, i) =>
        `p${i}: pullRequest(number: $n${i}) { commits(first: 1) { nodes { commit { parents(first: 1) { nodes { oid } } } } } }`,
    )
    .join('\n    ');
  const query = `query($owner: String!, $name: String!${vars}) {
  repository(owner: $owner, name: $name) {
    ${fields}
  }
}`;
  const args = ['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-f', `query=${query}`];
  numbers.forEach((n, i) => args.push('-F', `n${i}=${n}`));
  const stdout = await execTimed('gh', args, repoPath, `gh pr base (${numbers.length} PRs)`);
  type Node = {
    commits?: { nodes?: { commit?: { parents?: { nodes?: { oid?: string }[] } } }[] };
  } | null;
  const repo = (JSON.parse(stdout) as { data: { repository: Record<string, Node> } }).data
    .repository;
  numbers.forEach((n, i) => {
    const oid = repo[`p${i}`]?.commits?.nodes?.[0]?.commit?.parents?.nodes?.[0]?.oid;
    if (oid) bases.set(n, oid);
  });
  return bases;
}

/**
 * How many inline review comments each commit of a PR received, keyed by the
 * commit the comment was written against. `original_commit_id` is that commit;
 * `commit_id` moves when the comment is re-anchored onto a later push, which
 * would attribute an old comment to the patch that happens to hold the line
 * now.
 */
export async function prCommentCountsBySha(
  repoPath: string,
  prNumber: number,
): Promise<Map<string, number>> {
  const stdout = await execTimed(
    'gh',
    [
      'api',
      // per_page rides in the query string: a `-F` field would make gh POST.
      `repos/{owner}/{repo}/pulls/${prNumber}/comments?per_page=100`,
      '--paginate',
      '--jq',
      '.[].original_commit_id',
    ],
    repoPath,
    `gh pr comments #${prNumber}`,
  );
  const counts = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    const sha = line.trim();
    if (!sha) continue;
    counts.set(sha, (counts.get(sha) ?? 0) + 1);
  }
  return counts;
}

export type PrReviewKind = ReviewVerdict;

/** The `gh` user's own unsubmitted review on a PR, started on GitHub. */
export interface PendingReview {
  id: string;
  /** Inline comments waiting in it, which go out when it is submitted. */
  comments: number;
}

/**
 * The `gh` user's pending review on PR `prNumber`, if they have one. GitHub
 * shows a pending review only to its author, and allows each user one per PR,
 * so at most one comes back; `viewerDidAuthor` is checked all the same.
 */
export async function pendingPrReview(
  repoPath: string,
  prNumber: number,
): Promise<PendingReview | undefined> {
  const query = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      reviews(states: PENDING, first: 10) { nodes { id viewerDidAuthor comments { totalCount } } }
    }
  }
}`;
  const stdout = await execTimed(
    'gh',
    ['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `n=${prNumber}`, '-f', `query=${query}`],
    repoPath,
    `gh pr pending review #${prNumber}`,
  );
  type Node = { id: string; viewerDidAuthor?: boolean; comments?: { totalCount?: number } };
  const nodes =
    (JSON.parse(stdout) as {
      data?: { repository?: { pullRequest?: { reviews?: { nodes?: Node[] } } | null } };
    }).data?.repository?.pullRequest?.reviews?.nodes ?? [];
  const own = nodes.find((n) => n.viewerDidAuthor);
  return own ? { id: own.id, comments: own.comments?.totalCount ?? 0 } : undefined;
}

const REVIEW_EVENTS: Record<PrReviewKind, string> = {
  approve: 'APPROVE',
  comment: 'COMMENT',
  'request-changes': 'REQUEST_CHANGES',
};

/**
 * Submits a review on a PR as the `gh` user, and says how many inline
 * comments from a pending review went out with it.
 *
 * A review the user started on GitHub and has not submitted is submitted
 * here, with this verdict and body, so its inline comments are posted rather
 * than left behind. `gh pr review` cannot do that: it starts a new review,
 * which GitHub refuses while one is pending. With no pending review, or when
 * looking for one fails, the review goes through `gh pr review` as before.
 *
 * Text is passed as an argument rather than through a shell, so anything a
 * reviewer types is sent as-is. Rejects with gh's own message — GitHub
 * refuses, for example, an approval or a change request on a PR the reviewer
 * opened.
 */
export async function submitPrReview(
  repoPath: string,
  prNumber: number,
  kind: PrReviewKind,
  body: string,
): Promise<{ pendingComments: number }> {
  let pending: PendingReview | undefined;
  try {
    pending = await pendingPrReview(repoPath, prNumber);
  } catch (err) {
    log().warn(`pending review lookup #${prNumber} failed, posting a new review: ${describeError(err)}`);
  }
  try {
    if (pending) {
      await submitPendingReview(repoPath, prNumber, pending.id, kind, body);
      return { pendingComments: pending.comments };
    }
    const args = ['pr', 'review', String(prNumber), `--${kind}`];
    if (body) args.push('--body', body);
    await execTimed('gh', args, repoPath, `gh pr review #${prNumber} --${kind}`);
    return { pendingComments: 0 };
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (err instanceof Error ? err.message : String(err)));
  }
}

/**
 * Submits a pending review. An empty body is left out rather than sent, so
 * a summary already typed into the pending review on GitHub is kept.
 */
async function submitPendingReview(
  repoPath: string,
  prNumber: number,
  reviewId: string,
  kind: PrReviewKind,
  body: string,
): Promise<void> {
  const withBody = body !== '';
  const query = `mutation($id: ID!, $event: PullRequestReviewEvent!${withBody ? ', $body: String!' : ''}) {
  submitPullRequestReview(input: { pullRequestReviewId: $id, event: $event${withBody ? ', body: $body' : ''} }) {
    pullRequestReview { id }
  }
}`;
  const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `id=${reviewId}`, '-f', `event=${REVIEW_EVENTS[kind]}`];
  if (withBody) args.push('-f', `body=${body}`);
  await execTimed('gh', args, repoPath, `gh pr review #${prNumber} --${kind} (pending)`);
}
