import * as vscode from 'vscode';
import { prBody, setPrBody } from './gh';
import { describeError, log } from './log';
import { prBodyFileName, prNumberFromFileName } from './prBody';

export const PR_BODY_EDIT_SCHEME = 'wt-ext-pr-edit';

/**
 * The editable copy of PR `prNumber`'s description. Only the PR number rides
 * in it: an edit goes to the PR whichever worktree it was started from, and
 * the basename is the same `PR-<n>.md` the read-only document's tab carries.
 */
export function buildPrBodyEditUri(prNumber: number): vscode.Uri {
  return vscode.Uri.from({ scheme: PR_BODY_EDIT_SCHEME, path: `/${prBodyFileName(prNumber)}` });
}

/** The PR an edit URI belongs to, or undefined for any other URI. */
export function prNumberFromEditUri(uri: vscode.Uri): number | undefined {
  if (uri.scheme !== PR_BODY_EDIT_SCHEME) return undefined;
  return prNumberFromFileName(uri.path.replace(/^\//, ''));
}

export interface PrBodyEditorDeps {
  read(prNumber: number): Promise<string>;
  write(prNumber: number, body: string): Promise<void>;
  /**
   * Asked when the description changed on GitHub after it was opened here;
   * true overwrites what GitHub now holds with the text being saved.
   */
  confirmOverwrite(prNumber: number): Promise<boolean>;
  /** Told of every description saved, so the tree and open previews follow. */
  onSaved(prNumber: number, body: string): void;
}

/** The `gh`-backed dependencies the extension runs with. */
export function ghPrBodyEditorDeps(
  repoPath: string,
  onSaved: (prNumber: number, body: string) => void,
): PrBodyEditorDeps {
  return {
    read: (n) => prBody(repoPath, n),
    write: (n, body) => setPrBody(repoPath, n, body),
    confirmOverwrite: async (n) => {
      const overwrite = 'Overwrite';
      const choice = await vscode.window.showWarningMessage(
        `#${n}'s description changed on GitHub since you opened it here.`,
        {
          modal: true,
          detail:
            'Saving replaces it with your text, dropping the other edit. Cancel to keep your changes unsaved; reopening the description reads the new one.',
        },
        overwrite,
      );
      return choice === overwrite;
    },
    onSaved,
  };
}

/**
 * Serves PR descriptions as writable markdown files: opening one reads the
 * body from GitHub, and saving it writes the body back.
 *
 * A save first re-reads the body. When it no longer matches what was opened,
 * someone else edited the description meanwhile, and the save stops to ask
 * rather than silently drop their change.
 */
export class PrBodyFileSystemProvider implements vscode.FileSystemProvider {
  /** What each PR's body read when last opened or saved here: the base a save is checked against. */
  private readonly bases = new Map<number, string>();
  /**
   * Moved only by a save. VS Code compares a file's mtime at save time with
   * the one it opened, so a read that moved it would raise its own "newer on
   * disk" conflict on every save.
   */
  private readonly mtimes = new Map<number, number>();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  constructor(private readonly deps: PrBodyEditorDeps) {}

  stat(uri: vscode.Uri): vscode.FileStat {
    const prNumber = this.prNumber(uri);
    if (!this.mtimes.has(prNumber)) this.mtimes.set(prNumber, Date.now());
    return {
      type: vscode.FileType.File,
      ctime: 0,
      mtime: this.mtimes.get(prNumber) ?? 0,
      size: this.encoder.encode(this.bases.get(prNumber) ?? '').byteLength,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const prNumber = this.prNumber(uri);
    let body: string;
    try {
      body = await this.deps.read(prNumber);
    } catch (err) {
      log().error(`read #${prNumber}'s description for editing: ${describeError(err)}`);
      throw vscode.FileSystemError.Unavailable(
        `Could not read #${prNumber}'s description: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.bases.set(prNumber, body);
    return this.encoder.encode(body);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const prNumber = this.prNumber(uri);
    const body = this.decoder.decode(content);
    const base = this.bases.get(prNumber);
    const current = await this.deps.read(prNumber);
    if (base !== undefined && current !== base && current !== body) {
      if (!(await this.deps.confirmOverwrite(prNumber))) {
        throw vscode.FileSystemError.NoPermissions(
          `#${prNumber}'s description changed on GitHub; not saved.`,
        );
      }
    }
    if (current !== body) await this.deps.write(prNumber, body);
    this.bases.set(prNumber, body);
    this.mtimes.set(prNumber, Date.now());
    log().info(`saved #${prNumber}'s description (${body.length} chars)`);
    this.deps.onSaved(prNumber, body);
  }

  private prNumber(uri: vscode.Uri): number {
    const prNumber = prNumberFromEditUri(uri);
    if (prNumber === undefined) throw vscode.FileSystemError.FileNotFound(uri);
    return prNumber;
  }

  watch(): vscode.Disposable {
    return { dispose: () => {} };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  dispose(): void {
    this._onDidChangeFile.dispose();
  }
}
