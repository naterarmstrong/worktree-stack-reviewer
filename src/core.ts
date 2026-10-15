import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from './log';

/**
 * Calls into `wt-core`, the Rust process that answers the extension's git
 * questions in-process with gix (see `core/`). One process serves every
 * worktree for the life of the extension host, so a refresh costs no process
 * startups and the object database stays mapped between them.
 *
 * Each request is one line of JSON and so is each answer; answers are matched
 * back by id since the core runs requests concurrently and they finish in any
 * order. A core that exits fails whatever was in flight and is started again
 * on the next call.
 */

/** Same threshold as subprocess timing: slow calls are what this log is for. */
const SLOW_MS = 250;

const BINARY_NAME = process.platform === 'win32' ? 'wt-core.exe' : 'wt-core';

/** Raised with the core's own message when a request fails. */
export class CoreError extends Error {}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  label: string;
  start: number;
}

let child: ChildProcess | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();
let resolvedBinary: string | undefined;

/**
 * Where the binary is: `WT_CORE_BIN` when set, and otherwise the newest of the
 * copy `install.sh` packages into `bin/` and the release and debug builds in
 * `core/target/`. Newest rather than a fixed preference, so a development
 * host or a test run never picks up a binary older than the source beside it.
 */
export function coreBinaryPath(): string {
  if (resolvedBinary) return resolvedBinary;
  const override = process.env.WT_CORE_BIN;
  const root = path.resolve(__dirname, '..');
  const candidates = override
    ? [override]
    : [
        path.join(root, 'bin', BINARY_NAME),
        path.join(root, 'core', 'target', 'release', BINARY_NAME),
        path.join(root, 'core', 'target', 'debug', BINARY_NAME),
      ];
  let found: string | undefined;
  let newest = -1;
  for (const candidate of candidates) {
    try {
      const mtime = fs.statSync(candidate).mtimeMs;
      if (mtime > newest) {
        newest = mtime;
        found = candidate;
      }
    } catch {
      // Not built there.
    }
  }
  if (!found) {
    throw new CoreError(
      `wt-core not found (looked in ${candidates.join(', ')}) — build it with \`cargo build --release\` in core/, or run install.sh`,
    );
  }
  resolvedBinary = found;
  return found;
}

function ensureChild(): ChildProcess {
  if (child) return child;
  const binary = coreBinaryPath();
  const proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  log().info(`core: started ${binary} (pid ${proc.pid})`);
  let buffered = '';
  proc.stdout?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => {
    buffered += chunk;
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line) settle(line);
      newline = buffered.indexOf('\n');
    }
  });
  proc.stderr?.setEncoding('utf8');
  proc.stderr?.on('data', (chunk: string) => {
    log().warn(`core: ${chunk.trimEnd()}`);
  });
  const fail = (reason: string): void => {
    if (child === proc) child = undefined;
    for (const [id, p] of pending) {
      pending.delete(id);
      p.reject(new CoreError(`wt-core ${reason} during ${p.label}`));
    }
  };
  proc.on('error', (err) => {
    log().error(`core: ${err.message}`);
    fail(`failed (${err.message})`);
  });
  proc.on('exit', (code, signal) => {
    log().warn(`core: exited (${signal ?? code})`);
    fail('exited');
  });
  child = proc;
  holdOpen(false);
  return proc;
}

type Refable = { ref?: () => void; unref?: () => void } | null | undefined;

/**
 * Keeps Node's event loop alive on the core's account only while an answer is
 * owed. An idle core must not hold a test run or a closing host open, and a
 * busy one must: a pending promise alone doesn't keep a process running.
 */
function holdOpen(hold: boolean): void {
  if (!child) return;
  const handles: Refable[] = [
    child as unknown as Refable,
    child.stdin as unknown as Refable,
    child.stdout as unknown as Refable,
    child.stderr as unknown as Refable,
  ];
  for (const h of handles) {
    if (hold) h?.ref?.();
    else h?.unref?.();
  }
}

function settle(line: string): void {
  let message: { id: number; result?: unknown; error?: string };
  try {
    message = JSON.parse(line);
  } catch {
    log().warn(`core: unreadable answer: ${line.slice(0, 200)}`);
    return;
  }
  const p = pending.get(message.id);
  if (!p) return;
  pending.delete(message.id);
  if (pending.size === 0) holdOpen(false);
  const total = Date.now() - p.start;
  const report = `${`${total}ms`.padStart(7)} core ${p.label}${message.error === undefined ? '' : ' failed'}`;
  if (total >= SLOW_MS) log().info(report);
  else log().trace(report);
  if (message.error !== undefined) p.reject(new CoreError(message.error));
  else p.resolve(message.result);
}

/** Sends one request and waits for its answer. */
export function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let proc: ChildProcess;
    try {
      proc = ensureChild();
    } catch (err) {
      reject(err);
      return;
    }
    const id = nextId++;
    const label = `${method} ${describeParams(params)}`;
    pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
      label,
      start: Date.now(),
    });
    holdOpen(true);
    proc.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

function describeParams(params: Record<string, unknown>): string {
  return Object.entries(params)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'boolean')
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
}

/** Stops the core; the next call starts a fresh one. */
export function stopCore(): void {
  child?.kill();
  child = undefined;
}
