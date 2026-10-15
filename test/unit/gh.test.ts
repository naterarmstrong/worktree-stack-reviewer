import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { submitPrReview } from '../../src/gh';

describe('submitPrReview', () => {
  let dir: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    // A stand-in `gh` that records its arguments, one per line, and fails the
    // way gh does when told to.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
    fs.writeFileSync(
      path.join(dir, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\n` +
        `if [ -n "$FAKE_GH_FAIL" ]; then echo "$FAKE_GH_FAIL" >&2; exit 1; fi\n`,
      { mode: 0o755 },
    );
    originalPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    delete process.env.FAKE_GH_FAIL;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const args = () => fs.readFileSync(path.join(dir, 'args'), 'utf8').trimEnd().split('\n');

  test('sends the verdict and the comment as they were typed', async () => {
    await submitPrReview(dir, 142, 'request-changes', 'Please split `foo`; $(rm -rf /) stays text');
    expect(args()).toEqual([
      'pr',
      'review',
      '142',
      '--request-changes',
      '--body',
      'Please split `foo`; $(rm -rf /) stays text',
    ]);
  });

  test('approves without a body when none was given', async () => {
    await submitPrReview(dir, 7, 'approve', '');
    expect(args()).toEqual(['pr', 'review', '7', '--approve']);
  });

  test("rejects with gh's own message", async () => {
    process.env.FAKE_GH_FAIL = 'failed to create review: Can not approve your own pull request';
    await expect(submitPrReview(dir, 7, 'approve', '')).rejects.toThrow(
      'Can not approve your own pull request',
    );
  });
});
