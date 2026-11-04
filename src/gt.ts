import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { execTimed } from './exec';

const DEFAULT_COMMAND = 'gt';

/** Carries gt's own stderr message when it exits non-zero. */
export class GtError extends Error {}

let workingCommand: string | undefined;

/**
 * Runs gt. The configured command is tried first; when it's the default bare
 * name, `~/.cargo/bin/gt` is tried too, since the VS Code server process often
 * lacks the shell profile that puts cargo's bin directory on PATH. Whichever
 * command runs is remembered for subsequent calls.
 */
export async function runGt(cwd: string, args: string[]): Promise<string> {
  const configured = vscode.workspace
    .getConfiguration('worktreeReview')
    .get<string>('gtCommand', DEFAULT_COMMAND);
  const candidates: string[] = [];
  if (workingCommand) candidates.push(workingCommand);
  candidates.push(configured);
  if (configured === DEFAULT_COMMAND) {
    candidates.push(path.join(os.homedir(), '.cargo', 'bin', DEFAULT_COMMAND));
  }
  for (const command of new Set(candidates)) {
    try {
      const stdout = await execTimed(
        command,
        args,
        cwd,
        `${path.basename(command)} ${args.join(' ')}`,
      );
      workingCommand = command;
      return stdout;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (workingCommand === command) workingCommand = undefined;
        continue;
      }
      throw new GtError(gtError(err));
    }
  }
  throw new GtError(
    `'${configured}' not found — install gt or set worktreeReview.gtCommand to its path`,
  );
}

/** gt reports failures as `error: …` on stderr before exiting 1. */
export function gtError(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr?.trim() ?? '';
  if (stderr) return stderr.replace(/^error:\s*/i, '');
  return err instanceof Error ? err.message.split('\n')[0] : String(err);
}
