import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { makeFixture, seedComments } from '../fixtures/repo';

const EXTENSION_ROOT = path.resolve(__dirname, '..', '..');

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * VS Code's IPC socket lives inside the user-data directory, and unix socket
 * paths cap out at 107 characters. The default under the project directory is
 * long enough to trip that, so the run gets short directories of its own.
 */
function shortDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Electron needs an X display. Real desktops have one; a container gets a
 * throwaway Xvfb for the length of the run, published through `DISPLAY` so the
 * VS Code process inherits it.
 */
async function startDisplay(): Promise<{ stop: () => void } | undefined> {
  if (process.env.DISPLAY) return undefined;
  for (let n = 99; n < 110; n++) {
    const socket = `/tmp/.X11-unix/X${n}`;
    if (fs.existsSync(socket)) continue;
    const child = cp.spawn('Xvfb', [`:${n}`, '-screen', '0', '1280x1024x24'], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    for (let waited = 0; waited < 5_000; waited += 100) {
      await sleep(100);
      if (!fs.existsSync(socket)) continue;
      process.env.DISPLAY = `:${n}`;
      return { stop: () => child.kill('SIGKILL') };
    }
    child.kill('SIGKILL');
  }
  throw new Error('could not start Xvfb on displays :99-:109');
}

const PREREQUISITES = `
End-to-end tests drive a real VS Code, which needs a display and the GUI
libraries Electron links against:

  sudo apt-get install -y xvfb xauth libgtk-3-0 libnss3 libasound2

They are not part of the devcontainer image, so a rebuild drops them.
`.trim();

async function main(): Promise<void> {
  const fixture = makeFixture();
  // A failing run is easier to look into with the repositories still there.
  const keepFixture = process.env.WT_KEEP_FIXTURE === '1';
  if (keepFixture) console.log(`fixture: ${fixture.root}`);
  // A worktree that already carries comments, so the export path has something
  // to find — one on a file, one on a pull request description.
  seedComments(fixture.feature, [
    {
      id: 'seeded',
      branch: 'feature',
      file: 'src/app.ts',
      startLine: 1,
      body: 'seeded by the fixture',
    },
    {
      id: 'seeded-pr',
      branch: 'feature',
      file: 'PR-7.md',
      side: 'pr',
      startLine: 3,
      body: 'seeded on the description',
    },
  ]);

  const display = await startDisplay();
  const userDataDir = shortDir('wt-ud-');
  const extensionsDir = shortDir('wt-ext-');
  try {
    await runTests({
      extensionDevelopmentPath: EXTENSION_ROOT,
      extensionTestsPath: path.resolve(__dirname, 'index.js'),
      extensionTestsEnv: { WT_FIXTURE: fixture.root },
      launchArgs: [
        fixture.repo,
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`,
        '--disable-workspace-trust',
        '--disable-gpu',
        // Only the extension under development loads, so nothing else in the
        // developer's VS Code can influence the run.
        '--disable-extensions',
      ],
    });
  } finally {
    display?.stop();
    if (!keepFixture) fixture.remove();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(extensionsDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  console.error(`\n${PREREQUISITES}`);
  process.exit(1);
});
