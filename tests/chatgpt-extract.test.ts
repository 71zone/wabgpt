import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import { chatgptInspectionScript, composerAttachmentsScript } from '../src/adapters/chatgpt/dom.js';
import { chatgptExtractionScript, extraction } from '../src/adapters/chatgpt/extract.js';

const inspected = z.object({ url: z.string(), userId: z.string().nullable(), assistantId: z.string().nullable(), text: z.string(), complete: z.boolean(), busy: z.boolean(), error: z.string().nullable(), media: z.boolean() });

// Markup shapes below follow what ChatGPT's renderer produced when this was written: DIL prose (p/h2/ul/ol/blockquote/table with data-d-* attributes),
// a code-block widget whose header carries the language label, a CodeMirror editor for runnable languages, a file card outside the prose and a
// generated-image gallery. Class names are dropped except where the script reads them.
const text = (value: string): string => `<p data-d-text-flow="" data-d-component="text"><span data-d-stream-run="" data-d-text-flow="run">${value}</span></p>`;
const strong = (value: string): string => `<span data-d-inline=""><span data-d-stream-run=""><strong>${value}</strong></span></span>`;
const listItem = (content: string): string => `<li data-d-component="list-item"><div><div data-d-list-item-content="">${content}</div></div></li>`;
const header = (label: string): string => `<div data-markdown-copy="exclude" contenteditable="false"><svg><use href="#x"></use></svg><div class="min-w-0 truncate flex-1">${label}</div><button aria-label="Copy code">Copy code</button></div>`;
const codeWidget = (label: string, body: string): string => `<div data-client-defined-widget="code_block"><div><div data-code-block="true" data-markdown-copy="code-block">${header(label)}${body}</div></div><div hidden=""></div></div>`;
const staticCode = (code: string): string => `<div class="relative"><pre><code><span>${code}</span></code></pre></div>`;
const editor = (lines: string[], language: string): string => `<div class="cm-editor"><div class="cm-scroller"><div class="cm-content" role="textbox" data-language="${language}">${lines.map(line => `<div class="cm-line">${line}</div>`).join('')}</div></div></div>`;
const fileCard = (name: string): string => `<div class="mt-3"><div><span class="group/resource-row relative"><button aria-label="Open preview of ${name}" type="button"></button><span><span title="${name}">${name}</span><span>Spreadsheet</span></span><span class="absolute group-hover/resource-row:opacity-100"><button type="button" aria-label="Download file"></button></span></span></div></div>`;

interface Dom { document: Document }
function load(html: string, edit?: (dom: Dom) => void): Dom {
  const dom = parseHTML(html);
  edit?.(dom);
  return dom;
}
function run(html: string, script: string, target: string | null = null, edit?: (dom: Dom) => void): unknown {
  const { document } = load(html, edit);
  return runInNewContext(`(${script})(${JSON.stringify(target)})`, { document, location: { href: 'https://chatgpt.com/c/existing' }, URL });
}

/** A text turn: the message id sits on the assistant container, the reply on the Copy-button turn. */
const textTurn = (reply: string, extra = ''): string => `<main><section data-content-search-turn-key="turn-1"><div><h4 data-conversation-role="user">You said</h4><div data-chatgpt-search-message-ids="user-1">Question</div></div><div data-talvt-turn-state="complete"><div data-chatgpt-search-message-ids="assistant-1"><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-response-body="assistant-1"><div data-markdown-text-style="assistant-message"><div data-dil-response="" data-d-direction="col">${reply}</div></div>${extra}</div></div><button aria-label="Copy">Copy</button></div></section></main>`;
/** An image-only turn: no prose, no Copy button, and the message id on [data-response-body] inside a plain container. */
const imageTurn = (gallery: string): string => `<main><section data-content-search-turn-key="turn-1"><div><h4 data-conversation-role="user">You said</h4><div data-chatgpt-search-message-ids="user-1">Draw</div></div><div data-talvt-turn-state="complete"><div class="block"><h4 data-conversation-role="assistant">ChatGPT said:</h4><div data-response-body="assistant-1" data-chatgpt-search-message-ids="assistant-1"><div>${gallery}</div></div></div><button aria-label="Copy image">Copy image</button></div></section></main>`;

const parse = (value: unknown) => extraction.parse(value);

test('prose becomes Markdown with inline formatting, lists, quotes and cleaned links; the plain text stays the innerText', () => {
  const reply = [
    `<h2 data-d-component="title"><span data-d-stream-run="">${strong('Demo')}</span></h2>`,
    `<p data-d-component="text"><span>This sentence contains </span>${strong('bold')}<span>, </span><span data-d-font-style="italic"><em>italic</em></span><span>, </span><span><del>strike</del></span><span>, </span><code data-d-component="code"><span>inline code</span></code><span> and a link to </span><span data-d-component="popover-trigger"><a rel="noopener" target="_blank" href="https://example.com?utm_source=chatgpt.com"><span><span>Example</span></span><span><svg><path d="M1"></path></svg></span></a></span><span>.</span></p>`,
    `<ul data-d-component="list" data-d-marker="bullet">${listItem(text('A'))}${listItem(`${text('B')}<ul data-d-component="list" data-d-marker="bullet">${listItem(text('B1'))}</ul>`)}</ul>`,
    `<ol data-d-component="list" data-d-marker="number">${listItem(text('First'))}${listItem(text('Second'))}</ol>`,
    `<blockquote data-d-component="blockquote">${text('quoted')}${text('twice')}</blockquote>`,
  ].join('');
  const result = parse(run(textTurn(reply), chatgptExtractionScript));
  assert.deepEqual(result.blocks, [{
    type: 'markdown',
    text: [
      '## Demo',
      'This sentence contains **bold**, *italic*, ~~strike~~, `inline code` and a link to [Example](https://example.com/).',
      '- A\n- B\n  - B1',
      '1. First\n2. Second',
      '> quoted\n\n> twice',
    ].join('\n\n'),
  }]);
  assert.match(result.text, /Demo/);
  assert.deepEqual(result.assets, []);
});

test('links keep their target, lose ChatGPT tracking, and sandbox or script links fall back to their text', () => {
  const reply = `<p><a href="https://example.com/a?x=1&utm_source=chatgpt.com">one</a>, <a href="https://example.com/">https://example.com/</a>, <a href="sandbox:/mnt/data/x.csv">x.csv</a>, <a href="javascript:alert(1)">bad</a>, <span role="link" aria-label="Open y.csv" data-d-component="pressable">y.csv</span></p>`;
  const [block] = parse(run(textTurn(reply), chatgptExtractionScript)).blocks;
  assert.deepEqual(block, { type: 'markdown', text: '[one](https://example.com/a?x=1), https://example.com/, x.csv, bad, y.csv' });
});

test('code blocks keep their language, read the full CodeMirror document and fall back to the rendered lines', () => {
  const reply = [
    text('Before'),
    codeWidget('Python', `<div class="grid">${editor(['print(1)'], 'python')}</div>`),
    codeWidget('JSON', staticCode('{"a": 1}')),
    codeWidget('Plain text', staticCode('just text\n\n')),
    codeWidget('Bash', `<div>${editor(['echo a', 'echo b'], 'bash')}</div>`),
    text('After'),
  ].join('');
  const result = parse(run(textTurn(reply), chatgptExtractionScript, null, ({ document }) => {
    const python = document.querySelector('.cm-content');
    // CodeMirror only renders the visible lines; the document behind it has them all.
    assert.ok(python);
    Object.assign(python, { cmTile: { view: { state: { doc: { toString: () => 'print(1)\nprint(2)\n\nprint(4)\n' } } } } });
  }));
  assert.deepEqual(result.blocks, [
    { type: 'markdown', text: 'Before' },
    { type: 'code', language: 'python', code: 'print(1)\nprint(2)\n\nprint(4)' },
    { type: 'code', language: 'json', code: '{"a": 1}' },
    { type: 'code', language: null, code: 'just text' },
    { type: 'code', language: 'bash', code: 'echo a\necho b' },
    { type: 'markdown', text: 'After' },
  ]);
});

test('tables become header and rows of plain cell text, and a code block inside a list splits the list', () => {
  const cell = (tag: string, value: string): string => `<${tag} data-d-component="table-cell">${text(value)}</${tag}>`;
  const reply = [
    `<div data-d-component="table"><div data-d-table-viewport="true"><table><tbody>`,
    `<tr data-d-component="table-row">${cell('th', 'Fruit')}${cell('th', 'Color')}</tr>`,
    `<tr data-d-component="table-row">${cell('td', 'Apple')}<td><p><strong>Red</strong> and <a href="https://example.com/">shiny</a></p></td></tr>`,
    `<tr data-d-component="table-row">${cell('td', 'Banana')}</tr>`,
    `</tbody></table></div><div aria-hidden="true"></div></div>`,
    `<ol>${listItem(text('Install'))}${listItem(`${text('Run')}${codeWidget('Bash', staticCode('make'))}${text('then wait')}`)}${listItem(text('Done'))}</ol>`,
  ].join('');
  assert.deepEqual(parse(run(textTurn(reply), chatgptExtractionScript)).blocks, [
    { type: 'table', header: ['Fruit', 'Color'], rows: [['Apple', 'Red and shiny'], ['Banana', '']] },
    { type: 'markdown', text: '1. Install\n2. Run' },
    { type: 'code', language: 'bash', code: 'make' },
    { type: 'markdown', text: '   then wait\n3. Done' },
  ]);
});

test('a downloadable file card becomes an asset block at its position, stamped for the byte transfer', () => {
  const reply = `<p>Created <span role="link" aria-label="Open fruits.csv" data-d-component="pressable">fruits.csv</span> ready.</p>`;
  const html = textTurn(reply, fileCard('fruits.csv'));
  const { document } = load(html);
  const result = parse(runInNewContext(`(${chatgptExtractionScript})(null)`, { document, location: { href: 'https://chatgpt.com/c/existing' }, URL }));
  assert.deepEqual(result.blocks, [{ type: 'markdown', text: 'Created fruits.csv ready.' }, { type: 'asset', id: 1 }]);
  assert.deepEqual(result.assets, [{ id: 1, kind: 'file', name: 'fruits.csv' }]);
  assert.equal(document.querySelector('[data-wab-asset="1"]')?.getAttribute('aria-label'), 'Download file');
});

test('generated images become asset blocks while foreign or tiny images are ignored', () => {
  const gallery = `<div data-testid="generated-image-gallery"><div data-web-image-tile="true"><button data-testid="generated-image-preview"><img alt="Generated image 1" src="blob:https://chatgpt.com/abc"></button><button aria-label="Edit generated image 1">Edit</button></div><img alt="favicon" src="https://www.google.com/s2/favicons?domain=x"><img alt="own" src="https://chatgpt.com/backend-api/estuary/content?id=1"></div>`;
  const { document } = load(imageTurn(gallery));
  const result = parse(runInNewContext(`(${chatgptExtractionScript})(null)`, { document, location: { href: 'https://chatgpt.com/c/existing' }, URL }));
  assert.deepEqual(result.blocks, [{ type: 'asset', id: 1 }, { type: 'asset', id: 2 }]);
  assert.deepEqual(result.assets, [{ id: 1, kind: 'image', name: 'Generated image 1' }, { id: 2, kind: 'image', name: 'own' }]);
  assert.equal(document.querySelector('[data-wab-asset="1"]')?.tagName, 'IMG');
});

test('text and an image keep the order in which the message renders them', () => {
  const html = `<main><section data-content-search-turn-key="t"><div><h4 data-conversation-role="user">You</h4><div data-chatgpt-search-message-ids="user-1">Q</div></div><div data-talvt-turn-state="complete"><div data-chatgpt-search-message-ids="assistant-1"><h4 data-conversation-role="assistant">ChatGPT</h4><div data-response-body="assistant-1"><div data-testid="generated-image-gallery"><img alt="Generated image 1" src="blob:https://chatgpt.com/a"></div><div data-markdown-text-style="assistant-message"><div data-dil-response="">${text('Here it is')}</div></div></div></div><button aria-label="Copy">Copy</button></div></section></main>`;
  assert.deepEqual(parse(run(html, chatgptExtractionScript)).blocks, [{ type: 'asset', id: 1 }, { type: 'markdown', text: 'Here it is' }]);
});

const writingCard = (variant: string, header: string, body: string, copyText: string): string => `<div data-client-defined-widget="writing_block" data-id="58321"><div class="group/writing-block-surface relative" data-oai-writing-block-surface="" data-markdown-copy="rich-block" data-markdown-copy-text="${copyText}" data-testid="chatgpt-writing-block" data-writing-block-variant="${variant}"><div aria-hidden="true"></div><div class="relative z-[1]"><header class="flex">${header}</header><div><div></div><div><div class="relative"><div class="content-mUPWP6" data-markdown-copy-content="true" dir="auto"><div class="editor-jMsqTn writing-block-editor"><div contenteditable="true" aria-label="Start writing" aria-multiline="true" role="textbox" class="ProseMirror">${body}</div></div></div></div></div></div></div></div></div>`;
const writingHeader = (label: string): string => `<div class="flex"><div class="ms-2 flex"><span class="min-w-0 truncate px-3 py-2 text-tertiary"><span class="text-tertiary">${label}</span></span></div></div><div class="flex"><div class="flex"><div class="flex gap-1"><button type="button" aria-label="Copy" data-state="closed"><svg></svg></button></div></div><button type="button" aria-label="Open editor" data-state="closed"><svg></svg></button></div>`;
const draftParagraph = (value: string): string => `<p dir="auto"><span>${value}</span></p>`;

test('a writing card becomes its own draft block between the prose around it, without its label or buttons', () => {
  const draft = draftParagraph("Hey! 😊 We're putting together a dance performance, and I'd love for you to join us!");
  const reply = `${text('Here is a draft:')}${writingCard('chat_message', writingHeader('Writing'), draft, 'Hey')}${`<p data-d-text-flow="" data-d-component="text"><span data-d-stream-run=""><strong>Tone:</strong></span><span data-d-stream-run=""> Thân thiện, vui vẻ.</span></p>`}`;
  assert.deepEqual(parse(run(textTurn(reply), chatgptExtractionScript)).blocks, [
    { type: 'markdown', text: 'Here is a draft:' },
    { type: 'draft', text: "Hey! 😊 We're putting together a dance performance, and I'd love for you to join us!" },
    { type: 'markdown', text: '**Tone:** Thân thiện, vui vẻ.' },
  ]);
});

test('an email card keeps paragraphs, bold, italics, line breaks and bullet lists as Markdown and leads with its subject', () => {
  const body = [
    draftParagraph("Dear [Manager's Name],"),
    `<p dir="auto"><span>To ensure a smooth </span><strong><span>handover</span></strong><span>, I will:</span></p>`,
    `<ul data-spread="false"><li><p dir="auto"><span>Finish all </span><em><span>priority</span></em><span> work.</span></p></li><li><p dir="auto"><span>Share updates.</span></p></li></ul>`,
    `<p dir="auto"><span>Best regards,</span><br><span>[Your Name]</span></p>`,
  ].join('');
  const header = `<div class="flex"><div class="min-w-0">Leave Request for Friday</div></div><div class="flex"><button type="button" aria-label="Copy"><svg></svg></button><fieldset class="contents"><button type="button" aria-label="Open email in app"><svg></svg></button><button type="button" aria-label="Send as me@example.com"><svg></svg>Send</button></fieldset></div>`;
  const reply = `${writingCard('email', header, body, 'copy')}${text('Tone: formal.')}`;
  assert.deepEqual(parse(run(textTurn(reply), chatgptExtractionScript)).blocks, [
    { type: 'draft', text: "Subject: Leave Request for Friday\n\nDear [Manager's Name],\n\nTo ensure a smooth **handover**, I will:\n\n- Finish all *priority* work.\n- Share updates.\n\nBest regards,\n[Your Name]" },
    { type: 'markdown', text: 'Tone: formal.' },
  ]);
});

test('a writing card whose editor is empty falls back to the copy text ChatGPT attaches to it, and two cards stay separate drafts', () => {
  const reply = `${writingCard('chat_message', writingHeader('Writing'), '', 'Only the copy text')}${text('between')}${writingCard('chat_message', writingHeader('Message'), draftParagraph('Second'), 'x')}`;
  assert.deepEqual(parse(run(textTurn(reply), chatgptExtractionScript)).blocks, [
    { type: 'draft', text: 'Only the copy text' },
    { type: 'markdown', text: 'between' },
    { type: 'draft', text: 'Second' },
  ]);
});

test('a code block inside a writing card stays in order between two draft parts', () => {
  const body = `${draftParagraph('Run this:')}${codeWidget('Bash', staticCode('make'))}${draftParagraph('Done.')}`;
  assert.deepEqual(parse(run(textTurn(writingCard('chat_message', writingHeader('Writing'), body, 'c')), chatgptExtractionScript)).blocks, [
    { type: 'draft', text: 'Run this:' },
    { type: 'code', language: 'bash', code: 'make' },
    { type: 'draft', text: 'Done.' },
  ]);
});

test('an image and the sentence about it live in separate response bodies of one turn; both are read and the turn completes without a Copy button', () => {
  const html = `<main><section data-content-search-turn-key="t"><div><h4 data-conversation-role="user">You</h4><div data-chatgpt-search-message-ids="user-1">Q</div></div><div data-talvt-turn-state="complete"><div><div data-response-body="m1" data-chatgpt-search-message-ids="m1"><div data-testid="generated-image-gallery"><img alt="Generated image 1" src="blob:https://chatgpt.com/a"></div></div></div><div data-chatgpt-search-message-ids="m2"><h4 data-conversation-role="assistant">ChatGPT</h4><div data-response-body="m2"><div data-markdown-text-style="assistant-message"><p>A blue square.</p></div></div></div><button aria-label="Copy image">Copy image</button></div></section></main>`;
  assert.deepEqual(parse(run(html, chatgptExtractionScript)).blocks, [{ type: 'asset', id: 1 }, { type: 'markdown', text: 'A blue square.' }]);
  assert.deepEqual(inspected.parse(run(html, chatgptInspectionScript)), { url: 'https://chatgpt.com/c/existing', userId: 'user-1', assistantId: 'm2', text: 'A blue square.', complete: true, busy: false, error: null, media: true });
});

test('an older DOM without the response wrapper is read from the markdown body alone', () => {
  const html = `<main><section data-content-search-turn-key="t"><div><h4 data-conversation-role="user">You</h4><div data-chatgpt-search-message-ids="user-1">Q</div></div><div data-talvt-turn-state="complete"><div data-chatgpt-search-message-ids="assistant-1"><h4 data-conversation-role="assistant">ChatGPT</h4><div data-markdown-text-style="assistant-message"><p>Hello <strong>there</strong></p><pre><code class="language-ts">const a = 1;\n</code></pre><ul><li>one<ul><li>two</li></ul></li></ul></div></div><button aria-label="Copy">Copy</button></div></section></main>`;
  assert.deepEqual(parse(run(html, chatgptExtractionScript)).blocks, [
    { type: 'markdown', text: 'Hello **there**' },
    { type: 'code', language: 'ts', code: 'const a = 1;' },
    { type: 'markdown', text: '- one\n  - two' },
  ]);
});

test('extraction targets the submitted turn and reports nothing for a missing one', () => {
  const html = `<main>${[1, 2].map(id => `<section data-content-search-turn-key="turn-${id}"><div><h4 data-conversation-role="user">You</h4><div data-chatgpt-search-message-ids="user-${id}">Q${id}</div></div><div data-talvt-turn-state="complete"><div data-chatgpt-search-message-ids="assistant-${id}"><h4 data-conversation-role="assistant">ChatGPT</h4><div data-markdown-text-style="assistant-message"><p>Answer ${id}</p></div></div><button aria-label="Copy">Copy</button></div></section>`).join('')}</main>`;
  assert.deepEqual(parse(run(html, chatgptExtractionScript, 'user-1')).blocks, [{ type: 'markdown', text: 'Answer 1' }]);
  assert.deepEqual(parse(run(html, chatgptExtractionScript, 'user-9')).blocks, []);
});

test('an image-only reply is identified and complete even without prose or a Copy button', () => {
  const gallery = `<div data-testid="generated-image-gallery"><img alt="Generated image 1" src="blob:https://chatgpt.com/abc"></div>`;
  assert.deepEqual(inspected.parse(run(imageTurn(gallery), chatgptInspectionScript)), { url: 'https://chatgpt.com/c/existing', userId: 'user-1', assistantId: 'assistant-1', text: '', complete: true, busy: false, error: null, media: true });
});

test('a text reply with a file is complete and flagged as media, and a plain text reply is not', () => {
  assert.equal(inspected.parse(run(textTurn(text('Created it'), fileCard('a.csv')), chatgptInspectionScript)).media, true);
  const plain = inspected.parse(run(textTurn(text('Hello')), chatgptInspectionScript));
  assert.deepEqual({ media: plain.media, complete: plain.complete, text: plain.text }, { media: false, complete: true, text: 'Hello' });
});

test('the composer script counts attachment tiles and the ones still uploading', () => {
  const tile = (name: string, uploading: boolean): string => `<div role="button" aria-label="${name}"><img alt="${name}">${uploading ? `<span role="progressbar" aria-label="Uploading ${name}"></span>` : ''}<button aria-label="Remove ${name}"></button></div>`;
  const state = (html: string) => z.object({ tiles: z.number(), uploading: z.number(), error: z.string().nullable() }).parse(run(`<form data-chatgpt-composer>${html}<button aria-label="Send"></button></form>`, composerAttachmentsScript));
  assert.deepEqual(state(''), { tiles: 0, uploading: 0, error: null });
  assert.deepEqual(state(`<div data-composer-attachments>${tile('a.png', false)}${tile('b.png', true)}</div>`), { tiles: 2, uploading: 1, error: null });
});
