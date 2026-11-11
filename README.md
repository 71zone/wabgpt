# wabgpt

Connects your WhatsApp account to ChatGPT web through BrowserOS Neo. Each enabled contact has its own saved ChatGPT conversation. It uses `@whiskeysockets/baileys`, not the WhatsApp Business API, and does not use the OpenAI API.

There are two ways to run it, over the same core and the same data directory:

- an interactive terminal dashboard (`wabgpt`), and
- a self-hosted single-user server with an authenticated web dashboard (`wabgpt serve`, or the Docker Compose stack in [docs/deployment.md](docs/deployment.md)).

It is built for **one owner**: one WhatsApp account, one ChatGPT account, one BrowserOS profile. It is not a multi-tenant or public service.

Original code is MIT-licensed; dependencies and BrowserOS keep their own licenses. Read [License](#license) and `THIRD_PARTY_NOTICES.md` before redistributing anything.

## Install and launch (terminal dashboard)

Use Node.js 24 or newer.

```sh
npm install
npm run build
npm link
```

Then run this from any folder:

```sh
wabgpt
```

The dashboard needs an interactive terminal. A window at least 90 columns by 34 rows gives the full layout. `wabgpt --help` also works without an interactive terminal.

### First run: guided setup

The first bare `wabgpt` on a fresh install runs a short question-and-answer setup in the terminal, then opens the dashboard. No environment variables or Docker Compose commands are needed, and it works from any folder. Steps, in order:

1. **Choose a browser.** ChatGPT is driven through a BrowserOS Neo browser. Pick either your own BrowserOS (option 1) or let wabgpt run a managed one in Docker (option 2); see [Native or managed browser](#native-or-managed-browser).
2. **Sign in to ChatGPT yourself.** In that BrowserOS, sign in and finish any verification ChatGPT asks for. wabgpt never signs in for you, never solves challenges and sends no prompt during setup. When you press Enter, it checks real access by listing your ChatGPT projects. An empty list is accepted as signed in when ChatGPT reports it as a complete, empty list. If the check fails (BrowserOS not running, signed out, challenge pending) it explains and lets you fix it and retry.
3. **Link WhatsApp.** wabgpt prints the pairing QR in the terminal; on your phone open WhatsApp → Settings → Linked devices → Link a device and scan it. An existing saved login is reused and needs no QR. A failed attempt can be retried.
4. **First contact (optional).** You can set up one contact now or skip straight to the dashboard. Choose the person by name or enter a number with country code (useful while the contact list is still syncing), then pick that person's own ChatGPT project (a project already assigned to another contact is refused) and a conversation lifetime (default 24 hours; the same `90m`, `12h`, `3d` or `never` forms as the dashboard). Setup saves the contact **paused**. wabgpt cannot check or change a project's memory setting, so set that project to Project-only memory yourself in ChatGPT; setup only reminds you. The contact starts forwarding only if you type `yes` at the explicit prompt about sharing their incoming text with ChatGPT and sending its answers from your WhatsApp account; the default is no. Anything else leaves it saved and paused, and you enable it later with Space in the dashboard.
5. **Dashboard.** Setup is marked complete and the normal dashboard opens. Forwarding stays paused until you resume it (R) or enable a contact.

Account sign-ins, MFA and challenges are always done by you, in the browser. Press Ctrl-C at any prompt to stop; the data-directory lock is released and finished steps are kept. Running `wabgpt` again resumes at the first unfinished step.

Progress lives in a private file, `onboarding.json`, in the data directory. Installations that already have saved routing state or a WhatsApp login from an earlier version skip setup and start the dashboard as before. To redo the choices (switch browser, re-check ChatGPT and WhatsApp, set up another contact) run:

```sh
wabgpt setup [--config path]
```

Rerunning setup pauses forwarding globally while it runs and never turns existing contacts on implicitly; saved contacts and their conversations are kept, and you resume forwarding with R in the dashboard. `serve`, `token` and `--help` never start setup, so they work unattended and headless.

### Native or managed browser

| | Native BrowserOS (option 1) | Managed Docker browser (option 2) |
| --- | --- | --- |
| BrowserOS | The Neo installation you already have; install it from the [BrowserOS releases](https://github.com/browseros-ai/BrowserOS/releases) and keep it running | The official BrowserOS Neo image, pinned by digest and pulled from its publisher, run in a container wabgpt creates for you |
| Needs | BrowserOS installed and running on this computer | Docker (Docker Desktop, OrbStack or Docker Engine) **already installed and running**. wabgpt does not install Docker |
| ChatGPT login | The profile BrowserOS already has; sign in there if needed | A separate, isolated profile that persists in its own Docker volume; sign in through the viewer address wabgpt prints (and tries to open) |
| Config | `browserMcpUrl` in `config.json` stays as you set it (default `http://127.0.0.1:9010/mcp`); setup lets you type a different loopback address | wabgpt writes the container's current loopback MCP address into `browserMcpUrl` |

With the managed browser, only the `wabgpt` process on your computer talks to Docker, through the `docker` command (it needs no Compose and does not run an app container). If Docker is missing or not running, setup says so and lets you retry or go back and choose the native browser; it never claims success early.

What wabgpt creates for the managed browser, all scoped to your data directory so a second data directory gets its own set:

- one container, `wabgpt-neo-<id>`, and one profile volume, `wabgpt-neo-<id>-data`, where `<id>` is a short hash of the data directory path; both carry the Docker labels `io.wabgpt.owner=wabgpt` and `io.wabgpt.role=browser`, plus an `io.wabgpt.scope=<id>` label;
- container ports 9010 (BrowserOS MCP) and 6080 (noVNC viewer) published on `127.0.0.1` with **random host ports** chosen by Docker, so they cannot clash with a native BrowserOS or the default Compose stack, and are not reachable from another machine. Neither has authentication; see [SECURITY.md](SECURITY.md);
- BrowserOS settings (`deploy/neo.toml`, which turns automatic tab grouping on) copied into the container with `docker container cp`, not a bind mount, so a global install in any folder works.

Wabgpt reuses a container and volume it owns and never removes or recreates your profile automatically. It refuses to touch an unrelated container or volume that happens to have the same name.

Each later bare `wabgpt` starts that container again if it is stopped, waits until BrowserOS answers, and updates `browserMcpUrl` if Docker assigned a new port. Quitting wabgpt does not stop or delete the container or profile, so the ChatGPT login persists and the container keeps running (it has Docker's `unless-stopped` restart policy). To find or stop it without touching any other container, such as the default Compose stack:

```sh
docker ps -a --filter label=io.wabgpt.owner=wabgpt
docker stop wabgpt-neo-<id>      # use the name that command printed; the next `wabgpt` starts it again
```

Only if you want to discard the managed profile (this deletes its ChatGPT login) stop and remove that container, then its `-data` volume; the next `wabgpt` creates a new one and you sign in again. Do not use `docker compose down` for it: it was not created by Compose.

`wabgpt serve` and `wabgpt token` do not start or check the managed browser. If you use them with a managed browser, run bare `wabgpt` first, which starts the container and records its current address in `config.json`, and note Docker may assign a different port after the container restarts.

## Run as a server

```sh
wabgpt serve [--config path]
```

`serve` needs no terminal. It holds the same single-writer lock as the terminal dashboard, so you cannot run both against one data directory at once. It listens on `127.0.0.1:8788` by default and serves an owner dashboard that can link WhatsApp (QR), check the browser, resume or pause forwarding, add and enable contacts, assign projects, set conversation lifetimes and sign out. Everything past the login page requires the owner token:

```sh
wabgpt token [--config path]     # prints (creating on first use) the owner token; interactive terminals only
```

The token file defaults to `server-token` inside the data directory (mode 0600). The server never logs it, never accepts it in a URL and never exposes BrowserOS's MCP endpoint. Reach a remote server through an SSH tunnel or private VPN. The Docker Compose stack installs and wires BrowserOS Neo for you; see [docs/deployment.md](docs/deployment.md) for installation, human ChatGPT sign-in, WhatsApp pairing, backups and the exposure table. The HTTP API is described in [docs/http.md](docs/http.md).

### Choose where BrowserOS runs

Bare `wabgpt` asks this itself on first run (see [Native or managed browser](#native-or-managed-browser)). The server setups below are for expert and headless use: they are never started by the wizard.

| Setup | wabgpt | BrowserOS | How to start |
| --- | --- | --- | --- |
| Guided, managed browser | Your machine (`wabgpt`) | Managed container that wabgpt creates; `127.0.0.1` random ports | Choose option 2 in the first-run setup |
| Guided or manual, native browser | Your machine | Your own BrowserOS Neo | Choose option 1, or `wabgpt serve` with the default config |
| Bundled Docker (default server stack) | Docker | Bundled, digest-pinned container; sign in through noVNC at `127.0.0.1:6080` | `docker compose up -d --wait` |
| Existing native BrowserOS, Docker wabgpt (expert override) | Docker, host networking | Your own BrowserOS Neo | `docker compose -f compose.yaml -f compose.host-browser.yaml up -d --build --wait wabgpt` |

The last setup is an opt-in override and valid expert mode, unchanged by the guided setup. Pass both `-f` flags to every later `docker compose` command for it (`exec wabgpt wabgpt token ...`, `logs`, `stop wabgpt`), and run `docker compose stop` (bundled) or `docker compose -f compose.yaml -f compose.host-browser.yaml stop wabgpt` (host mode) before switching; the two Compose setups reuse the same data volume and must not run together. Never use `down -v` to switch; it deletes the data.

In host mode there is no noVNC on 6080. Sign in to ChatGPT yourself in your existing BrowserOS window; wabgpt does not log in for you and does not automatically verify that you did. The dashboard stays on host `127.0.0.1:8788`. BrowserOS MCP stays a loopback URL (`http://127.0.0.1:9010/mcp`) and is never published or replaced by a remote URL; inside an ordinary container `127.0.0.1` is the container, not your machine, which is why host networking is needed. Host networking also lets the container reach services on your host's loopback. It needs Docker Compose v2.24.4+ and either Docker Engine on Linux, OrbStack, or Docker Desktop 4.34+ with **Enable host networking** turned on and Enhanced Container Isolation off ([Docker docs](https://docs.docker.com/engine/network/drivers/host/#docker-desktop), [OrbStack docs](https://docs.orbstack.dev/docker/host-networking)). Your desktop BrowserOS profile and the bundled container profile are separate; do not copy cookies between them. See [docs/deployment.md](docs/deployment.md#choose-where-browseros-runs) for details, the OrbStack test and limitations.

## Dashboard

The status bar shows the last confirmed WhatsApp and BrowserOS connection states, and whether forwarding is active. The directory lists saved contacts and known chats. The sessions panel shows each configured contact, whether it has a saved, new or expired ChatGPT conversation, and its project and lifetime. The details panel shows the selected contact's JID, project, conversation lifetime, expiry time, conversation URL and any failure. The activity panel shows connection changes and deliveries without logging message bodies.

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

Toolbar buttons also accept mouse clicks; they and the keys are ignored while an input prompt, the project picker or the QR overlay is open. Press Escape to hide a QR overlay, cancel a prompt or picker, or clear a search. G and T act on the contact selected in whichever panel has focus, and only on that contact. Configuring a project or lifetime never enables forwarding: a contact you have not enabled gets a paused session that you enable separately with Space. The full layout fits 90 × 34 terminals with every control above on screen. For a new WhatsApp login, press L, then on your phone open WhatsApp → Settings → Linked devices → Link a device and scan the QR.

Enabling a contact explicitly allows their incoming text to be shared with ChatGPT and ChatGPT's response to be sent back from your account. Enable only contacts whose messages you are authorized to share. The app forwards the original text without extra system instructions.

## What survives a restart

- WhatsApp linked-device credentials reconnect without another QR scan unless the session was unlinked or expired.
- Synced contact names, phone/LID identity mappings, recent direct chats and their activity metadata are saved to disk. They are available before another history sync arrives.
- Enabled/paused contact choices, each contact's project, lifetime and ChatGPT conversation URL, and the time that conversation started are retained.
- Previously active forwarding resumes automatically. A global pause also survives restart. Sessions paused after a delivery error stay paused until explicitly enabled again. First-run setup and `wabgpt setup` pause forwarding while they run, so after either one press R in the dashboard to start the enabled contacts.
- Quitting does not disable configured sessions and does not stop or delete a managed Docker browser or its profile. Opening the dashboard again restores the last running preference.

The recent-chat list grows from WhatsApp's chat sync and live events. The app does not download or persist full WhatsApp message transcripts. Older versions did not save the contact/chat directory, so unsaved historical entries cannot be recovered from local data alone. Configured forwarding sessions and their ChatGPT conversation URLs are stored separately and remain available.

## Projects and conversation lifetime

Each contact can be bound to a ChatGPT project (press G) and given a fixed conversation lifetime (press T). Both are saved in `state.json` and survive restarts.

**Projects.** Press G to choose from your ChatGPT projects by name; you never paste a URL. The picker opens centered over the dashboard and reads the full project list live from ChatGPT through BrowserOS, in its own short-lived connection and scratch tab, so it does not touch the tab used for replies and never connects WhatsApp. It shows "Loading…" first; if ChatGPT is signed out, BrowserOS is unreachable or the list cannot be read completely, it shows the error and lets you retry instead of showing a partial or empty list. Nothing is changed or enabled while it loads.

| Picker key | Action |
| --- | --- |
| Type | Filter by project name, project ID or the name of the contact that uses it (the search box keeps every letter, including R) |
| Up / Down, PgUp / PgDn, Home / End | Move through the list from either mode; the mouse wheel and clicking a row also work (click a highlighted row again to assign it) |
| Enter | Assign the highlighted project, or clear the project if "No project" is highlighted |
| Tab | Switch between typing and list mode; in list mode J/K move, `/` returns to search, R refreshes and C highlights "No project" |
| F5 or Ctrl-R | Reload the list from ChatGPT (also the Refresh button) |
| Backspace / Ctrl-U | Edit / clear the search |
| Esc | Cancel without changing anything |

A search with no matches never clears the current assignment. To clear it, deliberately select "No project" with Home, the list-mode C key or the mouse, then press Enter, or use the No project button.

The first row, "No project · standalone chats", clears the assignment (also the No project button). The current assignment is marked `current` even if ChatGPT's list no longer contains it. A project already used by another contact is shown as `in use: <name>` and cannot be chosen; the store enforces this too. ChatGPT allows several projects with the same name, so identical names are listed separately with a short project ID suffix such as `#1a2b3c4d`. The stored value is still the canonical `https://chatgpt.com/g/g-p-<32 hex>`. Use a separate project per contact and set each one to project-only memory in ChatGPT. wabgpt does not check or change project settings, memory or instructions and never creates projects. With a project, a contact's new chat starts in that project and the bridge stops before sending if ChatGPT cannot open the project or lands elsewhere. Changing or clearing a contact's project resets its saved conversation URL so the next message starts a new chat in the new place. The old chat is not imported, moved or deleted; it stays in ChatGPT where it was. Setting the same project again changes nothing. A project cannot be changed while that contact's message is being processed; the picker then shows the reason and stays open. See [Projects in ChatGPT](https://help.openai.com/en/articles/10169521-projects-in-chatgpt) for how project memory modes work and their limits: project-only chats can reference only conversations within the same project, your account and workspace must allow memory, and a mode change on an existing project can take a few hours to apply.

**Lifetime.** The default is 24 hours; `never` disables expiry. The clock starts when the first conversation URL is saved and is fixed: later messages do not extend it. After expiry, the saved URL and start time are cleared locally when the next incoming message arrives and before it is submitted, so the message opens a new chat (in the contact's project, if set). Nothing happens on a timer or while a reply is being produced, and nothing is deleted in ChatGPT; old chats remain there for you to read. Conversations saved before this feature existed have no recorded start, so their clock starts once at the first load after upgrading; their history is preserved until that lifetime runs out. Changing a lifetime applies to the current conversation too, measured from its original start.

The lifetime limits only the active conversation thread. It does not limit context ChatGPT keeps or retrieves across a project. ChatGPT web is a subscription, not per-token API billing, so shorter or longer lifetimes make no cost or token-cache promise and no latency saving is guaranteed.

## Configuration

First launch creates `~/.wa-chatgpt/config.json`. No environment variables are required. If you choose the managed Docker browser in setup, wabgpt rewrites only `browserMcpUrl` in that file to the container's current loopback address (for example `http://127.0.0.1:49152/mcp`), keeping your other keys, and remembers your previous native address in `onboarding.json` so choosing the native browser later restores it.

```json
{
  "browserMcpUrl": "http://127.0.0.1:9010/mcp",
  "dataDir": "~/.wa-chatgpt"
}
```

Edit that file to change the connection or data directory. `browserMcpUrl` must be an `http` or `https` URL on a loopback host without credentials; the app refuses anything else, so BrowserOS's unauthenticated MCP endpoint is never reached over a network. Copy the actual local MCP URL from BrowserOS Neo's connection settings if yours differs. Only connect to a local server you trust.

Use `wabgpt --config /path/to/config.json` for another config file. Relative `dataDir` paths resolve from the config file's directory, not your current terminal folder.

The optional `server` block configures `wabgpt serve`:

```json
{
  "browserMcpUrl": "http://127.0.0.1:9010/mcp",
  "dataDir": "~/.wa-chatgpt",
  "server": {
    "host": "127.0.0.1",
    "port": 8788,
    "tokenFile": "~/.wa-chatgpt/server-token",
    "publicOrigin": "https://wabgpt.example.com"
  }
}
```

Every `server` key is optional. Defaults are host `127.0.0.1`, port `8788` and `server-token` in the data directory. `publicOrigin` is only for a trusted HTTPS reverse proxy you operate (a bare origin, no path). The default Docker deployment uses `deploy/config.json`, which sets `dataDir` to `/data` and listens on `0.0.0.0` inside the container; Compose publishes that port on the host's `127.0.0.1` only. The host-browser override uses `deploy/config.host-browser.json` instead, which listens on `127.0.0.1` because host networking has no port publishing to restrict.

## Delivery behavior

Only incoming direct text and extended-text messages are forwarded. Groups, statuses, your outgoing messages, history sync, attachments and voice notes are not forwarded. History sync can update the saved directory without sending old messages to ChatGPT. Messages sent before this listener started are ignored.

Messages are processed serially. The bridge saves each message ID before submitting it, so duplicate events are not resent after restart. It saves a new ChatGPT conversation URL (with its start time) as soon as one is assigned and prevents two contacts from sharing it. Replies use the selected ChatGPT web model and the existing conversation's context.

After the new prompt appears in its saved ChatGPT conversation, the bridge marks the original WhatsApp message as read. It does not wait for the assistant's response to finish and does not mark failed or unconfirmed submissions as read. This uses WhatsApp's normal read-receipt API and respects your account's read-receipt privacy setting. Receipt delivery runs independently: a slow or failed receipt does not delay the WhatsApp reply. Failures are reported in Activity without resending the prompt.

The response reader matches stable user and assistant message IDs within the same completed turn, then extracts only the assistant message body. It does not depend on rendered message counts, which can shrink as ChatGPT virtualizes older turns. It does not send headings or action labels. Browser readiness alone does not prove response extraction still matches the current ChatGPT UI.

The bridge checks the MCP connection before submitting each prompt and when you press B. If BrowserOS rejects an expired session with HTTP 404, the bridge creates a new MCP session and reuses its recorded tab and group instead of opening a duplicate ChatGPT tab, with at most one recovery attempt per message. If expiry happens after submission, it resumes observation only when the conversation URL is known. An uncertain submission is never automatically repeated.

If generation or delivery fails, the affected session pauses. Inspect both conversations before enabling it again. Failed messages are not automatically replayed because a remote service may have accepted a message before the connection failed. Interrupted deliveries are quarantined on restart. The bridge favors avoiding duplicates over guaranteed delivery and cannot promise exactly-once delivery across two remote services.

Pausing prevents any pending WhatsApp reply from being sent but cannot retract a prompt already submitted to ChatGPT. Quitting disarms forwarding and waits for an in-progress browser operation to finish before closing. Replies longer than 60,000 characters are not sent; read them in the saved ChatGPT conversation.

Activity logs show elapsed times for ChatGPT acceptance, reply readiness and WhatsApp delivery. Dependency console output is routed into the dashboard; structured objects are redacted to avoid exposing session keys.

## Local data and safety

The data directory contains `state.json` for sessions and the delivery journal, plus `whatsapp/` for credentials and the persisted contact/chat directory. It stores contact names, JIDs, project and conversation URLs, lifetimes, conversation start times, activity metadata and processed message IDs, but not message or reply bodies. `onboarding.json` holds only the first-run setup progress: which browser you chose, the stage reached and timestamps. Files are private to your OS account. Do not share the credentials directory.

`state.json` is versioned (currently version 2). When this version first saves over a file written by an older release (version 1), it keeps that old file next to it as `state.json.v1.bak` (private, never overwritten) so you can go back to the older release. The backup holds the same contact and conversation references as `state.json`, so treat it with the same care and delete it once you no longer need to downgrade.

A lock prevents simultaneous processes (terminal or server) from using the same credentials and state. After a crash, verify the previous process has stopped before removing `bridge.lock` from the data directory (`~/.wa-chatgpt/bridge.lock` by default). The server writes its owner token to `server-token` in the same directory.

Keep the data directory outside any Git checkout. If you point `dataDir` inside one, `.gitignore` covers the usual file names, but check before committing. Never put credentials, state files, tokens, BrowserOS profiles or backups into Git, a Docker image or an npm package; the ignore files and `package.json` `files` allowlist exist to prevent that.

Baileys is unofficial and the pinned version is a release candidate. WhatsApp can restrict accounts using unofficial clients. Browser automation can break when ChatGPT changes its UI. Login expiry, rate limits and verification challenges require manual attention in BrowserOS; the app does not bypass them or switch silently to an API.

WhatsApp can identify one account by both a LID and a phone number. Verified mappings now combine those directory entries, recent chats, forwarding settings and delivery IDs. The existing ChatGPT conversation is retained. If both aliases already have different ChatGPT conversations, the bridge refuses to discard either silently. Contacts that merely share a name are not merged; their numbers or LIDs appear beside the name so you can distinguish them.

## Extending

Messaging, assistant and storage providers are injected behind small interfaces, so a new channel or assistant needs an adapter and a composition change, not a fork of the core. See [docs/extending.md](docs/extending.md).

## Development

```sh
npm run check
npm test
npm run build
```

Tests live in `tests/`. They cover contact/chat persistence, verified identity deduplication, delivery deduplication across aliases, forwarding restoration, fixed-lifetime expiry and migration, project ownership, single-flight project discovery that never starts the delivery browser and is awaited on shutdown, cancellation of a blocked project read, blocked configuration changes during delivery, project-scoped navigation, conversation pinning, expired MCP session recovery without replay, and read receipts gated on prompt acceptance. The first-run setup is covered with synthetic WhatsApp and ChatGPT adapters (resumable progress, legacy installs skipping it, paused-by-default contacts that only an explicit yes enables, cancellation) and with a fake Docker runner that checks the managed browser's ownership and loopback-only rules. Full message delivery, a real Docker engine and the account sign-ins need live sessions and a human. The project picker is exercised by running the dashboard in a terminal. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

Manually exercised: a packed, freshly installed `wabgpt` launched from another folder in a real terminal chose the managed Docker browser (container ready, signed-out ChatGPT detected and blocking the next step), stopped cleanly with Ctrl-C leaving its checkpoint, and resumed on the next launch with the same container. The full setup journey, including contact choice and the explicit-consent prompt, was also run in a terminal against synthetic WhatsApp and ChatGPT adapters. No real WhatsApp pairing, ChatGPT sign-in or message was part of that, so those steps have not been verified against live accounts.

## License

Original wabgpt code is released under the [MIT License](LICENSE), copyright 2026 wabgpt contributors.

That does not relicense anything else. `@whiskeysockets/baileys` is MIT, but it depends on `libsignal`, which is declared GPL-3.0; BrowserOS Neo, which the Docker stack pulls from its publisher, is AGPL-3.0 and runs as a separate program. Whether a particular combined build (for example a published container image or bundled archive) is distributable under MIT terms for the wabgpt part has not been legally reviewed. `THIRD_PARTY_NOTICES.md` lists what is known and what is undecided. `package.json` stays `"private": true` and this repository publishes nothing to npm or a container registry.
