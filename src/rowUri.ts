import * as path from 'node:path';
import * as vscode from 'vscode';

/**
 * Scheme for the `resourceUri` of a row when decorations are suppressed.
 *
 * VS Code decorates any tree row whose `resourceUri` it recognises, and the
 * problem badges it draws there come from the diagnostics of whichever language
 * server claimed the file. In a repository of worktrees that server is often
 * running against a different worktree's context, so the errors it reports are
 * not real ones. Those lookups are keyed on the exact URI, so a private scheme
 * is enough to miss them.
 *
 * Nothing is registered to serve this scheme. It is only ever a decoration key,
 * never opened: rows that can be opened carry an explicit `command`, and the
 * one command that hands a path back to VS Code takes it from the node instead
 * of reading it off the row.
 */
export const UNDECORATED_SCHEME = 'wt-ext-row';

/**
 * Root the undecorated paths hang under, so that they land inside no
 * repository.
 *
 * Git's decorations are not keyed on the URI. Its provider resolves a row to a
 * repository by `fsPath` alone, paying no attention to the scheme, and colours
 * the row by what `git check-ignore` says about that path. Every path inside a
 * worktree under `.claude/worktrees/` answers that the same way — ignored,
 * because the repository the worktree was made from ignores the directory
 * holding it — so every row in such a worktree drew in the ignored grey. What a
 * path is to the repository around it says nothing about the file as a file
 * under review.
 *
 * A path under no repository is asked no such question. The file-icon theme is
 * unaffected: it reads the name off the end of the path and never looks for the
 * file itself.
 */
const UNDECORATED_ROOT = '/wt-ext-row';

/**
 * The `resourceUri` for a row naming a real file or directory, honouring the
 * `showFileDecorations` setting.
 */
export function rowUri(absPath: string): vscode.Uri {
  const decorate = vscode.workspace
    .getConfiguration('worktreeReview')
    .get<boolean>('showFileDecorations', false);
  if (decorate) return vscode.Uri.file(absPath);
  return undecoratedRowUri(absPath);
}

/**
 * A row `resourceUri` that is never decorated, whatever the setting says. For a
 * row standing for a file that exists nowhere on disk, where a real `file:` URI
 * would only invite decorations for a path that isn't there.
 */
export function undecoratedRowUri(absPath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: UNDECORATED_SCHEME,
    // The whole path rather than the file name: worktrees hold the same
    // relative paths as each other, and their rows have to stay distinct.
    path: path.posix.join(UNDECORATED_ROOT, absPath.split(path.sep).join('/')),
  });
}
