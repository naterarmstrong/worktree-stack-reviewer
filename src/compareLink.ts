import * as vscode from 'vscode';

/**
 * A `vscode://<extension id>/compare?branch=…&a=…&b=…[&file=…]` link opens
 * the interdiff between two versions of a branch, the same way "Compare with
 * Another Version…" does from the tree. `a` and `b` are what the compare
 * command accepts: version numbers, shas, or `base`. Shas are the stable
 * choice for a link that outlives the tab it was written in, since version
 * numbers shift when the reflog is truncated. `file` narrows the compare to
 * one worktree-relative path.
 *
 * Written by hand by an agent that has just committed a patch and wants to
 * point the reviewer at exactly what changed since the previous one.
 */
export const COMPARE_LINK_PATH = '/compare';

export interface CompareLink {
  branch: string;
  a: string;
  b: string;
  file?: string;
}

export function parseCompareLink(uri: vscode.Uri): CompareLink | undefined {
  if (uri.path !== COMPARE_LINK_PATH) return undefined;
  const query = new URLSearchParams(uri.query);
  const branch = query.get('branch')?.trim();
  const a = query.get('a')?.trim();
  const b = query.get('b')?.trim();
  if (!branch || !a || !b) return undefined;
  const file = query.get('file')?.trim();
  return { branch, a, b, file: file || undefined };
}

