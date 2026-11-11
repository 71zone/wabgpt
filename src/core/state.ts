import { z } from 'zod';
import type { AssistantReferencePolicy, Contact, IdentityAlias } from './contracts.js';

export const DEFAULT_CONVERSATION_TTL_MINUTES = 1440;
const CURRENT_VERSION = 2;

const ttlSchema = z.number().int().positive().refine(minutes => Number.isSafeInteger(minutes * 60_000), 'Conversation lifetime is out of range.');
const timestampSchema = z.number().int().nonnegative();
const deliveryStatus = z.enum(['working', 'done', 'failed']);

const routeSchema = z.object({
  contactId: z.string().min(1), name: z.string(), enabled: z.boolean(),
  conversationRef: z.string().min(1).nullable(), projectRef: z.string().min(1).nullable(),
  conversationTtlMinutes: ttlSchema.nullable(), conversationStartedAt: timestampSchema.nullable(),
  error: z.string().nullable(),
});
const deliverySchema = z.object({ key: z.string(), contactId: z.string().min(1), status: deliveryStatus });
const stateSchema = z.object({
  version: z.literal(CURRENT_VERSION), running: z.boolean(),
  aliases: z.array(z.object({ alias: z.string().min(1), canonical: z.string().min(1) })),
  routes: z.array(routeSchema), deliveries: z.array(deliverySchema),
});

/** Version 1 was the WhatsApp/ChatGPT-only shape. It is read, never written. */
const legacyStateSchema = z.object({
  version: z.literal(1), running: z.boolean().default(true),
  aliases: z.array(z.object({ lid: z.string().regex(/^\d+@lid$/), pn: z.string().regex(/^\d+@s\.whatsapp\.net$/) })).default([]),
  routes: z.array(z.object({
    jid: z.string(), name: z.string(), enabled: z.boolean(), conversationUrl: z.string().url().nullable(), error: z.string().nullable(),
    projectUrl: z.string().nullable().default(null),
    conversationTtlMinutes: ttlSchema.nullable().default(DEFAULT_CONVERSATION_TTL_MINUTES),
    conversationStartedAt: timestampSchema.nullable().default(null),
  })),
  deliveries: z.array(z.object({ key: z.string(), jid: z.string(), status: deliveryStatus })),
});

export type Route = z.infer<typeof routeSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export type PersistedState = z.infer<typeof stateSchema>;
/** Storage port. `read` returns the raw stored document or undefined when nothing is stored yet; `write` replaces it atomically. */
export interface StatePersistence {
  read(): Promise<unknown | undefined>;
  write(state: PersistedState): Promise<void>;
}

function describe(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/** Validates a stored document and migrates it to the current version in memory. Never writes. */
function parseStored(raw: unknown): PersistedState {
  const version = typeof raw === 'object' && raw !== null && 'version' in raw ? raw.version : undefined;
  try {
    if (version === 1) {
      const legacy = legacyStateSchema.parse(raw);
      return stateSchema.parse({
        version: CURRENT_VERSION, running: legacy.running,
        aliases: legacy.aliases.map(({ lid, pn }) => ({ alias: lid, canonical: pn })),
        routes: legacy.routes.map(route => ({
          contactId: route.jid, name: route.name, enabled: route.enabled,
          conversationRef: route.conversationUrl, projectRef: route.projectUrl,
          conversationTtlMinutes: route.conversationTtlMinutes, conversationStartedAt: route.conversationStartedAt, error: route.error,
        })),
        deliveries: legacy.deliveries.map(({ key, jid, status }) => ({ key, contactId: jid, status })),
      });
    }
    if (version !== CURRENT_VERSION) throw new Error(`Unsupported saved state version ${String(version)}. This build reads versions 1 and ${CURRENT_VERSION}.`);
    return stateSchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) throw new Error(`Saved state is invalid: ${describe(error)}`);
    throw error;
  }
}

function aliasMap(aliases: IdentityAlias[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const { alias, canonical } of aliases) {
    if (alias === canonical) throw new Error(`Saved state aliases ${alias} to itself.`);
    if (map.has(alias) && map.get(alias) !== canonical) throw new Error(`Saved state gives ${alias} more than one canonical identity.`);
    map.set(alias, canonical);
  }
  for (const canonical of map.values()) if (map.has(canonical)) throw new Error(`Saved state chains identity aliases through ${canonical}.`);
  return map;
}

export class RoutingState {
  private writes: Promise<void> = Promise.resolve();
  private readonly aliases: Map<string, string>;
  private constructor(private data: PersistedState, private readonly persistence: StatePersistence, private readonly references: AssistantReferencePolicy, private readonly now: () => number) {
    this.aliases = aliasMap(data.aliases);
  }

  /**
   * Reads, validates and (for legacy version 1) migrates saved state entirely in memory. Nothing is written
   * unless every check passes, so a rejected load leaves the stored document byte-for-byte untouched.
   */
  static async load(persistence: StatePersistence, references: AssistantReferencePolicy, now: () => number = Date.now): Promise<RoutingState> {
    const raw = await persistence.read();
    const data: PersistedState = raw === undefined ? { version: CURRENT_VERSION, running: false, aliases: [], routes: [], deliveries: [] } : parseStored(raw);
    const canonical = aliasMap(data.aliases);
    const projects = new Map<string, string>();
    const conversations = new Map<string, string>();
    const seen = new Set<string>();
    const baseline = now();
    if (!Number.isSafeInteger(baseline) || baseline < 0) throw new Error('Clock returned an unusable timestamp.');
    for (const route of data.routes) {
      if (seen.has(route.contactId)) throw new Error(`Saved state has more than one route for ${route.contactId}.`);
      seen.add(route.contactId);
      const owner = canonical.get(route.contactId) ?? route.contactId;
      if (route.projectRef !== null) {
        route.projectRef = references.normalizeProject(route.projectRef);
        const previous = projects.get(route.projectRef);
        if (previous !== undefined && previous !== owner) throw new Error(`Saved state assigns one project to more than one contact (${route.projectRef}). Fix the saved state before starting.`);
        projects.set(route.projectRef, owner);
      }
      if (route.conversationRef !== null) {
        try { route.conversationRef = references.normalizeConversation(route.conversationRef, route.projectRef); }
        catch (error) { throw new Error(`Saved conversation for ${route.name} does not match its saved project: ${error instanceof Error ? error.message : String(error)}`); }
        const previous = conversations.get(route.conversationRef);
        if (previous !== undefined && previous !== owner) throw new Error(`Saved state assigns one conversation to more than one contact (${route.conversationRef}). Fix the saved state before starting.`);
        conversations.set(route.conversationRef, owner);
        if (route.conversationStartedAt === null) route.conversationStartedAt = baseline;
      }
    }
    for (const delivery of data.deliveries) {
      if (delivery.status !== 'working') continue;
      delivery.status = 'failed';
      const owner = canonical.get(delivery.contactId) ?? delivery.contactId;
      const route = data.routes.find(item => (canonical.get(item.contactId) ?? item.contactId) === owner);
      if (route) { route.enabled = false; route.error = 'Interrupted delivery. Inspect both conversations before enabling again. The message will not be replayed.'; }
    }
    const state = new RoutingState(data, persistence, references, now);
    await state.save();
    return state;
  }

  routes(): Route[] { return this.data.routes.map(route => ({ ...route })); }
  route(contactId: string): Route | undefined {
    const id = this.canonicalId(contactId);
    const route = this.data.routes.find(item => item.contactId === id);
    return route && { ...route };
  }
  isRunning(): boolean { return this.data.running; }
  async setRunning(running: boolean): Promise<void> { this.data.running = running; await this.save(); }
  canonicalId(id: string): string { return this.aliases.get(id) ?? id; }
  /**
   * Delivery keys are `<contactId>:<messageId>` by convention, but ids are opaque and may contain ':'. The owning contact is therefore
   * always passed explicitly: a key that starts with that exact id gets the canonical id as its prefix; any other key is left as is.
   */
  private ownerKey(key: string, contactId: string): string {
    const prefix = `${contactId}:`;
    return key.startsWith(prefix) ? `${this.canonicalId(contactId)}:${key.slice(prefix.length)}` : key;
  }
  /** Journal identity is (canonical contact, owner-normalized key), so equal raw keys of different contacts never collide. */
  private findDelivery(key: string, contactId: string): Delivery | undefined {
    const identity = JSON.stringify([this.canonicalId(contactId), this.ownerKey(key, contactId)]);
    return this.data.deliveries.find(row => JSON.stringify([this.canonicalId(row.contactId), this.ownerKey(row.key, row.contactId)]) === identity);
  }
  private hasWorkingDelivery(contactId: string): boolean {
    return this.data.deliveries.some(delivery => delivery.status === 'working' && this.canonicalId(delivery.contactId) === contactId);
  }
  private pausedRoute(contact: Contact): Route {
    return { contactId: contact.id, name: contact.name, enabled: false, conversationRef: null, error: null, projectRef: null, conversationTtlMinutes: DEFAULT_CONVERSATION_TTL_MINUTES, conversationStartedAt: null };
  }

  async linkIdentity({ alias, canonical }: IdentityAlias): Promise<void> {
    if (!alias || !canonical || alias === canonical) throw new Error('An identity alias needs two different identities.');
    if (this.aliases.has(canonical)) throw new Error(`${canonical} is itself an alias and cannot be a canonical identity.`);
    for (const target of this.aliases.values()) if (target === alias) throw new Error(`${alias} is already a canonical identity and cannot become an alias.`);
    const source = this.data.routes.find(route => route.contactId === alias);
    const target = this.data.routes.find(route => route.contactId === canonical);
    if (source?.conversationRef && target?.conversationRef && source.conversationRef !== target.conversationRef) {
      throw new Error(`Two conversations are configured for the same contact (${alias}, ${canonical}). Neither conversation was discarded; inspect the saved session configuration before merging.`);
    }
    if (source?.projectRef && target?.projectRef && source.projectRef !== target.projectRef) {
      throw new Error(`Two projects are configured for the same contact (${alias}, ${canonical}). Neither project was discarded; clear one before merging.`);
    }
    if (source && target) {
      const conversation = target.conversationRef ?? source.conversationRef;
      if (conversation) {
        try { this.references.normalizeConversation(conversation, target.projectRef ?? source.projectRef); }
        catch { throw new Error(`The saved conversation of one of the same contact's routes (${alias}, ${canonical}) does not belong to the other route's project. Neither was discarded; clear the project or conversation before merging.`); }
      }
    }
    const existing = this.data.aliases.find(mapping => mapping.alias === alias);
    let changed = existing?.canonical !== canonical || source !== undefined;
    if (existing) existing.canonical = canonical;
    else this.data.aliases.push({ alias, canonical });
    this.aliases.set(alias, canonical);
    if (source && target) {
      const owner = !target.conversationRef && source.conversationRef ? source : target;
      const peer = owner === source ? target : source;
      const ttl = owner.conversationTtlMinutes === DEFAULT_CONVERSATION_TTL_MINUTES ? peer.conversationTtlMinutes : owner.conversationTtlMinutes;
      if (target.conversationRef) {
        if (source.conversationRef) target.conversationStartedAt = [target.conversationStartedAt, source.conversationStartedAt].reduce<number | null>((earliest, value) => value === null ? earliest : earliest === null ? value : Math.min(earliest, value), null);
      } else {
        target.conversationRef = source.conversationRef;
        target.conversationStartedAt = source.conversationStartedAt;
      }
      target.projectRef ??= source.projectRef;
      target.conversationTtlMinutes = ttl;
      target.error ??= source.error;
      target.enabled = (target.enabled || source.enabled) && !target.error;
      this.data.routes = this.data.routes.filter(route => route !== source);
    } else if (source) source.contactId = canonical;
    const deliveries = new Map<string, Delivery>();
    const priority = { working: 2, done: 1, failed: 0 };
    for (const delivery of this.data.deliveries) {
      const contactId = this.canonicalId(delivery.contactId);
      const key = this.ownerKey(delivery.key, delivery.contactId);
      const identity = JSON.stringify([contactId, key]);
      if (contactId !== delivery.contactId || key !== delivery.key || deliveries.has(identity)) changed = true;
      const previous = deliveries.get(identity);
      if (!previous || priority[delivery.status] > priority[previous.status]) deliveries.set(identity, { ...delivery, contactId, key });
    }
    this.data.deliveries = [...deliveries.values()];
    if (changed) await this.save();
  }
  async enable(contact: Contact): Promise<void> {
    contact = { ...contact, id: this.canonicalId(contact.id) };
    const existing = this.data.routes.find(route => route.contactId === contact.id);
    if (existing) { existing.enabled = true; existing.error = null; existing.name = contact.name; }
    else this.data.routes.push({ ...this.pausedRoute(contact), enabled: true });
    await this.save();
  }
  async pause(contactId: string, error: string | null = null): Promise<void> {
    contactId = this.canonicalId(contactId);
    const route = this.data.routes.find(item => item.contactId === contactId);
    if (!route) throw new Error('Contact has no route.');
    route.enabled = false; route.error = error;
    await this.save();
  }
  /** Assigns or clears the assistant project. Creates a paused route for an untouched contact. A changed project drops the local conversation link. */
  async setProject(contact: Contact, ref: string | null): Promise<void> {
    const contactId = this.canonicalId(contact.id);
    const project = ref === null ? null : this.references.normalizeProject(ref);
    if (this.hasWorkingDelivery(contactId)) throw new Error('A message is being delivered for this contact. Change the project after it finishes.');
    if (project !== null && this.data.routes.some(item => this.canonicalId(item.contactId) !== contactId && item.projectRef === project)) throw new Error('Project already belongs to another contact.');
    const route = this.data.routes.find(item => item.contactId === contactId);
    if (!route) this.data.routes.push({ ...this.pausedRoute({ id: contactId, name: contact.name }), projectRef: project });
    else if (route.projectRef === project) return;
    else { route.projectRef = project; route.conversationRef = null; route.conversationStartedAt = null; }
    await this.save();
  }
  /** Sets the fixed conversation lifetime in minutes, or null to never expire. The lifetime still counts from the existing conversation's birth. */
  async setConversationTtl(contact: Contact, minutes: number | null): Promise<void> {
    const contactId = this.canonicalId(contact.id);
    if (minutes !== null && !(Number.isSafeInteger(minutes) && minutes > 0 && Number.isSafeInteger(minutes * 60_000))) throw new Error('Conversation lifetime must be a positive whole number of minutes.');
    if (this.hasWorkingDelivery(contactId)) throw new Error('A message is being delivered for this contact. Change the lifetime after it finishes.');
    const route = this.data.routes.find(item => item.contactId === contactId);
    if (!route) this.data.routes.push({ ...this.pausedRoute({ id: contactId, name: contact.name }), conversationTtlMinutes: minutes });
    else if (route.conversationTtlMinutes === minutes) return;
    else route.conversationTtlMinutes = minutes;
    await this.save();
  }
  async conversation(contactId: string, ref: string): Promise<void> {
    contactId = this.canonicalId(contactId);
    const route = this.data.routes.find(item => item.contactId === contactId);
    if (!route) throw new Error('Contact has no route.');
    const normalized = this.references.normalizeConversation(ref, route.projectRef);
    if (this.data.routes.some(item => this.canonicalId(item.contactId) !== contactId && item.conversationRef === normalized)) throw new Error('Conversation already belongs to another contact.');
    if (route.conversationRef === normalized && route.conversationStartedAt !== null) return;
    route.conversationRef = normalized;
    route.conversationStartedAt = this.now();
    await this.save();
  }
  /** Drops an expired conversation link before submission and returns the current route. Fixed lifetime from the first persisted reference; never sliding. */
  async refreshConversation(contactId: string): Promise<Route | undefined> {
    contactId = this.canonicalId(contactId);
    const route = this.data.routes.find(item => item.contactId === contactId);
    if (!route) return undefined;
    const { conversationRef, conversationStartedAt, conversationTtlMinutes } = route;
    if (conversationRef !== null && conversationStartedAt !== null && conversationTtlMinutes !== null && this.now() >= conversationStartedAt + conversationTtlMinutes * 60_000) {
      route.conversationRef = null; route.conversationStartedAt = null;
      await this.save();
    }
    return { ...route };
  }
  async claim(key: string, contactId: string): Promise<boolean> {
    if (this.findDelivery(key, contactId)) return false;
    this.data.deliveries.push({ key: this.ownerKey(key, contactId), contactId: this.canonicalId(contactId), status: 'working' });
    await this.save();
    return true;
  }
  async finish(key: string, contactId: string, status: 'done' | 'failed'): Promise<void> {
    const delivery = this.findDelivery(key, contactId);
    if (!delivery) throw new Error('Unknown delivery.');
    delivery.status = status;
    await this.save();
  }
  /** Snapshots synchronously, then writes in call order so a slow earlier write can never overwrite a newer one. */
  private save(): Promise<void> {
    const snapshot = structuredClone(this.data);
    const next = this.writes.then(() => this.persistence.write(snapshot));
    this.writes = next.catch(() => undefined);
    return next;
  }
}
