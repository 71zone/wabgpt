---
type: Reference
title: Configuration and command line
description: The config.json file, its defaults and path rules, and the wabgpt command-line arguments.
---

# Configuration and command line

wabgpt is configured by one JSON file and a small command line. No environment variables are required. Source: [`src/infrastructure/config.ts`](../../src/infrastructure/config.ts), [`src/infrastructure/arguments.ts`](../../src/infrastructure/arguments.ts), [`src/infrastructure/loopback.ts`](../../src/infrastructure/loopback.ts), [`src/cli.ts`](../../src/cli.ts).

## Command line

```sh
wabgpt [setup | serve | token] [--config <path>]
```

| Command | What it does |
| --- | --- |
| `wabgpt` (no command) | Opens the [terminal dashboard](terminal.md). The first run on a fresh install starts the guided setup first; see [Getting started](../guides/getting-started.md). |
| `wabgpt setup` | Runs the guided setup again: browser, ChatGPT, WhatsApp, first contact. See [Getting started](../guides/getting-started.md). |
| `wabgpt serve` | Headless single-user server with the owner web dashboard. See [Server](../guides/server.md) and the [HTTP API](http-api.md). |
| `wabgpt token` | Prints the owner login token for the web dashboard, creating it on first use. |
| `wabgpt --help`, `-h`, `help` | Prints usage and the dashboard keys. `--help` or `-h` anywhere on the line wins over every other command. |

- `--config <path>` or `--config=<path>` selects another config file. Giving it twice, giving it without a path, an unknown option or an unknown command is an error that prints the usage line.
- The bare dashboard and `wabgpt setup` need an interactive terminal (stdin and stdout both a terminal); otherwise they stop with a message that points to `wabgpt serve` and `--help`. A window at least 90 columns by 34 rows shows the full layout.
- `wabgpt token` also needs an interactive terminal, because it prints a login secret. It never starts setup.
- `serve`, `token` and `--help` never start setup or the managed Docker browser, so they work unattended and headless. If you use `serve` with a managed browser, run bare `wabgpt` first; see [Managed browser](../guides/managed-browser.md).
- Ctrl-C, SIGTERM and SIGHUP during setup stop it quietly with exit status 130; finished steps stay saved and the data-directory lock is released. `serve` stops on the same signals.

## The config file

The first launch creates `~/.wa-chatgpt/config.json` (directory mode 0700, file mode 0600) with the defaults below. The same happens for a missing file at a path given with `--config`.

```json
{
  "browserMcpUrl": "http://127.0.0.1:9010/mcp",
  "dataDir": "~/.wa-chatgpt"
}
```

| Key | Required | Meaning |
| --- | --- | --- |
| `browserMcpUrl` | yes | The BrowserOS MCP endpoint. Must be an `http` or `https` URL on a loopback host (`localhost`, `127.0.0.1`, `[::1]`) without credentials. Anything else is refused, so BrowserOS's unauthenticated MCP endpoint is never reached over a network. |
| `dataDir` | yes | Where state, WhatsApp credentials and the lock live. See [Local data](local-data.md). |
| `server` | no | Settings for `wabgpt serve`; see below. |

Unknown keys, at the top level or inside `server`, are rejected: a file that does not load is never written back. Copy the actual local MCP URL from BrowserOS Neo's connection settings if yours differs, and connect only to a local server you trust.

### Paths

- A leading `~/` (or a bare `~`) expands to your home directory.
- A relative `dataDir` or `tokenFile` resolves from the **config file's directory**, not from your current terminal folder.
- Keep the data directory outside any Git checkout; see [Local data](local-data.md).

### The `server` block

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

Every `server` key is optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `host` | `127.0.0.1` | Bind address. |
| `port` | `8788` | Integer from 1 to 65535. |
| `tokenFile` | `server-token` inside the data directory | Where the owner token is stored (mode 0600). |
| `publicOrigin` | unset | Bare external origin of a trusted TLS reverse proxy you operate, for example `https://wabgpt.example.com`. It must use HTTPS unless it is a loopback address, with no path, query, fragment or credentials. See [HTTP API: public origin](http-api.md#security-rules). |

The default Docker deployment uses `deploy/config.json`, which sets `dataDir` to `/data` and listens on `0.0.0.0` inside the container; Compose publishes that port on the host's `127.0.0.1` only. The host-browser override uses `deploy/config.host-browser.json` instead, which listens on `127.0.0.1` because host networking has no port publishing to restrict. See [Docker Compose](../guides/docker-compose.md) and [Host browser](../guides/host-browser.md).

## How setup changes the file

If you choose the managed Docker browser in setup, wabgpt rewrites **only** `browserMcpUrl` in this file to the container's current loopback address (for example `http://127.0.0.1:49152/mcp`), keeping your other keys. The write is atomic (a private temporary file beside the config, then a rename) and symlinked config files keep their link. Docker may assign a different port after the container restarts, and each later bare `wabgpt` updates the URL again.

The native address you had before is remembered in `onboarding.json`, so choosing the native browser later restores it. With the native browser, `browserMcpUrl` stays as you set it and setup lets you type a different loopback address. See [Managed browser](../guides/managed-browser.md) and [Local data](local-data.md).
