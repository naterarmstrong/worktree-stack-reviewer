import { execFile, type ExecFileException } from 'node:child_process';
import * as os from 'node:os';
import { log } from './log';

const MAX_BUFFER = 50 * 1024 * 1024;

/**
 * Total duration at or above which a call is reported at info level. Slow work
 * is the reason to read this log, so it should not be hidden behind Trace.
 */
const SLOW_MS = 250;

interface ExecFailure extends ExecFileException {
  stdout?: string;
  stderr?: string;
}

/** Our own child processes currently running, reported alongside each timing. */
let inFlight = 0;

/**
 * Runs a command, recording separately how long it took to start and how long
 * it then ran.
 *
 * The two halves have different causes. `wait` covers the gap between asking
 * for the process and Node reporting it spawned; the extension host is
 * single-threaded, so a busy host pushes that up even for a command that costs
 * nothing. `run` is the command's own work.
 *
 * `run` alone still cannot explain a command that is fast in a terminal and
 * slow here, so each report also carries how many of our own children were
 * running and the machine's load average. Those separate the three
 * possibilities: our own fan-out (high `ours`, normal load), something else on
 * the machine competing for the same disk (low `ours`, high load), or a
 * genuinely expensive command (low on both).
 */
export function execTimed(
  command: string,
  args: string[],
  cwd: string,
  label = `${command} ${args.join(' ')}`,
): Promise<string> {
  const start = Date.now();
  let spawnedAt: number | undefined;
  inFlight += 1;
  // The count while this command ran matters, not the count once it finished,
  // so the peak is tracked as siblings start rather than read at the end.
  let peers = inFlight;
  const track = (): void => {
    peers = Math.max(peers, inFlight);
  };
  const timer = setInterval(track, 50);
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd, maxBuffer: MAX_BUFFER },
      (err, stdout, stderr) => {
        clearInterval(timer);
        track();
        inFlight -= 1;
        report(label, start, spawnedAt, peers, err);
        if (err) {
          const failure = err as ExecFailure;
          failure.stdout = stdout;
          failure.stderr = stderr;
          reject(failure);
          return;
        }
        resolve(stdout);
      },
    );
    // Never emitted when the binary is missing, which leaves `spawnedAt`
    // unset and the whole duration attributed to the wait.
    child.on('spawn', () => {
      spawnedAt = Date.now();
    });
  });
}

function report(
  label: string,
  start: number,
  spawnedAt: number | undefined,
  peers: number,
  err: ExecFileException | null,
): void {
  const done = Date.now();
  const total = done - start;
  const wait = (spawnedAt ?? done) - start;
  const run = spawnedAt === undefined ? 0 : done - spawnedAt;
  const outcome = err ? ' failed' : '';
  const load = os.loadavg()[0].toFixed(1);
  const line =
    `${`${total}ms`.padStart(7)} ${label}${outcome} ` +
    `(wait ${wait}ms, run ${run}ms, ${peers} ours, load ${load})`;
  if (total >= SLOW_MS) {
    log().info(line);
    return;
  }
  log().trace(line);
}
