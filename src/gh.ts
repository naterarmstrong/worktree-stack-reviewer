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
  const raw = JSON.parse(stdout) as GhPrJson[];
  return raw.map((p) => ({
    number: p.number,
    title: p.title,
    isDraft: p.isDraft,
    url: p.url,
    headRefName: p.headRefName,
    baseRefName: p.baseRefName,
    author: p.author?.login ?? '',
    body: p.body ?? '',
  }));
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
