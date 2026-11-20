import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import { chatgptInspectionScript, revealLatestTurnScript } from '../src/adapters/chatgpt/dom.js';

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

// ChatGPT mounts only the turns near the viewport. A conversation tab that was just loaded sits at its top, so after a very long reply the newest turn is
// absent from the page until the scroll container is moved to its end. The host below mounts turn 2 when (and only when) it is scrolled.
const turnHtml = (id: number): string => `<section data-content-search-turn-key="turn-${id}"><div><h4 data-conversation-role="user">You said</h4><div data-chatgpt-search-message-ids="user-${id}">Question ${id}</div></div><div data-talvt-turn-state="complete"><div data-chatgpt-search-message-ids="assistant-${id}"><h4 data-conversation-role="assistant">ChatGPT said</h4><div data-markdown-text-style="assistant-message">Answer ${id}</div></div><button aria-label="Copy">Copy</button></div></section>`;

function virtualizedPage(mountsOnScroll: boolean) {
  const { document } = parseHTML(`<main><div id="host" data-overflow="auto">${turnHtml(1)}</div></main>`);
  const host = document.getElementById('host');
  if (!host) throw new Error('host missing');
  let mounted = false;
  Object.defineProperty(host, 'clientHeight', { value: 800 });
  Object.defineProperty(host, 'scrollHeight', { get: () => (mounted ? 30_000 : 12_000) });
  Object.defineProperty(host, 'scrollTop', {
    get: () => 0,
    set: () => { if (mountsOnScroll && !mounted) { mounted = true; host.insertAdjacentHTML('beforeend', turnHtml(2)); } },
  });
  const context = { document, location: { href: 'https://chatgpt.com/c/existing' }, setTimeout, getComputedStyle: (element: Element) => ({ overflowY: element.getAttribute('data-overflow') ?? 'visible' }) };
  return {
    inspect: (target: string | null) => resultSchema.parse(runInNewContext(`(${chatgptInspectionScript})(${JSON.stringify(target)})`, context)),
    reveal: async (target: string | null) => z.object({ found: z.boolean() }).parse(await runInNewContext(`(${revealLatestTurnScript})(${JSON.stringify(target)})`, context)),
  };
}

test('scrolling the conversation to its end mounts the newest turn that ChatGPT had dropped, and it then reads as complete', async () => {
  const page = virtualizedPage(true);
  assert.equal(page.inspect('user-2').userId, null);
  assert.deepEqual(await page.reveal('user-2'), { found: true });
  assert.deepEqual(page.inspect('user-2'), { userId: 'user-2', assistantId: 'assistant-2', text: 'Answer 2', complete: true });
  assert.equal(page.inspect(null).userId, 'user-2');
});

test('a turn that never mounts is reported as not found rather than waited on forever', async () => {
  const page = virtualizedPage(false);
  assert.deepEqual(await page.reveal('user-2'), { found: false });
  assert.equal(page.inspect('user-2').userId, null);
});
