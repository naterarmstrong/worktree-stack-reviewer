import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Uri } from 'vscode';
import { prBody, setPrBody } from '../../src/gh';
import {
  PrBodyFileSystemProvider,
  buildPrBodyEditUri,
  prNumberFromEditUri,
} from '../../src/prBodyEditor';

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A PR on a GitHub that someone else can edit between our calls. */
function fakeGitHub(initial: string, overwrite = true) {
  const state = {
    remote: initial,
    writes: [] as string[],
    asked: 0,
    saved: [] as [number, string][],
  };
  const provider = new PrBodyFileSystemProvider({
    read: async () => state.remote,
    write: async (_n, body) => {
      state.writes.push(body);
      state.remote = body;
    },
    confirmOverwrite: async () => {
      state.asked += 1;
      return overwrite;
    },
    onSaved: (n, body) => state.saved.push([n, body]),
  });
  return { state, provider };
}

describe('pr body edit uris', () => {
  test('name the PR and survive the round trip VS Code puts them through', () => {
    const uri = buildPrBodyEditUri(142);
    expect(uri.path).toBe('/PR-142.md');
    expect(prNumberFromEditUri(Uri.parse(uri.toString()))).toBe(142);
  });

  test('belong to no PR under another scheme or name', () => {
    expect(prNumberFromEditUri(Uri.parse('wt-ext-pr:/PR-142.md'))).toBeUndefined();
    expect(prNumberFromEditUri(Uri.parse('wt-ext-pr-edit:/notes.md'))).toBeUndefined();
  });
});

describe('PrBodyFileSystemProvider', () => {
  const uri = buildPrBodyEditUri(142);

  test('opens the body GitHub holds and saves the edit back', async () => {
    const { state, provider } = fakeGitHub('## Description\n\nOld text\n');
    expect(text(await provider.readFile(uri))).toBe('## Description\n\nOld text\n');

    await provider.writeFile(uri, bytes('## Description\n\nNew text\n'));

    expect(state.writes).toEqual(['## Description\n\nNew text\n']);
    expect(state.asked).toBe(0);
    expect(state.saved).toEqual([[142, '## Description\n\nNew text\n']]);
  });

  test('asks before overwriting an edit made on GitHub meanwhile, and keeps it when told to', async () => {
    const { state, provider } = fakeGitHub('Original', false);
    await provider.readFile(uri);
    state.remote = 'Edited on GitHub';

    await expect(provider.writeFile(uri, bytes('Edited here'))).rejects.toThrow(
      'changed on GitHub',
    );

    expect(state.asked).toBe(1);
    expect(state.writes).toEqual([]);
    expect(state.remote).toBe('Edited on GitHub');
  });

  test('overwrites an edit made on GitHub when told to', async () => {
    const { state, provider } = fakeGitHub('Original', true);
    await provider.readFile(uri);
    state.remote = 'Edited on GitHub';

    await provider.writeFile(uri, bytes('Edited here'));

    expect(state.asked).toBe(1);
    expect(state.remote).toBe('Edited here');
  });

  test('checks a second save against the first, not against what was opened', async () => {
    const { state, provider } = fakeGitHub('Original');
    await provider.readFile(uri);
    await provider.writeFile(uri, bytes('First save'));
    await provider.writeFile(uri, bytes('Second save'));

    expect(state.asked).toBe(0);
    expect(state.writes).toEqual(['First save', 'Second save']);
  });

  test('sends nothing when GitHub already holds the saved text', async () => {
    const { state, provider } = fakeGitHub('Same');
    await provider.readFile(uri);
    await provider.writeFile(uri, bytes('Same'));

    expect(state.writes).toEqual([]);
    expect(state.saved).toEqual([[142, 'Same']]);
  });

  test("keeps a file's mtime across reads, so VS Code sees no newer copy on save", async () => {
    const { provider } = fakeGitHub('Body');
    const opened = provider.stat(uri).mtime;
    await provider.readFile(uri);
    await new Promise((r) => setTimeout(r, 5));
    expect(provider.stat(uri).mtime).toBe(opened);

    await provider.writeFile(uri, bytes('Changed'));
    expect(provider.stat(uri).mtime).toBeGreaterThan(opened);
  });
});

describe('prBody and setPrBody', () => {
  let dir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    // A stand-in `gh` that records its arguments, one per line, and prints
    // whatever a test puts in FAKE_GH_OUT.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
    fs.writeFileSync(
      path.join(dir, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\n` +
        `if [ -n "$FAKE_GH_FAIL" ]; then echo "$FAKE_GH_FAIL" >&2; exit 1; fi\n` +
        `printf '%s' "$FAKE_GH_OUT"\n`,
      { mode: 0o755 },
    );
    originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_GH_FAIL;
    delete process.env.FAKE_GH_OUT;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const args = () => fs.readFileSync(path.join(dir, 'args'), 'utf8').trimEnd().split('\n');

  test('reads the body alone', async () => {
    process.env.FAKE_GH_OUT = JSON.stringify({ body: 'Hello\r\nworld' });
    expect(await prBody(dir, 142)).toBe('Hello\r\nworld');
    expect(args()).toEqual(['pr', 'view', '142', '--json', 'body']);
  });

  test('sends the body as a raw string, even one that looks like a file name', async () => {
    await setPrBody(dir, 142, '@notes.md $(rm -rf /) stays text');
    expect(args()).toEqual([
      'api',
      '-X',
      'PATCH',
      'repos/{owner}/{repo}/pulls/142',
      '-f',
      'body=@notes.md $(rm -rf /) stays text',
      '--silent',
    ]);
  });

  test("rejects with gh's own message", async () => {
    process.env.FAKE_GH_FAIL = 'HTTP 403: Must have admin rights to Repository.';
    await expect(setPrBody(dir, 142, 'x')).rejects.toThrow('Must have admin rights');
  });
});
