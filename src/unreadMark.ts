import * as vscode from 'vscode';

/**
 * Scheme for the `resourceUri` of a comment thread row with replies the
 * reviewer has not seen. Like `UNDECORATED_SCHEME`, nothing serves it; it only
 * keys the decoration below. The count rides in the query, so a thread whose
 * count changes gets a fresh URI rather than a stale cached decoration.
 */
const UNREAD_SCHEME = 'wt-ext-unread';

export function unreadRowUri(threadId: string, unread: number): vscode.Uri {
  return vscode.Uri.from({ scheme: UNREAD_SCHEME, path: `/${threadId}`, query: `${unread}` });
}

/** Draws a solid dot on the right of every unread thread row. */
export function registerUnreadMarks(): vscode.Disposable {
  return vscode.window.registerFileDecorationProvider({
    provideFileDecoration(uri) {
      if (uri.scheme !== UNREAD_SCHEME) return undefined;
      const unread = Number(uri.query);
      return {
        badge: '●',
        tooltip: unread === 1 ? '1 unread reply' : `${unread} unread replies`,
        color: new vscode.ThemeColor('notificationsInfoIcon.foreground'),
      };
    },
  });
}
