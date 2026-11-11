import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import { chatgptInspectionScript } from '../src/adapters/chatgpt/dom.js';

const resultSchema = z.object({ userId: z.string().nullable(), assistantId: z.string().nullable(), text: z.string(), complete: z.boolean() });
function inspect(turns: number[], target: string | null = null) {
  const html = `<main>${turns.map(id => `<section data-content-search-turn-key="turn-${id}"><div><h4 data-conversation-role="user">You said</h4><div data-chatgpt-search-message-ids="user-${id}">Question ${id}</div></div><div data-talvt-turn-state="complete"><div data-chatgpt-search-message-ids="assistant-${id}"><h4 data-conversation-role="assistant">ChatGPT said</h4><div data-markdown-text-style="assistant-message">Answer ${id}</div></div><button aria-label="Copy">Copy</button></div></section>`).join('')}</main>`;
  const { document } = parseHTML(html);
  const value: unknown = runInNewContext(`(${chatgptInspectionScript})(${JSON.stringify(target)})`, { document, location: { href: 'https://chatgpt.com/c/existing' } });
  return resultSchema.parse(value);
}

test('a sliding five-turn window identifies the new response even though message counts do not grow', () => {
  const before = inspect([1, 2, 3, 4, 5]);
  const after = inspect([2, 3, 4, 5, 6]);
  assert.equal(before.userId, 'user-5');
  assert.equal(after.userId, 'user-6');
  assert.equal(after.assistantId, 'assistant-6');
  assert.equal(after.complete, true);
  assert.equal(after.text, 'Answer 6');
});

test('only the assistant response belonging to the submitted user message is selected', () => {
  assert.deepEqual(inspect([2, 3, 4, 5, 6], 'user-5'), { userId: 'user-5', assistantId: 'assistant-5', text: 'Answer 5', complete: true });
  const missing = inspect([2, 3, 4, 5, 6], 'user-1');
  assert.equal(missing.userId, null);
  assert.equal(missing.assistantId, null);
  assert.equal(missing.text, '');
  assert.equal(missing.complete, false);
});
