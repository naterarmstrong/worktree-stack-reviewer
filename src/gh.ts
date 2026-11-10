import { execTimed } from './exec';
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

/**
 * Submits a review on a PR as the `gh` user. The body is passed as an argument
 * rather than through a shell, so any text a reviewer types is sent as-is.
 * Rejects with gh's own message — GitHub refuses, for example, an approval or
 * a change request on a PR the reviewer opened.
 */
export async function submitPrReview(
  repoPath: string,
  prNumber: number,
  kind: PrReviewKind,
  body: string,
): Promise<void> {
  const args = ['pr', 'review', String(prNumber), `--${kind}`];
  if (body) args.push('--body', body);
  try {
    await execTimed('gh', args, repoPath, `gh pr review #${prNumber} --${kind}`);
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || (err instanceof Error ? err.message : String(err)));
  }
}
