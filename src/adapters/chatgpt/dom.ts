/** Accessible name of ChatGPT's message composer textbox, on the home page and on a project's new-chat landing. */
export const composerName = /Ask|Message|ChatGPT|New chat in/i;

/**
 * Page-script prelude shared by the inspection and extraction scripts: finds the newest turn, or the turn of `targetUserId`, and binds
 * `userId`, `assistantId`, `turn` and `holder` (the container of the turn's last assistant message, null when there is none).
 * A text reply carries the message id on `holder` itself; an image-only reply carries it on the `[data-response-body]` inside `holder`.
 */
export const locateAssistant = String.raw`
  const main = document.querySelector('main') || document.body;
  const users = Array.from(main.querySelectorAll('[data-conversation-role="user"]'));
  const user = targetUserId
    ? users.find(node => node.parentElement?.querySelector('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids')?.split(/\s+/).includes(targetUserId))
    : users.at(-1);
  const userId = user?.parentElement?.querySelector('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids')?.trim().split(/\s+/)[0] || null;
  const region = user?.closest('[data-content-search-turn-key]');
  const assistant = region ? Array.from(region.querySelectorAll('[data-conversation-role="assistant"]')).at(-1) : null;
  const holder = assistant?.parentElement || null;
  const assistantId = (holder?.getAttribute('data-chatgpt-search-message-ids') || holder?.querySelector('[data-chatgpt-search-message-ids]')?.getAttribute('data-chatgpt-search-message-ids'))?.trim().split(/\s+/)[0] || null;
  const turn = assistant?.closest('[data-talvt-turn-state]');
`;

/**
 * Page script (BrowserOS evaluateInPage) that reads the newest turn, or the turn of `targetUserId`, from ChatGPT's conversation DOM. It runs every second
 * while a reply is generating, so it stays light. `media` is true when the turn carries a generated image or a downloadable file: such a reply can be
 * complete without any prose, and without the "Copy" button that marks a completed text reply (an image has "Copy image" instead).
 */
export const chatgptInspectionScript = String.raw`(targetUserId) => {
  ${locateAssistant}
  const body = holder?.querySelector('[data-markdown-text-style="assistant-message"]');
  const text = body?.innerText || '';
  const media = !!turn?.querySelector('[data-testid="generated-image-gallery"] img, button[aria-label="Download file"]');
  const busy = !!main.querySelector('button[aria-label="Stop generating"],button[aria-label="Stop streaming"],button[aria-label="Stop"]');
  const complete = turn?.getAttribute('data-talvt-turn-state') === 'complete' && (!!turn.querySelector('button[aria-label="Copy"]') || media);
  const error = main.querySelector('[role="alert"]')?.textContent?.trim() || null;
  return {url:location.href,userId,assistantId,text,complete,busy,error,media};
}`;

/**
 * Page script that counts what the composer currently holds. Each attachment is a tile ([role="button"]) inside [data-composer-attachments]; a tile that is
 * still uploading contains a [role="progressbar"] (its "Uploading <name>" spinner). The Send button stays enabled during an upload, so this is the only
 * reliable readiness signal.
 */
export const composerAttachmentsScript = String.raw`() => {
  const root = document.querySelector('[data-composer-attachments]');
  return {
    tiles: root ? root.querySelectorAll('[role="button"]').length : 0,
    uploading: root ? root.querySelectorAll('[role="progressbar"]').length : 0,
    error: document.querySelector('[role="alert"]')?.textContent?.trim() || null,
  };
}`;

/** Project pages render a shell first; the composer only exists once the project has hydrated. Returns a BrowserOS script fragment waiting for it, or nothing for other pages. */
export const settleScript = (page: string, url: string): string => /^https:\/\/chatgpt\.com\/g\/g-p-/.test(url) ? `try{await ${page}.waitForSelector('[contenteditable="true"][role="textbox"]',{timeout:15000});}catch{}` : '';

/** BrowserOS script: true when the page behind `pageId` currently offers the composer. */
export const composerReadyScript = (pageId: number): string => `const snapshot=await browser.page(${pageId}).snapshot({mode:'interactive'}); return snapshot.refs.some(ref=>ref.role==='textbox' && ${composerName}.test(ref.name));`;

/** BrowserOS script prelude defining `inside(url)`: true while `url` is a ChatGPT page whose pathname matches `pathPattern` (a pathname regex source from destinationPathPattern). */
const insideGuard = (pathPattern: string): string => `const inside=(url)=>{const here=/^https:\\/\\/chatgpt\\.com(\\/[^?#]*)?(?:[?#].*)?$/.exec(url);return !!here&&new RegExp(${JSON.stringify(pathPattern)}).test(here[1]??'/');};`;

/**
 * BrowserOS script that adds local files to the composer through ChatGPT's own "Add photos & files" menu (the agent tab intercepts the native picker),
 * re-checking before each step that the tab is still inside `pathPattern`. It returns once the picker received the files; the upload itself continues
 * in the page, so callers poll composerAttachmentsScript until it settles.
 */
export function uploadScript(pageId: number, pathPattern: string, files: string[]): string {
  const stay = `if(!inside(snap.url)) throw new Error('ChatGPT left the expected destination; nothing attached.');`;
  return `${insideGuard(pathPattern)}const page=browser.page(${pageId}); let snap=await page.snapshot({mode:'interactive'}); ${stay} const add=snap.refs.find(ref=>ref.role==='button' && /^Add files and more$/i.test(ref.name)); if(!add) throw new Error('ChatGPT attachment button unavailable.'); await page.click(add.ref); snap=await page.snapshot({mode:'interactive'}); ${stay} const item=snap.refs.find(ref=>ref.role==='button' && /^Add photos & files/i.test(ref.name)); if(!item) throw new Error('ChatGPT upload option unavailable.'); const chooser=await page.click(item.ref); if(!chooser||!chooser.fileChooserOpen) throw new Error('ChatGPT did not open its file picker.'); await page.upload(null,${JSON.stringify(files)}); return true;`;
}

/**
 * BrowserOS script that fills the composer and presses Send, re-checking before each step that the tab is still inside `pathPattern`
 * so a prompt is never submitted to a page the caller did not choose. With `attachments` > 0 it also requires exactly that many finished
 * uploads in the composer, so a reloaded tab can never send the caption without its files. An empty `text` is not typed (attachments only).
 */
export function submitScript(pageId: number, pathPattern: string, text: string, attachments: number): string {
  const fill = text ? `await page.fill(editor.ref,${JSON.stringify(text)}); ` : '';
  const staged = attachments > 0 ? `const held=(await page.evaluateInPage(${composerAttachmentsScript})).value; if(held.tiles!==${attachments}||held.uploading>0) throw new Error('Attachments are not ready in the composer; no prompt submitted.'); ` : '';
  return `${insideGuard(pathPattern)}const page=browser.page(${pageId}); const snap=await page.snapshot({mode:'interactive'}); if(!inside(snap.url)) throw new Error('ChatGPT left the expected destination; no prompt submitted.'); const editor=snap.refs.find(ref=>ref.role==='textbox' && ${composerName}.test(ref.name)); if(!editor) throw new Error('ChatGPT composer unavailable; check login.'); ${fill}const filled=await page.snapshot({mode:'interactive'}); if(!inside(filled.url)) throw new Error('ChatGPT left the expected destination; no prompt submitted.'); ${staged}const send=filled.refs.find(ref=>ref.role==='button' && /^(Send|Send message|Send prompt)$/i.test(ref.name)); if(!send) throw new Error('Send button unavailable; no prompt submitted.'); await page.click(send.ref); return {url:(await page.snapshot({mode:'interactive'})).url};`;
}
