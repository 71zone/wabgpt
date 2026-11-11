import blessed from 'blessed';
import type { Application } from '../../core/application.js';
import type { Contact } from '../../core/contracts.js';
import { formatConversationTtl, parseConversationTtl } from '../../core/duration.js';
import { DEFAULT_CONVERSATION_TTL_MINUTES } from '../../core/state.js';
import type { Route } from '../../core/state.js';
import { createProjectPicker } from './project-picker.js';
import { clean, errorMessage, renderQr } from './text.js';

function lifecycle(route: Route | undefined): { project: string | null; ttl: number | null; conversation: string | null; startedAt: number | null; expiresAt: number | null; expired: boolean } {
  const ttl = route ? route.conversationTtlMinutes : DEFAULT_CONVERSATION_TTL_MINUTES;
  const conversation = route?.conversationRef ?? null;
  const startedAt = route?.conversationStartedAt ?? null;
  const expiresAt = conversation && ttl !== null && startedAt !== null ? startedAt + ttl * 60_000 : null;
  return { project: route?.projectRef ?? null, ttl, conversation, startedAt, expiresAt, expired: expiresAt !== null && Date.now() >= expiresAt };
}

/** Full-screen terminal dashboard over an unstarted Application. Resolves once the user quits and the application has closed. */
export async function runTui(application: Application): Promise<void> {
  const { channelName, assistantName, configPath } = application.metadata;
  const screen = blessed.screen({ smartCSR: true, fullUnicode: true, title: 'wabgpt', dockBorders: true, warnings: false });
  const done = Promise.withResolvers<void>();
  const frame = { type: 'line' } satisfies blessed.Widgets.Border;
  const colors = { border: { fg: 'gray' }, focus: { border: { fg: 'cyan' } } };
  const header = blessed.box({ parent: screen, top: 0, left: 0, width: '100%', height: 3, tags: true, padding: { left: 1 } });
  const status = blessed.box({ parent: screen, top: 3, left: 0, width: '100%', height: 4, border: frame, tags: true, padding: { left: 1 }, style: colors });
  const directory = blessed.box({ parent: screen, top: 10, left: 0, width: '40%', border: frame, label: ' Directory ', style: colors });
  const filterLabel = blessed.box({ parent: directory, top: 0, left: 1, width: '100%-4', height: 2, tags: true });
  const list = blessed.list({ parent: directory, top: 2, left: 0, width: '100%-2', height: '100%-4', keys: true, vi: true, mouse: true, tags: true, scrollable: true, scrollbar: { ch: '│' }, style: { selected: { bg: 'cyan', fg: 'black' }, item: { fg: 'white' }, scrollbar: { fg: 'gray' } } });
  const routesList = blessed.list({ parent: screen, top: 10, left: '40%', width: '60%', border: frame, label: ' Saved forwarding sessions ', keys: true, vi: true, mouse: true, tags: true, scrollable: true, padding: { left: 1, right: 1 }, style: { ...colors, selected: { bg: 'blue', fg: 'white' } } });
  const details = blessed.box({ parent: screen, left: '40%', width: '60%', border: frame, label: ' Selected chat ', tags: true, padding: { left: 1, right: 1 }, scrollable: true, mouse: true, keys: true, style: colors });
  const activity = blessed.log({ parent: screen, left: '40%', width: '60%', border: frame, label: ' Activity ', tags: true, scrollback: 300, scrollOnInput: true, mouse: true, keys: true, vi: true, scrollbar: { ch: '│' }, style: colors });
  blessed.box({ parent: screen, bottom: 0, left: 0, width: '100%', height: 2, tags: true, padding: { left: 1 }, content: '{cyan-fg}↑↓{/} Navigate  {cyan-fg}Tab{/} Panels  {cyan-fg}Space{/} Enable/pause  {cyan-fg}/{/} Search  {cyan-fg}1/2/3{/} View  {cyan-fg}G{/} Project  {cyan-fg}T{/} TTL\n{yellow-fg}Enabled chats share incoming text with the assistant and send its reply automatically.{/}' });
  const prompt = blessed.prompt({ parent: screen, top: 'center', left: 'center', width: '90%', height: 9, border: frame, label: ' Input ', hidden: true, tags: false, style: colors });
  const qr = blessed.box({ parent: screen, top: 'center', left: 'center', width: 68, height: 37, border: frame, label: ` ${clean(channelName)} login · Esc hides `, hidden: true, scrollable: true, mouse: true, keys: true, style: { fg: 'white', bg: 'black', border: { fg: 'cyan' } } });
  let modalActive = false;
  let closing = false;
  let view: 'all' | 'contacts' | 'chats' = 'all';
  let query = '';
  let rows: Contact[] = [];
  let directoryIndex = 0;
  let routeIndex = 0;
  let activePanel: 'directory' | 'sessions' = 'directory';
  let rendering = false;
  let scheduled: NodeJS.Immediate | null = null;
  const picker = createProjectPicker(screen, application, {
    opened: () => { modalActive = true; },
    closed: () => {
      if (closing) return;
      modalActive = !qr.hidden;
      if (qr.hidden) (activePanel === 'sessions' ? routesList : list).focus();
      refresh();
    },
    blocked: () => closing || !qr.hidden,
  }, frame);

  function attempt(action: () => unknown): void {
    if (closing) return;
    try { void Promise.resolve(action()).catch(error => application.log(errorMessage(error))); }
    catch (error) { application.log(errorMessage(error)); }
  }
  let toolbarLeft = 0;
  function toolbar(text: string, width: number, action: () => Promise<void> | void): void {
    const button = blessed.button({ parent: screen, top: 7, left: toolbarLeft, width, height: 3, content: text, align: 'center', border: frame, mouse: true, keys: true, style: { fg: 'white', border: { fg: 'gray' }, focus: { bg: 'blue', border: { fg: 'cyan' } }, hover: { bg: 'blue' } } });
    toolbarLeft += width;
    button.on('press', () => { if (!modalActive) attempt(action); });
  }
  function showPrompt(label: string, initial: string, submit: (value: string) => void): void {
    modalActive = true;
    const returnTo = activePanel === 'sessions' ? routesList : list;
    prompt.input(label, initial, (error: unknown, value?: string | null) => {
      modalActive = false;
      returnTo.focus();
      if (!error && typeof value === 'string') submit(value);
      refresh();
    });
  }
  function addContact(): void {
    showPrompt(`Enable automatic replies for a ${channelName} contact (the provider accepts a phone number or address):`, '', value => {
      attempt(() => application.addContact(value));
    });
  }
  function setProject(): void {
    const contact = selected();
    if (!contact) { application.log('Select a contact or saved session first, then press G.'); return; }
    picker.open(contact);
  }
  function setTtl(): void {
    const contact = selected();
    if (!contact) { application.log('Select a contact or saved session first, then press T.'); return; }
    const target = { id: contact.id, name: contact.name };
    const current = lifecycle(application.snapshot().routes.find(route => route.contactId === contact.id)).ttl;
    const shownName = Array.from(clean(contact.name)).slice(0, 24).join('');
    showPrompt(`TTL for ${shownName}: 90m, 12h, 3d or never; empty = 24h.\nCounted from the first saved chat reference; new messages never extend it.\nA new chat starts on the next incoming message; no remote chat is deleted.`, formatConversationTtl(current), value => {
      try {
        const next = parseConversationTtl(value);
        if (next === current) { application.log(`Conversation lifetime unchanged for ${contact.name}: ${formatConversationTtl(current)}.`); return; }
        attempt(() => application.setConversationTtl(target, next));
      } catch (error) { application.log(errorMessage(error)); }
    });
  }
  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true; picker.close();
    application.log('Stopping. Saved settings are retained. Waiting for any in-progress operation to finish…');
    try { await application.close(); }
    catch (error) { activity.log(clean(errorMessage(error))); }
    finally {
      clearImmediate(scheduled ?? undefined); clearInterval(clock);
      application.off('change', schedule); application.off('log', onLog); application.off('qr', onQr);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('SIGINT', onSignal);
      screen.destroy(); done.resolve();
    }
  }
  toolbar('L Login', 10, () => application.login());
  toolbar('R Resume', 11, () => application.resume());
  toolbar('P Pause', 10, () => application.pause());
  toolbar('A Add', 8, addContact);
  toolbar('B Browser', 12, () => application.checkBrowser());
  toolbar('G Project', 12, setProject);
  toolbar('T TTL', 9, setTtl);
  toolbar('Q Quit', 10, shutdown);

  function selected(): Contact | undefined {
    if (activePanel === 'sessions') {
      const route = application.snapshot().routes[routeIndex];
      return route ? { id: route.contactId, name: route.name } : undefined;
    }
    return rows[directoryIndex];
  }
  function renderHeader(): void {
    if (Number(screen.width) < 90 || Number(screen.height) < 34) header.setContent('{yellow-fg}wabgpt · Enlarge this terminal to at least 90 × 34 for the full dashboard.{/}');
    else header.setContent(`{cyan-fg}{bold}wabgpt{/bold}{/cyan-fg}  ${clean(channelName)} → ${clean(assistantName)} → ${clean(channelName)}\nSaved contacts. One conversation per forwarding session.`);
  }
  function refreshDetails(): void {
    const data = application.snapshot();
    const contact = selected();
    if (!contact) {
      details.setContent(`Choose a saved contact or recent chat.\nSpace enables automatic forwarding.\nG sets its ${clean(assistantName)} project; T sets chat lifetime.\nA adds a contact if it is not in the list.\nConfiguring G/T never enables forwarding.`);
    } else {
      const route = data.routes.find(item => item.contactId === contact.id);
      const chat = data.chats.find(item => item.id === contact.id);
      const life = lifecycle(route);
      const state = route?.error ? '{red-fg}Paused after an error{/}' : route?.enabled ? '{green-fg}Enabled{/}' : '{yellow-fg}Not forwarding{/}';
      const project = life.project ? `Project: ${clean(life.project)}` : 'Project: none · standalone chats';
      const ttl = `Lifetime: ${life.ttl === null ? 'never expires' : `${formatConversationTtl(life.ttl)} fixed from first chat reference`}`;
      const expiry = !life.conversation ? 'Chat: new one starts on next message'
        : life.expired ? `{yellow-fg}Chat: expired ${clean(new Date(life.expiresAt ?? 0).toLocaleString())} · next message starts a new chat{/}`
          : life.ttl === null ? 'Chat: saved · never expires'
            : life.expiresAt === null ? 'Chat: saved · start time unrecorded, no expiry yet'
              : `Chat: saved · expires ${clean(new Date(life.expiresAt).toLocaleString())}`;
      details.setContent([
        `{bold}${clean(contact.name)}{/bold}`,
        clean(contact.id),
        `${state}${route?.enabled && !data.armed ? ' · globally paused' : ''}`,
        ...(route?.error ? [`{red-fg}${clean(route.error)}{/}`] : []),
        project, ttl, expiry,
        ...(life.conversation ? [`Chat: ${clean(life.conversation)}`] : []),
        ...(chat?.lastMessageAt ? [`Last activity: ${clean(new Date(chat.lastMessageAt * 1000).toLocaleString())}`] : []),
      ].join('\n'));
    }
  }
  function refresh(): void {
    if (rendering || closing) return;
    rendering = true;
    try {
      const data = application.snapshot();
      const chosen = rows[directoryIndex]?.id ?? data.routes.find(route => route.enabled)?.contactId;
      const knownChats = new Map<string, Contact>();
      for (const route of data.routes) knownChats.set(route.contactId, { id: route.contactId, name: route.name });
      for (const chat of data.chats) knownChats.set(chat.id, chat);
      const source = view === 'chats' ? [...knownChats.values()] : view === 'contacts' ? data.contacts : data.directory;
      rows = source.filter(contact => `${contact.name} ${contact.id}`.toLowerCase().includes(query.toLowerCase()));
      const previous = rows.findIndex(contact => contact.id === chosen);
      directoryIndex = previous >= 0 ? previous : Math.min(directoryIndex, Math.max(0, rows.length - 1));
      const mark = (id: string): string => {
        const route = data.routes.find(item => item.contactId === id);
        return route?.error ? '{red-fg}[!]{/}' : route?.enabled ? '{green-fg}[ON]{/}' : '{gray-fg}[--]{/}';
      };
      const nameCounts = new Map<string, number>();
      for (const contact of data.directory) {
        const name = contact.name.trim().toLocaleLowerCase();
        nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      }
      const label = (contact: Contact): string => {
        const duplicate = (nameCounts.get(contact.name.trim().toLocaleLowerCase()) ?? 0) > 1;
        return `${clean(contact.name)}${duplicate ? ` {gray-fg}· ${clean(contact.id)}{/}` : ''}`;
      };
      list.setItems(rows.length ? rows.map(contact => `${mark(contact.id)} ${label(contact)}`) : ['{gray-fg}No matches. / clears search; A adds a contact.{/}']);
      list.select(directoryIndex);
      directory.setLabel(` Directory · ${view} · ${rows.length} `);
      filterLabel.setContent(`{cyan-fg}1 All  2 Contacts  3 Recent chats{/}\n${query ? `Filter: ${clean(query)}` : '/ to search saved names or numbers'}`);
      routesList.setItems(data.routes.length ? data.routes.map(route => {
        const life = lifecycle(route);
        const chatState = !life.conversation ? 'new chat' : life.expired ? 'expired' : 'saved chat';
        return `${mark(route.contactId)} ${label({ id: route.contactId, name: route.name })}  ↔ ${chatState} · ${life.project ? 'project' : 'no project'} · ${formatConversationTtl(life.ttl)}`;
      }) : ['{gray-fg}No sessions. Select a contact and press Space.{/}']);
      routeIndex = Math.min(routeIndex, Math.max(0, data.routes.length - 1)); routesList.select(routeIndex);
      const forwarding = data.armed ? '{green-fg}ACTIVE{/}' : '{yellow-fg}PAUSED{/}';
      status.setContent(`${clean(channelName)}: {bold}${clean(data.channelStatus)}{/bold}    ${clean(assistantName)}: {bold}${clean(data.assistantStatus)}{/bold}    Forwarding: ${forwarding}\n${data.contacts.length} saved contacts/chats · ${data.routes.filter(route => route.enabled).length} enabled sessions · Config: ${clean(configPath)}`);
      refreshDetails(); if (picker.isOpen()) picker.render(); screen.render();
    } finally { rendering = false; }
  }
  function schedule(): void {
    if (scheduled || closing) return;
    scheduled = setImmediate(() => { scheduled = null; refresh(); });
  }
  function onLog(message: string): void {
    activity.log(`{gray-fg}${new Date().toLocaleTimeString()}{/} ${clean(message)}`); schedule();
  }
  function hideQr(): void { qr.hide(); modalActive = picker.isOpen(); if (modalActive) picker.focus(); else list.focus(); }
  function onQr(payload: string): void {
    if (!payload) hideQr();
    else {
      let rendered: string;
      try { rendered = renderQr(payload); }
      catch (error) { application.log(`Could not render the login QR code: ${errorMessage(error)}`); return; }
      modalActive = true;
      qr.setContent(`Scan in ${channelName} → Linked devices\n${rendered}`);
      qr.width = Math.min(70, Number(screen.width)); qr.height = Math.min(38, Number(screen.height) - 1);
      qr.show(); qr.setFront(); qr.focus();
    }
    screen.render();
  }
  function layout(): void {
    const height = Number(screen.height);
    const available = Math.max(16, height - 12);
    const sessionHeight = Math.max(5, Math.floor(available * 0.23));
    const detailHeight = Math.max(10, Math.floor(available * 0.5));
    directory.height = available;
    routesList.height = sessionHeight;
    details.top = 10 + sessionHeight; details.height = detailHeight;
    activity.top = 10 + sessionHeight + detailHeight; activity.height = Math.max(4, available - sessionHeight - detailHeight);
    renderHeader();
    refresh(); picker.layout();
  }
  list.on('select item', (_item: unknown, index: number) => {
    if (picker.isOpen()) return;
    directoryIndex = index;
    if (!rendering) { activePanel = 'directory'; refreshDetails(); screen.render(); }
  });
  routesList.on('select item', (_item: unknown, index: number) => {
    if (picker.isOpen()) return;
    routeIndex = index;
    if (!rendering) { activePanel = 'sessions'; refreshDetails(); screen.render(); }
  });
  list.on('focus', () => { if (picker.isOpen()) { picker.focus(); return; } activePanel = 'directory'; refreshDetails(); screen.render(); });
  routesList.on('focus', () => { if (picker.isOpen()) { picker.focus(); return; } activePanel = 'sessions'; refreshDetails(); screen.render(); });
  const bind = (keys: string[], action: () => Promise<void> | void): void => {
    screen.key(keys, () => { if (!modalActive) attempt(action); });
  };
  bind(['l'], () => application.login()); bind(['r'], () => application.resume()); bind(['p'], () => application.pause());
  bind(['a'], addContact); bind(['b'], () => application.checkBrowser()); bind(['q'], shutdown);
  bind(['g'], setProject); bind(['t'], setTtl);
  screen.key(['C-c'], () => { void shutdown(); });
  bind(['space', 'enter'], () => {
    if (screen.focused !== list && screen.focused !== routesList) return;
    const contact = selected(); if (contact) return application.toggle(contact);
  });
  bind(['/'], () => showPrompt('Search contacts and recent chats. Leave empty to clear:', query, value => { query = value; directoryIndex = 0; }));
  bind(['1'], () => { view = 'all'; refresh(); });
  bind(['2'], () => { view = 'contacts'; refresh(); });
  bind(['3'], () => { view = 'chats'; refresh(); });
  bind(['tab'], () => { if (screen.focused === list) routesList.focus(); else list.focus(); });
  screen.key(['escape'], () => {
    if (!qr.hidden) { hideQr(); screen.render(); }
    else if (!modalActive) { query = ''; refresh(); }
  });
  const onSignal = (): void => { void shutdown(); };
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  const clock = setInterval(schedule, 30_000);
  application.on('change', schedule); application.on('log', onLog); application.on('qr', onQr);
  screen.on('resize', layout);
  list.focus(); layout();
  onLog(`Saved directory and forwarding sessions loaded. Press L to log in to ${channelName}, Space to enable a selected chat.`);
  attempt(() => application.restore());
  await done.promise;
}
