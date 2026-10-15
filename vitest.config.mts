import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // `vscode` is provided by the extension host at runtime and cannot be
      // imported outside it. The unit tier runs in plain Node against a stub.
      vscode: fileURLToPath(new URL('./test/stubs/vscode.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    setupFiles: ['test/unit/setup.ts'],
    // Builds the Rust core once per run, so every git read goes through a
    // binary built from the source beside it.
    globalSetup: ['test/unit/buildCore.ts'],
    // These build real repositories and shell out to git.
    testTimeout: 30_000,
  },
});
