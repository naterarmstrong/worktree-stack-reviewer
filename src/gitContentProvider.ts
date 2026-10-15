import * as vscode from 'vscode';
import { showFileAtRef } from './git';

export const GIT_SCHEME = 'wt-ext-git';

export interface GitUriParts {
  worktreePath: string;
  ref: string;
  file: string;
}

/**
 * Encodes the worktree and the ref in the query, and the file in the path.
 *
 * The worktree must not go in the authority. VS Code lowercases a URI's
 * authority when it formats it, and it resolves every virtual document by
 * `toString()`-ing the URI into a cache key and rebuilding it with
 * `URI.parse()`, so an authority-borne path arrives case-folded. A worktree
 * whose path contains an uppercase letter then matches none of the paths
 * `git worktree list` reports. The path and query survive that trip unchanged.
 */
export function buildGitUri(
  worktreePath: string,
  ref: string,
  filePath: string,
): vscode.Uri {
  return vscode.Uri.from({
    scheme: GIT_SCHEME,
    path: `/${filePath}`,
    query: new URLSearchParams({ wt: worktreePath, ref }).toString(),
  });
}

/**
 * Reads back what `buildGitUri` encoded. Returns undefined for a URI carrying
 * no worktree, which is how a tab restored from an older build arrives.
 */
export function parseGitUri(uri: vscode.Uri): GitUriParts | undefined {
  const query = new URLSearchParams(uri.query);
  const worktreePath = query.get('wt');
  if (!worktreePath) return undefined;
  return {
    worktreePath,
    ref: query.get('ref') ?? 'HEAD',
    file: uri.path.replace(/^\//, ''),
  };
}

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  private cache = new Map<string, string>();
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const parts = parseGitUri(uri);
    if (!parts) {
      // Raised rather than rendered as an empty document, which is what an
      // added or deleted file legitimately looks like.
      throw new Error(
        `Worktree Stack Reviewer: ${uri.toString()} names no worktree — close the tab and reopen the diff.`,
      );
    }
    const content = await showFileAtRef(parts.worktreePath, parts.ref, parts.file);
    this.cache.set(key, content);
    return content;
  }

  invalidate(): void {
    const keys = Array.from(this.cache.keys());
    this.cache.clear();
    for (const k of keys) {
      this._onDidChange.fire(vscode.Uri.parse(k));
    }
  }
}
