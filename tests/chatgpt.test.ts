import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { runInNewContext } from 'node:vm';
import { z } from 'zod';
import { parseHTML } from 'linkedom';
import { createChatGPT } from '../src/adapters/chatgpt/chatgpt.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { Application } from '../src/core/application.js';
import { fakeChannel, loadState, providerNames, withDirectory } from './support/core-fixtures.js';

const rpcSchema = z.object({ id: z.union([z.number(), z.string()]).optional(), method: z.string(), params: z.object({ name: z.string().optional(), arguments: z.object({ code: z.string().optional(), action: z.string().optional(), groupId: z.string().optional(), url: z.string().optional() }).passthrough().optional() }).passthrough().optional() });

const projectA = 'g-p-00000000000000000000000000000001';
const projectB = 'g-p-00000000000000000000000000000002';
const urlA = `https://chatgpt.com/g/${projectA}`;
const urlB = `https://chatgpt.com/g/${projectB}`;

interface Sidebar {
  projects: { id: string; name: string }[]; limit: number | null; revealed: boolean; collapsed: boolean; signedOut: boolean; hydrateAfter: number; reads: number;
  explorerCount: number | null; chatMoreClicks: number; recentsMoreClicks: number; toggles: number; signOutOnToggle: boolean;
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

// The same DOM shape ChatGPT renders: a Projects section (toggle, one container per project, an optional section-level "Show more"), a Recents section with its own "Show more", and the /projects explorer rows.
function runCatalogScript(state: State, script: string, mode: unknown, url: string): unknown {
  const sidebar = state.sidebar;
  const explorer = script.includes('data-project-row');
  if (!explorer && mode === 'read') sidebar.reads++;
  const hidden = sidebar.limit !== null && !sidebar.revealed && sidebar.projects.length > sidebar.limit;
  const visible = sidebar.collapsed || sidebar.reads <= sidebar.hydrateAfter ? [] : hidden ? sidebar.projects.slice(0, sidebar.limit ?? 0) : sidebar.projects;
  const count = sidebar.explorerCount ?? sidebar.projects.length;
  const html = `<h1>Projects</h1><nav>${sidebar.signedOut ? '<a data-testid="login-button">Log in</a>' : ''}<section data-app-action-sidebar-section-heading="Projects"><button data-app-action-sidebar-section-toggle aria-expanded="${!sidebar.collapsed}">Projects</button>`
    + visible.map(project => `<div data-sidebar-project-kind="local" data-sidebar-project-container-id="project:${project.id}"><div role="button" data-app-action-sidebar-project-id="${project.id}" data-app-action-sidebar-project-label="${escapeHtml(project.name)}">${escapeHtml(project.name)}</div><button data-chat-more>Show more</button></div>`).join('')
    + `${hidden && visible.length ? '<button data-section-more>Show more</button>' : ''}</section><section data-app-action-sidebar-section-heading="Recents"><button data-app-action-sidebar-section-toggle aria-expanded="true">Recents</button><button data-recents-more>Show more</button></section></nav>`
    + `<main><div data-projects-rows><div data-project-row="true"><button>Locked chats</button></div>${Array.from({ length: count }, (_, index) => `<div data-project-row="true"><button>Toggle project</button><button>Project actions for P${index}</button><button>Pin project</button><button>Start new chat in project</button></div>`).join('')}</div></main>`;
  const { document } = parseHTML(html);
  document.querySelector('[data-section-more]')?.addEventListener('click', () => { sidebar.revealed = true; });
  for (const button of Array.from(document.querySelectorAll('[data-chat-more]'))) button.addEventListener('click', () => { sidebar.chatMoreClicks++; });
  document.querySelector('[data-recents-more]')?.addEventListener('click', () => { sidebar.recentsMoreClicks++; });
  // The collapse state is account-wide presentation state shared by every tab, so it lives on the fixture rather than on a page.
  document.querySelector('section[data-app-action-sidebar-section-heading="Projects"] [data-app-action-sidebar-section-toggle]')?.addEventListener('click', () => { sidebar.collapsed = !sidebar.collapsed; sidebar.toggles++; if (sidebar.signOutOnToggle) sidebar.signedOut = true; });
  return runInNewContext(`(${script})(${JSON.stringify(mode)})`, { document, location: { href: url } });
}
interface State {
  initializations: number; submissions: number; disconnectOnSubmit: boolean; expireAfterSubmit: boolean; complete: boolean; initialTurns: number;
  reclaimedGroups: number; chatgptTabsOpened: number; opened: string[]; groupIdsOmitted: boolean; tabGroupListings: number;
  navigations: string[]; waits: string[]; submittedAt: string[]; conversations: number;
  /** When set, the sidebar read request is accepted and then never answered; `blockedClosed` counts those exchanges the client later aborted. */
  blockSidebarReads: boolean; blocked: number; blockedClosed: number;
  projects: Set<string>; redirects: Map<string, string>; slugConversations: boolean; driftAfterInspect: string | null; driftOnObserve: string | null;
  sidebar: Sidebar;
}
interface Fixture { endpoint: string; expire(): void; tabs(): string[]; moveTabs(url: string): void; state: State }

async function withServer(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const opened: string[] = [];
  const state: State = {
    initializations: 0, submissions: 0, disconnectOnSubmit: false, expireAfterSubmit: false, complete: true, initialTurns: 0, reclaimedGroups: 0, chatgptTabsOpened: 0, opened, groupIdsOmitted: false, tabGroupListings: 0,
    navigations: [], waits: [], submittedAt: [], conversations: 0, blockSidebarReads: false, blocked: 0, blockedClosed: 0, projects: new Set([projectA, projectB]), redirects: new Map(), slugConversations: false, driftAfterInspect: null, driftOnObserve: null,
    sidebar: { projects: [], limit: null, revealed: false, collapsed: false, signedOut: false, hydrateAfter: 0, reads: 0, explorerCount: null, chatMoreClicks: 0, recentsMoreClicks: 0, toggles: 0, signOutOnToggle: false },
  };
  const sessions = new Set<string>();
  const counts = new Map<string, number>();
  const landing = /^(https:\/\/chatgpt\.com\/g\/g-p-[0-9a-f]{32})(?:-[a-z]+)?\/project$/;
  let nextPage = 0;
  let disconnectCurrent = (): void => {};
  const pages = new Map<number, { id: number; owner: string; groupId: string; readonly url: string; move(url: string): void; goto(url: string): Promise<void>; waitForSelector(selector: string, options?: unknown): Promise<void>; snapshot(): Promise<unknown>; fill(ref: string, value: string): Promise<void>; click(ref: string): Promise<void>; evaluateInPage(fn: unknown, target?: string | null): Promise<unknown>; close(): Promise<void> }>();
  // What ChatGPT does with a navigation: canonicalize project landings, send missing projects home, or follow a scripted redirect.
  const resolve = (target: string): string => {
    const scripted = state.redirects.get(target);
    if (scripted) return scripted;
    const project = /^https:\/\/chatgpt\.com\/g\/(g-p-[0-9a-f]{32})(\/c\/[A-Za-z0-9-]+)?$/.exec(target);
    if (!project?.[1]) return target;
    if (!state.projects.has(project[1])) return 'https://chatgpt.com/';
    if (project[2]) return state.slugConversations ? `https://chatgpt.com/g/${project[1]}-example${project[2]}` : target;
    return `https://chatgpt.com/g/${project[1]}-example/project`;
  };
  const createPage = (target: string, owner: string) => {
    const id = ++nextPage;
    let url = resolve(target);
    state.opened.push(target);
    if (target.startsWith('https://chatgpt.com/')) state.chatgptTabsOpened++;
    const page = {
      id, owner, groupId: 'app-group', get url() { return url; },
      move: (next: string) => { url = next; },
      goto: async (next: string) => { url = resolve(next); state.opened.push(next); state.navigations.push(next); },
      waitForSelector: async (selector: string) => { state.waits.push(selector); },
      snapshot: async () => ({ url, refs: [{ role: 'textbox', name: /\/project$/.test(url) ? 'New chat in Example' : 'Ask ChatGPT', ref: 'editor' }, { role: 'button', name: 'Send', ref: 'send' }] }),
      fill: async (_ref: string, _value: string) => {},
      click: async () => {
        state.submissions++; state.submittedAt.push(url);
        if (url === 'https://chatgpt.com/') url = `https://chatgpt.com/c/new-conversation-${++state.conversations}`;
        else {
          const landed = landing.exec(url);
          if (landed) url = `${landed[1]}${state.slugConversations ? '-example' : ''}/c/new-conversation-${++state.conversations}`;
        }
        state.opened.push(url); counts.set(url, (counts.get(url) ?? state.initialTurns) + 1);
        if (state.disconnectOnSubmit) disconnectCurrent();
        if (state.expireAfterSubmit) { sessions.clear(); state.expireAfterSubmit = false; }
      },
      evaluateInPage: async (fn: unknown, targetUser?: unknown) => {
        const source = String(fn);
        if (source.includes('data-app-action-sidebar-project-id') || source.includes('data-project-row')) return { value: runCatalogScript(state, source, targetUser, url) };
        if (state.driftOnObserve && state.submissions > 0) { url = state.driftOnObserve; state.driftOnObserve = null; }
        const count = counts.get(url) ?? state.initialTurns;
        const userId = count ? `user-${count}` : null;
        const matched = !targetUser || targetUser === userId;
        const value = { url, users: Math.min(count, 5), assistants: Math.min(state.complete ? count : Math.max(0, count - 1), 5), userId: matched ? userId : null, assistantId: matched && count && state.complete ? `assistant-${count}` : null, text: matched && state.complete && count ? 'Completed response' : '', complete: matched && state.complete, busy: !state.complete && count > 0, error: null };
        if (state.driftAfterInspect) { url = state.driftAfterInspect; state.driftAfterInspect = null; }
        return { value };
      },
      close: async () => { pages.delete(id); },
    };
    pages.set(id, page); return page;
  };
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET') { response.writeHead(405).end(); return; }
      if (request.method === 'DELETE') { response.writeHead(200).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const rpc = rpcSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
      const header = request.headers['mcp-session-id'];
      const sessionId = typeof header === 'string' ? header : undefined;
      if (rpc.method !== 'initialize' && (!sessionId || !sessions.has(sessionId))) {
        response.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found: Session not found'); return;
      }
      if (rpc.id === undefined) { response.writeHead(202).end(); return; }
      let result: unknown;
      if (rpc.method === 'initialize') {
        const id = `session-${++state.initializations}`; sessions.add(id);
        response.setHeader('mcp-session-id', id);
        result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'browseros-neo', version: 'test' } };
      } else if (rpc.method === 'ping') result = {};
      else if (rpc.method === 'tools/list') result = { tools: ['run', 'tabs'].map(name => ({ name, description: name, inputSchema: { type: 'object', additionalProperties: true } })) };
      else if (rpc.method === 'tools/call') {
        if (!sessionId) throw new Error('No MCP session');
        if (rpc.params?.name === 'tabs') {
          if (rpc.params.arguments?.action !== 'new' || rpc.params.arguments.groupId !== 'app-group') throw new Error('Invalid group recovery');
          createPage('about:blank', sessionId); state.reclaimedGroups++;
          result = { content: [{ type: 'text', text: 'Group reclaimed' }] };
        } else {
          const code = rpc.params?.arguments?.code;
          if (!code) throw new Error('Missing script');
          if (state.blockSidebarReads && code.includes('data-app-action-sidebar-project-id')) {
            state.blocked++;
            response.once('close', () => { state.blockedClosed++; });
            return;
          }
          disconnectCurrent = () => { request.socket.destroy(); };
          const browser = {
            pages: { list: async () => [...pages.values()].map(page => ({ pageId: page.id, url: page.url, ...(state.groupIdsOmitted ? {} : { groupId: page.groupId }), ownership: page.owner === sessionId ? 'mine' : 'other-agent' })) },
            // The official Docker image reports membership only here, never on the page records.
            tabGroups: async (options: { action: string }) => {
              if (options.action !== 'list') throw new Error('Unexpected tab group action');
              state.tabGroupListings++;
              const pageIds = [...pages.values()].map(page => page.id);
              return { count: pageIds.length ? 1 : 0, groups: pageIds.length ? [{ groupId: 'app-group', pageIds }] : [] };
            },
            open: async (url: string) => { state.navigations.push(url); return createPage(url, sessionId); },
            page: (id: number) => { const page = pages.get(id); if (!page) throw new Error('Unknown page'); return page; },
          };
          const value: unknown = await runInNewContext(`(async () => { ${code} })()`, { browser });
          result = { content: [{ type: 'text', text: JSON.stringify({ ok: true, value }) }], structuredContent: { ok: true, value } };
        }
      } else throw new Error(`Unexpected method: ${rpc.method}`);
      if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) { if (!response.destroyed) response.writeHead(500).end(error instanceof Error ? error.message : String(error)); }
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  try { await run({ endpoint: `http://127.0.0.1:${address.port}/mcp`, expire: () => sessions.clear(), tabs: () => [...pages.values()].map(page => page.url), moveTabs: url => { for (const page of pages.values()) page.move(url); }, state }); }
  finally {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(error => error ? closed.reject(error) : closed.resolve());
    await closed.promise;
  }
}

const quiet = { onConversation: async (): Promise<void> => {}, onSubmitted: async (): Promise<void> => {} };

test('expired MCP sessions reconnect before submission and keep the saved conversation', async () => {
  await withServer(async fixture => {
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    try {
      await browser.start(); fixture.expire();
      const reply = await browser.reply({ conversationRef: 'https://chatgpt.com/c/existing', projectRef: null, text: 'A new message', ...quiet });
      assert.equal(reply.conversationRef, 'https://chatgpt.com/c/existing');
      assert.equal(fixture.state.initializations, 2);
      assert.equal(fixture.state.submissions, 1);
      assert.equal(fixture.state.chatgptTabsOpened, 1);
      assert.equal(fixture.state.reclaimedGroups, 1);
      assert.deepEqual(fixture.tabs(), ['https://chatgpt.com/c/existing']);
    } finally { await browser.stop().catch(() => undefined); }
  });
});

test('a lost response after submitting never causes another submission', async () => {
  await withServer(async fixture => {
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    let acknowledgements = 0;
    try {
      await browser.start(); fixture.state.disconnectOnSubmit = true;
      await assert.rejects(browser.reply({ conversationRef: 'https://chatgpt.com/c/existing', projectRef: null, text: 'Send once', onConversation: async () => {}, onSubmitted: async () => { acknowledgements++; } }));
      assert.equal(fixture.state.submissions, 1);
      assert.equal(fixture.state.initializations, 1);
      assert.equal(acknowledgements, 0);
    } finally { await browser.stop().catch(() => undefined); }
  });
});

test('session expiry during observation reopens the known conversation without resubmitting', async () => {
  await withServer(async fixture => {
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    try {
      await browser.start(); fixture.state.expireAfterSubmit = true;
      const reply = await browser.reply({ conversationRef: 'https://chatgpt.com/c/existing', projectRef: null, text: 'Send once', ...quiet });
      assert.equal(reply.conversationRef, 'https://chatgpt.com/c/existing');
      assert.equal(fixture.state.submissions, 1);
      assert.equal(fixture.state.initializations, 2);
      assert.equal(fixture.state.chatgptTabsOpened, 1);
      assert.deepEqual(fixture.tabs(), ['https://chatgpt.com/c/existing']);
    } finally { await browser.stop().catch(() => undefined); }
  });
});

test('prompt acceptance is acknowledged once before the assistant response completes', async () => {
  await withServer(async fixture => {
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    let acknowledgements = 0;
    try {
      await browser.start(); fixture.state.complete = false;
      const reply = await browser.reply({
        conversationRef: 'https://chatgpt.com/c/existing', projectRef: null, text: 'Accept before generating',
        onConversation: async () => {},
        onSubmitted: async () => {
          assert.equal(fixture.state.complete, false);
          acknowledgements++;
          fixture.state.complete = true;
        },
      });
      assert.equal(acknowledgements, 1);
      assert.equal(fixture.state.submissions, 1);
      assert.equal(reply.text, 'Completed response');
    } finally { await browser.stop().catch(() => undefined); }
  });
});

test('a completed response is returned when the virtualized conversation has already filled its rendered window', { timeout: 5000 }, async () => {
  await withServer(async fixture => {
    fixture.state.initialTurns = 5;
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    let accepted = 0;
    try {
      await browser.start();
      const reply = await browser.reply({
        conversationRef: 'https://chatgpt.com/c/existing', projectRef: null, text: 'New turn in a full window',
        onConversation: async () => {}, onSubmitted: async () => { accepted++; },
      });
      assert.equal(reply.text, 'Completed response');
      assert.equal(accepted, 1);
      assert.equal(fixture.state.submissions, 1);
    } finally { await browser.stop().catch(() => undefined); }
  });
});

test('a new chat for a project starts at the project landing, waits for the composer and persists the scoped conversation', async () => {
  await withServer(async fixture => {
    fixture.state.slugConversations = true;
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    const saved: string[] = [];
    try {
      await browser.start();
      const reply = await browser.reply({ conversationRef: null, projectRef: `${urlA}-example/project?utm=1#top`, text: 'Hello project', onConversation: async url => { saved.push(url); }, onSubmitted: async () => {} });
      assert.equal(fixture.state.navigations.at(-1), urlA);
      assert.deepEqual(fixture.state.waits, ['[contenteditable="true"][role="textbox"]']);
      assert.deepEqual(fixture.state.submittedAt, [`${urlA}-example/project`]);
      assert.equal(reply.conversationRef, `${urlA}/c/new-conversation-1`);
      assert.deepEqual(saved, [`${urlA}/c/new-conversation-1`]);
      assert.equal(fixture.state.chatgptTabsOpened, 1);
      assert.equal(reply.text, 'Completed response');
    } finally { await browser.stop().catch(() => undefined); }
  });
});

test('a saved project conversation is reused without navigation, recovered when the tab moved, and rotation returns to the landing', async () => {
  await withServer(async fixture => {
    fixture.state.slugConversations = true;
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    const saved: string[] = [];
    const remember = async (url: string): Promise<void> => { saved.push(url); };
    try {
      await browser.start();
      const first = await browser.reply({ conversationRef: null, projectRef: urlA, text: 'one', onConversation: remember, onSubmitted: async () => {} });
      const navigations = fixture.state.navigations.length;
      const second = await browser.reply({ conversationRef: first.conversationRef, projectRef: urlA, text: 'two', onConversation: remember, onSubmitted: async () => {} });
      assert.equal(second.conversationRef, first.conversationRef);
      assert.equal(fixture.state.navigations.length, navigations, 'the slug-canonicalized tab is already the saved conversation');
      fixture.moveTabs('https://chatgpt.com/c/elsewhere');
      const third = await browser.reply({ conversationRef: first.conversationRef, projectRef: urlA, text: 'three', onConversation: remember, onSubmitted: async () => {} });
      assert.equal(third.conversationRef, first.conversationRef);
      assert.equal(fixture.state.navigations.at(-1), first.conversationRef);
      assert.equal(fixture.state.submissions, 3);
      assert.deepEqual(saved, [first.conversationRef]);
      const rotated = await browser.reply({ conversationRef: null, projectRef: urlA, text: 'fresh', onConversation: remember, onSubmitted: async () => {} });
      assert.equal(fixture.state.navigations.at(-1), urlA);
      assert.notEqual(rotated.conversationRef, first.conversationRef);
      assert.match(rotated.conversationRef, new RegExp(`^${urlA}/c/new-conversation-2$`));
      assert.equal(fixture.state.submissions, 4);
      assert.equal(fixture.state.chatgptTabsOpened, 1);
      assert.deepEqual(saved, [first.conversationRef, rotated.conversationRef]);
    } finally { await browser.stop().catch(() => undefined); }
  });
});

test('rotation to a fresh conversation navigates to the landing even when the tracked tab URL is stale', async () => {
  await withServer(async fixture => {
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    try {
      await browser.start();
      await browser.reply({ conversationRef: null, projectRef: null, text: 'one', ...quiet });
      fixture.moveTabs('https://chatgpt.com/c/some-old-chat');
      const before = fixture.state.navigations.length;
      const fresh = await browser.reply({ conversationRef: null, projectRef: null, text: 'two', ...quiet });
      assert.equal(fixture.state.navigations.length, before + 1);
      assert.equal(fixture.state.navigations.at(-1), 'https://chatgpt.com/');
      assert.equal(fresh.conversationRef, 'https://chatgpt.com/c/new-conversation-2');
    } finally { await browser.stop().catch(() => undefined); }
  });
});

for (const [name, redirect] of [
  ['another project', `${urlB}-other/project`],
  ['the ChatGPT home page', 'https://chatgpt.com/'],
  ['a standalone conversation', 'https://chatgpt.com/c/standalone'],
  ['a project conversation instead of the landing', `${urlA}/c/existing`],
] as const) {
  test(`a project landing that redirects to ${name} is never submitted to`, async () => {
    await withServer(async fixture => {
      const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
      try {
        await browser.start();
        fixture.state.redirects.set(urlA, redirect);
        await assert.rejects(browser.reply({ conversationRef: null, projectRef: urlA, text: 'Never sent', ...quiet }), /project did not load/);
        assert.equal(fixture.state.submissions, 0);
        assert.equal(fixture.state.chatgptTabsOpened, 1);
      } finally { await browser.stop().catch(() => undefined); }
    });
  });
}

test('a deleted project that falls back to the home page is never submitted to', async () => {
  await withServer(async fixture => {
    fixture.state.projects.delete(projectA);
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    try {
      await assert.rejects(browser.start().then(() => browser.reply({ conversationRef: null, projectRef: urlA, text: 'Never sent', ...quiet })), /project did not load/);
      assert.equal(fixture.state.submissions, 0);
    } finally { await browser.stop().catch(() => undefined); }
  });
});

test('a saved project conversation that redirects elsewhere is never submitted to', async () => {
  await withServer(async fixture => {
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    try {
      await browser.start();
      fixture.state.redirects.set(`${urlA}/c/existing`, `${urlB}-other/project`);
      await assert.rejects(browser.reply({ conversationRef: `${urlA}/c/existing`, projectRef: urlA, text: 'Never sent', ...quiet }), /Saved conversation did not load/);
      assert.equal(fixture.state.submissions, 0);
    } finally { await browser.stop().catch(() => undefined); }
  });
});

test('a tab that leaves the project between inspection and sending is never submitted to', async () => {
  await withServer(async fixture => {
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    try {
      await browser.start();
      fixture.state.driftAfterInspect = 'https://chatgpt.com/';
      await assert.rejects(browser.reply({ conversationRef: null, projectRef: urlA, text: 'Never sent', ...quiet }));
      assert.equal(fixture.state.submissions, 0);
    } finally { await browser.stop().catch(() => undefined); }
  });
});

for (const [name, projectRef, scope] of [['project', urlA, urlA], ['standalone', null, 'https://chatgpt.com']] as const) {
  test(`the first persisted ${name} conversation stays pinned when the tab drifts to another conversation in the same scope`, async () => {
    await withServer(async fixture => {
      const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
      const saved: string[] = [];
      let acknowledgements = 0;
      try {
        await browser.start();
        fixture.state.driftOnObserve = `${scope}/c/unrelated-chat`;
        await assert.rejects(browser.reply({ conversationRef: null, projectRef, text: 'Pinned', onConversation: async url => { saved.push(url); }, onSubmitted: async () => { acknowledgements++; } }), /switched conversations/);
        assert.deepEqual(saved, [`${scope}/c/new-conversation-1`]);
        assert.equal(acknowledgements, 0);
        assert.equal(fixture.state.submissions, 1);
      } finally { await browser.stop().catch(() => undefined); }
    });
  });
}

test('project conversations recover from expired MCP sessions before and after submission without replay or extra tabs', async () => {
  await withServer(async fixture => {
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    const conversation = `${urlA}/c/existing`;
    try {
      await browser.start(); fixture.expire();
      const before = await browser.reply({ conversationRef: conversation, projectRef: urlA, text: 'Expired before sending', ...quiet });
      assert.equal(before.conversationRef, conversation);
      assert.equal(fixture.state.submissions, 1);
      assert.equal(fixture.state.initializations, 2);
      assert.equal(fixture.state.reclaimedGroups, 1);
      assert.equal(fixture.state.chatgptTabsOpened, 1);
      fixture.state.expireAfterSubmit = true;
      const after = await browser.reply({ conversationRef: conversation, projectRef: urlA, text: 'Expired while waiting', ...quiet });
      assert.equal(after.conversationRef, conversation);
      assert.equal(fixture.state.submissions, 2);
      assert.equal(fixture.state.initializations, 3);
      assert.equal(fixture.state.chatgptTabsOpened, 1);
      assert.deepEqual(fixture.tabs(), [conversation]);
    } finally { await browser.stop().catch(() => undefined); }
  });
});

test('a new project chat survives an expired MCP session before submission with a single submission and tab', async () => {
  await withServer(async fixture => {
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    try {
      await browser.start(); fixture.expire();
      const reply = await browser.reply({ conversationRef: null, projectRef: urlA, text: 'Fresh project chat', ...quiet });
      assert.equal(reply.conversationRef, `${urlA}/c/new-conversation-1`);
      assert.equal(fixture.state.submissions, 1);
      assert.equal(fixture.state.initializations, 2);
      assert.equal(fixture.state.chatgptTabsOpened, 1);
      assert.deepEqual(fixture.state.submittedAt, [`${urlA}-example/project`]);
    } finally { await browser.stop().catch(() => undefined); }
  });
});

test('malformed, hostile or wrong-project URLs are rejected before the browser is touched', async () => {
  await withServer(async fixture => {
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    try {
      await browser.start();
      const navigations = [...fixture.state.navigations];
      const rejected: [string | null, string | null][] = [
        ['https://evil.example/c/abc', null],
        ['https://chatgpt.com.evil.example/c/abc', null],
        ['http://chatgpt.com/c/abc', null],
        ['https://user:pw@chatgpt.com/c/abc', null],
        ['https://chatgpt.com:8443/c/abc', null],
        ['https://chatgpt.com/c/abc/../../x', null],
        [`${urlA}/c/abc`, null],
        ['https://chatgpt.com/c/abc', urlA],
        [`${urlB}/c/abc`, urlA],
        ['https://chatgpt.com/g/g-arbitrary/c/abc', urlA],
        [null, 'https://chatgpt.com/g/g-arbitrary'],
        [null, 'https://evil.example/g/' + projectA],
        [null, `https://user@chatgpt.com/g/${projectA}`],
        [null, 'https://chatgpt.com/c/abc'],
        [null, 'https://chatgpt.com/g/g-p-123'],
      ];
      for (const [conversationRef, projectRef] of rejected) {
        await assert.rejects(browser.reply({ conversationRef, projectRef, text: 'Never sent', ...quiet }), Error, `${conversationRef} / ${projectRef}`);
      }
      assert.equal(fixture.state.submissions, 0);
      assert.deepEqual(fixture.state.navigations, navigations);
    } finally { await browser.stop().catch(() => undefined); }
  });
});

const projectId = (digit: string): string => `g-p-${digit.repeat(32)}`;
const catalogProjects = [
  { id: projectId('3'), name: 'Zebra' }, { id: projectId('1'), name: 'apple notes' }, { id: projectId('2'), name: '  Banana  ' }, { id: projectId('4'), name: 'Mango' },
  { id: projectId('5'), name: 'cherry' }, { id: projectId('6'), name: 'Dragonfruit' }, { id: projectId('7'), name: 'Fig & Co' },
];
const sortedCatalog = [
  { name: 'apple notes', ref: `https://chatgpt.com/g/${projectId('1')}` }, { name: 'Banana', ref: `https://chatgpt.com/g/${projectId('2')}` }, { name: 'cherry', ref: `https://chatgpt.com/g/${projectId('5')}` },
  { name: 'Dragonfruit', ref: `https://chatgpt.com/g/${projectId('6')}` }, { name: 'Fig & Co', ref: `https://chatgpt.com/g/${projectId('7')}` }, { name: 'Mango', ref: `https://chatgpt.com/g/${projectId('4')}` },
  { name: 'Zebra', ref: `https://chatgpt.com/g/${projectId('3')}` },
];

test('the catalog reveals every project hidden behind the sidebar Show more, ignores chat and Recents Show more, de-duplicates and sorts', async () => {
  await withServer(async fixture => {
    Object.assign(fixture.state.sidebar, { projects: [...catalogProjects, catalogProjects[0]], limit: 5 });
    fixture.state.sidebar.explorerCount = 7;
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    assert.deepEqual(await browser.listProjects(), sortedCatalog);
    assert.equal(fixture.state.sidebar.revealed, true);
    assert.equal(fixture.state.sidebar.chatMoreClicks, 0);
    assert.equal(fixture.state.sidebar.recentsMoreClicks, 0);
    assert.equal(fixture.state.sidebar.toggles, 0);
    assert.deepEqual(fixture.tabs(), []);
  });
});

test('the catalog waits for the sidebar to hydrate instead of reporting an early empty list', async () => {
  await withServer(async fixture => {
    Object.assign(fixture.state.sidebar, { projects: catalogProjects.slice(0, 3), hydrateAfter: 2 });
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    assert.deepEqual((await browser.listProjects()).map(project => project.name), ['apple notes', 'Banana', 'Zebra']);
    assert.deepEqual(fixture.tabs(), []);
  });
});

test('an account with no projects yields a verified empty catalog', { timeout: 20_000 }, async () => {
  await withServer(async fixture => {
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    assert.deepEqual(await browser.listProjects(), []);
    assert.deepEqual(fixture.tabs(), []);
  });
});

for (const [name, prepare, message] of [
  ['the sidebar is truncated relative to the Projects explorer', (state: State) => { Object.assign(state.sidebar, { projects: catalogProjects.slice(0, 5), explorerCount: 7 }); }, /lists 7 projects but 5 were read/],
  ['ChatGPT is signed out', (state: State) => { Object.assign(state.sidebar, { projects: catalogProjects, signedOut: true }); }, /signed out/],
  ['the Projects explorer reads empty while the sidebar has projects', (state: State) => { Object.assign(state.sidebar, { projects: catalogProjects.slice(0, 3), explorerCount: 0 }); }, /lists 0 projects but 3 were read/],
] as const) {
  test(`the catalog rejects rather than returning a partial or empty list when ${name}, and closes its scratch tab`, async () => {
    await withServer(async fixture => {
      prepare(fixture.state);
      const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
      await assert.rejects(browser.listProjects(), message);
      assert.deepEqual(fixture.tabs(), []);
      await assert.rejects(browser.listProjects(), message);
    });
  });
}

test('a collapsed Projects section is expanded in the scratch tab for the read and collapsed again afterwards', async () => {
  await withServer(async fixture => {
    Object.assign(fixture.state.sidebar, { projects: catalogProjects.slice(0, 3), collapsed: true });
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    assert.deepEqual((await browser.listProjects()).map(project => project.name), ['apple notes', 'Banana', 'Zebra']);
    assert.equal(fixture.state.sidebar.collapsed, true);
    assert.equal(fixture.state.sidebar.toggles, 2);
    assert.deepEqual(fixture.tabs(), []);
  });
});

for (const [name, prepare, message] of [
  ['ChatGPT signs out right after the expansion', (state: State) => { Object.assign(state.sidebar, { projects: catalogProjects.slice(0, 3), collapsed: true, signOutOnToggle: true }); }, /signed out/],
  ['the explorer disagrees after the expansion', (state: State) => { Object.assign(state.sidebar, { projects: catalogProjects.slice(0, 3), collapsed: true, explorerCount: 0 }); }, /lists 0 projects but 3 were read/],
] as const) {
  test(`a collapsed Projects section is collapsed again and the scratch tab closed when ${name}`, async () => {
    await withServer(async fixture => {
      prepare(fixture.state);
      const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
      await assert.rejects(browser.listProjects(), message);
      assert.equal(fixture.state.sidebar.collapsed, true);
      assert.equal(fixture.state.sidebar.toggles, 2);
      assert.deepEqual(fixture.tabs(), []);
    });
  });
}

test('listing projects mid-reply uses its own session and tab, never touches the delivery tab and shares one lookup between concurrent callers', async () => {
  await withServer(async fixture => {
    Object.assign(fixture.state.sidebar, { projects: catalogProjects.slice(0, 2) });
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    let listed: unknown[] = [];
    try {
      await browser.start(); fixture.state.complete = false;
      const reply = await browser.reply({
        conversationRef: 'https://chatgpt.com/c/existing', projectRef: null, text: 'Reply while the picker loads',
        onConversation: async () => {},
        onSubmitted: async () => {
          const navigationsBefore = fixture.state.navigations.length;
          const lookups = await Promise.all([browser.listProjects(), browser.listProjects()]);
          listed = lookups[0];
          assert.deepEqual(lookups[0], lookups[1]);
          assert.equal(fixture.state.initializations, 2);
          assert.deepEqual(fixture.state.navigations.slice(navigationsBefore), ['https://chatgpt.com/', 'https://chatgpt.com/projects']);
          assert.deepEqual(fixture.tabs(), ['https://chatgpt.com/c/existing']);
          fixture.state.complete = true;
        },
      });
      assert.equal(listed.length, 2);
      assert.equal(reply.text, 'Completed response');
      assert.equal(fixture.state.submissions, 1);
      assert.deepEqual(fixture.tabs(), ['https://chatgpt.com/c/existing']);
    } finally { await browser.stop().catch(() => undefined); }
  });
});

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

test('cancelling a catalog whose MCP request is blocked aborts that request, closes the scratch tab and leaves the delivery session alone', { timeout: 20_000 }, async () => {
  await withServer(async fixture => {
    Object.assign(fixture.state.sidebar, { projects: catalogProjects.slice(0, 2) });
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    try {
      await browser.start();
      const deliveryTabs = fixture.tabs();
      assert.equal(deliveryTabs.length, 1);
      fixture.state.blockSidebarReads = true;
      const controller = new AbortController();
      const reason = new Error('setup cancelled');
      const listing = assert.rejects(browser.listProjects(controller.signal), error => error === reason);
      await until(() => fixture.state.blocked === 1, 'the sidebar read to reach the server and block');
      assert.equal(fixture.tabs().length, 2);
      controller.abort(reason);
      await listing;
      // The abandoned HTTP exchange ends with the independent client, not later.
      await until(() => fixture.state.blockedClosed === 1, 'the blocked HTTP exchange to be aborted');
      assert.deepEqual(fixture.tabs(), deliveryTabs);
      assert.equal(fixture.state.initializations, 2);
      // Nothing is cached or half-open: the next lookup is a fresh complete read.
      fixture.state.blockSidebarReads = false;
      assert.equal((await browser.listProjects()).length, 2);
      assert.deepEqual(fixture.tabs(), deliveryTabs);
      assert.equal(fixture.state.submissions, 0);
    } finally { await browser.stop().catch(() => undefined); }
    assert.deepEqual(fixture.tabs(), []);
  });
});

test('Application.close cancels an in-flight catalog blocked on the MCP server, drains its cleanup and then completes', { timeout: 15_000 }, async () => {
  await withDirectory(async directory => {
    await withServer(async fixture => {
      fixture.state.blockSidebarReads = true;
      const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
      const app = new Application({ configPath: join(directory, 'config.json'), ...providerNames }, await loadState(directory), fakeChannel(), browser);
      const listing = assert.rejects(app.listProjects(), /closing/);
      await until(() => fixture.state.blocked === 1, 'the sidebar read to reach the server and block');
      await app.close();
      await listing;
      assert.deepEqual(fixture.tabs(), []);
      await until(() => fixture.state.blockedClosed === 1, 'the blocked HTTP exchange to be aborted');
    });
  }, 'wabgpt-app-');
});

test('cancelling before the catalog starts rejects with the reason and opens nothing', async () => {
  await withServer(async fixture => {
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    await assert.rejects(browser.listProjects(AbortSignal.abort(new Error('never started'))), /never started/);
    assert.equal(fixture.state.initializations, 0);
    assert.deepEqual(fixture.tabs(), []);
  });
});

test('the adapter exposes the ChatGPT reference policy and refuses endpoints that are not local', () => {
  const assistant = createChatGPT({ endpoint: 'http://127.0.0.1:9/mcp', logger: () => {} });
  assert.equal(assistant.references.normalizeProject(`${urlA}-example/project?x=1`), urlA);
  assert.equal(assistant.references.normalizeConversation(`${urlA}-example/c/abc?x=1`, urlA), `${urlA}/c/abc`);
  assert.equal(assistant.references.normalizeConversation('https://chatgpt.com/c/abc#top', null), 'https://chatgpt.com/c/abc');
  assert.throws(() => assistant.references.normalizeProject('https://evil.example/g/' + projectA));
  assert.throws(() => assistant.references.normalizeConversation('https://chatgpt.com/c/abc', urlA));
  for (const endpoint of ['https://example.com/mcp', 'http://192.0.2.1:9010/mcp', 'http://user:pw@127.0.0.1:9010/mcp', 'ftp://127.0.0.1/mcp', 'not a url']) {
    assert.throws(() => createChatGPT({ endpoint, logger: () => {} }), Error, endpoint);
  }
});

test('when page records carry no groupId, group membership from tabGroups keeps start, 404 recovery and replies on one tab', async () => {
  await withServer(async fixture => {
    fixture.state.groupIdsOmitted = true;
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    const conversation = `${urlA}/c/existing`;
    try {
      await browser.start();
      assert.ok(fixture.state.tabGroupListings > 0);
      assert.equal(fixture.state.chatgptTabsOpened, 1);
      fixture.expire();
      const before = await browser.reply({ conversationRef: conversation, projectRef: urlA, text: 'Expired before sending', ...quiet });
      assert.equal(before.conversationRef, conversation);
      assert.equal(fixture.state.initializations, 2);
      assert.equal(fixture.state.reclaimedGroups, 1);
      assert.equal(fixture.state.chatgptTabsOpened, 1);
      assert.equal(fixture.state.submissions, 1);
      assert.deepEqual(fixture.tabs(), [conversation]);
      fixture.state.expireAfterSubmit = true;
      const after = await browser.reply({ conversationRef: conversation, projectRef: urlA, text: 'Expired while waiting', ...quiet });
      assert.equal(after.conversationRef, conversation);
      assert.equal(fixture.state.submissions, 2);
      assert.equal(fixture.state.initializations, 3);
      assert.equal(fixture.state.chatgptTabsOpened, 1);
      assert.deepEqual(fixture.tabs(), [conversation]);
    } finally { await browser.stop().catch(() => undefined); }
    assert.deepEqual(fixture.tabs(), []);
  });
});

test('a new standalone chat survives a 404 before submission without duplicate tabs when groups come only from tabGroups', async () => {
  await withServer(async fixture => {
    fixture.state.groupIdsOmitted = true;
    const browser = createChatGPT({ endpoint: fixture.endpoint, logger: () => {} });
    try {
      await browser.start(); fixture.expire();
      const reply = await browser.reply({ conversationRef: null, projectRef: null, text: 'Fresh chat', ...quiet });
      assert.equal(reply.conversationRef, 'https://chatgpt.com/c/new-conversation-1');
      assert.equal(fixture.state.submissions, 1);
      assert.equal(fixture.state.initializations, 2);
      assert.equal(fixture.state.chatgptTabsOpened, 1);
      assert.deepEqual(fixture.tabs(), ['https://chatgpt.com/c/new-conversation-1']);
    } finally { await browser.stop().catch(() => undefined); }
  });
});
