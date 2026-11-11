---
type: Reference
title: Local data
description: What wabgpt stores in its data directory, what survives a restart, file privacy, state versioning and the single-writer lock.
---

# Local data

Everything wabgpt remembers lives in one data directory (`dataDir` in [Configuration](configuration.md); `~/.wa-chatgpt` by default). Source: [`src/adapters/storage/json-state.ts`](../../src/adapters/storage/json-state.ts), [`src/core/state.ts`](../../src/core/state.ts), [`src/infrastructure/lock.ts`](../../src/infrastructure/lock.ts), [`src/onboarding/state.ts`](../../src/onboarding/state.ts), [`src/adapters/whatsapp/directory.ts`](../../src/adapters/whatsapp/directory.ts).

## What is stored

| Path in the data directory | Contents |
| --- | --- |
| `state.json` | Forwarding sessions and the delivery journal: contact names, JIDs, project and conversation references, lifetimes, conversation start times, activity metadata, processed message IDs and verified identity aliases. |
| `whatsapp/` | WhatsApp linked-device credentials and the persisted contact/chat directory. Do not share this directory. |
| `onboarding.json` | Only first-run setup progress: which browser you chose, the stage reached and timestamps. Also remembers your previous native `browserMcpUrl` when the managed browser replaces it. |
| `server-token` | The owner token for `wabgpt serve`, unless `server.tokenFile` points elsewhere. Mode 0600. |
| `bridge.lock` | The single-writer lock, present only while a process runs. |
| `state.json.v1.bak` | Backup of an older-format state file; see below. |

Message bodies and reply bodies are **not** stored. The app does not download or persist full WhatsApp message transcripts. Files are private to your OS account (directory 0700, files 0600). For backing up, restoring and resetting the directory see [Maintenance](../runbooks/maintenance.md).

## What survives a restart

- WhatsApp linked-device credentials reconnect without another QR scan unless the session was unlinked or expired.
- Synced contact names, phone/LID identity mappings, recent direct chats and their activity metadata are saved to disk and are available before another history sync arrives.
- Enabled/paused contact choices, each contact's project, lifetime and ChatGPT conversation URL, and the time that conversation started are retained.
- Previously active forwarding resumes automatically. A global pause also survives restart. Sessions paused after a delivery error stay paused until explicitly enabled again. First-run setup and `wabgpt setup` pause forwarding while they run, so after either one press R in the dashboard to start the enabled contacts.
- Interrupted deliveries are quarantined on restart rather than replayed; see [Delivery](../concepts/delivery.md#errors-and-pausing).
- Quitting does not disable configured sessions and does not stop or delete a managed Docker browser or its profile. Opening the dashboard again restores the last running preference.

The recent-chat list grows from WhatsApp's chat sync and live events. Older versions did not save the contact/chat directory, so unsaved historical entries cannot be recovered from local data alone. Configured forwarding sessions and their ChatGPT conversation URLs are stored separately and remain available.

An installation that already has saved routing state or a WhatsApp login from an earlier version counts as existing and skips first-run setup. Details: [Getting started](../guides/getting-started.md).

## State file versions

`state.json` is versioned (currently version 2). When this version first saves over a file written by an older release (version 1), it keeps that old file next to it as `state.json.v1.bak` (private, never overwritten) so you can go back to the older release. The backup holds the same contact and conversation references as `state.json`, so treat it with the same care and delete it once you no longer need to downgrade. Writes replace the file atomically.

## Identity aliases

WhatsApp can identify one account by both a LID and a phone number. Verified mappings are stored in `state.json` and combine those directory entries, recent chats, forwarding settings and delivery IDs under one canonical identity. The existing ChatGPT conversation is retained. If both aliases already have different ChatGPT conversations, the bridge refuses to discard either silently. Contacts that merely share a name are not merged; their numbers or LIDs appear beside the name so you can distinguish them. How this affects delivery de-duplication: [Delivery](../concepts/delivery.md#identity-aliases).

## Single-writer lock

A lock prevents simultaneous processes (terminal or server) from using the same credentials and state, so the dashboard and `wabgpt serve` cannot run against one data directory at once. The lock is the file `bridge.lock` (`~/.wa-chatgpt/bridge.lock` by default) and contains the owning process ID. A leftover lock is never removed automatically, because only you can tell whether the owner still runs. After a crash, verify the previous process has stopped before removing `bridge.lock`; the startup error names the path. Stale-lock steps: [Troubleshooting](../runbooks/troubleshooting.md).

## Keep it out of Git

Keep the data directory outside any Git checkout. If you point `dataDir` inside one, `.gitignore` covers the usual file names, but check before committing. Never put credentials, state files, tokens, BrowserOS profiles or backups into Git, a Docker image or an npm package; the ignore files and the `package.json` `files` allowlist exist to prevent that.

## Risks that follow from the data

Baileys (`@whiskeysockets/baileys`) is unofficial and the pinned version is a release candidate. WhatsApp can restrict accounts using unofficial clients. Browser automation can break when ChatGPT changes its UI. Login expiry, rate limits and verification challenges require manual attention in BrowserOS; the app does not bypass them or switch silently to an API. wabgpt is built for one owner and does not use the OpenAI API. See also the [security policy](../../SECURITY.md) and the [motivation and policy notice](../concepts/motivation.md).
