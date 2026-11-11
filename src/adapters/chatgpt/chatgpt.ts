import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { AssistantAdapter, Logger, Project } from '../../core/contracts.js';
import { parseLocalMcpEndpoint } from '../../infrastructure/loopback.js';
import { isExpiredSession, listPagesPrelude, openMcp, reclaimTabGroup, runScript } from '../browseros/mcp.js';
import { chatgptInspectionScript, composerName, composerReadyScript, settleScript, submitScript } from './dom.js';
import { SingleFlight } from '../../core/single-flight.js';
import { readProjectCatalog } from './projects.js';
import { chatgptReferences, destinationPathPattern, isConversationPage, isDestination, normalizeConversationUrl, normalizeProjectUrl, type Destination } from './references.js';

const pageResult = z.object({ pageId: z.number(), ready: z.boolean(), groupId: z.string() });
const inspection = z.object({ url: z.string(), userId: z.string().nullable(), assistantId: z.string().nullable(), text: z.string(), complete: z.boolean(), busy: z.boolean(), error: z.string().nullable() });
const home = 'https://chatgpt.com/';
/** Upper bound for closing the catalog's scratch tab after the read ended or was cancelled. */
const scratchCleanupMs = 5000;

/**
 * ChatGPT through BrowserOS Neo. A conversation or project reference is its canonical https://chatgpt.com URL, so refs map to the pages the tab visits without translation.
 * One delivery tab lives in one app-owned tab group; project listing uses its own MCP client and scratch tab and never touches delivery state.
 */
export function createChatGPT(options: { endpoint: string; logger: Logger }): AssistantAdapter {
  const endpoint = parseLocalMcpEndpoint(options.endpoint);
  let client: Client | null = null;
  let runName = '';
  let pageId: number | null = null;
  let groupId: string | null = null;
  let session: string | undefined;
  let currentUrl: string | null = null;
  let working = false;
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
    async reply(input): Promise<{ conversationRef: string; text: string }> {
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
        const submit = async () => {
          await ping();
          let navigated = false;
          if (pageId === null) { await openPage(target); navigated = true; }
          else if (!conversationUrl || currentUrl !== target) { await navigate(); navigated = true; }
          let before = await inspect();
          if (!navigated && !isDestination(before.url, destination)) { await navigate(); before = await inspect(); }
          if (!isDestination(before.url, destination)) throw new Error(failure);
          if (before.busy) throw new Error('This conversation is already generating a response.');
          if (before.error) throw new Error(`ChatGPT: ${before.error}`);
          if (pageId === null) throw new Error('ChatGPT tab is not open.');
          const sent = await run(submitScript(pageId, pathPattern, input.text));
          submitted = true;
          await remember(z.object({ url: z.string() }).parse(sent).url);
          return before;
        };
        let before;
        try { before = await submit(); }
        catch (error) {
          if (!isExpiredSession(error) || submitted) throw error;
          reconnected = true; await reconnect(target); before = await submit();
        }
        const deadline = Date.now() + 180000;
        while (Date.now() < deadline) {
          let observed;
          try { observed = await inspect(submittedUserId); }
          catch (error) {
            if (!isExpiredSession(error) || reconnected || !saved) throw error;
            reconnected = true; await reconnect(saved); continue;
          }
          await remember(observed.url);
          if (observed.error) throw new Error(`ChatGPT: ${observed.error}`);
          if (!submittedUserId && observed.userId && observed.userId !== before.userId) submittedUserId = observed.userId;
          if (saved && submittedUserId && observed.userId === submittedUserId && !acknowledged) {
            acknowledged = true;
            await input.onSubmitted();
          }
          if (saved && submittedUserId && observed.userId === submittedUserId && observed.assistantId && observed.complete && !observed.busy && observed.text.trim()) return { conversationRef: saved, text: observed.text };
          await setTimeout(1000);
        }
        throw new Error('ChatGPT response timed out after submission. Inspect the saved conversation; do not resend automatically.');
      } finally { working = false; }
    },
  };
}
