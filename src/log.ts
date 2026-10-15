import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): vscode.LogOutputChannel {
  const c = vscode.window.createOutputChannel('Worktree Stack Reviewer', { log: true });
  context.subscriptions.push(c);
  channel = c;
  return c;
}

export function log(): vscode.LogOutputChannel {
  if (!channel) {
    throw new Error('Worktree Stack Reviewer log channel accessed before init.');
  }
  return channel;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

/** Milliseconds since `start`, as `"123ms"`. */
export function elapsed(start: number): string {
  return `${Date.now() - start}ms`;
}
