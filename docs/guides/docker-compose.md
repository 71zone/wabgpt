---
type: Guide
title: Docker Compose stack
description: Install the bundled single-user server stack, understand what it exposes, and complete the human sign-in and pairing steps.
---

# Docker Compose stack

This guide runs wabgpt as a **single-user** server with Docker Compose: one WhatsApp account, one ChatGPT account, one owner. It is not a multi-tenant or public service, and nothing here makes it one. If you only want the terminal dashboard on your own computer you do not need this guide: install `wabgpt` and its first-run setup can start a managed Docker browser for you (see [Managed Docker browser](managed-browser.md)).

Operating it afterwards (start, stop, logs, updates, backups, token rotation, reset) is in [maintenance](../runbooks/maintenance.md); problems are in [troubleshooting](../runbooks/troubleshooting.md).

## What runs

Two containers are involved in the default (bundled) setup. [Getting started](getting-started.md#choose-where-browseros-runs) compares it with the other setups, and [Host browser](host-browser.md) covers using an existing native BrowserOS instead.

| Service | Image | Role |
| --- | --- | --- |
| `browseros` | Official `ghcr.io/browseros-ai/neo`, pinned by digest, pulled from its publisher | BrowserOS Neo on a virtual display, with its MCP server and a noVNC viewer |
| `wabgpt` | Built from this repository's `Dockerfile` | WhatsApp connection, routing and the owner dashboard |

BrowserOS Neo is AGPL-3.0 software that this repository neither copies nor modifies. Compose downloads the official image directly from GitHub Container Registry; see [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

## What is exposed

| Port | Served by | Published on the host? | Authentication |
| --- | --- | --- | --- |
| 8788 | wabgpt owner dashboard | `127.0.0.1` only | Owner token, then a server-side session cookie |
| 6080 | BrowserOS noVNC viewer | `127.0.0.1` only | **None** |
| 9010 | BrowserOS MCP (and its local API) | **Not published at all** | **None** |

- Docker publishes ports only on the host's loopback address. Remote access is an SSH tunnel or a private VPN, not an open port.
- The `wabgpt` container joins the `browseros` container's network namespace (`network_mode: service:browseros`). wabgpt therefore reaches MCP at `127.0.0.1:9010` inside that shared namespace, and Docker never maps 9010 to the host. The dashboard on 8788 is wabgpt's listener inside the same namespace, published through the `browseros` service.
- Keep the `127.0.0.1:` prefix on the `ports:` entries in [`compose.yaml`](../../compose.yaml). Without it Docker publishes on every interface and, on Linux, bypasses firewalls such as `ufw`.
- noVNC gives full mouse and keyboard control of a browser that is signed in to your ChatGPT account. MCP lets a caller drive that browser and run scripts in it. Never put either behind a public port, and never proxy them without your own authentication layer.
- No application environment variables are needed. The bundled configuration, `deploy/config.json`, sets `dataDir` to `/data` and listens on `0.0.0.0` inside the shared container network namespace; Compose publishes the dashboard on the host's `127.0.0.1` only. The host-browser override uses `deploy/config.host-browser.json`, which binds the dashboard directly to `127.0.0.1` instead. Both files are secret-free. See [configuration](../reference/configuration.md).
- The statement that MCP is never published describes this Compose stack. The one deliberate exception is the [managed browser](managed-browser.md#ports) that the native `wabgpt` command starts for itself, published on `127.0.0.1` only, on random host ports. Neither Compose file does that.

See also [SECURITY.md](../../SECURITY.md).

## Requirements

- A Linux host with Docker Engine and the Compose plugin (v2). Docker Desktop on macOS or Windows also works for trying it out.
- Plan for roughly 2 vCPU and 4 GB of RAM: Chromium renders in software and the container sets `shm_size: 1g`. This is a sizing estimate, not a tested minimum.
- Outbound internet access for `ghcr.io`, Docker Hub (for the `node` base image), `registry.npmjs.org`, WhatsApp and ChatGPT.
- A phone with the WhatsApp account you want to link, and a ChatGPT account you can sign in to by hand.

## Install

Get the repository onto the server (clone it from wherever you obtained it, or copy a checked-out tree) and run from its root:

```sh
docker compose pull browseros        # official BrowserOS Neo image, digest-pinned
docker compose build wabgpt          # builds this repository's app image
docker compose up -d --wait          # starts both; waits for health checks
docker compose ps
```

`--wait` returns once `browseros` reports healthy (its own image-defined health check, which allows a start period of about 90 seconds) and wabgpt's dashboard answers on its loopback health probe.

Nothing is forwarded after installation. A fresh install has no contacts enabled, no WhatsApp link and no ChatGPT login.

The first run creates, inside the `wabgpt-data` volume: `server-token` (owner token, mode 0600), `state.json`, `bridge.lock` and a `whatsapp/` directory with WhatsApp credentials after you link an account. If the volume starts from state written by an older release (schema version 1, for example a restored backup), the first save keeps that file as `state.json.v1.bak` beside the new `state.json`; it is private but as sensitive as the state itself. The `browseros-data` volume holds the BrowserOS profile. See [local data](../reference/local-data.md).

## Reach the dashboard and viewer

From your own workstation, open an SSH tunnel to the server (replace the user and host):

```sh
ssh -N -L 8788:127.0.0.1:8788 -L 6080:127.0.0.1:6080 you@your-server
```

Do **not** forward 9010; nothing on your workstation needs it.

- Dashboard: <http://127.0.0.1:8788>
- noVNC viewer: <http://127.0.0.1:6080>

A private VPN works the same way as long as the Docker host's published ports stay bound to `127.0.0.1` and you reach them through a tunnel or forward you control. Even inside a VPN, the dashboard asks for the owner token; another VPN member is not automatically authorized, and noVNC has no such protection.

Open the dashboard through the same hostname you tunneled (`127.0.0.1` or `localhost`). The server rejects unexpected `Host` values; see the [HTTP API reference](../reference/http-api.md) for the exact rules.

## Get the owner token

The token is created on first use and stored in `/data/server-token`. Print it on the server, in an interactive terminal:

```sh
docker compose exec wabgpt wabgpt token --config /etc/wabgpt/config.json
```

The command refuses to print into a non-interactive pipe (do not pass `-T` or pipe it), never writes the token to logs and never puts it in a URL. Paste it into the dashboard's login form. Treat it like a password: whoever holds it can pair your WhatsApp account and enable forwarding. To rotate it, see [maintenance](../runbooks/maintenance.md); every existing session ends.

Anyone who can run `docker` on the host is effectively root there and can read both volumes.

## First-time setup (human steps)

These steps need a person. wabgpt does not log in for you, solve CAPTCHAs, or bypass Cloudflare or OpenAI challenges.

### Sign in to ChatGPT through noVNC

*Bundled mode only.* With an existing native BrowserOS (native or [host-browser](host-browser.md) mode) skip noVNC: sign in to `https://chatgpt.com` yourself in that BrowserOS window, and continue with the browser check below.

1. Open <http://127.0.0.1:6080> through the SSH tunnel. BrowserOS Neo fills the tab.
2. In the remote browser, go to `https://chatgpt.com` and sign in yourself: email or SSO, multi-factor prompts, and any Cloudflare verification that appears. Use the remote keyboard and mouse.
3. Confirm you land on the signed-in ChatGPT page.

The profile lives in the `browseros-data` volume, so the login survives restarts and image updates. Hosted-mode BrowserOS disables Chromium's password saving and autofill, so expect to sign in manually again if the session expires.

**Linux fresh login is required.** The profile in this Compose stack is new and isolated. Do not copy a macOS or Windows BrowserOS or Chrome profile into it: those cookies are encrypted with the desktop OS keychain, which Linux cannot read, and copying a personal profile would also move unrelated logins. Your desktop profile and this container profile never share state.

**Datacenter IP caveat.** Cloudflare and OpenAI treat datacenter addresses (VPS providers) with more suspicion than residential connections, so a VPS may see repeated verification challenges, temporary blocks or rate limits on `chatgpt.com`. There is no workaround in this project, and you should not try to automate around the challenges. Details and the desktop-browser alternative are in [troubleshooting](../runbooks/troubleshooting.md#datacenter-ip).

### Open the dashboard and check the browser

Log in with the owner token and run the browser check. It verifies that wabgpt can reach the BrowserOS MCP server and that a ChatGPT message composer is available, without sending a prompt. A signed-out ChatGPT page can still show a composer, so the check alone does not prove you are signed in. Refresh the project list as well: it reports "ChatGPT is signed out in BrowserOS" until the remote browser is actually signed in.

### Link WhatsApp in the owner dashboard

1. In the dashboard connect WhatsApp. A QR code renders from the raw pairing payload.
2. On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan the QR.
3. The directory fills from WhatsApp's sync. The QR is shown only to an authenticated owner and never appears in logs or on unauthenticated endpoints.

WhatsApp can restrict accounts that use unofficial clients, and linking from an unfamiliar datacenter address can make that more likely. This project uses an unofficial protocol library; accept that risk before linking a number you depend on.

### Choose contacts and enable them

Pick a project (optional) and a conversation lifetime per contact, then enable only contacts whose messages you are authorized to share with ChatGPT. Enabling a contact sends their incoming text to ChatGPT and sends ChatGPT's answers from your WhatsApp account. See [conversations](../concepts/conversations.md) and [delivery](../concepts/delivery.md).

## Dashboard behind HTTPS (optional)

For access without an SSH tunnel you may put a TLS reverse proxy that you control in front of `127.0.0.1:8788` only. Set the public origin in `deploy/config.json`:

```json
"server": {
  "host": "0.0.0.0",
  "port": 8788,
  "tokenFile": "/data/server-token",
  "publicOrigin": "https://wabgpt.example.com"
}
```

`publicOrigin` must be a bare `https://` origin (plain `http://` is accepted only for a loopback address). The proxy must forward the original `Host` header. Cookies are `Secure` for an HTTPS origin. Do not add a proxy for 6080 or 9010 unless it enforces strong authentication of its own and you accept that everyone who passes it controls your signed-in browser. Restart with `docker compose up -d` after editing the file; `compose.yaml` bind-mounts it read-only.

## Browser sandbox

Upstream's image defaults to `NEO_SANDBOX=false`, which starts Chromium with `--no-sandbox`, because Docker's default seccomp profile blocks the user namespaces Chromium's sandbox needs. Pages therefore run without Chromium's process sandbox, and the container boundary is the only wall. This stack keeps that upstream default and does not use `privileged`, `seccomp=unconfined`, `apparmor=unconfined` or host mounts to change it. Only sign in to sites you trust in this browser, and keep the host patched. If you want the sandbox and accept relaxing Docker's security profile for that container, read upstream's "Security" section and add the settings yourself.
