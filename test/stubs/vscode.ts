/**
 * Stand-in for the `vscode` module, which only exists inside the extension
 * host. Vitest resolves imports of `vscode` here (see `vitest.config.ts`), so
 * the modules under test can be loaded by plain Node.
 *
 * It covers what those modules actually reach for — the log channel, settings,
 * and URIs — and nothing else. Anything that needs more of the API belongs in
 * the end-to-end tier, where the real thing is available.
 */

import { URI } from 'vscode-uri';

/**
 * Not a stand-in: `vscode-uri` is the package VS Code publishes its own `Uri`
 * from, so tests see the same normalisation the editor applies — including the
 * authority case-folding that a URI has to survive.
 */
export const Uri = URI;

const noop = (): void => {};

const channel = {
  name: 'Worktree Stack Reviewer',
  logLevel: 0,
  onDidChangeLogLevel: () => ({ dispose: noop }),
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  append: noop,
  appendLine: noop,
  replace: noop,
  clear: noop,
  show: noop,
  hide: noop,
  dispose: noop,
};

export const window = {
  createOutputChannel: () => channel,
};

/** Every setting reads as its caller-supplied default. */
export const workspace = {
  getConfiguration: () => ({
    get: <T>(_section: string, fallback?: T): T | undefined => fallback,
  }),
};
