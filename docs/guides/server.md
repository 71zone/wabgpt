---
type: Guide
title: Run wabgpt as a server
description: Run the headless owner dashboard with wabgpt serve, use the owner token and reach it privately.
---

# Run wabgpt as a server

```sh
wabgpt serve [--config path]
```

`serve` runs the same core as the terminal dashboard as a self-hosted, single-user server. It needs no terminal and never runs the first-run setup. For a server that comes with its own browser, see the [Docker Compose stack](docker-compose.md).

## What it does

- It serves an owner web dashboard that can link WhatsApp (QR), check the browser, resume or pause forwarding, add and enable contacts, assign projects, set conversation lifetimes and sign out.
- It listens on `127.0.0.1:8788` by default. The `server` block of the config file changes the host, port, token file and public origin; see [configuration](../reference/configuration.md).
- It holds the same single-writer lock (`bridge.lock`) as the terminal dashboard, so you cannot run both, or two servers, against one data directory at once.
- `serve` and `token` do not start or check a [managed Docker browser](managed-browser.md). Run bare `wabgpt` first if you use one.

## Owner token

Everything past the login page requires the owner token.

```sh
wabgpt token [--config path]     # prints (creating on first use) the owner token; interactive terminals only
```

The token file defaults to `server-token` inside the data directory (mode 0600). The server never logs it, never accepts it in a URL and never exposes BrowserOS's MCP endpoint. Treat the token like a password: whoever holds it can pair your WhatsApp account and enable forwarding. Open the dashboard with the owner token, which then sets a server-side session cookie. Authentication, session and `Host` header rules are in the [HTTP API reference](../reference/http-api.md).

## Reach it privately

The default listener is loopback only. Reach a remote server through an SSH tunnel or a private VPN, not an open port:

```sh
ssh -N -L 8788:127.0.0.1:8788 you@your-server
```

Then open <http://127.0.0.1:8788>, using the same hostname you tunneled (`127.0.0.1` or `localhost`); the server rejects unexpected `Host` values. Even inside a VPN the dashboard asks for the owner token. For HTTPS behind a reverse proxy you operate, see [Dashboard behind HTTPS](docker-compose.md#dashboard-behind-https-optional). Never expose BrowserOS's MCP or noVNC ports; see [SECURITY.md](../../SECURITY.md).

## Where BrowserOS runs

`wabgpt serve` with the default config uses your own BrowserOS Neo on `http://127.0.0.1:9010/mcp`. The other setups are listed in [Getting started](getting-started.md#choose-where-browseros-runs).

### Server away from a signed-in browser

If a VPS address triggers constant ChatGPT verification challenges, run the wabgpt app where BrowserOS Neo is signed in on a residential connection, for example your desktop, with `wabgpt serve` or the terminal dashboard and the default `~/.wa-chatgpt/config.json`. The SSH reverse-tunnel variant and its limits are described in [troubleshooting](../runbooks/troubleshooting.md#alternative-topology-desktop-browseros).

If you want wabgpt itself in Docker but BrowserOS native on the same machine, use the [host-browser override](host-browser.md) instead.
