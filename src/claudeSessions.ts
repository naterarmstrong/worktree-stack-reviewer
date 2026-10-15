import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describeError, log } from './log';

/**
 * A running Claude Code session records itself in one file per process here,
 * which is how the sessions in a worktree are found at all.
 */
const SESSIONS_DIR_NAME = 'sessions';

/**
 * Conversation transcripts, one directory per working directory. A title the
 * user has given a conversation is stored under it, per session.
 */
const PROJECTS_DIR_NAME = 'projects';

/** Holds `{ "customTitle": "…" }` for a conversation that has been titled. */
const TITLE_FILE_NAME = 'custom-title.json';

/**
 * The value `nameSource` carries when Claude made the session file's `name` up
 * from the directory name rather than being told one — `bridge-cse-01umjj…-bc`
 * and the like. Those say less than the branch name they would replace.
 */
const DERIVED_NAME_SOURCE = 'derived';

/** A conversation whose session is still running, and what it is called. */
export interface ClaudeSession {
  /** The conversation's title. */
  name: string;
  /** Claude's own id for the conversation, which outlives any one process. */
  sessionId: string;
  /** `idle`, `waiting`, `shell` — absent until the session first reports one. */
  status: string | undefined;
  startedAt: number | undefined;
}

/** The shape of a session file, as far as any of it is relied on here. */
interface SessionRecord {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  name?: string;
  nameSource?: string;
  /** Process start time in clock ticks, which pins the record to one process. */
  procStart?: string;
  /** The pid namespace `pid` is a number in, as `linux::pid:[…]`. */
  pidDomain?: string;
  status?: string;
  startedAt?: number;
}

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function sessionsDir(): string {
  return path.join(configDir(), SESSIONS_DIR_NAME);
}

/**
 * Where a conversation's title is kept, for a session started in `cwd`.
 *
 * Claude names each transcript directory after the working directory, with
 * every `/`, `.` and `_` in the path written as `-`.
 */
export function titlePathFor(cwd: string, sessionId: string): string {
  const project = cwd.replace(/[/._]/g, '-');
  return path.join(configDir(), PROJECTS_DIR_NAME, project, sessionId, TITLE_FILE_NAME);
}

/**
 * The titled conversations running in a worktree, most recently started first.
 *
 * Session files outlive their sessions: a container restart leaves records
 * behind whose titles still read as current, so a record only counts once the
 * process it names is confirmed to still be the one that wrote it. Untitled
 * conversations are left out entirely.
 */
export async function liveSessionsIn(worktreePath: string): Promise<ClaudeSession[]> {
  const dir = sessionsDir();
  let filenames: string[];
  try {
    filenames = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log().warn(`sessions: cannot read ${dir}: ${describeError(err)}`);
    }
    return [];
  }

  const domain = await pidNamespace();
  const records = await Promise.all(
    filenames
      .filter((f) => f.endsWith('.json'))
      .map((f) => readRecord(path.join(dir, f))),
  );

  const found: ClaudeSession[] = [];
  for (const record of records) {
    if (!record || record.cwd !== worktreePath) continue;
    if (!(await isRunning(record, domain))) continue;
    const name = await titleOf(record);
    if (name === undefined) continue;
    found.push({
      name,
      sessionId: record.sessionId ?? `pid:${record.pid}`,
      status: record.status,
      startedAt: record.startedAt,
    });
  }

  found.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  // One conversation can have written several files across restarts. The
  // liveness check clears out most of them, so this is the last resort.
  const bySession = new Map<string, ClaudeSession>();
  for (const session of found) {
    if (!bySession.has(session.sessionId)) bySession.set(session.sessionId, session);
  }
  return Array.from(bySession.values());
}

async function readRecord(file: string): Promise<SessionRecord | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log().warn(`sessions: cannot read ${file}: ${describeError(err)}`);
    }
    return undefined;
  }
  try {
    return JSON.parse(raw) as SessionRecord;
  } catch (err) {
    log().warn(`sessions: ${file} is not valid JSON (${describeError(err)})`);
    return undefined;
  }
}

/**
 * What a conversation is called.
 *
 * The session file carries a `name`, but it is a copy that only some sessions
 * keep up to date: one run through the remote-control bridge holds the title
 * Claude derived for it at startup however often the conversation is renamed
 * afterwards. The transcript directory's `custom-title.json` is where a rename
 * actually lands, so it is asked first, and the session file's `name` is only
 * used when there is no such file and Claude did not derive that name either.
 */
async function titleOf(record: SessionRecord): Promise<string | undefined> {
  if (record.cwd !== undefined && record.sessionId !== undefined) {
    const titled = await readCustomTitle(titlePathFor(record.cwd, record.sessionId));
    if (titled !== undefined) return titled;
  }
  if (record.nameSource === DERIVED_NAME_SOURCE) return undefined;
  return nonEmpty(record.name);
}

async function readCustomTitle(file: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log().warn(`sessions: cannot read ${file}: ${describeError(err)}`);
    }
    return undefined;
  }
  try {
    return nonEmpty((JSON.parse(raw) as { customTitle?: string }).customTitle);
  } catch (err) {
    log().warn(`sessions: ${file} is not valid JSON (${describeError(err)})`);
    return undefined;
  }
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Whether the process a record names is still the one that wrote it.
 *
 * Two things can make a pid lie. It can belong to another pid namespace, which
 * a restarted container leaves records from; `pidDomain` says which one, and a
 * mismatch means the number addresses nothing here. Or it can have been reused
 * since, which `procStart` catches — the kernel's start time for a pid changes
 * the moment a different process takes the number.
 */
async function isRunning(
  record: SessionRecord,
  domain: string | undefined,
): Promise<boolean> {
  if (typeof record.pid !== 'number') return false;
  if (domain === undefined) return respondsToSignal(record.pid);
  if (record.pidDomain !== undefined && record.pidDomain !== domain) return false;
  const started = await processStart(record.pid);
  if (started === undefined) return false;
  if (record.procStart === undefined) return true;
  return started === record.procStart;
}

/** This process's pid namespace, in the form records write it, or undefined off Linux. */
async function pidNamespace(): Promise<string | undefined> {
  try {
    return `linux::${await fs.readlink('/proc/self/ns/pid')}`;
  } catch {
    return undefined;
  }
}

/** Field 22 of `/proc/<pid>/stat`, the process's start time in clock ticks. */
async function processStart(pid: number): Promise<string | undefined> {
  let stat: string;
  try {
    stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
  // Field 2 is the executable name in parentheses and may itself contain
  // spaces and brackets, so the fields past it are counted from the last `)`
  // rather than by splitting the whole line. Field 3 lands at index 0 there,
  // which puts field 22 at index 19.
  const afterName = stat.slice(stat.lastIndexOf(')') + 1).trim();
  return afterName.split(/\s+/)[19];
}

/**
 * Whether a pid exists, for hosts with no `/proc` to ask instead. `EPERM` is a
 * process owned by someone else, which is still a process.
 */
function respondsToSignal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
