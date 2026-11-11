import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJsonStatePersistence } from '../../src/adapters/storage/json-state.js';
import { chatgptReferences } from '../../src/adapters/chatgpt/references.js';
import type { AssistantAdapter, AssistantReferencePolicy, MessagingAdapter } from '../../src/core/contracts.js';
import { RoutingState, type PersistedState, type StatePersistence } from '../../src/core/state.js';

export const aliasPair = { alias: '123456789@lid', canonical: '14155551234@s.whatsapp.net' };
export const projectA = `https://chatgpt.com/g/g-p-${'a'.repeat(32)}`;
export const projectB = `https://chatgpt.com/g/g-p-${'b'.repeat(32)}`;
export const minute = 60_000;

/**
 * A second, unrelated reference scheme: opaque non-URL strings (`ws:<name>`, `ws:<name>/thread:<id>`, `thread:<id>`).
 * Used to prove that core stores whatever the injected policy canonicalizes and never parses references itself.
 */
export const opaqueReferences: AssistantReferencePolicy = (() => {
  const project = (ref: string): string => {
    const match = /^ws:([A-Za-z0-9-]{1,32})$/.exec(ref.trim());
    if (!match?.[1]) throw new Error('Workspace reference must look like ws:<name>.');
    return `ws:${match[1].toLowerCase()}`;
  };
  return {
    normalizeProject: project,
    normalizeConversation(ref, projectRef) {
      const expected = projectRef === null ? null : project(projectRef);
      const match = /^(?:(ws:[A-Za-z0-9-]{1,32})\/)?thread:([0-9a-z]+)$/.exec(ref.trim());
      if (!match?.[2]) throw new Error('Thread reference must look like [ws:<name>/]thread:<id>.');
      const scope = match[1] ? project(match[1]) : null;
      if (scope !== expected) throw new Error('Thread does not belong to the assigned workspace.');
      return `${scope ? `${scope}/` : ''}thread:${match[2]}`;
    },
  };
})();

export async function withDirectory(run: (directory: string) => Promise<void>, prefix = 'wabgpt-core-'): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Loads RoutingState from `<directory>/state.json` through the real JSON adapter. */
export function loadState(directory: string, now?: () => number, references: AssistantReferencePolicy = chatgptReferences): Promise<RoutingState> {
  return RoutingState.load(createJsonStatePersistence(directory), references, now);
}

/** In-memory persistence that records every write; `stored` is what a later load would read. */
export function memoryPersistence(initial?: unknown): StatePersistence & { writes: PersistedState[]; stored(): unknown } {
  let stored = initial;
  const writes: PersistedState[] = [];
  return {
    writes,
    stored: () => stored,
    read: async () => stored,
    write: async state => { writes.push(state); stored = JSON.parse(JSON.stringify(state)); },
  };
}

export const providerNames = { channelName: 'WhatsApp', assistantName: 'ChatGPT' };

/** Inert messaging adapter for core tests; override only what a test observes. */
export function fakeChannel(overrides: Partial<MessagingAdapter> = {}): MessagingAdapter {
  return {
    start: async () => {}, stop: async () => {},
    contacts: () => [], chats: () => [], identities: () => [],
    hasSavedSession: () => false,
    resolveContact: input => { throw new Error(`Unexpected contact lookup: ${input}`); },
    sendText: async () => {},
    ...overrides,
  };
}

/** Inert assistant adapter for core tests; `reply` rejects unless a test supplies one. */
export function fakeAssistant(overrides: Partial<AssistantAdapter> = {}): AssistantAdapter {
  return {
    references: chatgptReferences,
    start: async () => {}, stop: async () => {},
    listProjects: async () => [],
    reply: async () => { throw new Error('Unexpected prompt submission'); },
    ...overrides,
  };
}
