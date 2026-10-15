// Runs inside the built-in markdown preview webview (contributed via the
// `markdown.previewScripts` extension point). Maps the current text selection
// to source lines using the `data-line` attributes the preview stamps on every
// block element, and publishes the result as a `data-vscode-context` attribute
// on <body>. VS Code merges that context into any right-click, which is what
// the `webview/context` menu contribution and the
// `worktreeReview.addCommentFromPreview` command key off.
(function () {
  // The context object travels over IPC on every right-click; a page-sized
  // selection does not need to arrive whole to anchor a comment.
  const MAX_SELECTED_TEXT = 2000;

  function sourceUri() {
    const meta = document.getElementById('vscode-markdown-preview-data');
    if (!meta || !meta.dataset.settings) return undefined;
    try {
      return JSON.parse(meta.dataset.settings).source;
    } catch {
      return undefined;
    }
  }

  // Nearest ancestor carrying a data-line, i.e. the tightest source block the
  // node sits in. Text nodes have no dataset, so start from the parent element.
  function blockLineOf(node) {
    let el = node instanceof Element ? node : node.parentElement;
    for (; el; el = el.parentElement) {
      if (el.dataset && el.dataset.line !== undefined) {
        const line = parseInt(el.dataset.line, 10);
        if (!isNaN(line)) return line;
      }
    }
    return undefined;
  }

  // First data-line strictly greater than `line` — where the next block
  // starts. The preview appends a sentinel element whose data-line is the
  // document's line count, so the last real block always has a successor.
  function nextBlockLineAfter(line) {
    let best;
    for (const el of document.querySelectorAll('[data-line]')) {
      const n = parseInt(el.getAttribute('data-line'), 10);
      if (isNaN(n) || n <= line) continue;
      if (best === undefined || n < best) best = n;
    }
    return best;
  }

  function clearContext() {
    delete document.body.dataset.vscodeContext;
  }

  function publishSelection() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      clearContext();
      return;
    }
    const resource = sourceUri();
    if (!resource) {
      clearContext();
      return;
    }
    const range = selection.getRangeAt(0);
    const startLine = blockLineOf(range.startContainer);
    const endBlockLine = blockLineOf(range.endContainer);
    if (startLine === undefined || endBlockLine === undefined) {
      clearContext();
      return;
    }
    // A selection ending in an outer block (e.g. the tail of a list) can map
    // to a smaller data-line than its start; the later of the two bounds it.
    const lastBlock = Math.max(startLine, endBlockLine);
    const endLineExclusive = nextBlockLineAfter(lastBlock);
    if (endLineExclusive === undefined) {
      clearContext();
      return;
    }
    document.body.dataset.vscodeContext = JSON.stringify({
      wtReviewSelection: true,
      resource: resource,
      startLine: startLine,
      endLineExclusive: endLineExclusive,
      selectedText: selection.toString().slice(0, MAX_SELECTED_TEXT),
    });
  }

  document.addEventListener('selectionchange', publishSelection);
})();
