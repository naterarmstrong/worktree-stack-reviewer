import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { liveSessionsIn, sessionsDir, titlePathFor } from '../../src/claudeSessions';

/**
 * The liveness check reads `/proc`, so the records that are meant to pass name
 * this very process. Anything that stubbed that out would stop the tests
 * covering the part most likely to be wrong.
 */
const OWN_PID = process.pid;
const OWN_START = ownProcStart();
const OWN_DOMAIN = `linux::${fs.readlinkSync('/proc/self/ns/pid')}`;

const WORKTREE = '/tmp/tree/feature';

interface RecordFields {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  name?: string;
  nameSource?: string;
  procStart?: string;
  pidDomain?: string;
  status?: string;
  startedAt?: number;
}

describe('liveSessionsIn', () => {
  let configDir: string;
  let previousConfigDir: string | undefined;

  beforeEach(() => {
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-review-sessions-'));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    fs.mkdirSync(sessionsDir(), { recursive: true });
  });

  afterEach(() => {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test('takes the title the conversation was given', async () => {
    writeRecord('live', { name: 'stale-copy', status: 'idle' });
    writeTitle('live', 'auth-refactor');

    const sessions = await liveSessionsIn(WORKTREE);

    expect(sessions).toEqual([
      expect.objectContaining({ name: 'auth-refactor', status: 'idle' }),
    ]);
  });

  test('takes a title a bridge session never copied into its record', async () => {
    // What the remote-control bridge leaves behind: the record still holds the
    // name Claude derived at startup, and only the title file knows the rename.
    writeRecord('bridged', {
      name: 'bridge-cse-01vvzvwz6flds83hudoy6rvk-29',
      nameSource: 'derived',
    });
    writeTitle('bridged', 'slack-error-investigation');

    const sessions = await liveSessionsIn(WORKTREE);

    expect(sessions.map((s) => s.name)).toEqual(['slack-error-investigation']);
  });

  test('falls back to the record when no title file has been written', async () => {
    writeRecord('named', { name: 'auth-refactor' });

    expect((await liveSessionsIn(WORKTREE)).map((s) => s.name)).toEqual(['auth-refactor']);
  });

  test('leaves out a session whose only name Claude derived for it', async () => {
    writeRecord('derived', {
      name: 'bridge-cse-01umjjsvcyhezpqm88csrbxw-bc',
      nameSource: 'derived',
    });

    expect(await liveSessionsIn(WORKTREE)).toEqual([]);
  });

  test('leaves out a session with no title at all', async () => {
    writeRecord('untitled', { name: '   ' });

    expect(await liveSessionsIn(WORKTREE)).toEqual([]);
  });

  test('an unparseable title file leaves the record’s own name standing', async () => {
    writeRecord('broken-title', { name: 'auth-refactor' });
    const target = titlePathFor(WORKTREE, 'broken-title');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{not json', 'utf8');

    expect((await liveSessionsIn(WORKTREE)).map((s) => s.name)).toEqual(['auth-refactor']);
  });

  test('leaves out a session running in another worktree', async () => {
    writeRecord('elsewhere', { name: 'other-work', cwd: '/tmp/tree/review' });

    expect(await liveSessionsIn(WORKTREE)).toEqual([]);
  });

  test('leaves out a record from another pid namespace', async () => {
    writeRecord('restarted', {
      name: 'before-the-restart',
      pidDomain: 'linux::pid:[4026530000]',
    });

    expect(await liveSessionsIn(WORKTREE)).toEqual([]);
  });

  test('leaves out a record whose pid has been reused since', async () => {
    writeRecord('reused', { name: 'long-gone', procStart: '1' });

    expect(await liveSessionsIn(WORKTREE)).toEqual([]);
  });

  test('leaves out a record naming a pid that is not running', async () => {
    writeRecord('dead', { name: 'exited', pid: freePid(), procStart: undefined });

    expect(await liveSessionsIn(WORKTREE)).toEqual([]);
  });

  test('collapses several records for one conversation to its newest', async () => {
    writeRecord('older', {
      name: 'agentic-prior-ask-detection',
      sessionId: 'shared',
      startedAt: 1,
    });
    writeRecord('newer', {
      name: 'auto-reply-prior-ask',
      sessionId: 'shared',
      startedAt: 2,
    });

    const sessions = await liveSessionsIn(WORKTREE);

    expect(sessions.map((s) => s.name)).toEqual(['auto-reply-prior-ask']);
  });

  test('orders several conversations with the most recently started first', async () => {
    writeRecord('first', { name: 'older-work', sessionId: 'a', startedAt: 1 });
    writeRecord('second', { name: 'newer-work', sessionId: 'b', startedAt: 2 });

    const sessions = await liveSessionsIn(WORKTREE);

    expect(sessions.map((s) => s.name)).toEqual(['newer-work', 'older-work']);
  });

  test('a record that is not valid JSON does not lose the ones that are', async () => {
    fs.writeFileSync(path.join(sessionsDir(), 'broken.json'), '{not json', 'utf8');
    writeRecord('live', { name: 'auth-refactor' });

    const sessions = await liveSessionsIn(WORKTREE);

    expect(sessions.map((s) => s.name)).toEqual(['auth-refactor']);
  });

  test('the key files sitting beside the records are not read as records', async () => {
    fs.writeFileSync(path.join(sessionsDir(), '123.abc.key'), 'binary', 'utf8');

    expect(await liveSessionsIn(WORKTREE)).toEqual([]);
  });

  test('no sessions directory means no sessions', async () => {
    fs.rmSync(sessionsDir(), { recursive: true });

    expect(await liveSessionsIn(WORKTREE)).toEqual([]);
  });

  function writeTitle(sessionId: string, customTitle: string): void {
    const target = titlePathFor(WORKTREE, sessionId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify({ customTitle }), 'utf8');
  }

  function writeRecord(basename: string, fields: RecordFields): void {
    const record: RecordFields = {
      pid: OWN_PID,
      sessionId: basename,
      cwd: WORKTREE,
      nameSource: 'user',
      procStart: OWN_START,
      pidDomain: OWN_DOMAIN,
      ...fields,
    };
    fs.writeFileSync(
      path.join(sessionsDir(), `${basename}.json`),
      JSON.stringify(record),
      'utf8',
    );
  }
});

/** Field 22 of this process's `/proc/<pid>/stat`, read the way the module does. */
function ownProcStart(): string {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  return stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/)[19];
}

/** A pid with no process behind it, so the record naming it reads as finished. */
function freePid(): number {
  for (let pid = 4_194_300; pid > 4_000_000; pid--) {
    if (!fs.existsSync(`/proc/${pid}`)) return pid;
  }
  throw new Error('no free pid to test a finished session with');
}
