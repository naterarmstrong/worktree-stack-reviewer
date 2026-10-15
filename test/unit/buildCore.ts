import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * Builds `core/` before the unit tier runs. A debug build is enough here and
 * is incremental; the client picks whichever build is newest, so this one
 * wins over an older release build.
 */
export default function setup(): void {
  const manifest = path.resolve(__dirname, '../../core/Cargo.toml');
  execFileSync('cargo', ['build', '--quiet', '--manifest-path', manifest], {
    stdio: 'inherit',
  });
}
