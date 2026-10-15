import * as path from 'node:path';
import Mocha from 'mocha';

/**
 * Entry point VS Code calls inside the extension host. Everything from here on
 * runs with the real `vscode` module available.
 */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: false, timeout: 60_000 });
  mocha.addFile(path.resolve(__dirname, 'extension.test.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} test(s) failed`));
        return;
      }
      resolve();
    });
  });
}
