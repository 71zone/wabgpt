import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Attachment, ReplyBlock } from '../src/core/contracts.js';
import { createMediaStore } from '../src/infrastructure/media.js';
import { markdownToWhatsApp, planReply, renderReply, splitText, tableToCsv } from '../src/adapters/whatsapp/render.js';

const texts = (blocks: ReplyBlock[]): string[] => planReply(blocks).map(message => message.kind === 'text' ? message.text : `[${message.kind}]`);

test('emphasis, strikethrough, headings and literal asterisks convert to WhatsApp syntax', () => {
  assert.equal(markdownToWhatsApp('**bold** and __also__ and *italic* and _kept_ and ~~gone~~'), '*bold* and *also* and _italic_ and _kept_ and ~gone~');
  assert.equal(markdownToWhatsApp('***both***'), '*_both_*');
  assert.equal(markdownToWhatsApp('# Title\n## 2. Numbered **heading** ##'), '*Title*\n*2. Numbered heading*');
  assert.equal(markdownToWhatsApp('2 * 3 * 4 and \\*escaped\\*'), '2 * 3 * 4 and *escaped*');
  assert.equal(markdownToWhatsApp('use `**raw**` here and **bold `code`**'), 'use `**raw**` here and *bold `code`*');
});

test('lists, quotes and rules convert and nested indentation survives', () => {
  assert.equal(markdownToWhatsApp('* one\n  - nested **x**\n+ two\n\n1. first\n2) second\n\n> quoted *q*\n\n---\nend'),
    '- one\n  - nested *x*\n- two\n\n1. first\n2. second\n\n> quoted _q_\n\nend');
});

test('links keep their URL, bold inside links converts, images are dropped', () => {
  assert.equal(markdownToWhatsApp('see [**docs**](https://a.test/x_y_z) now'), 'see *docs* (https://a.test/x_y_z) now');
  assert.equal(markdownToWhatsApp('[https://a.test](https://a.test) ![pic](https://a.test/p.png)'), 'https://a.test');
  assert.equal(markdownToWhatsApp('<https://a.test/__x__>'), 'https://a.test/__x__');
});

test('fenced code inside prose is untouched and its language tag removed', () => {
  assert.equal(markdownToWhatsApp('text\n```js\nconst a = **b**;\n```'), 'text\n```\nconst a = **b**;\n```');
});

test('code blocks get their own fenced message with the fence made unbreakable', () => {
  const messages = texts([
    { type: 'markdown', text: 'before' },
    { type: 'code', language: 'ts', code: 'const s = "```";\n' },
    { type: 'markdown', text: 'after' },
  ]);
  assert.deepEqual(messages, ['before', '```\nconst s = "``\u200b`";\n```', 'after']);
  assert.ok(!messages[1]?.slice(3, -3).includes('```'));
});

test('code longer than 12000 chars becomes a document named after the language', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wa-render-'));
  try {
    const rendered = await renderReply([{ type: 'code', language: 'python', code: 'x = 1\n'.repeat(3000) }], createMediaStore(dir));
    assert.equal(rendered.length, 1);
    const [message] = rendered;
    assert.ok(message?.kind === 'media');
    assert.equal(message.attachment.fileName, 'snippet.py');
    assert.equal(message.attachment.kind, 'document');
    assert.equal((await readFile(message.attachment.path, 'utf8')).startsWith('x = 1\nx = 1'), true);
    const [unknown] = planReply([{ type: 'code', language: null, code: 'y'.repeat(13000) }]);
    assert.ok(unknown?.kind === 'file' && unknown.fileName === 'snippet.txt');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('empty blocks are dropped', () => {
  assert.deepEqual(planReply([
    { type: 'markdown', text: '  \n ' }, { type: 'code', language: null, code: '\n  \n' }, { type: 'table', header: [], rows: [] },
  ]), []);
});

test('narrow tables render as a fenced aligned grid with ragged rows padded', () => {
  const [message, ...rest] = planReply([{ type: 'table', header: ['Name', 'Qty'], rows: [['Apple', '3'], ['Kiwi']] }]);
  assert.deepEqual(rest, []);
  assert.deepEqual(message, { kind: 'text', text: '```\nName  | Qty\n------+----\nApple | 3\nKiwi  |\n```' });
});

test('newlines in cells collapse and single-column and header-only tables still render', () => {
  assert.deepEqual(texts([{ type: 'table', header: ['Item'], rows: [['a\nb'], ['c|d']] }]), ['```\nItem\n----\na b\nc|d\n```']);
  assert.deepEqual(texts([{ type: 'table', header: ['A', 'B'], rows: [] }]), ['```\nA | B\n--+--\n```']);
});

test('wide tables use the record layout and also ship a CSV', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wa-render-'));
  try {
    const block: ReplyBlock = { type: 'table', header: ['City', 'Description of the place'], rows: [['Hanoi', 'The capital, with a long story behind it'], ['Hue', '']] };
    const planned = planReply([block]);
    assert.equal(planned.length, 2);
    assert.deepEqual(planned[0], { kind: 'text', text: '*Hanoi*\nDescription of the place: The capital, with a long story behind it\n\n*Hue*' });
    const rendered = await renderReply([block], createMediaStore(dir));
    const csv = rendered[1];
    assert.ok(csv?.kind === 'media');
    assert.equal(csv.attachment.fileName, 'table.csv');
    assert.equal(csv.attachment.mimeType, 'text/csv');
    assert.equal(await readFile(csv.attachment.path, 'utf8'), '\uFEFFCity,Description of the place\r\nHanoi,"The capital, with a long story behind it"\r\nHue,\r\n');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('tables with more than 8 rows add a CSV next to the grid; more than 30 rows fall back to records', () => {
  const rows = (count: number): string[][] => Array.from({ length: count }, (_, index) => [`r${index}`, 'v']);
  const nine = planReply([{ type: 'table', header: ['k', 'v'], rows: rows(9) }]);
  assert.deepEqual(nine.map(message => message.kind), ['text', 'file']);
  assert.ok(nine[0]?.kind === 'text' && nine[0].text.startsWith('```\nk  | v'));
  const eight = planReply([{ type: 'table', header: ['k', 'v'], rows: rows(8) }]);
  assert.deepEqual(eight.map(message => message.kind), ['text']);
  const many = planReply([{ type: 'table', header: ['k', 'v'], rows: rows(31) }]);
  assert.ok(many[0]?.kind === 'text' && many[0].text.startsWith('*r0*\nv: v'));
  assert.equal(many.at(-1)?.kind, 'file');
});

test('CSV quotes commas, quotes and newlines per RFC 4180', () => {
  assert.equal(tableToCsv(['a', 'b,c'], [['say "hi"', 'x\ny'], ['1']]), '\uFEFFa,"b,c"\r\n"say ""hi""","x\ny"\r\n1,\r\n');
});

test('wide characters are counted by code point when sizing the grid', () => {
  const [message] = planReply([{ type: 'table', header: ['Emoji', 'N'], rows: [['😀😀', '1']] }]);
  assert.deepEqual(message, { kind: 'text', text: '```\nEmoji | N\n------+--\n😀😀    | 1\n```' });
});

test('mixed blocks keep their order and consecutive prose merges', async () => {
  const image: Attachment = { kind: 'image', path: '/tmp/a.png', fileName: 'a.png', mimeType: 'image/png' };
  const messages = texts([
    { type: 'markdown', text: 'one' }, { type: 'markdown', text: 'two' },
    { type: 'attachment', attachment: image },
    { type: 'code', language: null, code: 'c' },
    { type: 'table', header: ['h'], rows: [['v']] },
    { type: 'markdown', text: 'last' },
  ]);
  assert.deepEqual(messages, ['one\n\ntwo', '[media]', '```\nc\n```', '```\nh\n-\nv\n```', 'last']);
  assert.deepEqual(planReply([{ type: 'attachment', attachment: image }]), [{ kind: 'media', attachment: image }]);
});

test('a draft is its own plain WhatsApp message between the prose around it; bold and italics convert and long drafts split', () => {
  const messages = planReply([
    { type: 'markdown', text: 'Here is a draft:' },
    { type: 'draft', text: 'Hi **team**,\n\n- *one*\n- two' },
    { type: 'markdown', text: '**Tone:** friendly' },
    { type: 'draft', text: '  ' },
  ]);
  assert.deepEqual(messages.map(message => message.kind === 'text' ? message.text : '[other]'), ['Here is a draft:', 'Hi *team*,\n\n- _one_\n- two', '*Tone:* friendly']);
  const long = planReply([{ type: 'draft', text: Array.from({ length: 10 }, (_, index) => `${index}`.repeat(900)).join('\n\n') }]);
  assert.ok(long.length > 1 && long.every(message => message.kind === 'text' && message.text.length <= 4000));
});

test('an email draft arrives as a label bubble, a bubble with only the subject and the body in its own bubbles', () => {
  const messages = planReply([
    { type: 'markdown', text: 'Here is the email:' },
    { type: 'draft', title: 'Leave Request for Friday', text: 'Dear **boss**,\n\nPlease approve.' },
    { type: 'markdown', text: 'Tone: formal' },
  ]);
  assert.deepEqual(messages.map(message => message.kind === 'text' ? message.text : '[other]'), [
    'Here is the email:', '_Subject_', 'Leave Request for Friday', 'Dear *boss*,\n\nPlease approve.', 'Tone: formal',
  ]);
  const long = planReply([{ type: 'draft', title: 'S', text: Array.from({ length: 10 }, (_, index) => `${index}`.repeat(900)).join('\n\n') }]);
  assert.ok(long.length > 3 && long.slice(2).every(message => message.kind === 'text' && message.text.length <= 4000));
});

test('long prose splits on paragraph, line and word boundaries within 4000 characters', () => {
  const paragraphs = Array.from({ length: 10 }, (_, index) => `${index}`.repeat(900));
  const chunks = splitText(paragraphs.join('\n\n'));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 4000));
  assert.equal(chunks.join('\n\n'), paragraphs.join('\n\n'));

  const words = Array.from({ length: 2000 }, () => 'word').join(' ');
  const wrapped = splitText(words);
  assert.ok(wrapped.every(chunk => chunk.length <= 4000));
  assert.equal(wrapped.join(' '), words);

  const solid = splitText('x'.repeat(9000));
  assert.ok(solid.every(chunk => chunk.length <= 4000));
  assert.equal(solid.join(''), 'x'.repeat(9000));
});

test('a split inside a fenced code block reopens the fence in the next message', () => {
  const body = Array.from({ length: 600 }, (_, index) => `line ${index}`).join('\n');
  const chunks = splitText(`\`\`\`\n${body}\n\`\`\``);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4000);
    assert.equal(chunk.split('\n').filter(line => line === '```').length % 2, 0);
  }
});
