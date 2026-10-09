/*
 * Inline-handler bridge.
 *
 * The screens this extension reuses from obsidian-app-web are HTML strings with `onclick="ObsidianX('arg')"`
 * attributes. An extension page's Content-Security-Policy forbids inline handlers (and any eval), so they
 * cannot run as written and must not be allowed to. This file turns them into data and dispatches them
 * itself:
 *
 *   1. every `onclick` attribute that appears is moved to `data-obs-click` and removed, so the browser never
 *      sees an inline handler;
 *   2. one delegated click listener reads `data-obs-click`, accepts ONLY the shape `ObsidianName('a', 'b')`
 *      — a global whose name starts with "Obsidian", called with plain quoted strings — and looks the name up
 *      on `window`. There is no eval, no Function, and no way to reach any other function or to pass
 *      anything but literal text.
 *
 * It is a classic script (not a module) so it is in place before anything is rendered. The design file's own
 * `data-a` dispatcher is separate and is restricted in main.mjs.
 */
(() => {
  'use strict';
  const NAME = '(Obsidian[A-Za-z]{2,40})';
  const STRING = "'[^'\\\\\\n]*'"; // single-quoted, no escapes, no newline
  const CALL = new RegExp(`^\\s*${NAME}\\(\\s*(${STRING}(?:\\s*,\\s*${STRING})*)?\\s*\\)\\s*;?\\s*$`);
  const ARG = new RegExp(STRING, 'g');

  /** @returns {{name: string, args: string[]} | null} */
  function parse(text) {
    if (typeof text !== 'string' || text.length > 400) return null;
    const match = CALL.exec(text);
    if (!match) return null;
    const args = match[2] ? (match[2].match(ARG) ?? []).map((quoted) => quoted.slice(1, -1)) : [];
    return { name: match[1], args };
  }

  function adopt(root) {
    if (root.nodeType !== 1) return;
    const nodes = root.hasAttribute('onclick') ? [root] : [];
    root.querySelectorAll?.('[onclick]').forEach((el) => nodes.push(el));
    for (const el of nodes) {
      el.setAttribute('data-obs-click', el.getAttribute('onclick'));
      el.removeAttribute('onclick');
    }
  }

  function install() {
    adopt(document.documentElement);
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') adopt(record.target);
        else record.addedNodes.forEach(adopt);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['onclick'] });

    document.addEventListener('click', (event) => {
      const el = event.target instanceof Element ? event.target.closest('[data-obs-click]') : null;
      if (!el) return;
      const call = parse(el.getAttribute('data-obs-click'));
      if (!call) return;
      const fn = window[call.name];
      if (typeof fn !== 'function') return;
      try {
        const result = fn(...call.args);
        // An async handler's rejection is its own to report; an unhandled one must not be silent.
        if (result && typeof result.catch === 'function') result.catch((error) => console.error('[obsidian] handler failed:', error?.message ?? error));
      } catch (error) {
        console.error('[obsidian] handler failed:', error?.message ?? error);
      }
    });
  }

  if (typeof document !== 'undefined') install();
  // For tests: the parser is the security boundary, so it is exposed to be tested directly.
  if (typeof globalThis !== 'undefined') globalThis.__obsidianBridgeParse = parse;
})();
