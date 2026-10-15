import { describe, expect, test } from 'vitest';
import { parseFilePatches } from '../../src/patchId';

/** One file's section of `git diff -U0 --patch` output. */
function section(options: {
  path?: string;
  oldBlob?: string;
  newBlob?: string;
  hunkHeader?: string;
  body?: string[];
}): string {
  const {
    path = 'src/app.ts',
    oldBlob = '1111111',
    newBlob = '2222222',
    hunkHeader = '@@ -1,0 +2 @@',
    body = ['+export const v = 2;'],
  } = options;
  return [
    `diff --git a/${path} b/${path}`,
    `index ${oldBlob}..${newBlob} 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    hunkHeader,
    ...body,
    '',
  ].join('\n');
}

const idOf = (patch: string, file = 'src/app.ts'): string | undefined =>
  parseFilePatches(patch).get(file)?.patchId;

describe('parseFilePatches', () => {
  test('reads one entry per file, keyed by its right-side path', () => {
    const patches = parseFilePatches(
      section({}) + section({ path: 'tests/app.test.ts' }),
    );
    expect(Array.from(patches.keys()).sort()).toEqual([
      'src/app.ts',
      'tests/app.test.ts',
    ]);
  });

  test('the id survives a restack: blob shas and line numbers are left out', () => {
    const before = idOf(section({}));
    const restacked = idOf(
      section({
        oldBlob: 'aaaaaaa',
        newBlob: 'bbbbbbb',
        hunkHeader: '@@ -40,0 +41 @@',
      }),
    );
    expect(restacked).toBe(before);
  });

  test('the id changes when the change itself does', () => {
    const before = idOf(section({}));
    const amended = idOf(section({ body: ['+export const v = 3;'] }));
    expect(amended).not.toBe(before);
  });

  test('two hunks do not hash the same as one hunk holding both bodies', () => {
    const split = idOf(
      section({
        body: ['+first', '@@ -9,0 +10 @@', '+second'],
      }),
    );
    const joined = idOf(section({ body: ['+first', '+second'] }));
    expect(split).not.toBe(joined);
  });

  test('records the base blob for an edit and leaves it unset for an addition', () => {
    const edited = parseFilePatches(section({})).get('src/app.ts');
    expect(edited?.baseBlob).toBe('1111111');

    const added = parseFilePatches(
      section({ oldBlob: '0000000' }),
    ).get('src/app.ts');
    expect(added?.baseBlob).toBeUndefined();
  });

  test('names a deletion by its old path', () => {
    const patch = [
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      'index 3333333..0000000',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-export const gone = true;',
      '',
    ].join('\n');
    expect(Array.from(parseFilePatches(patch).keys())).toEqual(['src/gone.ts']);
  });

  test('distinguishes a rename from the file staying put', () => {
    const renamed = [
      'diff --git a/src/app.ts b/src/renamed.ts',
      'similarity index 100%',
      'rename from src/app.ts',
      'rename to src/renamed.ts',
      '',
    ].join('\n');
    const patches = parseFilePatches(renamed);
    expect(Array.from(patches.keys())).toEqual(['src/renamed.ts']);
    expect(patches.get('src/renamed.ts')?.patchId).not.toBe(idOf(section({})));
  });
});
