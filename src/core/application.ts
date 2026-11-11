import { EventEmitter } from 'node:events';
import { Bridge, type ProviderNames } from './bridge.js';
import type { AssistantAdapter, Contact, IdentityAlias, IncomingMessage, MessagingAdapter, Project, RecentChat } from './contracts.js';
import { SingleFlight } from './single-flight.js';
import type { RoutingState, Route } from './state.js';

export interface ApplicationMetadata extends ProviderNames {
  /** Location of the user's configuration file, shown by frontends. */
  configPath: string;
}

export interface ApplicationSnapshot {
  routes: Route[];
  contacts: Contact[];
  directory: Contact[];
  chats: RecentChat[];
  armed: boolean;
  channelStatus: string;
  assistantStatus: string;
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export class Application extends EventEmitter<{ change: []; log: [message: string]; qr: [text: string] }> {
  private readonly bridge: Bridge;
  private channelAttempt: Promise<void> | null = null;
  private assistantAttempt: Promise<void> | null = null;
  private resumeAttempt: Promise<void> | null = null;
  private readonly catalog = new SingleFlight<Project[]>();
  private closing: Promise<void> | null = null;
  private closed = false;
  private generation = 0;
  private channelStatus = 'disconnected';
  private assistantStatus = 'disconnected';

  constructor(readonly metadata: ApplicationMetadata, private readonly store: RoutingState, private readonly channel: MessagingAdapter, private readonly assistant: AssistantAdapter) {
    super();
    this.bridge = new Bridge(store, assistant, channel, text => this.log(text), metadata);
  }
  log(text: string): void { this.emit('log', text); this.emit('change'); }
  receive(incoming: IncomingMessage): void { this.bridge.receive(incoming); }
  async linkIdentity(alias: IdentityAlias): Promise<void> {
    await this.store.linkIdentity(alias);
    this.emit('change');
  }
  setChannelStatus(status: string): void {
    this.channelStatus = status;
    if (status.startsWith('failed:') || status === 'logged-out') this.bridge.disarm();
    this.log(`${this.metadata.channelName}: ${status}`);
  }
  snapshot(): ApplicationSnapshot {
    const routes = this.store.routes();
    const contacts = this.channel.contacts();
    const chats = this.channel.chats();
    const directory = new Map<string, Contact>();
    for (const route of routes) directory.set(route.contactId, { id: route.contactId, name: route.name });
    for (const chat of chats) directory.set(chat.id, { id: chat.id, name: chat.name });
    for (const contact of contacts) directory.set(contact.id, contact);
    return {
      routes, contacts, directory: [...directory.values()].sort((a, b) => a.name.localeCompare(b.name)),
      chats, armed: this.bridge.isArmed(),
      channelStatus: this.channelStatus, assistantStatus: this.assistantStatus,
    };
  }
  async restore(): Promise<void> {
    if (this.store.isRunning() && this.store.routes().some(route => route.enabled)) {
      this.log(`Restoring saved forwarding sessions and their ${this.metadata.assistantName} conversations.`);
      await this.resume();
    } else {
      if (this.channel.hasSavedSession()) this.login();
      this.log('Saved contacts and sessions loaded. Enable a contact to start forwarding.');
    }
  }
  login(): void {
    if (this.closed) return;
    const { channelName } = this.metadata;
    if (this.channelAttempt || this.channelStatus === 'open') {
      this.log(`${channelName} is already ${this.channelStatus === 'open' ? 'connected using your saved login' : 'connecting'}.`);
      return;
    }
    this.channelStatus = 'connecting';
    this.emit('change');
    this.channelAttempt = this.channel.start().catch(error => {
      this.channelStatus = 'failed';
      this.bridge.disarm();
      this.log(`${channelName} connection failed: ${message(error)}`);
    }).finally(() => { this.channelAttempt = null; this.emit('change'); });
  }
  async checkBrowser(): Promise<void> {
    if (this.assistantAttempt) return this.assistantAttempt;
    this.assistantStatus = 'connecting'; this.emit('change');
    this.assistantAttempt = this.assistant.start().then(() => {
      this.assistantStatus = 'connected';
    }).catch(error => { this.assistantStatus = 'failed'; throw error; }).finally(() => {
      this.assistantAttempt = null; this.emit('change');
    });
    return this.assistantAttempt;
  }
  async resume(): Promise<void> {
    if (this.closed) return;
    if (this.resumeAttempt) return this.resumeAttempt;
    if (!this.store.routes().some(route => route.enabled)) throw new Error('Enable a contact for forwarding first.');
    const generation = ++this.generation;
    this.resumeAttempt = (async () => {
      await this.checkBrowser();
      if (this.closed || generation !== this.generation) return;
      await this.store.setRunning(true);
      if (this.closed || generation !== this.generation) return;
      this.login(); this.bridge.arm(); this.log('Forwarding active for enabled sessions.');
    })().finally(() => { this.resumeAttempt = null; this.emit('change'); });
    return this.resumeAttempt;
  }
  async pause(): Promise<void> {
    this.generation++; this.bridge.disarm();
    await this.store.setRunning(false);
    this.log(`All forwarding paused. Saved contacts and ${this.metadata.assistantName} conversation references are unchanged.`);
  }
  async toggle(contact: Contact): Promise<void> {
    await this.setContactEnabled(contact, !this.store.route(contact.id)?.enabled);
  }
  /** Idempotent desired state: repeating a request that already holds changes nothing and does not resume forwarding. */
  async setContactEnabled(contact: Contact, enabled: boolean): Promise<void> {
    const route = this.store.route(contact.id);
    if (enabled) {
      if (route?.enabled) { this.log(`${route.name} is already enabled.`); return; }
      await this.store.enable(contact);
      this.log(`Enabled ${contact.name}. Incoming text will be shared with ${this.metadata.assistantName} and its reply sent back automatically.`);
      await this.resume();
    } else {
      if (!route?.enabled) { this.log(`${contact.name} is already paused.`); return; }
      await this.store.pause(contact.id);
      this.log(`Paused ${route.name}. The ${this.metadata.assistantName} conversation is retained.`);
    }
    this.emit('change');
  }
  /**
   * Resolves a direct contact through the messaging adapter without changing any saved state. The display name keeps the directory
   * priority: channel contacts, then recent chats, then the saved route's name, and only then the resolver's own fallback.
   */
  resolveContact(input: string): Contact {
    const resolved = this.channel.resolveContact(input);
    const id = this.store.canonicalId(resolved.id);
    const known = (list: Contact[]): Contact | undefined => list.find(item => item.id === id || item.id === resolved.id);
    const name = known(this.channel.contacts())?.name ?? known(this.channel.chats())?.name ?? this.store.route(id)?.name ?? resolved.name;
    return { id, name };
  }
  /** Resolves a direct contact, then enables it unless it already is. */
  async addContact(input: string): Promise<Contact> {
    const contact = this.resolveContact(input);
    await this.setContactEnabled(contact, true);
    return contact;
  }
  /**
   * Project picker catalog. Single-flight; the adapter owns an independent connection, so this never touches the delivery assistant session or the channel.
   * Cancellation is explicit: the shared read has its own controller. A caller's `signal` rejects that caller when it aborts; the read itself is cancelled only
   * once every signalled caller has left (callers without a signal keep it alive) or when the application closes. Cancelling the last interested caller
   * resolves only after the adapter has drained its cleanup.
   */
  listProjects(signal?: AbortSignal): Promise<Project[]> {
    if (this.closed) return Promise.reject(new Error('wabgpt is closing.'));
    return this.catalog.join(async shared => (await this.assistant.listProjects(shared)).map(project => ({ ...project })), signal);
  }
  async setProject(contact: Contact, ref: string | null): Promise<void> {
    const { assistantName } = this.metadata;
    const before = this.store.route(contact.id)?.projectRef ?? null;
    await this.store.setProject(contact, ref);
    const route = this.store.route(contact.id);
    const state = route?.enabled ? 'It stays enabled' : 'It stays paused';
    if (route?.projectRef === before) this.log(`${contact.name} already has ${before === null ? `no ${assistantName} project` : `that ${assistantName} project`}; nothing changed. ${state}.`);
    else if (route?.projectRef === null) this.log(`Cleared the ${assistantName} project for ${contact.name}; its saved conversation link was dropped and its next message starts a new conversation. ${state}.`);
    else this.log(`Assigned a ${assistantName} project to ${contact.name}; any earlier conversation link was dropped and its next message starts a new conversation there. ${state}. Use a project with project-only memory.`);
  }
  async setConversationTtl(contact: Contact, minutes: number | null): Promise<void> {
    await this.store.setConversationTtl(contact, minutes);
    const { assistantName } = this.metadata;
    this.log(minutes === null ? `${contact.name}'s ${assistantName} conversation will never expire.` : `${contact.name}'s ${assistantName} conversation now expires ${minutes} minute${minutes === 1 ? '' : 's'} after it started, checked at its next message.`);
  }
  /** Single-flight: concurrent callers wait for the same shutdown. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true; this.generation++; this.bridge.disarm();
      this.catalog.cancel(new Error('wabgpt is closing.'));
      await this.resumeAttempt?.catch(() => undefined);
      await this.assistantAttempt?.catch(() => undefined);
      await this.catalog.drained();
      await this.bridge.idle();
      await Promise.allSettled([this.channel.stop(), this.assistant.stop()]);
    })();
    return this.closing;
  }
}
