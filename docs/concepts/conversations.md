---
type: Concept
title: Conversations, projects and lifetime
description: How each contact maps to a saved ChatGPT conversation, how projects scope its memory, and how the fixed lifetime resets it.
---

# Conversations, projects and lifetime

wabgpt is built for one owner. Each enabled contact has its own saved ChatGPT conversation, and a reply uses the selected ChatGPT web model and that conversation's context. Two contacts never share one conversation. Setting a project and lifetime is done in the [terminal dashboard](../reference/terminal.md) (G and T keys) or the [HTTP API](../reference/http-api.md#routes); both are saved in `state.json` and survive restarts ([Local data](../reference/local-data.md)). Source: [`src/core/state.ts`](../../src/core/state.ts), [`src/core/duration.ts`](../../src/core/duration.ts), [`src/adapters/chatgpt/projects.ts`](../../src/adapters/chatgpt/projects.ts), [`src/adapters/chatgpt/references.ts`](../../src/adapters/chatgpt/references.ts).

## Conversation ownership

The bridge saves a new ChatGPT conversation URL, with its start time, as soon as one is assigned, and prevents two contacts from sharing it. The saved URL is the contact's conversation until it expires or the project changes. Conversation references are never sent to the web dashboard; the API reports only whether a conversation is saved and when it expires. The same person known by two WhatsApp identifiers is one contact; see [Delivery](delivery.md#identity-aliases).

## Projects

Each contact can be bound to a ChatGPT project, chosen by name from a live list (the picker details are in [Terminal dashboard](../reference/terminal.md#project-picker)). The stored value is the canonical `https://chatgpt.com/g/g-p-<32 hex>` reference; you never paste a URL.

- **Ownership.** A project already used by another contact cannot be assigned; the store enforces this too. Use a separate project per contact.
- **Memory is yours to set.** Set each project to project-only memory in ChatGPT. wabgpt cannot check or change project settings, memory or instructions and never creates projects. Setup only reminds you. See [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt) for how project memory modes work and their limits: project-only chats can reference only conversations within the same project, your account and workspace must allow memory, and a mode change on an existing project can take a few hours to apply.
- **New chats start in the project.** With a project, a contact's new chat starts in that project, and the bridge stops before sending if ChatGPT cannot open the project or lands elsewhere.
- **Changing resets the chat.** Changing or clearing a contact's project resets its saved conversation URL, so the next message starts a new chat in the new place. The old chat is not imported, moved or deleted; it stays in ChatGPT where it was. Setting the same project again changes nothing.
- **Not while busy.** A project cannot be changed while that contact's message is being processed.
- **Never enables forwarding.** Configuring a project leaves the contact paused until you enable it. Enabling explicitly allows their incoming text to be shared with ChatGPT and ChatGPT's response to be sent from your WhatsApp account; the app forwards the original text without extra system instructions.

## Lifetime

Each contact has a fixed conversation lifetime. The default is 24 hours; `never` disables expiry. Accepted forms are minutes (`90`, `90m`), hours (`12h`) and days (`3d`), a whole number of minutes between 1 minute and 3650 days, or `never`; empty input means 24 hours.

- **The clock is fixed.** It starts when the first conversation URL is saved. Later messages do not extend it.
- **Expiry is lazy.** After expiry, the saved URL and start time are cleared locally when the next incoming message arrives and before it is submitted, so that message opens a new chat (in the contact's project, if set). Nothing happens on a timer or while a reply is being produced, and nothing is deleted in ChatGPT; old chats remain there for you to read.
- **Older conversations.** Conversations saved before this feature existed have no recorded start, so their clock starts once at the first load after upgrading; their history is preserved until that lifetime runs out.
- **Changing a lifetime** applies to the current conversation too, measured from its original start.
- **Thread only.** The lifetime limits only the active conversation thread. It does not limit context ChatGPT keeps or retrieves across a project.
- **No cost promise.** ChatGPT web is a subscription, not per-token API billing, so shorter or longer lifetimes make no cost or token-cache promise, and no latency saving is guaranteed. wabgpt does not use the OpenAI API.

For terms and account-use caveats about driving ChatGPT web through a browser, read the [motivation and policy notice](motivation.md).
