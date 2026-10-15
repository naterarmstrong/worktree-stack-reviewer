// The review preview editor's webview side. Renders the HTML the provider
// sends (built-in markdown engine output, complete with data-line source
// mapping), overlays review thread widgets between blocks, and turns text
// selection into an inline comment composer. All persistence goes through the
// provider — this file only draws and forwards.
(function () {
  const vscode = acquireVsCodeApi();
  const content = document.getElementById('wt-content');

  // ---------------------------------------------------------------- state

  let threads = [];
  let lineCount = 0;
  // {startLine, endLineExclusive, selectedText} while the composer is open.
  let composerSel = null;
  const replyOpen = new Set();
  const expanded = new Set();
  const drafts = { composer: '', replies: {} };
  // The review dialog: the PR it is open on (null when closed), its draft, and
  // the verdict chosen.
  const reviewState = { pr: null, draft: '', verdict: 'comment' };

  const saved = vscode.getState();
  if (saved) {
    composerSel = saved.composerSel ?? null;
    drafts.composer = saved.composerDraft ?? '';
    Object.assign(drafts.replies, saved.replyDrafts ?? {});
    for (const id of saved.replyOpen ?? []) replyOpen.add(id);
    for (const id of saved.expanded ?? []) expanded.add(id);
    reviewState.pr = saved.reviewPr ?? null;
    reviewState.draft = saved.reviewDraft ?? '';
    reviewState.verdict = saved.reviewVerdict ?? 'comment';
  }

  function persistState() {
    vscode.setState({
      composerSel,
      composerDraft: drafts.composer,
      replyDrafts: drafts.replies,
      replyOpen: Array.from(replyOpen),
      expanded: Array.from(expanded),
      reviewPr: reviewState.pr,
      reviewDraft: reviewState.draft,
      reviewVerdict: reviewState.verdict,
    });
  }

  // ------------------------------------------------------------- messages

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'render': {
        const scrollY = window.scrollY;
        // Markdown may carry raw HTML; the page's CSP allows scripts only by
        // nonce, so anything in the document itself cannot execute — the same
        // containment the built-in preview relies on.
        content.innerHTML = msg.html;
        lineCount = msg.lineCount;
        placeWidgets();
        window.scrollTo(0, scrollY);
        break;
      }
      case 'threads':
        threads = msg.threads;
        placeWidgets();
        break;
      case 'revealThread':
        revealThread(msg.threadId);
        break;
      case 'openReview':
        openReview({ number: msg.number, title: msg.title });
        break;
      case 'reviewResult':
        onReviewResult(msg);
        break;
      case 'openComposer':
        composerSel = {
          startLine: msg.startLine,
          endLineExclusive: msg.endLineExclusive,
          selectedText: msg.selectedText,
        };
        persistState();
        placeWidgets();
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });

  // --------------------------------------------------------- line mapping

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

  function nextBlockLineAfter(line) {
    let best;
    for (const el of content.querySelectorAll('[data-line]')) {
      const n = parseInt(el.getAttribute('data-line'), 10);
      if (isNaN(n) || n <= line) continue;
      if (best === undefined || n < best) best = n;
    }
    // The engine emits no trailing sentinel, so the last block's successor is
    // the end of the document, which the provider sends with every render.
    return best !== undefined ? best : Math.max(line + 1, lineCount);
  }

  // The element widgets are inserted after: the direct child of the content
  // container holding the greatest data-line at or before `line0`. Inserting
  // between top-level blocks keeps widgets out of lists and tables.
  function hostBlockFor(line0) {
    let bestEl;
    let bestLine = -1;
    for (const child of content.children) {
      const own = topLineOf(child);
      if (own === undefined || own > line0) continue;
      if (own >= bestLine) {
        bestLine = own;
        bestEl = child;
      }
    }
    return bestEl;
  }

  function topLineOf(el) {
    if (el.dataset && el.dataset.line !== undefined) {
      const line = parseInt(el.dataset.line, 10);
      if (!isNaN(line)) return line;
    }
    const inner = el.querySelector ? el.querySelector('[data-line]') : null;
    if (!inner) return undefined;
    const line = parseInt(inner.getAttribute('data-line'), 10);
    return isNaN(line) ? undefined : line;
  }

  // ------------------------------------------------------------- widgets

  function placeWidgets() {
    for (const el of content.querySelectorAll('.wt-widget')) el.remove();

    // Insertion order matters: widgets after the same block stack in thread
    // order because each inserts after the previous widget.
    const anchored = threads
      .slice()
      .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
    const afterBlock = new Map();
    for (const thread of anchored) {
      const widget = thread.resolved && !expanded.has(thread.id)
        ? resolvedChip(thread)
        : threadCard(thread);
      insertWidget(widget, thread.startLine, afterBlock);
    }
    if (composerSel) {
      insertWidget(composerCard(), composerSel.startLine + 1, afterBlock);
      const textarea = content.querySelector('.wt-composer textarea');
      if (textarea) {
        textarea.focus();
        textarea.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  /**
   * Brings one thread into view, expanding it first when it is resolved and so
   * drawn as a one-line chip. This is where a click on the thread's row in the
   * tree lands.
   */
  function revealThread(threadId) {
    expanded.add(threadId);
    persistState();
    placeWidgets();
    const widget = content.querySelector(`[data-thread-id="${threadId}"]`);
    if (!widget) return;
    widget.scrollIntoView({ block: 'center' });
    widget.classList.add('wt-revealed');
    setTimeout(() => widget.classList.remove('wt-revealed'), 1500);
  }

  function insertWidget(widget, startLine, afterBlock) {
    if (startLine === undefined) {
      content.insertAdjacentElement('afterbegin', widget);
      return;
    }
    const host = hostBlockFor(startLine - 1);
    if (!host) {
      content.insertAdjacentElement('afterbegin', widget);
      return;
    }
    const prev = afterBlock.get(host);
    (prev ?? host).insertAdjacentElement('afterend', widget);
    afterBlock.set(host, widget);
  }

  function linesLabel(thread) {
    if (thread.startLine === undefined) return 'whole file';
    if (thread.endLine === undefined || thread.endLine === thread.startLine) {
      return `line ${thread.startLine}`;
    }
    return `lines ${thread.startLine}–${thread.endLine}`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    const b = el('button', className, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function resolvedChip(thread) {
    const chip = el('div', 'wt-widget wt-chip');
    chip.dataset.threadId = thread.id;
    chip.appendChild(el('span', 'wt-chip-check', '✓'));
    const first = thread.comments[0];
    const label = first ? `${first.author}: ${first.body}` : 'resolved thread';
    chip.appendChild(el('span', 'wt-chip-text', label));
    chip.appendChild(
      el('span', 'wt-chip-count', `${thread.comments.length}`),
    );
    chip.title = 'Resolved — click to expand';
    chip.addEventListener('click', () => {
      expanded.add(thread.id);
      persistState();
      placeWidgets();
    });
    return chip;
  }

  function threadCard(thread) {
    const card = el('div', 'wt-widget wt-thread');
    card.dataset.threadId = thread.id;
    if (thread.resolved) card.classList.add('wt-resolved');

    const header = el('div', 'wt-thread-header');
    const where = el('a', 'wt-thread-lines', linesLabel(thread));
    where.href = '#';
    where.title = 'Open in the source editor';
    where.addEventListener('click', (e) => {
      e.preventDefault();
      vscode.postMessage({
        type: 'openSource',
        line: thread.startLine !== undefined ? thread.startLine - 1 : 0,
      });
    });
    header.appendChild(where);
    if (thread.kind === 'note') {
      header.appendChild(el('span', 'wt-badge wt-badge-note', 'note'));
    }
    if (thread.drifted) {
      header.appendChild(el('span', 'wt-badge', 'anchor drifted'));
    }
    if (thread.resolved) {
      header.appendChild(el('span', 'wt-badge wt-badge-resolved', 'resolved'));
    }
    const actions = el('span', 'wt-thread-actions');
    actions.appendChild(
      button(thread.resolved ? 'Unresolve' : 'Resolve', 'wt-secondary', () => {
        vscode.postMessage({
          type: 'setResolved',
          threadId: thread.id,
          resolved: !thread.resolved,
        });
      }),
    );
    header.appendChild(actions);
    card.appendChild(header);

    for (const comment of thread.comments) {
      const row = el('div', 'wt-comment');
      const meta = el('div', 'wt-comment-meta');
      meta.appendChild(el('span', 'wt-author', comment.author));
      meta.appendChild(
        el('span', 'wt-time', new Date(comment.createdAt).toLocaleString()),
      );
      row.appendChild(meta);
      row.appendChild(el('div', 'wt-comment-body', comment.body));
      card.appendChild(row);
    }

    if (replyOpen.has(thread.id)) {
      card.appendChild(
        editorArea({
          placeholder: 'Reply (exported as JSON for Claude)',
          draft: drafts.replies[thread.id] ?? '',
          onInput: (value) => {
            drafts.replies[thread.id] = value;
            persistState();
          },
          onSubmit: (value) => {
            vscode.postMessage({ type: 'reply', threadId: thread.id, body: value });
            replyOpen.delete(thread.id);
            delete drafts.replies[thread.id];
            persistState();
          },
          onCancel: () => {
            replyOpen.delete(thread.id);
            delete drafts.replies[thread.id];
            persistState();
            placeWidgets();
          },
          submitLabel: 'Reply',
        }),
      );
    } else {
      const footer = el('div', 'wt-thread-footer');
      footer.appendChild(
        button('Reply', 'wt-secondary', () => {
          replyOpen.add(thread.id);
          persistState();
          placeWidgets();
        }),
      );
      card.appendChild(footer);
    }
    return card;
  }

  function composerCard() {
    const card = el('div', 'wt-widget wt-thread wt-composer');
    const header = el('div', 'wt-thread-header');
    const start = composerSel.startLine + 1;
    const end = composerSel.endLineExclusive;
    header.appendChild(
      el(
        'span',
        'wt-thread-lines',
        start === end ? `New comment, line ${start}` : `New comment, lines ${start}–${end}`,
      ),
    );
    card.appendChild(header);
    if (composerSel.selectedText) {
      card.appendChild(el('blockquote', 'wt-quote', composerSel.selectedText));
    }
    card.appendChild(
      editorArea({
        placeholder: 'Comment (exported as JSON for Claude)',
        draft: drafts.composer,
        onInput: (value) => {
          drafts.composer = value;
          persistState();
        },
        onSubmit: (value) => {
          vscode.postMessage({ type: 'createThread', body: value, ...composerSel });
          closeComposer();
        },
        onCancel: closeComposer,
        submitLabel: 'Comment',
      }),
    );
    return card;
  }

  function closeComposer() {
    composerSel = null;
    drafts.composer = '';
    persistState();
    placeWidgets();
  }

  function editorArea({ placeholder, draft, onInput, onSubmit, onCancel, submitLabel }) {
    const wrap = el('div', 'wt-editor');
    const textarea = el('textarea');
    textarea.placeholder = placeholder;
    textarea.value = draft;
    textarea.rows = 3;
    textarea.addEventListener('input', () => onInput(textarea.value));
    textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    });
    wrap.appendChild(textarea);
    const row = el('div', 'wt-editor-actions');
    row.appendChild(button('Cancel', 'wt-secondary', onCancel));
    row.appendChild(button(submitLabel, 'wt-primary', submit));
    wrap.appendChild(row);
    function submit() {
      const value = textarea.value.trim();
      if (value.length > 0) onSubmit(value);
    }
    return wrap;
  }

  // ------------------------------------------- selection → comment button

  const MAX_SELECTED_TEXT = 2000;
  const addButton = button('💬 Comment', 'wt-add-button', () => {
    const sel = pendingSelection;
    if (!sel) return;
    composerSel = sel;
    drafts.composer = '';
    persistState();
    document.getSelection()?.removeAllRanges();
    hideAddButton();
    placeWidgets();
  });
  addButton.style.display = 'none';
  document.body.appendChild(addButton);
  let pendingSelection = null;

  function hideAddButton() {
    pendingSelection = null;
    addButton.style.display = 'none';
  }

  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hideAddButton();
      return;
    }
    const range = selection.getRangeAt(0);
    // Selections inside a widget (a draft, a comment body) are not source text.
    if (
      closestWidget(range.startContainer) ||
      closestWidget(range.endContainer) ||
      !content.contains(range.commonAncestorContainer)
    ) {
      hideAddButton();
      return;
    }
    const startLine = blockLineOf(range.startContainer);
    const endBlockLine = blockLineOf(range.endContainer);
    if (startLine === undefined || endBlockLine === undefined) {
      hideAddButton();
      return;
    }
    const lastBlock = Math.max(startLine, endBlockLine);
    pendingSelection = {
      startLine,
      endLineExclusive: nextBlockLineAfter(lastBlock),
      selectedText: selection.toString().slice(0, MAX_SELECTED_TEXT),
    };
    const rect = range.getBoundingClientRect();
    addButton.style.display = 'block';
    addButton.style.top = `${window.scrollY + rect.bottom + 6}px`;
    addButton.style.left = `${window.scrollX + Math.max(rect.left, 8)}px`;
  });

  function closestWidget(node) {
    const start = node instanceof Element ? node : node.parentElement;
    return start ? start.closest('.wt-widget, .wt-add-button') : null;
  }

  // ---------------------------------------------------------- review dialog

  // A modal over a PR description that approves, comments on, or requests
  // changes on the PR. The draft and the chosen verdict live in webview state,
  // so closing the dialog — or the tab going to the background — keeps them
  // until the review is posted.
  const VERDICTS = [
    { value: 'comment', label: 'Comment', hint: 'General feedback without explicit approval.' },
    { value: 'approve', label: 'Approve', hint: 'Give your approval to merge these changes.' },
    {
      value: 'request-changes',
      label: 'Request changes',
      hint: 'Feedback that must be addressed before merging.',
    },
  ];
  let overlay = null;
  let submitting = false;

  // A dialog left open when the page reloaded comes back with it.
  if (reviewState.pr) openReview(reviewState.pr);

  function openReview(pr) {
    reviewState.pr = pr;
    persistState();
    closeOverlay();
    submitting = false;

    overlay = el('div', 'wt-review-overlay');
    overlay.addEventListener('mousedown', (e) => {
      // Only a press that starts on the backdrop closes, so a drag that ends
      // outside the textarea doesn't throw the dialog away.
      if (e.target === overlay) closeReview();
    });
    const dialog = el('div', 'wt-review-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    overlay.appendChild(dialog);

    const header = el('div', 'wt-review-header');
    header.appendChild(el('div', 'wt-review-title', `Review #${pr.number}`));
    if (pr.title) header.appendChild(el('div', 'wt-review-subtitle', pr.title));
    dialog.appendChild(header);

    const textarea = el('textarea', 'wt-review-body');
    textarea.placeholder = 'Leave a comment (markdown)';
    textarea.value = reviewState.draft;
    textarea.rows = 8;
    textarea.addEventListener('input', () => {
      reviewState.draft = textarea.value;
      persistState();
      validate();
    });
    dialog.appendChild(textarea);

    const choices = el('div', 'wt-review-verdicts');
    for (const v of VERDICTS) {
      const label = el('label', 'wt-review-verdict');
      const input = el('input');
      input.type = 'radio';
      input.name = 'wt-review-verdict';
      input.value = v.value;
      input.checked = reviewState.verdict === v.value;
      input.addEventListener('change', () => {
        reviewState.verdict = v.value;
        persistState();
        validate();
      });
      label.appendChild(input);
      const text = el('div', 'wt-review-verdict-text');
      text.appendChild(el('div', 'wt-review-verdict-label', v.label));
      text.appendChild(el('div', 'wt-review-verdict-hint', v.hint));
      label.appendChild(text);
      choices.appendChild(label);
    }
    dialog.appendChild(choices);

    const error = el('div', 'wt-review-error');
    dialog.appendChild(error);

    const actions = el('div', 'wt-review-actions');
    const cancel = button('Cancel', 'wt-secondary', closeReview);
    const submit = button('Submit review', 'wt-primary', send);
    actions.appendChild(cancel);
    actions.appendChild(submit);
    dialog.appendChild(actions);

    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!submitting) closeReview();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        send();
      } else if (e.key === 'Tab') {
        trapFocus(e, dialog);
      }
    });

    function needsBody() {
      return reviewState.verdict !== 'approve' && textarea.value.trim() === '';
    }

    function validate() {
      submit.disabled = submitting || needsBody();
      submit.title = needsBody() ? 'A comment is required to comment or request changes.' : '';
    }

    function send() {
      if (submitting || needsBody()) return;
      submitting = true;
      error.textContent = '';
      textarea.disabled = true;
      for (const input of choices.querySelectorAll('input')) input.disabled = true;
      cancel.disabled = true;
      submit.textContent = 'Submitting…';
      validate();
      vscode.postMessage({
        type: 'submitReview',
        verdict: reviewState.verdict,
        body: textarea.value,
      });
    }

    overlay.reviewFailed = (message) => {
      submitting = false;
      textarea.disabled = false;
      for (const input of choices.querySelectorAll('input')) input.disabled = false;
      cancel.disabled = false;
      submit.textContent = 'Submit review';
      error.textContent = message;
      validate();
      textarea.focus();
    };

    validate();
    document.body.appendChild(overlay);
    document.body.classList.add('wt-review-open');
    textarea.focus();
  }

  function onReviewResult(msg) {
    if (!overlay) return;
    if (msg.ok) {
      reviewState.draft = '';
      reviewState.verdict = 'comment';
      closeReview();
      return;
    }
    overlay.reviewFailed(msg.error || 'The review could not be submitted.');
  }

  /** Closes the dialog; the draft stays for next time. */
  function closeReview() {
    reviewState.pr = null;
    persistState();
    closeOverlay();
  }

  function closeOverlay() {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    document.body.classList.remove('wt-review-open');
  }

  /** Keeps Tab cycling inside the dialog while it is open. */
  function trapFocus(event, dialog) {
    const focusable = Array.from(
      dialog.querySelectorAll('textarea, input, button'),
    ).filter((node) => !node.disabled);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // ----------------------------------------------------------------- links

  document.addEventListener(
    'click',
    (event) => {
      let node = event.target instanceof Element ? event.target : null;
      const anchor = node ? node.closest('a') : null;
      if (!anchor || anchor.closest('.wt-widget')) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      event.preventDefault();
      event.stopPropagation();
      if (href.startsWith('#')) {
        const target = document.getElementById(href.slice(1));
        if (target) target.scrollIntoView();
        return;
      }
      vscode.postMessage({ type: 'openLink', href });
    },
    true,
  );
})();
