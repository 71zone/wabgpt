import type { Application } from '../../core/application.js';
import { formatConversationTtl } from '../../core/duration.js';
import { DEFAULT_CONVERSATION_TTL_MINUTES } from '../../core/state.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** One visible line of untrusted text: no control or bidirectional-override characters, whitespace collapsed, length bounded. */
export function visibleText(text: string, max = 200): string {
  const line = text.replace(CONTROL_CHARACTERS, ' ').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Error text safe for an HTTP response: single line, bounded, with any URLs (BrowserOS endpoints, page addresses) removed. */
export function publicMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const text = visibleText(raw.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[address]'), 300);
  return text || fallback;
}

export interface ContactView {
  id: string;
  name: string;
  enabled: boolean;
  /** Saved forwarding settings exist for this contact (it may still be paused). */
  hasRoute: boolean;
  /** Last error that paused this contact, if any. */
  error: string | null;
  projectRef: string | null;
  ttlMinutes: number | null;
  ttl: string;
  conversation: { active: boolean; startedAt: number | null; expiresAt: number | null; expired: boolean };
  saved: boolean;
  lastMessageAt: number | null;
  unread: number;
  archived: boolean;
}

export interface StateView {
  app: { channelName: string; assistantName: string };
  armed: boolean;
  channelStatus: string;
  assistantStatus: string;
  enabledCount: number;
  /** Server clock for expiry display. */
  now: number;
  contacts: ContactView[];
}

export interface ActivityEntry { id: number; at: number; message: string }

export function buildState(application: Application, now = Date.now()): StateView {
  const snapshot = application.snapshot();
  const routes = new Map(snapshot.routes.map(route => [route.contactId, route]));
  const saved = new Set(snapshot.contacts.map(contact => contact.id));
  const chats = new Map(snapshot.chats.map(chat => [chat.id, chat]));
  const contacts = snapshot.directory.map((contact): ContactView => {
    const route = routes.get(contact.id);
    const chat = chats.get(contact.id);
    const ttlMinutes = route ? route.conversationTtlMinutes : DEFAULT_CONVERSATION_TTL_MINUTES;
    const active = route?.conversationRef != null;
    const startedAt = route?.conversationStartedAt ?? null;
    const expiresAt = active && ttlMinutes !== null && startedAt !== null ? startedAt + ttlMinutes * 60_000 : null;
    return {
      id: contact.id,
      name: visibleText(contact.name, 120) || contact.id,
      enabled: route?.enabled === true,
      hasRoute: route !== undefined,
      error: route?.error ? publicMessage(route.error, 'Forwarding stopped.') : null,
      projectRef: route?.projectRef ?? null,
      ttlMinutes,
      ttl: formatConversationTtl(ttlMinutes),
      conversation: { active, startedAt, expiresAt, expired: expiresAt !== null && now >= expiresAt },
      saved: saved.has(contact.id),
      lastMessageAt: chat?.lastMessageAt ?? null,
      unread: chat?.unread ?? 0,
      archived: chat?.archived ?? false,
    };
  });
  return {
    app: { channelName: visibleText(application.metadata.channelName, 60), assistantName: visibleText(application.metadata.assistantName, 60) },
    armed: snapshot.armed,
    channelStatus: publicMessage(snapshot.channelStatus, 'unknown'),
    assistantStatus: publicMessage(snapshot.assistantStatus, 'unknown'),
    enabledCount: snapshot.routes.filter(route => route.enabled).length,
    now,
    contacts,
  };
}

export interface ProjectView { name: string; ref: string; owner: { id: string; name: string } | null }

/** Catalog from the assistant plus the contact (if any) that already owns each project, so the picker can disable taken ones. */
export async function buildProjects(application: Application): Promise<ProjectView[]> {
  const catalog = await application.listProjects();
  const owners = new Map<string, { id: string; name: string }>();
  for (const route of application.snapshot().routes) {
    if (route.projectRef) owners.set(route.projectRef, { id: route.contactId, name: visibleText(route.name, 120) || route.contactId });
  }
  return catalog.map(project => ({ name: visibleText(project.name, 200) || 'Untitled project', ref: project.ref, owner: owners.get(project.ref) ?? null }));
}
