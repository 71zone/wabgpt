import { z } from 'zod';
import { locateAssistant } from './dom.js';

/**
 * Page script (BrowserOS evaluateInPage) that converts the assistant message of the newest turn, or of `targetUserId`, into display-ordered blocks.
 * It is separate from the inspection poll because it walks the whole message. Prose becomes Markdown (rebuilt from the DOM, since ChatGPT's own
 * "copy" output is not reachable), fenced code and tables become their own blocks, and generated images and downloadable files become `asset` blocks.
 * Each asset element is stamped with `data-wab-asset="<id>"` so the later byte-transfer scripts can find it.
 *
 * DOM facts it relies on (ChatGPT's DIL renderer, observed live):
 * - Prose sits in `[data-markdown-text-style="assistant-message"] [data-dil-response]` as plain p/h1-h6/ul/ol/blockquote/table elements with
 *   `data-d-*` attributes; list items wrap their paragraph and nested lists in two divs; tables have no thead (the header row is all `th`).
 * - A code block is `[data-client-defined-widget="code_block"]` whose header (`[data-markdown-copy="exclude"] .truncate`) shows the language label.
 *   Runnable languages use a CodeMirror editor that only renders the visible lines, so the full text is read from its EditorView
 *   (`.cm-content` -> `cmTile.view` or `cmView.view`); other blocks are a plain `pre > code`.
 * - Links carry `?utm_source=chatgpt.com`; `sandbox:` files are `span[role="link"]` inline plus a card (outside the prose) with a "Download file" button.
 * - A generated image is `[data-testid="generated-image-gallery"] img` with a `blob:` source, outside the prose.
 */
export const chatgptExtractionScript = String.raw`(targetUserId) => {
  ${locateAssistant}
  const result = { url: location.href, text: '', blocks: [], assets: [] };
  if (!holder) return result;
  const prose = holder.querySelector('[data-markdown-text-style="assistant-message"]');
  result.text = prose?.innerText || '';
  // An image and the sentence about it are separate response bodies of one assistant turn, so every body of the turn is read in order.
  const roots = turn ? Array.from(turn.querySelectorAll('[data-response-body]')) : [];
  if (!roots.length && prose) roots.push(prose);
  if (!roots.length) return result;

  const TICK = String.fromCharCode(96);
  const SKIP = '[hidden],[aria-hidden="true"],[data-markdown-copy="exclude"],style,script,svg,button:not([aria-label="Download file"]),aside,[role="alert"]';
  const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  const CODE = '[data-client-defined-widget="code_block"],[data-code-block],pre';
  const BLOCKS = 'p,ul,ol,table,blockquote,hr,' + HEADINGS.join(',') + ',' + CODE + ',[data-testid="generated-image-gallery"],button[aria-label="Download file"],img';
  const collapse = (text) => text.replace(/\s+/g, ' ');
  const tagOf = (el) => el.tagName.toLowerCase();

  const cleanUrl = (href) => {
    try {
      const url = new URL(href, location.href);
      if (!/^(https?:|mailto:|tel:)$/.test(url.protocol)) return null;
      if (url.searchParams.get('utm_source') === 'chatgpt.com') url.searchParams.delete('utm_source');
      return url.href;
    } catch { return null; }
  };
  const wrap = (text, mark) => {
    const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    return parts[2] ? parts[1] + mark + parts[2] + mark + parts[3] : text;
  };
  const inline = (node, marks) => {
    if (node.nodeType === 3) return collapse(node.textContent);
    if (node.nodeType !== 1 || node.matches(SKIP)) return '';
    const tag = tagOf(node);
    if (tag === 'br') return '\n';
    if (tag === 'img') return '';
    if (tag === 'input') return node.type === 'checkbox' ? (node.checked ? '[x] ' : '[ ] ') : '';
    if (node.classList.contains('katex')) {
      const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim();
      return tex ? '$' + tex + '$' : collapse(node.textContent);
    }
    if (tag === 'code') {
      const code = node.textContent;
      const fence = code.includes(TICK) ? TICK + TICK : TICK;
      return code ? fence + code + fence : '';
    }
    const inner = () => Array.from(node.childNodes).map(child => inline(child, marks)).join('');
    if (tag === 'strong' || tag === 'b') return marks ? wrap(inner(), '**') : inner();
    if (tag === 'em' || tag === 'i') return marks ? wrap(inner(), '*') : inner();
    if (tag === 'del' || tag === 's') return marks ? wrap(inner(), '~~') : inner();
    if (tag === 'a') {
      const text = inner().trim();
      const href = cleanUrl(node.getAttribute('href') || '');
      if (!href) return text;
      return text && text !== href ? '[' + text + '](' + href + ')' : href;
    }
    return inner();
  };
  const paragraph = (nodes, marks) => nodes.map(node => inline(node, marks)).join('').replace(/ *\n */g, '\n').trim();

  const plain = (node) => {
    if (node.nodeType === 3) return collapse(node.textContent);
    if (node.nodeType !== 1 || node.matches(SKIP)) return '';
    const inner = Array.from(node.childNodes).map(plain).join('');
    return /^(br|p|li|div)$/.test(tagOf(node)) ? ' ' + inner + ' ' : inner;
  };

  const blocks = [];
  let pending = [];
  let quote = '';
  const addMarkdown = (text) => {
    if (!text.trim()) return;
    pending.push(quote ? text.split('\n').map(line => (quote + line).trimEnd()).join('\n') : text);
  };
  const flush = () => {
    if (pending.length) blocks.push({ type: 'markdown', text: pending.join('\n\n') });
    pending = [];
  };
  const addBlock = (block) => { flush(); blocks.push(block); };

  const codeBlock = (el) => {
    const widget = el.matches('[data-code-block]') ? el : (el.querySelector('[data-code-block]') || el);
    const editor = widget.querySelector('.cm-content');
    let code = null;
    if (editor) {
      try {
        const view = (editor.cmTile && editor.cmTile.view) || (editor.cmView && editor.cmView.view);
        if (view && view.state && view.state.doc) code = view.state.doc.toString();
      } catch { code = null; }
      if (code === null) code = Array.from(editor.querySelectorAll('.cm-line')).map(line => line.textContent).join('\n');
    } else {
      const pre = widget.matches('pre') ? widget : widget.querySelector('pre');
      code = ((pre && pre.querySelector('code')) || pre || widget).textContent;
    }
    let language = (editor && editor.getAttribute('data-language')) || widget.querySelector('[data-markdown-copy="exclude"] .truncate')?.textContent?.trim() || null;
    if (!language) language = (/language-([\w+#.-]+)/.exec(widget.querySelector('code')?.className || '') || [])[1] || null;
    language = language ? language.toLowerCase() : null;
    if (language && /^(plain ?text|text|txt)$/.test(language)) language = null;
    return { type: 'code', language, code: code.replace(/\n+$/, '') };
  };

  const tableBlock = (table) => {
    const rows = Array.from(table.querySelectorAll('tr')).filter(row => row.closest('table') === table)
      .map(row => Array.from(row.children).filter(cell => /^(th|td)$/.test(tagOf(cell))).map(cell => collapse(plain(cell)).trim()))
      .filter(row => row.length > 0);
    if (!rows.length) return null;
    const width = Math.max(...rows.map(row => row.length));
    const padded = rows.map(row => row.concat(Array(width - row.length).fill('')));
    return { type: 'table', header: padded[0], rows: padded.slice(1) };
  };

  let nextAsset = 0;
  const addAsset = (el, kind, name) => {
    const id = ++nextAsset;
    el.setAttribute('data-wab-asset', String(id));
    result.assets.push({ id, kind, name });
    addBlock({ type: 'asset', id });
  };
  const addImage = (img) => {
    const source = img.currentSrc || img.src || '';
    if (!/^(blob:|data:|https:\/\/chatgpt\.com\/)/.test(source) || (img.naturalWidth && img.naturalWidth < 48)) return;
    addAsset(img, 'image', img.getAttribute('alt') || 'image');
  };
  const fileName = (button) => {
    const row = button.closest('[class~="group/resource-row"]');
    const title = row?.querySelector('[title]')?.getAttribute('title');
    if (title) return title;
    const preview = row?.querySelector('[aria-label^="Open preview of "]')?.getAttribute('aria-label');
    return preview ? preview.slice('Open preview of '.length) : 'file';
  };

  const hasBlock = (el) => !!el.querySelector(BLOCKS);
  const itemsOf = (parent) => {
    const out = [];
    let run = [];
    const endRun = () => {
      if (run.some(node => node.textContent.trim())) out.push({ nodes: run });
      run = [];
    };
    for (const node of parent.childNodes) {
      if (node.nodeType === 3) { run.push(node); continue; }
      if (node.nodeType !== 1 || node.matches(SKIP)) continue;
      if (node.matches(BLOCKS)) { endRun(); out.push({ el: node }); }
      else if (hasBlock(node)) { endRun(); out.push(...itemsOf(node)); }
      else run.push(node);
    }
    endRun();
    return out;
  };

  const inProse = (item) => !!(item.el || item.nodes[0].parentElement)?.closest('[data-markdown-text-style]');
  // A list becomes Markdown lines: the marker line, continuation lines, nested lists. A block that cannot live inside Markdown (code, table, asset)
  // ends the pending lines, goes out as its own block, and the rest of the list continues in a new Markdown block.
  const addList = (list) => {
    let lines = [];
    const drain = () => { if (lines.length) addMarkdown(lines.join('\n')); lines = []; };
    const walk = (current, depth) => {
      const ordered = tagOf(current) === 'ol';
      let number = parseInt(current.getAttribute('start') || '1', 10) || 1;
      for (const li of Array.from(current.children).filter(child => tagOf(child) === 'li')) {
        const marker = ordered ? number++ + '. ' : '- ';
        const lead = ' '.repeat(depth) + marker.trimEnd();
        const inner = ' '.repeat(depth + marker.length);
        let started = false;
        const begin = () => { if (!started) { lines.push(lead); started = true; } };
        for (const part of itemsOf(li)) {
          const tag = part.el ? tagOf(part.el) : null;
          const text = part.nodes ? paragraph(part.nodes, true) : (tag === 'p' || HEADINGS.includes(tag) ? paragraph(Array.from(part.el.childNodes), tag === 'p') : null);
          if (text !== null) {
            const rows = text.split('\n');
            if (started) lines.push(inner + rows[0]); else { lines.push(' '.repeat(depth) + marker + rows[0]); started = true; }
            for (const row of rows.slice(1)) lines.push(inner + row);
          } else if (tag === 'ul' || tag === 'ol') {
            begin();
            walk(part.el, depth + marker.length);
          } else {
            begin();
            drain();
            emit(part);
          }
        }
        begin();
      }
    };
    walk(list, 0);
    drain();
  };

  const emit = (item) => {
    if (item.nodes) {
      if (inProse(item)) addMarkdown(paragraph(item.nodes, true));
      return;
    }
    const el = item.el;
    const tag = tagOf(el);
    if (el.matches('[data-testid="generated-image-gallery"]')) { for (const img of el.querySelectorAll('img')) addImage(img); return; }
    if (tag === 'img') { addImage(el); return; }
    if (tag === 'button') { addAsset(el, 'file', fileName(el)); return; }
    if (!inProse(item)) return;
    if (el.matches(CODE)) { const block = codeBlock(el); if (block.code.trim()) addBlock(block); return; }
    if (tag === 'table') { const block = tableBlock(el); if (block) addBlock(block); return; }
    if (tag === 'hr') addMarkdown('---');
    else if (tag === 'ul' || tag === 'ol') addList(el);
    else if (tag === 'blockquote') {
      const outer = quote;
      quote = outer + '> ';
      for (const part of itemsOf(el)) emit(part);
      quote = outer;
    } else if (HEADINGS.includes(tag)) addMarkdown('#'.repeat(Number(tag.slice(1))) + ' ' + paragraph(Array.from(el.childNodes), false));
    else addMarkdown(paragraph(Array.from(el.childNodes), true));
  };

  for (const root of roots) for (const item of itemsOf(root)) emit(item);
  flush();
  result.blocks = blocks;
  return result;
}`;

const rawBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('markdown'), text: z.string() }),
  z.object({ type: z.literal('code'), language: z.string().nullable(), code: z.string() }),
  z.object({ type: z.literal('table'), header: z.array(z.string()), rows: z.array(z.array(z.string())) }),
  z.object({ type: z.literal('asset'), id: z.number() }),
]);

/** What chatgptExtractionScript returns: display-ordered blocks where images and files are still unfetched `asset` placeholders. */
export const extraction = z.object({
  url: z.string(),
  text: z.string(),
  blocks: z.array(rawBlock),
  assets: z.array(z.object({ id: z.number(), kind: z.enum(['image', 'file']), name: z.string() })),
});
export type Extraction = z.infer<typeof extraction>;
