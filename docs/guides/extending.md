---
type: Guide
title: Extending wabgpt
description: Add a messaging channel, assistant, storage or frontend by implementing a small interface and changing one composition point.
---

# Extending wabgpt

wabgpt separates a provider-neutral core from concrete adapters and frontends. You extend it by implementing a small interface and changing one composition point. There is no plugin registry, no dynamic loading and no configuration-driven provider selection; that is deliberate for a single-owner tool.

For the behavior these interfaces carry, see [delivery](../concepts/delivery.md) and [conversations](../concepts/conversations.md). For project verification expectations, see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Layout and dependency rule

```
src/core/            contracts.ts  application.ts  bridge.ts  state.ts  duration.ts  single-flight.ts
src/adapters/
  storage/           json-state.ts            StatePersistence on the filesystem
  whatsapp/          whatsapp.ts (factory), directory.ts, inbound/lifecycle helpers
  chatgpt/           chatgpt.ts (factory), references.ts, dom.ts, projects.ts
  browseros/         mcp.ts                   MCP transport shared by delivery and the project catalog
src/interfaces/
  tui/               terminal dashboard
  http/              owner web dashboard (static assets live in web/)
src/infrastructure/  config.ts  lock.ts  console-output.ts  loopback.ts  arguments.ts
src/onboarding/     first-run terminal setup: prepare.ts wizard.ts state.ts terminal.ts browser.ts
src/bootstrap.ts     the only production composition: createApplication, openRuntime
src/cli.ts           entrypoint: TUI (with first-run setup), `setup`, `serve`, `token`
src/serve.ts         server lifecycle: serve, restore after subscribe, stop server then runtime
src/index.ts         supported programmatic exports
```

Key files: [`contracts.ts`](../../src/core/contracts.ts), [`application.ts`](../../src/core/application.ts), [`state.ts`](../../src/core/state.ts), [`bootstrap.ts`](../../src/bootstrap.ts), [`serve.ts`](../../src/serve.ts) and [`index.ts`](../../src/index.ts).

Rule: `src/core` imports nothing from adapters, the filesystem, config, Baileys, BrowserOS or any presentation code. Frontends talk to `Application`, never to concrete providers. Only [`bootstrap.ts`](../../src/bootstrap.ts) knows which concrete adapters exist.

## The contracts

Defined in [`src/core/contracts.ts`](../../src/core/contracts.ts) (doc comments omitted here):

```ts
export type Logger = (message: string) => void;
export interface Contact { id: string; name: string }
export interface RecentChat extends Contact { lastMessageAt: number | null; unread: number; archived: boolean }
export interface IdentityAlias { alias: string; canonical: string }
export interface IncomingMessage {
  id: string;
  contact: Contact;
  text: string;
  acknowledge: () => Promise<void>;   // marks it read in the provider; closes over provider data only
}
export interface MessagingAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  contacts(): Contact[];
  chats(): RecentChat[];
  identities(): IdentityAlias[];
  hasSavedSession(): boolean;
  resolveContact(input: string): Contact;      // throws a user-readable Error for unusable input
  sendText(contactId: string, text: string): Promise<void>;
}
export interface Project { name: string; ref: string }
export interface AssistantReferencePolicy {
  normalizeProject(ref: string): string;
  normalizeConversation(ref: string, projectRef: string | null): string;
}
export interface AssistantAdapter {
  readonly references: AssistantReferencePolicy;
  start(): Promise<void>;
  stop(): Promise<void>;
  listProjects(signal?: AbortSignal): Promise<Project[]>;
  reply(input: {
    conversationRef: string | null;
    projectRef: string | null;
    text: string;
    onConversation: (ref: string) => Promise<void>;
    onSubmitted: () => Promise<void>;
  }): Promise<{ conversationRef: string; text: string }>;
}
```

### Behavioral rules an adapter must keep

These are what the core's guarantees rest on. Tests in `tests/` exercise the existing adapters against them.

- **Opaque ids and references.** The core stores `Contact.id`, `Project.ref` and conversation refs as strings and never parses them. Validation and canonicalization belong to the adapter's `AssistantReferencePolicy`. [`tests/support/core-fixtures.ts`](../../tests/support/core-fixtures.ts) has `opaqueReferences`, a deliberately non-URL scheme used to prove the core does not interpret references.
- **Stable identity.** The same contact must always produce the same `id`. If a provider knows two ids for one person, report them through `identities()` / the identity callback as `{ alias, canonical }`; delivery keys and routes then merge by canonical id.
- **No message bodies at rest.** The core persists ids, names, references and delivery status, not text. Do not add body logging or persistence.
- **No replay of uncertain work.** `reply()` must throw if it cannot tell whether the prompt was accepted. The bridge pauses that route and never resubmits. Call `onConversation(ref)` as soon as a conversation reference exists so the core can persist it, and `onSubmitted()` only after the assistant has actually accepted the prompt: that is what triggers the read receipt.
- **Complete project catalogs.** `listProjects()` returns the full, sorted, unique list or throws. A partial or falsely empty list is a bug; it must use its own connection so it never disturbs delivery. It receives an optional `AbortSignal`: when it aborts, stop any blocked transport or polling wait, drain your cleanup and settle, because `Application.close()` waits for an in-flight catalog and a catalog that ignores the signal can hold the data-directory lock. The first-run setup also uses this call as its proof of a real signed-in session.
- **Pause is honored.** The core checks the route again before sending the reply; `sendText` should do no extra queuing or retrying.
- **Receipts are independent.** `acknowledge` runs separately from the reply path. A slow or failed receipt must not delay a reply.
- **Saved sessions.** `hasSavedSession()` is synchronous and must not touch the network. The `MessagingAdapter` factory receives its credentials location from composition; no environment variables are required by the application and an adapter should not need any.
- **No secrets in logs or errors shown to users.** Frontends render adapter error text. Do not put tokens, QR payloads or raw dependency dumps in it.

## Worked example: a different assistant

The example below is a complete `AssistantAdapter` that echoes the prompt. It shows the shape: a reference policy, `start`/`stop`, a project catalog and `reply` with both callbacks.

This exact code was type-checked with the repository's strict compiler settings and run in a throwaway directory (a symlink to the real `src/core`; no adapter was added to the repository). The run checked the reference policy, a standalone `reply` and a project-scoped `reply` (callback order and returned references, reuse of an existing conversation), then a real `RoutingState` and `Application` with a fake messaging adapter: the contact was enabled, assigned the `demo` project, one incoming message was forwarded, the saved route held a `demo/thread-…` conversation reference, the reply was sent through the channel and the message was acknowledged once. To try it in your checkout, copy it into `src/adapters/echo/echo.ts` and run `npm run check`.

```ts
import type {
  AssistantAdapter, AssistantReferencePolicy, Project,
} from '../../core/contracts.js';

const PROJECT = /^[a-z0-9-]{1,32}$/;
const CONVERSATION = /^(?:([a-z0-9-]{1,32})\/)?thread-([0-9a-f]{8})$/;

function normalizeProject(ref: string): string {
  const value = ref.trim().toLowerCase();
  if (!PROJECT.test(value)) throw new Error('Project must be 1-32 lowercase letters, digits or dashes.');
  return value;
}

const references: AssistantReferencePolicy = {
  normalizeProject,
  normalizeConversation(ref, projectRef) {
    const match = CONVERSATION.exec(ref.trim().toLowerCase());
    if (!match?.[2]) throw new Error('Conversation must look like [project/]thread-<8 hex>.');
    const scope = match[1] ?? null;
    if (scope !== (projectRef === null ? null : normalizeProject(projectRef))) {
      throw new Error('Conversation does not belong to the assigned project.');
    }
    return `${scope ? `${scope}/` : ''}thread-${match[2]}`;
  },
};

export function createEcho(): AssistantAdapter {
  let started = false;
  return {
    references,
    async start() { started = true; },
    async stop() { started = false; },
    async listProjects(): Promise<Project[]> {
      return [{ name: 'Demo', ref: 'demo' }];
    },
    async reply({ conversationRef, projectRef, text, onConversation, onSubmitted }) {
      if (!started) throw new Error('Echo assistant is not started.');
      const ref = conversationRef
        ?? `${projectRef ? `${projectRef}/` : ''}thread-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`;
      await onConversation(ref);   // persisted before anything can be lost
      await onSubmitted();         // the "prompt" was accepted; read receipt may now be sent
      return { conversationRef: ref, text: `echo: ${text}` };
    },
  };
}
```

Wire it by replacing the assistant in [`src/bootstrap.ts`](../../src/bootstrap.ts):

```ts
import { createEcho } from './adapters/echo/echo.js';
// in createApplication():
const assistant = createEcho();   // instead of createChatGPT({ endpoint, logger })
const store = await RoutingState.load(createJsonStatePersistence(config.dataDir), assistant.references);
```

The `RoutingState` and every frontend work unchanged because they only see the contracts. Name the providers for users through the `Application` metadata (see below).

## Composition

```ts
const application = new Application(
  { configPath, channelName: 'WhatsApp', assistantName: 'ChatGPT' },   // names shown in logs and UI
  store,        // RoutingState.load(persistence, assistant.references)
  channel,      // MessagingAdapter
  assistant,    // AssistantAdapter
);
```

`createApplication(config)` in [`bootstrap.ts`](../../src/bootstrap.ts) does exactly this for the real providers and returns an unstarted `Application`. `openRuntime(config, options?)` additionally sets `umask 077`, takes the data directory's single-writer lock (`bridge.lock`) for the process lifetime, routes dependency console output into the application log, and returns `{ application, close() }`. Its optional `prepare(config)` hook runs after the lock is held and before any provider exists, and returns the config the `Application` is built from; the terminal's first-run setup uses it to choose the BrowserOS endpoint (including starting the [managed Docker browser](managed-browser.md)) before the assistant adapter is created. If `prepare` throws, the lock is released and the console restored before the error propagates. Every frontend must go through `openRuntime`: two writers on one credential directory corrupt WhatsApp sessions. If you embed `Application` from [`src/index.ts`](../../src/index.ts) instead, you are responsible for holding an equivalent lock.

Message callbacks flow from the adapter to the application: `application.receive(incoming)`, `application.setChannelStatus(status)`, `application.linkIdentity(alias)`, and `application.emit('qr', rawPayload)` for pairing codes (the raw payload string; each frontend renders it).

## Adding a messaging channel

Implement `MessagingAdapter` plus a factory taking the same kind of callbacks as `createWhatsApp` (`onMessage`, `onStatus`, `onUpdate`, `onIdentity`, `onQr`, `logger`, and a credentials directory). Map provider message ids and sender ids to opaque `Contact.id` strings, drop group, status and outgoing messages inside the adapter before calling `onMessage`, and keep any provider types (such as WhatsApp receipt keys) private to the adapter. Then construct it in `bootstrap.ts`.

## Replacing storage

`StatePersistence` is the whole storage port:

```ts
interface StatePersistence {
  read(): Promise<unknown | undefined>;       // raw stored document, or undefined if none
  write(state: PersistedState): Promise<void>; // must replace atomically
}
```

`RoutingState.load(persistence, references)` validates what `read()` returns and migrates the legacy v1 document to the current v2 schema in memory; nothing is written until validation succeeds. `createJsonStatePersistence(dataDir)` is the filesystem implementation (directory mode 0700, file mode 0600, temp file plus rename). When its first write replaces a document of a different schema version, it first copies the old document to `state.json.v<version>.bak` (mode 0600, never overwritten), so an upgraded v1 file is kept as `state.json.v1.bak` and a downgrade stays possible. A replacement must keep writes private and atomic, and must serialize concurrent writes. Business rules (unique project ownership, TTL, delivery journal) stay in `RoutingState`; do not reimplement them in an adapter. See [local data](../reference/local-data.md) for what the default implementation stores.

## Adding a frontend

Depend only on `Application`:

- Read `application.snapshot()` (`routes`, `contacts`, `directory`, `chats`, `armed`, `channelStatus`, `assistantStatus`).
- Subscribe to `change`, `log` and `qr` events and remove listeners on shutdown.
- Mutate through `login()`, `checkBrowser()`, `resume()`, `pause()`, `toggle(contact)`, `setContactEnabled(contact, boolean)`, `resolveContact(input)` (non-mutating lookup; it never enables or saves anything), `addContact(input)` (resolves, then enables), `listProjects(signal?)`, `setProject(contact, ref | null)`, `setConversationTtl(contact, minutes | null)` and `close()`. `parseConversationTtl` / `formatConversationTtl` in [`core/duration.ts`](../../src/core/duration.ts) are shared by the TUI and HTTP frontends.
- Call `application.restore()` after you are subscribed, so early QR codes and status changes are not missed.
- Do not close the application from a frontend that did not create the runtime; the creator of the runtime owns `close()`.

The HTTP frontend follows this pattern: `startHttpServer({ application, settings })` returns `{ url, close() }` and neither restores nor closes the application. The lifecycle around it lives in [`src/serve.ts`](../../src/serve.ts): `serveUntilStopped({ runtime, settings, stopped, output })` starts the server, then calls `application.restore()` once the server is subscribed (a failed restore is logged and leaves the dashboard up with forwarding disarmed), and on stop closes the server first and the runtime second. A new long-running frontend should reuse that ordering. See the [HTTP API reference](../reference/http-api.md) for the authentication, session and API rules, and [Run wabgpt as a server](server.md) for running it.

## Testing an extension

- Tests live in `tests/*.test.ts` and run with `npm test` (`tsx --test`). Type checking is `npm run check`.
- [`tests/support/core-fixtures.ts`](../../tests/support/core-fixtures.ts) provides in-memory persistence, temporary directories and the opaque reference policy; use them to drive `RoutingState` and `Application` with fake adapters, no network and no real accounts.
- Never write tests that send real WhatsApp messages or ChatGPT prompts, and use synthetic ids and names in fixtures.
