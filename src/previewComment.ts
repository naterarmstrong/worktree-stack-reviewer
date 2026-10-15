/**
 * Pure logic behind "Add Worktree Stack Reviewer Comment" in the rendered markdown
 * preview. The preview script (`media/preview-comments.js`) maps the DOM
 * selection to source lines via the preview's `data-line` attributes and ships
 * them over as a webview context object; this module validates that object and
 * narrows the block-level line range it carries to something worth storing.
 */

/**
 * What the preview script puts in `data-vscode-context`. Lines are 0-based:
 * `startLine` is the `data-line` of the block the selection starts in, and
 * `endLineExclusive` the `data-line` of the first block after the one it ends
 * in — the same half-open convention markdown-it's token maps use.
 */
export interface PreviewSelectionContext {
  resource: string;
  startLine: number;
  endLineExclusive: number;
  selectedText: string;
}

/** 1-based inclusive, matching `StoredThread.startLine`/`endLine`. */
export interface ResolvedPreviewRange {
  startLine: number;
  endLine: number;
}

export function asPreviewSelectionContext(
  arg: unknown,
): PreviewSelectionContext | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const ctx = arg as Partial<PreviewSelectionContext>;
  if (typeof ctx.resource !== 'string' || ctx.resource.length === 0) {
    return undefined;
  }
  if (!isLine(ctx.startLine) || !isLine(ctx.endLineExclusive)) return undefined;
  if (ctx.endLineExclusive <= ctx.startLine) return undefined;
  return {
    resource: ctx.resource,
    startLine: ctx.startLine,
    endLineExclusive: ctx.endLineExclusive,
    selectedText: typeof ctx.selectedText === 'string' ? ctx.selectedText : '',
  };
}

function isLine(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Turns the block-level range from the preview into the range to store.
 *
 * The preview can only anchor at block granularity — `data-line` marks where
 * each block starts, not where the selected words sit inside it. When the
 * selected text can be found verbatim inside the block's source lines, the
 * range is narrowed to just the lines that contain it; inline markup (bold,
 * links) makes rendered text diverge from source, in which case the whole
 * block is kept. The trailing blank lines that separate blocks are always
 * trimmed off.
 */
export function resolvePreviewRange(
  lines: readonly string[],
  ctx: Pick<PreviewSelectionContext, 'startLine' | 'endLineExclusive' | 'selectedText'>,
): ResolvedPreviewRange | undefined {
  if (ctx.startLine >= lines.length) return undefined;
  let start = ctx.startLine;
  let end = Math.min(ctx.endLineExclusive, lines.length) - 1;
  while (end > start && lines[end].trim() === '') end -= 1;

  const narrowed = narrowToSelection(lines, start, end, ctx.selectedText);
  if (narrowed) ({ start, end } = narrowed);

  return { startLine: start + 1, endLine: end + 1 };
}

/**
 * Finds the sub-range of `[start, end]` whose source lines contain the
 * selection's first and last rendered lines as substrings. Both must match —
 * a lone hit could be a coincidence in an unrelated line of a long block.
 */
function narrowToSelection(
  lines: readonly string[],
  start: number,
  end: number,
  selectedText: string,
): { start: number; end: number } | undefined {
  const selected = selectedText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (selected.length === 0) return undefined;
  const first = selected[0];
  const last = selected[selected.length - 1];

  let firstAt: number | undefined;
  for (let i = start; i <= end; i++) {
    if (lines[i].includes(first)) {
      firstAt = i;
      break;
    }
  }
  if (firstAt === undefined) return undefined;
  for (let i = end; i >= firstAt; i--) {
    if (lines[i].includes(last)) return { start: firstAt, end: i };
  }
  return undefined;
}
