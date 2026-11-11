// Review comments on an explainer page, the HTML counterpart of the markdown
// review preview's threads (preview-editor.js). Inlined by htmlPreview.ts into
// the bridge script's closure, which calls `wtExplainerComments(vscode)` with
// the webview API it acquired, so nothing here is reachable from the page.
//
// The page is HTML an agent wrote, with no source lines, so a thread is
// anchored by the text it was written on and the heading above that text.
// Each time the page is drawn, the text is found again and the thread is drawn
// below the block holding it. Every widget lives in its own shadow root, so
// the page's styles can't reach in and these can't leak out.
function wtExplainerComments(vscode) {
  const MAX_QUOTE = 500;
  const HEADINGS = 'h1, h2, h3, h4, h5, h6';
  // Containers a card is never put inside; it goes after them instead.
  const NESTED = 'ul, ol, dl, table, pre, svg';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

  let threads = [];
  // {quote, section} while the composer is open.
  let composer = null;
  const replyOpen = new Set();
  const expanded = new Set();
  const drafts = { composer: '', replies: {} };

  const saved = vscode.getState();
  if (saved && saved.explainer) {
    composer = saved.explainer.composer ?? null;
    drafts.composer = saved.explainer.composerDraft ?? '';
    Object.assign(drafts.replies, saved.explainer.replyDrafts ?? {});
    for (const id of saved.explainer.replyOpen ?? []) replyOpen.add(id);
    for (const id of saved.explainer.expanded ?? []) expanded.add(id);
  }

  function persistState() {
    vscode.setState({
      ...(vscode.getState() ?? {}),
      explainer: {
        composer,
        composerDraft: drafts.composer,
        replyDrafts: drafts.replies,
        replyOpen: Array.from(replyOpen),
        expanded: Array.from(expanded),
      },
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'threads' && Array.isArray(msg.threads)) {
      threads = msg.threads;
      placeWidgets();
    } else if (msg.type === 'revealThread' && typeof msg.threadId === 'string') {
      revealThread(msg.threadId);
    }
  });

  const start = () => {
    vscode.postMessage({ type: 'ready' });
    // Diagrams and other late content can move text around once the page's
    // own scripts have run.
    window.addEventListener('load', () => placeWidgets());
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // -------------------------------------------------------------- anchoring

  function norm(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function isWidget(node) {
    const elem = node instanceof Element ? node : node && node.parentElement;
    return !!(elem && elem.closest('[data-wt-widget]'));
  }

  function headingFor(node) {
    let found = null;
    for (const h of document.body.querySelectorAll(HEADINGS)) {
      if (isWidget(h)) continue;
      if (h === node || h.contains(node)) return h;
      if (h.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) found = h;
      else break;
    }
    return found;
  }

  function sectionHeading(section) {
    if (!section) return null;
    for (const h of document.body.querySelectorAll(HEADINGS)) {
      if (!isWidget(h) && norm(h.textContent) === section) return h;
    }
    return null;
  }

  /**
   * The innermost elements whose text holds the quote's first line, preferring
   * one under the thread's heading. Returns {elem, found}; `found` is false
   * when only the heading could be found, and the result is null when neither
   * can.
   */
  function locate(quote, section) {
    const heading = sectionHeading(section);
    const firstLine = (quote || '').split('\n').map(norm).find((l) => l.length > 0);
    if (firstLine) {
      const needle = firstLine.slice(0, 200);
      const hits = [];
      for (const elem of document.body.querySelectorAll('*')) {
        if (SKIP.has(elem.tagName) || isWidget(elem)) continue;
        if (norm(elem.textContent).includes(needle)) hits.push(elem);
      }
      const innermost = hits.filter((h) => !hits.some((o) => o !== h && h.contains(o)));
      const after = heading
        ? innermost.find(
            (h) => heading.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING,
          )
        : undefined;
      const pick = after ?? innermost[0];
      if (pick) return { elem: pick, found: true };
    }
    return heading ? { elem: heading, found: false } : null;
  }

  /**
   * The block a card goes after: the nearest ancestor that is neither inline
   * text nor inside a list, table, code block, diagram, or flex or grid
   * layout, where a card dropped among the rows, items or columns would break
   * the layout.
   */
  function blockFor(elem) {
    let node = elem;
    while (node.parentElement && node.parentElement !== document.body) {
      const parent = node.parentElement;
      const inline = getComputedStyle(node).display.startsWith('inline');
      const laidOut = /flex|grid/.test(getComputedStyle(parent).display);
      if (!inline && !laidOut && !(node instanceof SVGElement) && !parent.closest(NESTED)) break;
      node = parent;
    }
    return node;
  }

  // ---------------------------------------------------------------- widgets

  function placeWidgets() {
    if (!document.body) return;
    for (const w of document.querySelectorAll('[data-wt-widget]')) {
      if (w !== addHost) w.remove();
    }
    const after = new Map();
    const lost = [];
    for (const thread of threads) {
      const where = locate(thread.quote, thread.section);
      const drawn = thread.resolved && !expanded.has(thread.id)
        ? resolvedChip(thread)
        : threadCard(thread, where ? !where.found : true);
      if (where) insertAfter(blockFor(where.elem), drawn, after);
      else lost.push(drawn);
    }
    // A thread whose text and heading are both gone goes at the top, where
    // it can still be read and resolved.
    for (const drawn of lost.reverse()) document.body.insertAdjacentElement('afterbegin', drawn);
    if (composer) {
      const where = locate(composer.quote, composer.section);
      const card = composerCard();
      if (where) insertAfter(blockFor(where.elem), card, after);
      else document.body.insertAdjacentElement('afterbegin', card);
      const textarea = card.shadowRoot.querySelector('textarea');
      if (textarea) {
        textarea.focus();
        card.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  function insertAfter(block, widget, after) {
    const prev = after.get(block);
    (prev ?? block).insertAdjacentElement('afterend', widget);
    after.set(block, widget);
  }

  function revealThread(threadId) {
    expanded.add(threadId);
    persistState();
    placeWidgets();
    const widget = document.querySelector(`[data-wt-thread-id="${CSS.escape(threadId)}"]`);
    if (!widget) return;
    widget.scrollIntoView({ block: 'center' });
    const card = widget.shadowRoot.querySelector('.card, .chip');
    if (card) {
      card.classList.add('revealed');
      setTimeout(() => card.classList.remove('revealed'), 1500);
    }
  }

  const STYLE = `
    :host { all: initial; display: block; margin: 12px 0; max-width: 100%; box-sizing: border-box;
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: 13px; line-height: 1.45; color: var(--vscode-foreground); }
    * { box-sizing: border-box; }
    .card { border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.35));
      border-left: 3px solid var(--vscode-focusBorder, #3794ff); border-radius: 6px;
      background: var(--vscode-editorWidget-background, rgba(128,128,128,.08)); padding: 8px 10px; }
    .card.resolved { opacity: .75; border-left-color: var(--vscode-descriptionForeground, #888); }
    .revealed { outline: 2px solid var(--vscode-focusBorder, #3794ff); outline-offset: 2px; }
    .header { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
    .label { color: var(--vscode-descriptionForeground, #888); font-size: 12px; }
    .actions { margin-left: auto; display: flex; gap: 6px; }
    .badge { font-size: 11px; padding: 0 6px; border-radius: 8px;
      background: var(--vscode-badge-background, #555); color: var(--vscode-badge-foreground, #fff); }
    .quote { margin: 0 0 6px; padding: 2px 8px; white-space: pre-wrap;
      border-left: 3px solid var(--vscode-textBlockQuote-border, rgba(128,128,128,.5));
      color: var(--vscode-descriptionForeground, #888); max-height: 6em; overflow: auto; }
    .comment { padding: 4px 0; }
    .comment + .comment { border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.25)); }
    .meta { display: flex; gap: 8px; align-items: baseline; font-size: 12px; }
    .author { font-weight: 600; }
    .time { color: var(--vscode-descriptionForeground, #888); }
    .body { white-space: pre-wrap; overflow-wrap: anywhere; }
    .footer { margin-top: 4px; }
    textarea { width: 100%; min-height: 4.5em; resize: vertical; font: inherit; padding: 6px;
      color: var(--vscode-input-foreground, inherit); background: var(--vscode-input-background, transparent);
      border: 1px solid var(--vscode-input-border, rgba(128,128,128,.5)); border-radius: 4px; }
    textarea:focus { outline: 1px solid var(--vscode-focusBorder, #3794ff); }
    .editor-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
    button { font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 3px; cursor: pointer;
      border: 1px solid transparent; }
    .primary { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
    .secondary { background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2));
      color: var(--vscode-button-secondaryForeground, inherit); }
    .chip { display: flex; gap: 6px; align-items: center; cursor: pointer; padding: 3px 8px;
      border-radius: 12px; font-size: 12px; color: var(--vscode-descriptionForeground, #888);
      background: var(--vscode-editorWidget-background, rgba(128,128,128,.08)); }
    .chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
    .add { box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  `;

  function widgetHost(threadId) {
    const host = document.createElement('div');
    host.setAttribute('data-wt-widget', '');
    if (threadId) host.setAttribute('data-wt-thread-id', threadId);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);
    return { host, root };
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

  function quoteBlock(quote) {
    const text = quote.length > 240 ? `${quote.slice(0, 240)}…` : quote;
    return el('blockquote', 'quote', text);
  }

  function resolvedChip(thread) {
    const { host, root } = widgetHost(thread.id);
    const chip = el('div', 'chip');
    chip.appendChild(el('span', '', '✓'));
    const first = thread.comments[0];
    chip.appendChild(el('span', 'chip-text', first ? `${first.author}: ${first.body}` : 'resolved thread'));
    chip.appendChild(el('span', 'badge', String(thread.comments.length)));
    chip.title = 'Resolved — click to expand';
    chip.addEventListener('click', () => {
      expanded.add(thread.id);
      persistState();
      placeWidgets();
    });
    root.appendChild(chip);
    return host;
  }

  function threadCard(thread, lostText) {
    const { host, root } = widgetHost(thread.id);
    const card = el('div', thread.resolved ? 'card resolved' : 'card');
    const header = el('div', 'header');
    header.appendChild(el('span', 'label', thread.section ? `Comment · ${thread.section}` : 'Comment'));
    if (thread.kind === 'note') header.appendChild(el('span', 'badge', 'note'));
    if (lostText) header.appendChild(el('span', 'badge', 'text no longer on the page'));
    if (thread.resolved) header.appendChild(el('span', 'badge', 'resolved'));
    const actions = el('span', 'actions');
    actions.appendChild(
      button(thread.resolved ? 'Unresolve' : 'Resolve', 'secondary', () => {
        vscode.postMessage({ type: 'setResolved', threadId: thread.id, resolved: !thread.resolved });
      }),
    );
    header.appendChild(actions);
    card.appendChild(header);
    if (thread.quote) card.appendChild(quoteBlock(thread.quote));

    for (const comment of thread.comments) {
      const row = el('div', 'comment');
      const meta = el('div', 'meta');
      meta.appendChild(el('span', 'author', comment.author));
      if (comment.unread) meta.appendChild(el('span', 'badge', 'new'));
      meta.appendChild(el('span', 'time', new Date(comment.createdAt).toLocaleString()));
      row.appendChild(meta);
      row.appendChild(el('div', 'body', comment.body));
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
      const footer = el('div', 'footer');
      footer.appendChild(
        button('Reply', 'secondary', () => {
          replyOpen.add(thread.id);
          persistState();
          placeWidgets();
        }),
      );
      card.appendChild(footer);
    }
    root.appendChild(card);
    return host;
  }

  function composerCard() {
    const { host, root } = widgetHost();
    const card = el('div', 'card');
    const header = el('div', 'header');
    header.appendChild(el('span', 'label', composer.section ? `New comment · ${composer.section}` : 'New comment'));
    card.appendChild(header);
    card.appendChild(quoteBlock(composer.quote));
    card.appendChild(
      editorArea({
        placeholder: 'Comment (exported as JSON for Claude)',
        draft: drafts.composer,
        onInput: (value) => {
          drafts.composer = value;
          persistState();
        },
        onSubmit: (value) => {
          vscode.postMessage({ type: 'createThread', body: value, ...composer });
          closeComposer();
        },
        onCancel: closeComposer,
        submitLabel: 'Comment',
      }),
    );
    root.appendChild(card);
    return host;
  }

  function closeComposer() {
    composer = null;
    drafts.composer = '';
    persistState();
    placeWidgets();
  }

  function editorArea({ placeholder, draft, onInput, onSubmit, onCancel, submitLabel }) {
    const wrap = el('div');
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
    const row = el('div', 'editor-actions');
    row.appendChild(button('Cancel', 'secondary', onCancel));
    row.appendChild(button(submitLabel, 'primary', submit));
    wrap.appendChild(row);
    function submit() {
      const value = textarea.value.trim();
      if (value.length > 0) onSubmit(value);
    }
    return wrap;
  }

  // ------------------------------------------- selection → comment button

  // Fixed to the viewport rather than placed in the page's flow, so the
  // page's own positioning can't throw it off.
  const { host: addHost, root: addRoot } = widgetHost();
  addHost.style.cssText = 'position: fixed; z-index: 2147483647; margin: 0; display: none;';
  let pending = null;
  const addButton = button('💬 Comment', 'primary add', () => {
    if (!pending) return;
    composer = pending;
    drafts.composer = '';
    persistState();
    document.getSelection()?.removeAllRanges();
    hideAddButton();
    placeWidgets();
  });
  // Keeps the selection alive through the click that reads it.
  addButton.addEventListener('mousedown', (e) => e.preventDefault());
  addRoot.appendChild(addButton);

  function hideAddButton() {
    pending = null;
    addHost.style.display = 'none';
  }

  const mountAddButton = () => document.body.appendChild(addHost);
  if (document.body) mountAddButton();
  else document.addEventListener('DOMContentLoaded', mountAddButton);
  window.addEventListener('scroll', hideAddButton, { passive: true });

  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      hideAddButton();
      return;
    }
    const range = selection.getRangeAt(0);
    const quote = selection.toString().trim().slice(0, MAX_QUOTE);
    if (!quote || isWidget(range.startContainer) || isWidget(range.endContainer)) {
      hideAddButton();
      return;
    }
    const heading = headingFor(range.startContainer);
    pending = { quote, section: heading ? norm(heading.textContent) : undefined };
    const rect = range.getBoundingClientRect();
    addHost.style.display = 'block';
    addHost.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 36)}px`;
    addHost.style.left = `${Math.max(rect.left, 8)}px`;
  });
}
