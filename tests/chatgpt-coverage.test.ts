import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lostContent } from '../src/adapters/chatgpt/coverage.js';
import type { ReplyBlock } from '../src/core/contracts.js';

const plain = 'Situation: the team missed its targets for three weeks. Task: restore quality without pressure. Action: we reviewed cases and coached agents. Result: quality recovered.';

test('blocks that carry the reply text are not flagged, whatever Markdown, tables or code they use', () => {
  const blocks: ReplyBlock[] = [
    { type: 'markdown', text: '**Situation:** the team missed its targets for three weeks.\n\n- **Task:** restore quality without pressure.' },
    { type: 'table', header: ['Action'], rows: [['we reviewed cases and coached agents']] },
    { type: 'code', language: null, code: 'Result: quality recovered.' },
  ];
  assert.equal(lostContent(blocks, plain), false);
});

test('blocks that kept well under the plain text are flagged so the plain text is delivered instead', () => {
  assert.equal(lostContent([{ type: 'markdown', text: 'Situation: the team missed its targets for three weeks.' }], plain), true);
  assert.equal(lostContent([], plain), true);
});

test('a reply without prose (an image or a file) is never flagged, and files add nothing to the comparison', () => {
  assert.equal(lostContent([{ type: 'attachment', attachment: { kind: 'image', path: '/tmp/a.png', fileName: 'a.png', mimeType: 'image/png' } }], ''), false);
  assert.equal(lostContent([{ type: 'attachment', attachment: { kind: 'document', path: '/tmp/a.csv', fileName: 'a.csv', mimeType: 'text/csv' } }], plain), true);
});
