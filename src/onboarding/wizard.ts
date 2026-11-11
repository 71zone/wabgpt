import qrcode from 'qrcode-terminal';
import type { Application, ApplicationSnapshot } from '../core/application.js';
import type { Contact, Project } from '../core/contracts.js';
import { formatConversationTtl, parseConversationTtl } from '../core/duration.js';
import type { Route } from '../core/state.js';
import { OnboardingCancelled } from './cancelled.js';
import type { PreparedOnboarding } from './prepare.js';
import { checkpoint, completeSetup, writeSetupState, type BrowserSelection } from './state.js';
import { abortable, ask, askYesNo, clean, errorText } from './text.js';
import type { SetupIO } from './terminal.js';

export interface CompleteOptions { io: SetupIO; signal: AbortSignal }

interface Context {
  application: Application;
  io: SetupIO;
  signal: AbortSignal;
  dataDir: string;
  browser: BrowserSelection;
  viewerUrl: string | undefined;
}

const projectsHelp = 'https://help.openai.com/en/articles/10169521-projects-in-chatgpt';
const DIRECT_CONTACT = /^\d+@(?:s\.whatsapp\.net|lid)$/;
const LIST_LIMIT = 10;
const PROJECT_LIST_LIMIT = 30;

function label(contact: Contact): string {
  const name = clean(contact.name, 60) || 'this contact';
  const number = /^(\d+)@s\.whatsapp\.net$/.exec(contact.id)?.[1];
  const phone = number ? `+${number}` : null;
  return phone && name !== phone ? `${name} (${phone})` : name;
}

function routeOf(snapshot: ApplicationSnapshot, contact: Contact): Route | undefined {
  return snapshot.routes.find(route => route.contactId === contact.id);
}

/** Step 3: real project access, not just a ready composer. An empty complete catalog also proves a signed-in account. */
async function confirmChatGPT({ application, io, signal, viewerUrl }: Context): Promise<void> {
  io.write('\nStep 1 of 3 · ChatGPT\n');
  io.write('In the BrowserOS window, sign in to ChatGPT yourself and finish any verification it asks for.\n');
  io.write('wabgpt never signs in for you, never solves challenges, and does not send any prompt during setup.\n');
  if (viewerUrl) io.write(`Your managed browser is at ${viewerUrl}\n`);
  await ask(io, 'Press Enter when you are signed in and wabgpt should check: ');
  for (;;) {
    try {
      const projects = await abortable(application.listProjects(signal), signal);
      io.write(`Signed in to ChatGPT: ${projects.length} project${projects.length === 1 ? '' : 's'} found.\n`);
      return;
    } catch (error) {
      if (signal.aborted) throw new OnboardingCancelled();
      io.write(`\nCould not confirm a signed-in ChatGPT: ${errorText(error)}\n`);
      await ask(io, 'Sign in (and finish any verification) in BrowserOS yourself, then press Enter to check again. Ctrl-C stops and keeps your progress: ');
    }
  }
}

type LoginOutcome = { state: 'open' } | { state: 'failed'; detail: string };

/** Subscribes before starting the login so no QR code can be missed, and settles on the first terminal channel status. */
async function watchLogin({ application, io, signal }: Context): Promise<LoginOutcome> {
  const { channelName } = application.metadata;
  const settled = Promise.withResolvers<LoginOutcome>();
  let failure = '';
  let shown: string | null = null;
  let codes = 0;
  const check = (): void => {
    const status = application.snapshot().channelStatus;
    if (status === 'open') settled.resolve({ state: 'open' });
    else if (status === 'failed' || status.startsWith('failed:') || status === 'logged-out') {
      settled.resolve({ state: 'failed', detail: status === 'logged-out' ? `${channelName} logged this device out.` : failure || `${channelName} could not connect.` });
    }
  };
  const onQr = (payload: string): void => {
    if (!payload || payload === shown) return;
    shown = payload;
    let rendered = '';
    qrcode.generate(payload, { small: true }, (output: string) => { rendered = output; });
    io.write(codes++ === 0
      ? `\nScan this code with ${channelName} on your phone: Settings → Linked devices → Link a device.\n${rendered}\n`
      : `\nThe code refreshed. Scan this newer one:\n${rendered}\n`);
  };
  const onLog = (text: string): void => { if (text.startsWith(`${channelName} connection failed`)) failure = clean(text, 200); };
  application.on('qr', onQr);
  application.on('log', onLog);
  application.on('change', check);
  try {
    io.write(`Connecting to ${channelName}…\n`);
    application.login();
    check();
    return await abortable(settled.promise, signal);
  } finally {
    application.off('qr', onQr);
    application.off('log', onLog);
    application.off('change', check);
  }
}

/** Step 4: connect WhatsApp (an existing saved login is reused), retrying on failure until connected or stopped. */
async function connectWhatsApp(context: Context): Promise<void> {
  const { application, io } = context;
  const { channelName } = application.metadata;
  if (application.snapshot().channelStatus === 'open') return;
  io.write(`\nStep 2 of 3 · ${channelName}\n`);
  for (;;) {
    const outcome = await watchLogin(context);
    if (outcome.state === 'open') { io.write(`${channelName} is connected.\n`); return; }
    io.write(`\n${outcome.detail}\n`);
    await ask(io, 'Press Enter to try again, or Ctrl-C to stop and continue later: ');
  }
}

function recentCandidates(snapshot: ApplicationSnapshot): Contact[] {
  const recent = snapshot.chats.filter(chat => DIRECT_CONTACT.test(chat.id)).slice(0, LIST_LIMIT);
  return (recent.length > 0 ? recent : snapshot.directory.filter(contact => DIRECT_CONTACT.test(contact.id)).slice(0, LIST_LIMIT)).map(({ id, name }) => ({ id, name }));
}

function searchCandidates(snapshot: ApplicationSnapshot, query: string): { shown: Contact[]; more: boolean } {
  const needle = query.toLowerCase();
  const matches = snapshot.directory.filter(contact => DIRECT_CONTACT.test(contact.id) && (clean(contact.name, 200).toLowerCase().includes(needle) || contact.id.includes(needle)));
  return { shown: matches.slice(0, LIST_LIMIT).map(({ id, name }) => ({ id, name })), more: matches.length > LIST_LIMIT };
}

/** Numbered choice from `items`; undefined when the user backs out. */
async function chooseFrom<T>(io: SetupIO, items: T[], describe: (item: T) => string, prompt: string): Promise<T | undefined> {
  items.forEach((item, index) => io.write(`  ${index + 1}) ${describe(item)}\n`));
  for (;;) {
    const answer = await ask(io, prompt);
    if (!answer) return undefined;
    const item = items[Number(answer) - 1];
    if (/^\d+$/.test(answer) && item !== undefined) return item;
    io.write(`Enter a number from 1 to ${items.length}, or press Enter to go back.\n`);
  }
}

/** The contact to configure, resolved without changing any saved state; null when the user skips. */
async function pickContact({ application, io }: Context): Promise<Contact | null> {
  const resolve = (candidate: string): Contact | undefined => {
    try { return application.resolveContact(candidate); }
    catch (error) { io.write(`${errorText(error)}\n`); return undefined; }
  };
  for (;;) {
    if (application.snapshot().directory.length === 0) io.write('No contacts have appeared yet; WhatsApp sends them shortly after connecting. Enter a number with country code (for example +14155551234) or press Enter to look again.\n');
    const answer = await ask(io, "Contact: part of a name, a number with country code, Enter for recent chats, or 'skip': ");
    const lower = answer.toLowerCase();
    if (lower === 'skip' || lower === 's') return null;
    if (/^\+?[\d\s()\-.]{7,}$/.test(answer) || answer.includes('@')) {
      const contact = resolve(answer);
      if (contact) return contact;
      continue;
    }
    // Contacts keep arriving while the user types, so search what is known now, not what was known when the prompt appeared.
    const snapshot = application.snapshot();
    const { shown, more } = answer ? searchCandidates(snapshot, answer) : { shown: recentCandidates(snapshot), more: false };
    if (shown.length === 0) {
      if (snapshot.directory.length > 0) io.write(answer ? 'No contact matches. Contacts can keep arriving for a while; try again, or enter a number.\n' : 'No recent direct chats yet. Search by name or enter a number.\n');
      continue;
    }
    if (more) io.write(`More than ${LIST_LIMIT} matches; showing the first ${LIST_LIMIT}. Type more of the name to narrow it down.\n`);
    const picked = await chooseFrom(io, shown, label, 'Number (Enter to search again): ');
    const contact = picked && resolve(picked.id);
    if (contact) return contact;
  }
}

type ProjectChoice = { kind: 'keep' } | { kind: 'set'; ref: string | null };

function projectLine(project: Project, index: number, owner: Route | undefined, contact: Contact): string {
  const note = !owner ? '' : owner.contactId === contact.id ? '  (already this contact\'s)' : `  (used by ${clean(owner.name, 40) || 'another contact'})`;
  return `  ${index + 1}) ${clean(project.name, 60) || 'Untitled project'}${note}\n`;
}

async function chooseProject(context: Context, contact: Contact): Promise<ProjectChoice> {
  const { application, io, signal } = context;
  io.write(`\nChatGPT project for ${label(contact)}\n`);
  io.write('Give each person their own ChatGPT project, and set that project\'s memory to "Project-only" in ChatGPT, so one person\'s chats never mix with your other ones.\n');
  io.write(`wabgpt cannot check or change that setting; you do it in ChatGPT. More: ${projectsHelp}\n`);
  let catalog: Project[] | null = null;
  for (;;) {
    const routes = application.snapshot().routes;
    const route = routes.find(item => item.contactId === contact.id);
    const owners = new Map<string, Route>();
    for (const item of routes) if (item.projectRef) owners.set(item.projectRef, item);
    if (catalog === null) {
      try { catalog = await abortable(application.listProjects(signal), signal); }
      catch (error) {
        if (signal.aborted) throw new OnboardingCancelled();
        io.write(`Could not read your ChatGPT projects: ${errorText(error)}\n`);
        const answer = (await ask(io, "Press Enter to retry, or type 'none' to continue without a project: ")).toLowerCase();
        if (answer === 'none' && await confirmNoProject(io)) return { kind: 'set', ref: null };
        continue;
      }
      if (catalog.length === 0) io.write('You have no ChatGPT projects yet. In ChatGPT create one (sidebar → Projects → New project) and set its memory to Project-only, then type r here.\n');
      catalog.slice(0, PROJECT_LIST_LIMIT).forEach((project, index) => io.write(projectLine(project, index, owners.get(project.ref), contact)));
      if (catalog.length > PROJECT_LIST_LIMIT) io.write(`  …and ${catalog.length - PROJECT_LIST_LIMIT} more; type part of a name to find them.\n`);
    }
    const hint = route?.projectRef ? 'Enter keeps the current project, ' : '';
    const answer = await ask(io, `Project number or part of its name (${hint}r reloads, 'none' for no project): `);
    const lower = answer.toLowerCase();
    if (!answer) {
      if (route?.projectRef) return { kind: 'keep' };
      io.write('Choose a project, or type none to continue without one.\n');
      continue;
    }
    if (lower === 'r') { catalog = null; continue; }
    if (lower === 'none') {
      if (await confirmNoProject(io)) return { kind: 'set', ref: null };
      continue;
    }
    const byNumber = /^\d+$/.test(answer) ? catalog[Number(answer) - 1] : undefined;
    // Numbers stay those of the full list, so a number typed after a filtered display means what that display showed.
    const matches = byNumber
      ? [{ project: byNumber, number: Number(answer) }]
      : catalog.map((project, index) => ({ project, number: index + 1 })).filter(({ project }) => clean(project.name, 200).toLowerCase().includes(lower));
    if (matches.length === 0) { io.write('No project matches that.\n'); continue; }
    if (matches.length > 1) {
      io.write('Several projects match; type more of the name or use its number from this list.\n');
      matches.slice(0, LIST_LIMIT).forEach(({ project, number }) => io.write(projectLine(project, number - 1, owners.get(project.ref), contact)));
      continue;
    }
    const project = matches[0]?.project;
    if (!project) continue;
    const owner = owners.get(project.ref);
    if (owner && owner.contactId !== contact.id) {
      io.write(`That project already belongs to ${clean(owner.name, 40) || 'another contact'}. Choose a different one.\n`);
      continue;
    }
    return { kind: 'set', ref: project.ref };
  }
}

function confirmNoProject(io: SetupIO): Promise<boolean> {
  return askYesNo(io, 'Without a project, replies use ordinary ChatGPT chats that can share your general memory. Continue without one?', false);
}

async function saveProject(context: Context, contact: Contact): Promise<void> {
  const { application, io } = context;
  for (;;) {
    const choice = await chooseProject(context, contact);
    if (choice.kind === 'keep') return;
    try {
      const current = routeOf(application.snapshot(), contact)?.projectRef ?? null;
      if (choice.ref !== current) await application.setProject(contact, choice.ref);
      return;
    } catch (error) { io.write(`${errorText(error)}\n`); }
  }
}

async function saveLifetime({ application, io }: Context, contact: Contact): Promise<void> {
  const route = routeOf(application.snapshot(), contact);
  const current = route ? route.conversationTtlMinutes : parseConversationTtl('');
  io.write(`\nChat lifetime: one ChatGPT chat with ${label(contact)} lasts this long from its first message, then the next message starts a fresh chat. Nothing is deleted in ChatGPT.\n`);
  for (;;) {
    const answer = await ask(io, `Lifetime (90m, 12h, 3d or never) [${formatConversationTtl(current)}]: `);
    let minutes: number | null;
    try { minutes = answer ? parseConversationTtl(answer) : current; }
    catch (error) { io.write(`${errorText(error)}\n`); continue; }
    if (!route || minutes !== route.conversationTtlMinutes) await application.setConversationTtl(contact, minutes);
    return;
  }
}

/** Saves the contact paused; only an explicit yes enables it and starts forwarding. */
async function offerEnable({ application, io }: Context, contact: Contact): Promise<void> {
  const name = label(contact);
  const snapshot = application.snapshot();
  const route = routeOf(snapshot, contact);
  if (route?.enabled) {
    io.write(`\n${name} was already enabled. Forwarding stays paused until you press R in the dashboard.\n`);
    return;
  }
  if (snapshot.routes.some(item => item.enabled && item.contactId !== contact.id)) {
    io.write(`\n${name} is saved paused. Other contacts are already enabled, so nothing is started during setup: in the dashboard press Space on ${name} to enable it, then R to resume.\n`);
    return;
  }
  io.write(`\nAutomatic replies are OFF for ${name}. If you turn them on, every text this person sends you on WhatsApp is shared with ChatGPT in the project above, and ChatGPT's answer is sent back to them automatically from your account.\n`);
  const answer = (await ask(io, `Turn on automatic replies for ${name} now? Type yes to enable [default: no]: `)).toLowerCase();
  if (answer !== 'yes' && answer !== 'y') {
    io.write(`${name} is saved and paused. In the dashboard press Space on it to enable it later.\n`);
    return;
  }
  try { await application.setContactEnabled(contact, true); }
  catch (error) {
    io.write(`${name} is enabled, but forwarding could not start yet: ${errorText(error)}\nPress R in the dashboard to try again.\n`);
    return;
  }
  io.write(application.snapshot().armed ? `Forwarding is active for ${name}.\n` : `${name} is enabled. Press R in the dashboard to start forwarding.\n`);
}

/** Step 5, optional. Contacts are configured paused; nothing is shared with ChatGPT without an explicit yes. */
async function firstContact(context: Context): Promise<void> {
  const { application, io } = context;
  io.write('\nStep 3 of 3 · First contact (optional)\n');
  const existing = application.snapshot().routes.length > 0;
  const wanted = await askYesNo(io, existing ? 'Set up or adjust one contact now? Saved contacts stay as they are, and forwarding stays paused.' : 'Set up a contact now?', !existing);
  if (!wanted) return;
  const contact = await pickContact(context);
  if (!contact) return;
  io.write(`\nSelected ${label(contact)}.\n`);
  await saveProject(context, contact);
  await saveLifetime(context, contact);
  await offerEnable(context, contact);
}

function farewell({ application, io }: Context): void {
  const snapshot = application.snapshot();
  io.write('\nSetup is complete. Opening the dashboard.\n');
  if (snapshot.armed) return;
  if (snapshot.routes.some(route => route.enabled)) io.write('Forwarding is paused. Press R in the dashboard to resume the enabled contacts.\n');
  else io.write('No contact forwards yet. In the dashboard press A to add one, or select a chat and press Space.\n');
}

/**
 * Runs the remaining setup steps against the live application. Forwarding is paused first, so reopening the dashboard never
 * resumes an earlier running preference behind the wizard's back. Throws OnboardingCancelled when stopped; every checkpoint
 * reached so far stays saved and the setup is only marked complete after the last step.
 */
export async function completeOnboarding(application: Application, plan: PreparedOnboarding, options: CompleteOptions): Promise<void> {
  const { setup } = plan;
  if (!setup) return;
  if (setup.stage === 'browser') throw new Error('Setup has no browser selected yet.');
  const context: Context = { application, io: options.io, signal: options.signal, dataDir: plan.config.dataDir, browser: setup.browser, viewerUrl: plan.viewerUrl };
  const save = (stage: 'whatsapp' | 'contact'): Promise<void> => writeSetupState(context.dataDir, checkpoint(context.browser, stage));
  try {
    await application.pause();
    if (setup.stage === 'chatgpt') { await confirmChatGPT(context); await save('whatsapp'); }
    if (setup.stage !== 'contact') { await connectWhatsApp(context); await save('contact'); }
    else await connectWhatsApp(context);
    await firstContact(context);
    await writeSetupState(context.dataDir, completeSetup(context.browser));
    farewell(context);
  } catch (error) {
    if (options.signal.aborted && !(error instanceof OnboardingCancelled)) throw new OnboardingCancelled();
    throw error;
  }
}
