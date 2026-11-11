---
type: Guide
title: Host browser mode
description: Run wabgpt in Docker against your own native BrowserOS Neo with host networking, and switch between Compose modes safely.
---

# Host browser mode

Use this when you want wabgpt in a container but your own BrowserOS Neo, already signed in to ChatGPT on your machine, as the browser. It is an opt-in expert setup built on the [Docker Compose stack](docker-compose.md); read that guide first for the install requirements, exposure rules and human setup steps.

`compose.host-browser.yaml` is an override of [`compose.yaml`](../../compose.yaml). It:

- runs `wabgpt` with `network_mode: host`, so `127.0.0.1` inside the container is the **host's** loopback and reaches native BrowserOS MCP at `127.0.0.1:9010`;
- removes the dependency on the bundled `browseros` service, so you start only `wabgpt`;
- replaces the config mounted at `/etc/wabgpt/config.json` with `deploy/config.host-browser.json`. It is identical to `deploy/config.json` except that `server.host` is `127.0.0.1` (not `0.0.0.0`, because host networking has no port publishing to restrict), `browserMcpUrl` is `http://127.0.0.1:9010/mcp`, and `dataDir` and `tokenFile` stay under `/data`.

This is separate from the [managed Docker browser](managed-browser.md), which belongs to the native `wabgpt` process and does not use Compose.

## Requirements

- Native BrowserOS Neo running on this machine, with its MCP listening on `127.0.0.1:9010`.
- **Docker Compose v2.24.4 or newer.** The override uses Compose's `!reset` tag.
- A Docker that supports host networking:
  - **Docker Engine on Linux** supports `network_mode: host` ([Docker: host network driver](https://docs.docker.com/engine/network/drivers/host/)).
  - **Docker Desktop** supports it from version **4.34** and only after you sign in to Docker and enable **Settings → Resources → Network → Enable host networking**, then **Apply and restart**. It works in both directions (a host-networked container can reach servers on the host's `localhost`), at layer 4 (TCP and UDP) only. It does not work with Enhanced Container Isolation enabled, and only for Linux containers ([Docker: host network driver, Docker Desktop section](https://docs.docker.com/engine/network/drivers/host/#docker-desktop)).
  - **OrbStack** supports host networking out of the box: servers on the Mac are reachable from the container on `localhost` ([OrbStack: host networking](https://docs.orbstack.dev/docker/host-networking)).

## Start it

From the repository root, naming only `wabgpt` and always with both `-f` flags:

```sh
docker compose -f compose.yaml -f compose.host-browser.yaml up -d --build --wait wabgpt
```

Use the same two flags for every later command in this mode:

```sh
docker compose -f compose.yaml -f compose.host-browser.yaml ps
docker compose -f compose.yaml -f compose.host-browser.yaml logs -f wabgpt
docker compose -f compose.yaml -f compose.host-browser.yaml exec wabgpt wabgpt token --config /etc/wabgpt/config.json
docker compose -f compose.yaml -f compose.host-browser.yaml stop wabgpt
```

Plain `docker compose exec wabgpt ...` runs inside whichever `wabgpt` container already exists and does not reconfigure it. What switches modes is `docker compose up` run without the override: it recreates `wabgpt` from the bundled definition and starts `browseros`. Pass both flags to every command in this mode anyway, so each one resolves against the same definition.

There is no `browseros` service in this mode, so there is nothing to start, stop or read logs from. To update wabgpt, rerun the `up -d --build --wait wabgpt` command above. More on operating the stack: [maintenance](../runbooks/maintenance.md).

## What changes in this mode

- **Dashboard.** Served on the host's `127.0.0.1:8788` by the container itself, because host networking ignores `ports:` and the config binds loopback only. Reach it at <http://127.0.0.1:8788>, or from another machine through `ssh -N -L 8788:127.0.0.1:8788 you@your-machine`. Log in with the owner token as usual.
- **No noVNC (6080).** There is no bundled browser. Sign in to ChatGPT yourself, locally, in the existing BrowserOS window that owns the profile its MCP server drives. wabgpt does not log in for you and does not check automatically that you did; use the dashboard's browser check and project refresh as described in [Docker Compose stack](docker-compose.md#open-the-dashboard-and-check-the-browser).
- **MCP stays on loopback.** The MCP URL is still `http://127.0.0.1:9010/mcp`, a loopback URL, and the app still refuses anything else. Do not publish or rebind 9010 on a LAN interface, and do not add a remote, LAN or `host.docker.internal` URL instead. In an ordinary (bridge-network) container `127.0.0.1` is the container itself, not your machine, which is why bundled mode shares a network namespace with `browseros` and this mode uses host networking.
- **Different profiles.** Native BrowserOS uses your desktop profile; the bundled one uses the `browseros-data` volume. They never share cookies and you must not copy one into the other (see the Linux fresh login note in the [Compose guide](docker-compose.md#sign-in-to-chatgpt-through-novnc)). Switching modes means the other browser may need its own ChatGPT sign-in. Sign in with the **same ChatGPT account** if you want to keep using the saved project and conversation references in `wabgpt-data`: those references point at conversations in that account, and nothing migrates cookies, history or conversations between browsers or accounts. A different account will not find them.
- **Broader network reach.** Host networking removes the container's network isolation. The `wabgpt` process can connect to any service listening on the host's loopback, and any local user or process that can reach host loopback can reach the dashboard port. Loopback is not authentication; the owner token is. The override changes only the network, the dependency and the config mount; the container is still non-root, read-only, with all capabilities dropped and `no-new-privileges`. The unauthenticated native MCP endpoint is reachable by anything that can reach host loopback, with or without Docker.
- **No ad-hoc exposure.** Do not set `server.host` to `0.0.0.0` in this mode: under host networking that binds every host interface. Do not publish ports or add remote URLs to work around a problem.

## What was tested

On macOS with OrbStack only: an ephemeral `docker run --network host wabgpt:local` container fetched native BrowserOS's `http://127.0.0.1:9010/system/ready` and got HTTP 200 with status `ok`; and an isolated test instance started through this Compose override, with no BrowserOS container, became healthy, called the native BrowserOS MCP (open and script calls returned a marker object, touching no tabs and sending no messages), served its dashboard on host loopback (login page 200, private routes 401), and refused connections on the Mac's non-loopback IPv4 addresses. The bundled default stack kept answering throughout. No WhatsApp link, ChatGPT sign-in or message was exercised, and none of this has been exercised on Linux or Docker Desktop.

## Switching modes

The two Compose modes are mutually exclusive: they are the same Compose project and share the `wabgpt-data` volume (same WhatsApp credentials, owner token and `bridge.lock`) and dashboard port 8788. Stop the running one first, then start the other. Never use `down -v`; it deletes the volumes (see [maintenance](../runbooks/maintenance.md)).

Bundled Docker to native BrowserOS with Docker wabgpt:

```sh
docker compose stop
docker compose -f compose.yaml -f compose.host-browser.yaml up -d --build --wait wabgpt
```

Back to bundled Docker:

```sh
docker compose -f compose.yaml -f compose.host-browser.yaml stop wabgpt
docker compose up -d --wait
```

Either direction reuses the same `wabgpt-data` volume, so the WhatsApp link, routing state and owner token carry over. Native `wabgpt` keeps its own data directory (default `~/.wa-chatgpt`) and is a separate WhatsApp link; never run it and a Compose `wabgpt` at the same time against copies of the same credentials.

If something fails, see [troubleshooting](../runbooks/troubleshooting.md).
