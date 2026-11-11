/** Accessible name of ChatGPT's message composer textbox, on the home page and on a project's new-chat landing. */
export const composerName = /Ask|Message|ChatGPT|New chat in/i;

/** Page script (BrowserOS evaluateInPage) that reads the newest turn, or the turn of `targetUserId`, from ChatGPT's conversation DOM. */
export const chatgptInspectionScript = `(targetUserId) => {
  const main = document.querySelector('main') || document.body;
  const users = Array.from(main.querySelectorAll('[data-conversation-role="user"]'));
  const user = targetUserId
    ? users.find(node => node.parentElement?.querySelector('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids')?.split(/\\s+/).includes(targetUserId))
    : users.at(-1);
  const userId = user?.parentElement?.querySelector('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids')?.trim().split(/\\s+/)[0] || null;
  const region = user?.closest('[data-content-search-turn-key]');
  const assistant = region ? Array.from(region.querySelectorAll('[data-conversation-role="assistant"]')).at(-1) : null;
  const assistantId = assistant?.parentElement?.getAttribute('data-chatgpt-search-message-ids')?.trim().split(/\\s+/)[0] || null;
  const turn = assistant?.closest('[data-talvt-turn-state]');
  const body = assistant?.parentElement?.querySelector('[data-markdown-text-style="assistant-message"]');
  const text = body?.innerText || '';
  const busy = !!main.querySelector('button[aria-label="Stop generating"],button[aria-label="Stop streaming"],button[aria-label="Stop"]');
  const complete = turn?.getAttribute('data-talvt-turn-state') === 'complete' && !!turn.querySelector('button[aria-label="Copy"]');
  const error = main.querySelector('[role="alert"]')?.textContent?.trim() || null;
  return {url:location.href,userId,assistantId,text,complete,busy,error};
}`;

/** Project pages render a shell first; the composer only exists once the project has hydrated. Returns a BrowserOS script fragment waiting for it, or nothing for other pages. */
export const settleScript = (page: string, url: string): string => /^https:\/\/chatgpt\.com\/g\/g-p-/.test(url) ? `try{await ${page}.waitForSelector('[contenteditable="true"][role="textbox"]',{timeout:15000});}catch{}` : '';

/** BrowserOS script: true when the page behind `pageId` currently offers the composer. */
export const composerReadyScript = (pageId: number): string => `const snapshot=await browser.page(${pageId}).snapshot({mode:'interactive'}); return snapshot.refs.some(ref=>ref.role==='textbox' && ${composerName}.test(ref.name));`;

/**
 * BrowserOS script that fills the composer and presses Send, re-checking before each step that the tab is still inside `pathPattern`
 * (a pathname regex source from destinationPathPattern) so a prompt is never submitted to a page the caller did not choose.
 */
export function submitScript(pageId: number, pathPattern: string, text: string): string {
  const guard = `const inside=(url)=>{const here=/^https:\\/\\/chatgpt\\.com(\\/[^?#]*)?(?:[?#].*)?$/.exec(url);return !!here&&new RegExp(${JSON.stringify(pathPattern)}).test(here[1]??'/');};`;
  return `${guard}const page=browser.page(${pageId}); const snap=await page.snapshot({mode:'interactive'}); if(!inside(snap.url)) throw new Error('ChatGPT left the expected destination; no prompt submitted.'); const editor=snap.refs.find(ref=>ref.role==='textbox' && ${composerName}.test(ref.name)); if(!editor) throw new Error('ChatGPT composer unavailable; check login.'); await page.fill(editor.ref,${JSON.stringify(text)}); const filled=await page.snapshot({mode:'interactive'}); if(!inside(filled.url)) throw new Error('ChatGPT left the expected destination; no prompt submitted.'); const send=filled.refs.find(ref=>ref.role==='button' && /^(Send|Send message|Send prompt)$/i.test(ref.name)); if(!send) throw new Error('Send button unavailable; no prompt submitted.'); await page.click(send.ref); return {url:(await page.snapshot({mode:'interactive'})).url};`;
}
