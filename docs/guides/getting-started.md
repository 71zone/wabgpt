---
type: Guide
title: Getting started
description: Install wabgpt, run the guided first-run setup in the terminal, and choose where BrowserOS runs.
---

# Getting started

wabgpt connects your WhatsApp account to ChatGPT web through BrowserOS Neo. It uses `@whiskeysockets/baileys`, not the WhatsApp Business API, and does not use the OpenAI API. It is built for **one owner**: one WhatsApp account, one ChatGPT account, one BrowserOS profile. It is not a multi-tenant or public service. Read the [motivation and policy notice](../concepts/motivation.md) before you link an account.

This guide installs wabgpt on your own computer and walks through the first-run setup. Everything here is run by you, in a terminal.

## Prerequisites

- Node.js 24 or newer.
- An interactive terminal. A window at least 90 columns by 34 rows gives the full dashboard layout. `wabgpt --help` also works without an interactive terminal.
- Either BrowserOS Neo installed and running (native browser), or Docker already installed and running (managed browser). See [Choose a browser](#choose-a-browser).
- A phone with the WhatsApp account you want to link, and a ChatGPT account you can sign in to by hand.

## Install and launch

From a checkout of the repository:

```sh
npm install
npm run build
npm link
```

Then run this from any folder:

```sh
wabgpt
```

No environment variables or Docker Compose commands are needed.

## First run: guided setup

The first bare `wabgpt` on a fresh install runs a short question-and-answer setup in the terminal, then opens the dashboard. It works from any folder. Steps, in order:

1. **Choose a browser.** ChatGPT is driven through a BrowserOS Neo browser. Pick either your own BrowserOS (option 1) or let wabgpt run a managed one in Docker (option 2); see [Choose a browser](#choose-a-browser).
2. **Sign in to ChatGPT yourself.** In that BrowserOS, sign in and finish any verification ChatGPT asks for. wabgpt never signs in for you, never solves challenges and sends no prompt during setup. When you press Enter, it checks real access by listing your ChatGPT projects. An empty list is accepted as signed in when ChatGPT reports it as a complete, empty list. If the check fails (BrowserOS not running, signed out, challenge pending) it explains and lets you fix it and retry.
3. **Link WhatsApp.** wabgpt prints the pairing QR in the terminal; on your phone open WhatsApp → Settings → Linked devices → Link a device and scan it. An existing saved login is reused and needs no QR. A failed attempt can be retried.
4. **First contact (optional).** You can set up one contact now or skip straight to the dashboard. Choose the person by name or enter a number with country code (useful while the contact list is still syncing), then pick that person's own ChatGPT project (a project already assigned to another contact is refused) and a conversation lifetime (default 24 hours; the same `90m`, `12h`, `3d` or `never` forms as the dashboard). Setup saves the contact **paused**. wabgpt cannot check or change a project's memory setting, so set that project to Project-only memory yourself in ChatGPT; setup only reminds you. The contact starts forwarding only if you type `yes` at the explicit prompt about sharing their incoming text with ChatGPT and sending its answers from your WhatsApp account; the default is no. Anything else leaves it saved and paused, and you enable it later with Space in the dashboard.
5. **Dashboard.** Setup is marked complete and the normal dashboard opens. Forwarding stays paused until you resume it (R) or enable a contact.

Account sign-ins, MFA and challenges are always done by you, in the browser. Enabling a contact explicitly allows their incoming text to be shared with ChatGPT and ChatGPT's response to be sent back from your account; enable only contacts whose messages you are authorized to share.

Press Ctrl-C at any prompt to stop; the data-directory lock is released and finished steps are kept. Running `wabgpt` again resumes at the first unfinished step.

Progress lives in a private file, `onboarding.json`, in the data directory. See [local data](../reference/local-data.md) for what it holds.

### Existing installations

Installations that already have saved routing state or a WhatsApp login from an earlier version skip setup and start the dashboard as before.

### Redo setup

To redo the choices (switch browser, re-check ChatGPT and WhatsApp, set up another contact) run:

```sh
wabgpt setup [--config path]
```

Rerunning setup pauses forwarding globally while it runs and never turns existing contacts on implicitly; saved contacts and their conversations are kept, and you resume forwarding with R in the dashboard. `serve`, `token` and `--help` never start setup, so they work unattended and headless.

## Choose a browser

| | Native BrowserOS (option 1) | Managed Docker browser (option 2) |
| --- | --- | --- |
| BrowserOS | The Neo installation you already have; install it from the [BrowserOS releases](https://github.com/browseros-ai/BrowserOS/releases) and keep it running | The official BrowserOS Neo image, pinned by digest and pulled from its publisher, run in a container wabgpt creates for you |
| Needs | BrowserOS installed and running on this computer | Docker (Docker Desktop, OrbStack or Docker Engine) **already installed and running**. wabgpt does not install Docker |
| ChatGPT login | The profile BrowserOS already has; sign in there if needed | A separate, isolated profile that persists in its own Docker volume; sign in through the viewer address wabgpt prints (and tries to open) |
| Config | `browserMcpUrl` in `config.json` stays as you set it (default `http://127.0.0.1:9010/mcp`); setup lets you type a different loopback address | wabgpt writes the container's current loopback MCP address into `browserMcpUrl` |

For the native browser, keep BrowserOS Neo running and leave `browserMcpUrl` at its loopback URL in `~/.wa-chatgpt/config.json`. No Docker is involved. See [configuration](../reference/configuration.md) for `browserMcpUrl` rules.

For the managed browser, see [Managed Docker browser](managed-browser.md).

## Choose where BrowserOS runs

wabgpt talks to one BrowserOS MCP endpoint, always a loopback URL (`http://127.0.0.1:9010/mcp` by default). Bare `wabgpt` asks the browser question itself on first run. The server and Compose setups are for expert and headless use: the wizard never starts them.

| Setup | wabgpt runs in | BrowserOS runs in | Config | Sign in to ChatGPT | How to start |
| --- | --- | --- | --- | --- | --- |
| **Managed Docker browser, native wabgpt** | Your machine (`wabgpt`) | A container the native `wabgpt` creates (not Compose), on `127.0.0.1` random ports | `~/.wa-chatgpt/config.json`, written by setup | The viewer address setup prints | Choose option 2 in the first-run setup |
| **Native BrowserOS, native wabgpt** | Your machine (`wabgpt`, `wabgpt serve`) | Your machine, an existing BrowserOS Neo | `~/.wa-chatgpt/config.json` | In your own BrowserOS window | Choose option 1, or `wabgpt serve` with the default config |
| **Bundled Docker** (default server stack) | Docker (`compose.yaml`) | Docker, the bundled digest-pinned `browseros` service | `deploy/config.json` | noVNC at `127.0.0.1:6080` | `docker compose up -d --wait` |
| **Native BrowserOS, Docker wabgpt** (expert override) | Docker, host networking (`compose.host-browser.yaml`) | Your machine, an existing BrowserOS Neo | `deploy/config.host-browser.json` | In your own BrowserOS window | `docker compose -f compose.yaml -f compose.host-browser.yaml up -d --build --wait wabgpt` |

- The two Docker Compose modes (bundled and host-browser) are the same Compose project and share the `wabgpt-data` volume, so they use the same WhatsApp credentials, owner token and `bridge.lock`, and the same dashboard port 8788. Run only one of them at a time and switch by stopping first; see [Host browser](host-browser.md#switching-modes).
- Native `wabgpt` (the terminal dashboard or `wabgpt serve`) is independent: it keeps its own data directory, `~/.wa-chatgpt` by default, and does not use that volume. It is a separate WhatsApp link from any Compose `wabgpt`; never run it and a Compose `wabgpt` at the same time against copies of the same credentials.
- Which mode is active is decided by the command you run; nothing detects it for you. The Compose modes remain valid expert setups, unchanged by the guided setup.

Where to go next:

- [Managed Docker browser](managed-browser.md): the guided Docker browser and its lifecycle.
- [Server](server.md): `wabgpt serve` and the owner token, without a terminal.
- [Docker Compose stack](docker-compose.md): the bundled default server stack.
- [Host browser](host-browser.md): Docker wabgpt with your existing native BrowserOS.
- [Terminal dashboard](../reference/terminal.md): keys and panels once setup is done.
