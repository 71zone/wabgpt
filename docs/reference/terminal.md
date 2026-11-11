---
type: Reference
title: Terminal dashboard
description: Panels, keys, prompts, the project picker and what pausing does in the interactive wabgpt dashboard.
---

# Terminal dashboard

`wabgpt` with no command opens an interactive dashboard over the same core and data directory as [`wabgpt serve`](http-api.md). It needs an interactive terminal; a window at least 90 columns by 34 rows shows the full layout with every control on screen. On a fresh install the guided setup runs first; see [Getting started](../guides/getting-started.md). Command line: [Configuration](configuration.md#command-line). Source: [`src/interfaces/tui/tui.ts`](../../src/interfaces/tui/tui.ts), [`src/interfaces/tui/project-picker.ts`](../../src/interfaces/tui/project-picker.ts), [`src/core/duration.ts`](../../src/core/duration.ts).

## Panels

- **Status bar.** The last confirmed WhatsApp and BrowserOS connection states, and whether forwarding is active.
- **Directory.** Saved contacts and known chats. Views `1`, `2` and `3` below switch what it lists.
- **Sessions.** Each configured contact, whether it has a saved, new or expired ChatGPT conversation, and its project and lifetime.
- **Details.** The selected contact's JID, project, conversation lifetime, expiry time, conversation URL and any failure.
- **Activity.** Connection changes and deliveries, without message bodies. Elapsed times for ChatGPT acceptance, reply readiness and WhatsApp delivery appear here. Dependency console output is routed into this panel, with structured objects redacted to avoid exposing session keys.

What each panel's data means: [Conversations](../concepts/conversations.md), [Delivery](../concepts/delivery.md).

## Keys

| Control | Action |
| --- | --- |
| Arrow keys or J/K | Navigate the focused list |
| Tab | Switch between directory and saved sessions |
| Space or Enter | Enable or pause the selected contact's automatic replies |
| / | Search saved names or numbers; submit an empty search to clear |
| 1 | Show the combined directory |
| 2 | Show saved synced contacts |
| 3 | Show recent direct chats and configured sessions |
| L | Connect WhatsApp or show its pairing QR |
| R | Resume enabled forwarding sessions |
| P | Pause all forwarding, retaining session selections |
| A | Add an international phone number or a direct-contact JID |
| B | Check that BrowserOS is reachable and a ChatGPT composer is available, without sending a prompt (a signed-out page can still show one; the project picker reports a signed-out login) |
| G | Open the searchable ChatGPT project picker for the selected contact (see below) |
| T | Set the selected contact's fixed conversation lifetime: minutes, `90m`, `12h`, `3d` or `never`; empty means 24h |
| Q or Ctrl-C | Quit and retain settings |

Toolbar buttons also accept mouse clicks. Buttons and keys are ignored while an input prompt, the project picker or the QR overlay is open. Escape hides a QR overlay, cancels a prompt or picker, or clears a search.

- G and T act on the contact selected in whichever panel has focus, and only on that contact.
- Configuring a project or lifetime **never enables forwarding**: a contact you have not enabled gets a paused session that you enable separately with Space.
- Lifetime input accepts a number of minutes (a bare number means minutes), or a number with a unit such as `90m`, `12h`, `3d`, or `never`. It must be a whole number of minutes between 1 minute and 3650 days. An empty answer means the 24 hour default. Semantics: [Conversations](../concepts/conversations.md#lifetime).
- For a new WhatsApp login, press L, then on your phone open WhatsApp → Settings → Linked devices → Link a device and scan the QR.

## Enabling a contact

Enabling a contact explicitly allows their incoming text to be shared with ChatGPT and ChatGPT's response to be sent back from your WhatsApp account. Enable only contacts whose messages you are authorized to share. The app forwards the original text without extra system instructions.

## Project picker

Press G to choose from your ChatGPT projects by name; you never paste a URL. The picker opens centered over the dashboard and reads the full project list live from ChatGPT through BrowserOS, in its own short-lived connection and scratch tab, so it does not touch the tab used for replies and never connects WhatsApp. It shows "Loading…" first. If ChatGPT is signed out, BrowserOS is unreachable or the list cannot be read completely, it shows the error and lets you retry instead of showing a partial or empty list. Nothing is changed or enabled while it loads.

| Picker key | Action |
| --- | --- |
| Type | Filter by project name, project ID or the name of the contact that uses it (the search box keeps every letter, including R) |
| Up / Down, PgUp / PgDn, Home / End | Move through the list from either mode; the mouse wheel and clicking a row also work (click a highlighted row again to assign it) |
| Enter | Assign the highlighted project, or clear the project if "No project" is highlighted |
| Tab | Switch between typing and list mode; in list mode J/K move, `/` returns to search, R refreshes and C highlights "No project" |
| F5 or Ctrl-R | Reload the list from ChatGPT (also the Refresh button) |
| Backspace / Ctrl-U | Edit / clear the search |
| Esc | Cancel without changing anything |

- A search with no matches never clears the current assignment. To clear it, deliberately select "No project" with Home, the list-mode C key or the mouse, then press Enter, or use the No project button.
- The first row, "No project · standalone chats", clears the assignment (also the No project button).
- The current assignment is marked `current` even if ChatGPT's list no longer contains it.
- A project already used by another contact is shown as `in use: <name>` and cannot be chosen; the store enforces this too.
- ChatGPT allows several projects with the same name, so identical names are listed separately with a short project ID suffix such as `#1a2b3c4d`. The stored value is still the canonical `https://chatgpt.com/g/g-p-<32 hex>`.
- A project cannot be changed while that contact's message is being processed; the picker then shows the reason and stays open.

What a project assignment does to a conversation, and the memory caveats: [Conversations](../concepts/conversations.md#projects).

## Pausing and quitting

- P pauses all forwarding and keeps each contact's selections. Pausing prevents any pending WhatsApp reply from being sent but cannot retract a prompt already submitted to ChatGPT.
- Quitting (Q or Ctrl-C) disarms forwarding and waits for an in-progress browser operation to finish before closing. It retains settings, does not disable configured sessions, and does not stop or delete a managed Docker browser or its profile. Opening the dashboard again restores the last running preference; see [Local data](local-data.md#what-survives-a-restart).
- A session paused after a delivery error stays paused until you enable it again; see [Delivery](../concepts/delivery.md#errors-and-pausing).
