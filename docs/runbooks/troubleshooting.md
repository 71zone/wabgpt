---
type: Runbook
title: Troubleshoot wabgpt
description: Symptoms and fixes for terminal, browser, Docker, host-networking, lock, token and ChatGPT sign-in problems, plus the datacenter-IP caveat and the desktop-BrowserOS alternative.
---

# Troubleshoot wabgpt

Find the symptom, then follow the linked section or runbook. Sign-ins, CAPTCHAs, Cloudflare or OpenAI challenges and login expiry always need you in the browser; wabgpt does not bypass or automate them and does not switch silently to an API.

## Native terminal

| Symptom | What to check |
| --- | --- |
| `wabgpt needs an interactive terminal` | The dashboard and first-run setup need a real terminal on both stdin and stdout. Run `wabgpt` directly in a terminal tab. Use `wabgpt serve` for the web dashboard, or `wabgpt --help`, which works without an interactive terminal. |
| Layout looks cramped or clipped | Use a window at least 90 columns by 34 rows for the full layout. |
| `wabgpt token` refuses to print | It prints a login secret and only runs in an interactive terminal. Run it directly in a terminal, not through a pipe or redirect. In Docker, run it with a TTY (the default for `docker compose exec`); do not pass `-T` or pipe it. |
| Startup fails with a lock error, or Docker keeps restarting `wabgpt` with a lock error | See [Lock error](#lock-error). |
| First-run setup stopped part way | Press Ctrl-C at any prompt to stop: the data-directory lock is released and finished steps are kept. Running `wabgpt` again resumes at the first unfinished step. `wabgpt setup [--config path]` redoes the choices. |
| `serve`, `token` or `--help` did not start setup | By design they never run setup, so they work unattended and headless. |

Node.js 24 or newer is required ([Getting started](../guides/getting-started.md)).

## Browser and ChatGPT

| Symptom | What to check |
| --- | --- |
| Dashboard loads but reports the browser unavailable | Run the browser check (B in the terminal dashboard, the browser check in the web dashboard) and refresh the project list. Confirm that noVNC (bundled Docker) or your native BrowserOS window (host-browser or native mode) shows a signed-in ChatGPT page. In host-browser mode also confirm native BrowserOS is running and its MCP answers on `127.0.0.1:9010`. For a managed Docker browser, run bare `wabgpt` to restart it and refresh the port. |
| Browser check passes but replies fail | The check verifies that wabgpt can reach the BrowserOS MCP server and that a ChatGPT message composer is available, without sending a prompt. A signed-out ChatGPT page can still show a composer, so the check alone does not prove you are signed in. Refresh the project list as well: it reports "ChatGPT is signed out in BrowserOS" until the browser is actually signed in. wabgpt does not check automatically that you signed in. |
| Project picker shows an error or retry | ChatGPT is signed out, BrowserOS is unreachable or the list could not be read completely. Fix that and retry; nothing is changed or enabled while it loads. See the [terminal reference](../reference/terminal.md). |
| Setup's ChatGPT check fails | BrowserOS not running, signed out or a challenge is pending. Setup explains and lets you fix it and retry. |
| Replies stop and a session is paused | If generation or delivery fails the affected session pauses. Inspect both the WhatsApp and ChatGPT conversations before enabling it again. Failed messages are never replayed automatically because ChatGPT may have accepted a message before the connection failed. See [Delivery](../concepts/delivery.md). |
| Replies no longer extracted | Browser readiness alone does not prove response extraction still matches the current ChatGPT UI. Browser automation can break when ChatGPT changes its UI. |
| Replies longer than 60,000 characters | They are not sent; read them in the saved ChatGPT conversation. |
| Sign-in expired | Sign in again in BrowserOS yourself (the managed or Compose browser disables password saving and autofill, so expect to sign in manually). |
| Wrong state after switching browsers | Native BrowserOS and the Docker profiles are separate and never share cookies; sign in with the same ChatGPT account to keep saved project and conversation references. See [Maintenance](maintenance.md#switching-between-the-two-compose-modes). |

### Datacenter IP

Cloudflare and OpenAI treat datacenter addresses (VPS providers) with more suspicion than residential connections. You may see repeated verification challenges ("constant verification pages on chatgpt.com"), temporary blocks or rate limits. This is probabilistic: some ranges work fine, and residential connections still get occasional checks. There is no workaround in this project, and you should not try to automate around the challenges. Linking WhatsApp from an unfamiliar datacenter address can also make WhatsApp restrictions more likely.

If challenges make a VPS unusable, move the browser, not the checks: run wabgpt where BrowserOS Neo is signed in on a residential connection, for example your desktop.

#### Alternative topology: desktop BrowserOS

Run the wabgpt app (not the Compose stack) where BrowserOS Neo is signed in on a residential connection. A server can also reach your desktop's BrowserOS through an SSH reverse tunnel such as `ssh -R 9010:127.0.0.1:9010 user@server`, with `browserMcpUrl` left at `http://127.0.0.1:9010/mcp`. The loopback-only check on `browserMcpUrl` stays, so the MCP endpoint is never configured as a remote URL. This depends on the desktop staying awake and online, carries unauthenticated MCP over your tunnel, and is not exercised by this repository's Compose smoke test. Do not use `deploy/config.json` there; use the default `~/.wa-chatgpt/config.json`, run `wabgpt serve` or the terminal dashboard, and keep the dashboard on its default `127.0.0.1` listener.

If you want wabgpt itself in Docker but BrowserOS native on the same machine, use the [host-browser override](../guides/host-browser.md) instead of this topology.

## Docker Compose

| Symptom | What to check |
| --- | --- |
| `docker compose up --wait` times out | `docker compose ps` and `docker compose logs browseros`. Give the first start about two minutes (BrowserOS's health check allows a start period of about 90 seconds). |
| Chromium tabs crash ("Aw, Snap!") | `shm_size: 1g` must stay on `browseros`. |
| `port is already allocated` | Another program uses 8788 or 6080; stop it or change the host side of the `ports:` mappings. Keep the `127.0.0.1:` prefix. In host-browser mode only 8788 is used, and the bundled stack must be stopped first because it publishes the same port. |
| `wabgpt` unreachable after `browseros` was recreated | Run `docker compose up -d` again so `wabgpt` is recreated into the new network namespace. |
| Host-browser mode cannot reach `127.0.0.1:9010` | Docker Desktop needs 4.34 or later with **Enable host networking** turned on and Enhanced Container Isolation off; Compose must be v2.24.4 or newer (the override uses `!reset`). Check `docker compose -f compose.yaml -f compose.host-browser.yaml logs wabgpt`, and that native BrowserOS listens on `127.0.0.1:9010`. Do not switch to a `host.docker.internal` or LAN URL; the app only accepts loopback. See [Host browser](../guides/host-browser.md). |
| `wabgpt token` fails or shows the wrong state in host-browser mode | Pass both `-f compose.yaml -f compose.host-browser.yaml` so the command resolves against the host-browser definition, and check that you did not run `docker compose up` without the override, which recreates `wabgpt` in bundled mode. |
| Dashboard rejects the page | The server rejects unexpected `Host` values. Open it through the hostname you tunneled (`127.0.0.1` or `localhost`), or set `publicOrigin` for a trusted HTTPS proxy. See the [HTTP API reference](../reference/http-api.md). |

## Browser conflicts

- The managed Docker browser publishes on `127.0.0.1` with random host ports, so it should not clash with native BrowserOS on 9010, the default stack's viewer on 6080 or other tools. After its container restarts the ports can change; run bare `wabgpt` to restart it and refresh `browserMcpUrl`. `wabgpt serve` and `wabgpt token` do not do that.
- The two Compose modes share port 8788, the `wabgpt-data` volume and `bridge.lock`; run only one. See [Maintenance](maintenance.md#switching-between-the-two-compose-modes).
- Native `wabgpt` and a Compose `wabgpt` have separate data directories and WhatsApp links; never run them against copies of the same credentials.
- Setup reports a same-named Docker container or volume that lacks wabgpt's ownership labels and leaves it alone. Remove or rename it yourself if you want wabgpt to use the name.
- If Docker is missing, not running or denies your user, first-run setup reports it in plain words and lets you retry or go back and choose the native browser. wabgpt does not install Docker.

## Lock error

wabgpt holds one single-writer lock per data directory (`bridge.lock`), shared by the terminal dashboard and `wabgpt serve`. If another process is using the same data directory, stop it first. After a crash, the app refuses to start while `bridge.lock` remains; stale locks are never removed automatically. Verify nothing is using the same credentials, then remove only that file. Exact commands for native, bundled Docker and host-browser modes are in [Maintenance](maintenance.md#stale-bridgelock-after-a-crash).

## Login, access and exposure

| Symptom | What to check |
| --- | --- |
| Cannot sign in to the dashboard | Log in with the owner token from `wabgpt token` (in Docker, `docker compose exec wabgpt wabgpt token --config /etc/wabgpt/config.json`). Everything past the login page needs it; sessions end when the token is rotated ([Maintenance](maintenance.md#rotate-the-owner-token)). Login attempts are rate-limited. |
| Linux Docker profile will not accept a copied desktop profile | The Compose browser profile is new and isolated. Do not copy a macOS or Windows BrowserOS or Chrome profile into it: those cookies are encrypted with the desktop OS keychain, which Linux cannot read, and copying a personal profile would also move unrelated logins. Sign in fresh. |
| WhatsApp restricted or logged out | WhatsApp can restrict accounts that use unofficial clients; the pinned Baileys is a release candidate. Accept that risk before linking a number you depend on. |
| Need remote access | Use an SSH tunnel or private VPN to the loopback ports; never publish noVNC (6080) or MCP (9010) and never remove the `127.0.0.1:` prefix from `compose.yaml`. See [Docker Compose](../guides/docker-compose.md) and [SECURITY.md](../../SECURITY.md). |
