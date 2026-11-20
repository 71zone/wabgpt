import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { NotSentError, type AssistantAdapter, type Attachment, type Logger, type Project, type ReplyBlock } from '../../core/contracts.js';
import { parseLocalMcpEndpoint } from '../../infrastructure/loopback.js';
import type { MediaStore } from '../../infrastructure/media.js';
import { isExpiredSession, listPagesPrelude, openMcp, reclaimTabGroup, runScript } from '../browseros/mcp.js';
import { resolveBlocks } from './assets.js';
import { chatgptInspectionScript, composerAttachmentsScript, composerName, composerReadyScript, revealLatestTurnScript, settleScript, submitScript, uploadScript } from './dom.js';
import { chatgptExtractionScript, extraction } from './extract.js';
import { lostContent } from './coverage.js';
import { SingleFlight } from '../../core/single-flight.js';
import { readProjectCatalog } from './projects.js';
import { chatgptReferences, destinationPathPattern, isConversationPage, isDestination, normalizeConversationUrl, normalizeProjectUrl, type Destination } from './references.js';

const pageResult = z.object({ pageId: z.number(), ready: z.boolean(), groupId: z.string() });
const inspection = z.object({ url: z.string(), userId: z.string().nullable(), assistantId: z.string().nullable(), text: z.string(), complete: z.boolean(), busy: z.boolean(), error: z.string().nullable(), media: z.boolean() });
const composerState = z.object({ tiles: z.number(), uploading: z.number(), error: z.string().nullable() });
const revealState = z.object({ found: z.boolean() });
const home = 'https://chatgpt.com/';
/** Upper bound for closing the catalog's scratch tab after the read ended or was cancelled. */
const scratchCleanupMs = 5000;
/** A submitted prompt is abandoned only after ChatGPT shows no progress (not generating, text unchanged, or unreachable) for this long. */
const IDLE_LIMIT_MS = 5 * 60_000;
/** Absolute ceiling on one reply, however much progress it shows. */
const MAX_WAIT_MS = 60 * 60_000;
/** ChatGPT must finish uploading the attachments of one prompt within this long, or the prompt is not sent. */
const UPLOAD_LIMIT_MS = 3 * 60_000;
const UPLOAD_POLL_MS = 500;

/**
 * ChatGPT through BrowserOS Neo. A conversation or project reference is its canonical https://chatgpt.com URL, so refs map to the pages the tab visits without translation.
 * One delivery tab lives in one app-owned tab group; project listing uses its own MCP client and scratch tab and never touches delivery state.
 */
export function createChatGPT(options: { endpoint: string; logger: Logger; media: MediaStore }): AssistantAdapter {
  const endpoint = parseLocalMcpEndpoint(options.endpoint);
  let client: Client | null = null;
  let runName = '';
  let pageId: number | null = null;
  let groupId: string | null = null;
  let session: string | undefined;
  let currentUrl: string | null = null;
  let working = false;
  let lastRevealFailure = '';
  const catalog = new SingleFlight<Project[]>();

  async function run(code: string): Promise<unknown> {
    if (!client) throw new Error('BrowserOS is not connected.');
    const result = await runScript({ client, runName }, code, session);
    session = result.session;
    return result.value;
  }
  async function disconnect(): Promise<void> {
    const previous = client;
    client = null; session = undefined; runName = '';
    await previous?.close().catch(() => undefined);
  }
  async function connect(): Promise<void> {
    if (client) return;
    const opened = await openMcp(endpoint);
    try {
      runName = opened.runName; client = opened.client;
      const listed = await run(`${listPagesPrelude}return await listPages();`);
      if (pageId !== null && groupId) {
        const pages = z.array(z.object({ pageId: z.number(), groupId: z.string().nullable().optional() })).parse(listed);
        if (pages.some(page => page.pageId === pageId && page.groupId === groupId)) {
          await reclaimTabGroup(opened, groupId);
          const held = await run(`${listPagesPrelude}const pages=await listPages();const held=pages.find(page=>page.pageId===${pageId}&&page.groupId===${JSON.stringify(groupId)});for(const page of pages.filter(page=>page.groupId===${JSON.stringify(groupId)}&&page.ownership!=='user'&&page.url==='about:blank'&&!${JSON.stringify(pages.map(page => page.pageId))}.includes(page.pageId)))await browser.page(page.pageId).close();return held?{pageId:held.pageId,url:held.url}:null;`);
          const recovered = z.object({ pageId: z.number(), url: z.string() }).nullable().parse(held);
          pageId = recovered?.pageId ?? null; currentUrl = recovered?.url ?? null;
        } else { pageId = null; groupId = null; currentUrl = null; }
      }
    } catch (error) { await opened.client.close().catch(() => undefined); client = null; throw error; }
  }
  async function openPage(url: string): Promise<void> {
    const value = await run(`${listPagesPrelude}const page=${pageId === null ? `await browser.open(${JSON.stringify(url)})` : `browser.page(${pageId})`};${pageId !== null && currentUrl !== url ? `await page.goto(${JSON.stringify(url)});` : ''}${settleScript('page', url)}const snapshot=await page.snapshot({mode:'interactive'});const own=(await listPages()).find(item=>item.pageId===page.id);return {pageId:page.id,groupId:own?.groupId,ready:snapshot.refs.some(ref=>ref.role==='textbox'&&${composerName}.test(ref.name))};`);
    const parsed = pageResult.parse(value);
    pageId = parsed.pageId; groupId = parsed.groupId; currentUrl = url;
    if (!parsed.ready) throw new Error('ChatGPT composer not found. Sign in or complete verification in BrowserOS, then check Browser again.');
  }
  async function reconnect(url: string): Promise<void> {
    options.logger('BrowserOS session expired. Reconnecting and reusing the app-owned ChatGPT tab.');
    await disconnect(); await connect(); await openPage(url);
    options.logger('BrowserOS reconnected.');
  }
  async function inspect(targetUserId: string | null = null): Promise<z.infer<typeof inspection>> {
    const value = await run(`const result = await browser.page(${JSON.stringify(pageId)}).evaluateInPage(${chatgptInspectionScript},${JSON.stringify(targetUserId)}); return result.value;`);
    return inspection.parse(value);
  }
  async function composerAttachments(): Promise<z.infer<typeof composerState>> {
    const value = await run(`const result = await browser.page(${JSON.stringify(pageId)}).evaluateInPage(${composerAttachmentsScript}); return result.value;`);
    return composerState.parse(value);
  }
  /** Puts `files` in the composer and waits until ChatGPT has finished uploading every one. Nothing is submitted, so any failure here leaves the prompt unsent. */
  async function attach(files: Attachment[], pathPattern: string): Promise<void> {
    if (pageId === null) throw new Error('ChatGPT tab is not open.');
    try {
      if ((await composerAttachments()).tiles > 0) throw new Error('The ChatGPT composer already holds attachments from an earlier attempt; no prompt submitted.');
      await run(uploadScript(pageId, pathPattern, files.map(file => file.path)));
      const deadline = Date.now() + UPLOAD_LIMIT_MS;
      let steady = 0;
      for (;;) {
        const state = await composerAttachments();
        steady = state.tiles === files.length && state.uploading === 0 ? steady + 1 : 0;
        if (steady >= 2) return;
        if (Date.now() >= deadline) throw new Error(`ChatGPT did not finish uploading ${files.length === 1 ? 'the attachment' : 'the attachments'} (${state.tiles} of ${files.length} present, ${state.uploading} still uploading)${state.error ? `: ${state.error}` : ''}. No prompt submitted.`);
        await setTimeout(UPLOAD_POLL_MS);
      }
    } catch (error) {
      // A failed attempt can leave half-uploaded tiles in the composer, so the next attempt must start from a freshly loaded page.
      currentUrl = null;
      throw error;
    }
  }
  /**
   * Scrolls the conversation to its end so ChatGPT mounts the newest turn, or the turn of `targetUserId`. ChatGPT drops turns that are far from the
   * viewport, including a finished reply in a tab that sits at the top of a long conversation. Best effort: the next inspection reports a real failure.
   */
  async function reveal(targetUserId: string | null): Promise<boolean> {
    if (pageId === null) return false;
    try {
      const value = await run(`const result = await browser.page(${JSON.stringify(pageId)}).evaluateInPage(${revealLatestTurnScript},${JSON.stringify(targetUserId)}); return result.value;`);
      return revealState.parse(value).found;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason !== lastRevealFailure) options.logger(`Could not scroll ChatGPT to its newest message (${reason}).`);
      lastRevealFailure = reason;
      return false;
    }
  }
  /** Display-ordered blocks of the completed reply; any failure to read its structure falls back to the plain text so a finished reply is never lost. */
  async function readBlocks(text: string, targetUserId: string): Promise<ReplyBlock[]> {
    const plain: ReplyBlock[] = text.trim() ? [{ type: 'markdown', text }] : [];
    if (pageId === null) return plain;
    try {
      await reveal(targetUserId);
      const value = await run(`const result = await browser.page(${pageId}).evaluateInPage(${chatgptExtractionScript},${JSON.stringify(targetUserId)}); return result.value;`);
      const blocks = await resolveBlocks(extraction.parse(value), { run, pageId, media: options.media, logger: options.logger });
      if (blocks.length === 0) return plain;
      if (lostContent(blocks, text)) {
        options.logger("ChatGPT's reply lost content when its structure was read; delivering its plain text.");
        return [...plain, ...blocks.filter(block => block.type === 'attachment')];
      }
      return blocks;
    } catch (error) {
      options.logger(`Could not read the structure of ChatGPT's reply (${error instanceof Error ? error.message : String(error)}); delivering its plain text.`);
      return plain;
    }
  }
  async function ping(): Promise<void> {
    if (!client) throw new Error('BrowserOS is not connected.');
    await client.ping({ timeout: 10000 });
  }

  // The catalog uses its own MCP client and temporary tab: delivery state (client, session, pageId, currentUrl, working) is never read or written.
  // `signal` is the catalog's own controller signal. It cancels every request and wait; the cleanup below never uses it (it is already aborted), and instead
  // runs on a fresh bounded signal so a hung browser cannot hold the caller. Closing the independent client in finally also aborts any HTTP exchange the
  // SDK abandoned when a request was cancelled, so no provider work outlives this function.
  async function readCatalog(signal: AbortSignal): Promise<Project[]> {
    const connection = await openMcp(endpoint, signal);
    let handle: string | undefined;
    const call = async (code: string, callSignal?: AbortSignal): Promise<unknown> => {
      const result = await runScript(connection, code, handle, callSignal);
      handle = result.session;
      return result.value;
    };
    let scratch: number | null = null;
    try {
      scratch = z.number().parse(await call(`const page=await browser.open('${home}');return page.id;`, signal));
      return await readProjectCatalog(call, scratch, options.logger, signal);
    } catch (error) {
      throw signal.aborted ? signal.reason : error;
    } finally {
      try { if (scratch !== null) await call(`await browser.page(${scratch}).close();return true;`, AbortSignal.timeout(scratchCleanupMs)); }
      catch (error) { options.logger(`Could not close the temporary ChatGPT tab used for the project list: ${error instanceof Error ? error.message : String(error)}`); }
      await connection.client.close().catch(() => undefined);
    }
  }

  return {
    references: chatgptReferences,
    async start(): Promise<void> {
      for (let attempt = 0; ; attempt++) {
        try {
          await connect(); await ping();
          if (working) { options.logger('BrowserOS is reachable. ChatGPT is processing the current message.'); return; }
          if (pageId === null) await openPage(home);
          else {
            const ready = await run(composerReadyScript(pageId));
            if (ready !== true) throw new Error('ChatGPT composer unavailable. Check sign-in in BrowserOS.');
          }
          options.logger('Connected to BrowserOS Neo; ChatGPT composer is available.');
          return;
        } catch (error) {
          if (!isExpiredSession(error) || attempt > 0 || working) throw error;
          options.logger('BrowserOS session expired. Establishing a new MCP connection.');
          await disconnect();
        }
      }
    },
    async stop(): Promise<void> {
      catalog.cancel(new Error('ChatGPT adapter stopped.'));
      await catalog.drained();
      if (!client) return;
      try { if (pageId !== null) await run(`await browser.page(${pageId}).close(); return true;`); }
      catch (error) {
        if (!isExpiredSession(error)) throw error;
        await disconnect(); await connect();
        if (pageId !== null) await run(`await browser.page(${pageId}).close(); return true;`);
      } finally { await disconnect(); pageId = null; groupId = null; currentUrl = null; }
    },
    listProjects(signal?: AbortSignal): Promise<Project[]> { return catalog.join(readCatalog, signal); },
    async reply(input): Promise<{ conversationRef: string; text: string; blocks?: ReplyBlock[] }> {
      if (working) throw new Error('Browser adapter is already processing a message.');
      working = true;
      let reconnected = false;
      let submitted = false;
      let acknowledged = false;
      let submittedUserId: string | null = null;
      let saved: string | null = null;
      try {
        if (!client) throw new Error('Connect BrowserOS first.');
        const projectUrl = input.projectRef === null ? null : normalizeProjectUrl(input.projectRef);
        const conversationUrl = input.conversationRef === null ? null : normalizeConversationUrl(input.conversationRef, projectUrl);
        const destination: Destination = { conversationUrl, projectUrl };
        const pathPattern = destinationPathPattern(destination);
        const target = conversationUrl ?? projectUrl ?? home;
        saved = conversationUrl;
        const failure = conversationUrl
          ? 'Saved conversation did not load. Restore access rather than creating a replacement.'
          : projectUrl ? 'The assigned ChatGPT project did not load (missing, renamed away, or redirected). No prompt submitted.' : 'ChatGPT did not open a new conversation page. No prompt submitted.';
        const remember = async (url: string): Promise<void> => {
          if (!isConversationPage(url)) return;
          let conversation: string;
          try { conversation = normalizeConversationUrl(url, projectUrl); }
          catch { throw new Error('ChatGPT opened a conversation outside the assigned scope.'); }
          if (saved && conversation !== saved) throw new Error('ChatGPT switched conversations unexpectedly.');
          if (!saved) { await input.onConversation(conversation); saved = conversation; }
          currentUrl = conversation;
        };
        const navigate = async (): Promise<void> => {
          await run(`const page=browser.page(${pageId}); await page.goto(${JSON.stringify(target)});${settleScript('page', target)} return true;`);
          currentUrl = target;
        };
        let attempting = false;
        const submit = async () => {
          attempting = false;
          await ping();
          let navigated = false;
          if (pageId === null) { await openPage(target); navigated = true; }
          else if (!conversationUrl || currentUrl !== target) { await navigate(); navigated = true; }
          // A freshly loaded long conversation starts at its top, where the newest turn is not mounted: bring it into view so the first read sees the real latest turn.
          if (conversationUrl) await reveal(null);
          let before = await inspect();
          if (!navigated && !isDestination(before.url, destination)) { await navigate(); before = await inspect(); }
          if (!isDestination(before.url, destination)) throw new Error(failure);
          if (before.busy) throw new Error('This conversation is already generating a response.');
          if (before.error) throw new Error(`ChatGPT: ${before.error}`);
          if (pageId === null) throw new Error('ChatGPT tab is not open.');
          if (input.attachments.length > 0) await attach(input.attachments, pathPattern);
          attempting = true;
          const sent = await run(submitScript(pageId, pathPattern, input.text, input.attachments.length));
          submitted = true;
          await remember(z.object({ url: z.string() }).parse(sent).url);
          return before;
        };
        let before;
        try {
          try { before = await submit(); }
          catch (error) {
            if (!isExpiredSession(error) || submitted) throw error;
            reconnected = true; await reconnect(target); before = await submit();
          }
        } catch (error) {
          // Files staged in the composer would ride along with whatever is sent from this page next, so a failure before submission discards the page state.
          if (input.attachments.length > 0 && !submitted) currentUrl = null;
          // Nothing reached ChatGPT unless the submit click itself was attempted, so the bridge may safely try this same message again.
          if (attempting || submitted || error instanceof NotSentError) throw error;
          throw new NotSentError(error instanceof Error ? error.message : String(error), { cause: error });
        }
        // Wait for as long as ChatGPT makes progress. A slow answer (long thinking, long generation) is not a failure, and a dropped BrowserOS
        // connection is retried rather than abandoned; only a page that stays silent for IDLE_LIMIT_MS, or the absolute ceiling, gives up.
        const startedAt = Date.now();
        let lastProgress = startedAt;
        let lastText = '';
        let lastFailure: unknown;
        let lastSeen = '';
        let failures = 0;
        let pinned = false;
        while (Date.now() - startedAt < MAX_WAIT_MS) {
          let observed;
          try { observed = await inspect(submittedUserId); failures = 0; }
          catch (error) {
            if (Date.now() - lastProgress >= IDLE_LIMIT_MS) throw error;
            lastFailure = error; failures++;
            if (failures === 1 || failures % 10 === 0) options.logger(`Lost contact with ChatGPT (${error instanceof Error ? error.message : String(error)}); retrying. The submitted message is not resent.`);
            await setTimeout(Math.min(1000 * failures, 10000));
            try { if ((isExpiredSession(error) || !client) && saved) await reconnect(saved); } catch (reconnectError) { lastFailure = reconnectError; }
            continue;
          }
          await remember(observed.url);
          if (observed.error) throw new Error(`ChatGPT: ${observed.error}`);
          if (!submittedUserId && observed.userId && observed.userId !== before.userId) submittedUserId = observed.userId;
          const present = submittedUserId !== null && observed.userId === submittedUserId;
          if (saved && present && !acknowledged) {
            acknowledged = true;
            await input.onSubmitted();
          }
          if (saved && submittedUserId && present && observed.assistantId && observed.complete && !observed.busy && (observed.text.trim() || observed.media)) return { conversationRef: saved, text: observed.text, blocks: await readBlocks(observed.text, submittedUserId) };
          if (observed.busy || observed.text !== lastText) { lastProgress = Date.now(); lastText = observed.text; }
          if (Date.now() - lastProgress >= IDLE_LIMIT_MS) break;
          // ChatGPT drops a finished turn that is far from the viewport (or leaves an empty shell of it), and the reply can no longer be read. Scroll to the
          // newest turn once the message is on the page so it stays mounted, and again whenever it goes missing. A message that never shows up at all gets
          // one scroll too, since its turn may simply not be mounted yet.
          const hollow = present && observed.complete && !observed.busy && !observed.text.trim() && !observed.media;
          lastSeen = !present ? 'the submitted message is not on the ChatGPT page' : hollow ? 'the reply has no text on the page' : !observed.complete ? 'ChatGPT has not marked the reply complete' : '';
          const missing = submittedUserId !== null && (!present || hollow);
          const unseen = submittedUserId === null && Date.now() - startedAt >= 5000;
          if (missing || (!pinned && (submittedUserId !== null || unseen))) {
            pinned = true;
            await reveal(submittedUserId);
            await setTimeout(250);
            continue;
          }
          await setTimeout(1000);
        }
        const reason = lastFailure instanceof Error ? ` Last error: ${lastFailure.message}` : '';
        const seen = lastSeen ? ` Last seen: ${lastSeen}.` : '';
        throw new Error(`ChatGPT response timed out after submission (no progress for ${Math.round(IDLE_LIMIT_MS / 60000)} minutes or over ${Math.round(MAX_WAIT_MS / 60000)} minutes total).${reason}${seen} Inspect the saved conversation; do not resend automatically.`);
      } finally { working = false; }
    },
  };
}
