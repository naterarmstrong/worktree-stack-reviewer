import { createHash } from 'node:crypto';

/**
 * Identity of one file's change, derived from the diff rather than from the
 * content on either side of it.
 */
export interface FilePatch {
  /** Worktree-relative path on the right side, or the old path for a deletion. */
  path: string;
  patchId: string;
  /**
   * Abbreviated blob sha of the file on the base side. Unset for files the base
   * does not have. This is not part of the patch id — it only reports that the
   * ground under an already-reviewed change has moved.
   */
  baseBlob?: string;
}

/**
 * Splits `git diff --patch` output into per-file sections and gives each one an
 * id that survives a rebase.
 *
 * The id covers the hunk bodies and the file-mode headers, with two things left
 * out: the `index <old>..<new>` blob shas, which change whenever the branch is
 * restacked, and the line numbers in each `@@` header, which shift when
 * anything lands above the change. What remains is the text the change adds and
 * removes, so re-applying the same patch onto a moved base reproduces the same
 * id. `git patch-id` works the same way but reports one id per commit rather
 * than per file, which is the wrong granularity here.
 *
 * Callers must diff with `-U0`. Context lines are part of a hunk body, so at
 * git's default of three lines of context an unrelated edit landing within
 * three lines of the change would rewrite the id.
 */
export function parseFilePatches(patchText: string): Map<string, FilePatch> {
  const patches = new Map<string, FilePatch>();
  for (const section of splitSections(patchText)) {
    const patch = readSection(section);
    if (patch) patches.set(patch.path, patch);
  }
  return patches;
}

const SECTION_PREFIX = 'diff --git ';

function splitSections(patchText: string): string[][] {
  const sections: string[][] = [];
  let current: string[] | undefined;
  for (const line of patchText.split('\n')) {
    if (line.startsWith(SECTION_PREFIX)) {
      current = [];
      sections.push(current);
    }
    current?.push(line);
  }
  return sections;
}

function readSection(lines: string[]): FilePatch | undefined {
  let newPath: string | undefined;
  let oldPath: string | undefined;
  let combinedPath: string | undefined;
  let baseBlob: string | undefined;
  let indexLine: string | undefined;
  let binary = false;
  // Everything before the first hunk header is metadata. Tracking that is what
  // makes `--- ` and `+++ ` unambiguous: inside a hunk they are ordinary
  // removed and added lines whose content happens to start that way.
  let inHunks = false;
  const hashed: string[] = [];

  for (const line of lines) {
    if (line.startsWith('@@')) {
      inHunks = true;
      // A bare marker keeps hunk boundaries without the line numbers, so two
      // separate hunks cannot hash the same as one hunk holding both bodies.
      hashed.push('@@');
      continue;
    }
    if (inHunks) {
      hashed.push(line);
      continue;
    }
    if (line.startsWith('index ')) {
      indexLine = line;
      baseBlob = parseBaseBlob(line);
      continue;
    }
    if (line.startsWith('--- ')) {
      oldPath = parseHeaderPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      newPath = parseHeaderPath(line.slice(4));
      continue;
    }
    // Hashed as well as read: a pure rename has no hunks, so without them every
    // rename in a diff would reduce to the same `similarity index` line.
    if (line.startsWith('rename from ')) {
      oldPath = unquotePath(line.slice('rename from '.length));
      hashed.push(line);
      continue;
    }
    if (line.startsWith('rename to ')) {
      newPath = unquotePath(line.slice('rename to '.length));
      hashed.push(line);
      continue;
    }
    if (line.startsWith(SECTION_PREFIX)) {
      combinedPath = parseCombinedHeader(line);
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      binary = true;
    }
    hashed.push(line);
  }

  // A deletion writes `+++ /dev/null`, leaving the old path as the only name.
  // A binary file has neither header line, so its name comes from the combined
  // `diff --git` line.
  const filePath = newPath ?? oldPath ?? combinedPath;
  if (!filePath) return undefined;

  // A binary file has no hunks, so everything hashed above is identical
  // whatever the file now holds. Its blob shas are the only thing that moves,
  // which makes them the id — content-addressed, and so not rebase-stable. A
  // binary file has no patch for a patch id to be stable about.
  if (binary && indexLine) hashed.push(indexLine);

  return {
    path: filePath,
    patchId: createHash('sha1').update(hashed.join('\n')).digest('hex'),
    baseBlob,
  };
}

/**
 * The path from a `diff --git a/<old> b/<new>` line, used only when the section
 * carries no other name — which in practice means a binary file, since those
 * get no `---`/`+++` pair.
 *
 * Splitting that line is ambiguous in general, because a path may itself contain
 * ` b/`. It is not ambiguous here: git writes explicit `rename from`/`rename to`
 * lines whenever the two sides differ, so reaching this point means both halves
 * name the same file, and the only split with equal halves is the right one.
 */
function parseCombinedHeader(line: string): string | undefined {
  const rest = line.slice(SECTION_PREFIX.length);
  if (rest.startsWith('"')) return undefined;
  // `a/` + path + ` b/` + path
  const pathLength = (rest.length - 5) / 2;
  if (!Number.isInteger(pathLength) || pathLength <= 0) return undefined;
  const candidate = rest.slice(2, 2 + pathLength);
  if (rest !== `a/${candidate} b/${candidate}`) return undefined;
  return candidate;
}

/** The all-zero sha git writes when a side has no blob (an added file). */
const NULL_BLOB = /^0+$/;

function parseBaseBlob(indexLine: string): string | undefined {
  const match = indexLine.match(/^index ([0-9a-f]+)\.\.[0-9a-f]+/);
  if (!match || NULL_BLOB.test(match[1])) return undefined;
  return match[1];
}

/** Strips the `a/` or `b/` the diff prefixes every path with. */
function parseHeaderPath(raw: string): string | undefined {
  if (raw === '/dev/null') return undefined;
  const unquoted = unquotePath(raw);
  return unquoted.replace(/^[ab]\//, '');
}

const C_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  '"': '"',
};

/**
 * Reverses the C-style quoting git applies to paths holding characters it
 * cannot write literally. Unquoted paths pass through untouched, which is every
 * path that is not pathological.
 */
function unquotePath(raw: string): string {
  const trimmed = raw.trimEnd();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  const body = trimmed.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      out += body[i];
      continue;
    }
    const next = body[i + 1];
    const escape = C_ESCAPES[next];
    if (escape !== undefined) {
      out += escape;
      i += 1;
      continue;
    }
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      out += String.fromCharCode(Number.parseInt(octal, 8));
      i += 3;
      continue;
    }
    out += body[i];
  }
  return out;
}
