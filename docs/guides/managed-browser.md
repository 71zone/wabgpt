---
type: Guide
title: Managed Docker browser
description: Let the native wabgpt command run its own BrowserOS Neo container, and find, stop or discard it.
---

# Managed Docker browser

Choosing option 2 in the first-run setup (`wabgpt`, or `wabgpt setup` to redo it) makes the native `wabgpt` process run a BrowserOS Neo container for you. See [Getting started](getting-started.md#choose-a-browser) for how it compares with the native browser.

It is independent of the [Docker Compose stack](docker-compose.md): no Compose project, no `compose.yaml`, no app container and no repository checkout needed, from any working directory after a normal install.

## Prerequisite

Docker (Docker Desktop, OrbStack or Docker Engine) must already be installed and running. wabgpt does not install it. The `wabgpt` process only runs the `docker` command-line client (it needs no Compose and does not run an app container), and Docker's socket is never exposed over HTTP.

If Docker is missing, not running or denies your user, setup says so in plain words and lets you retry or, on first setup, go back and choose the native browser. It never claims success early.

## What wabgpt creates

Everything is scoped to your data directory, so a second data directory gets its own set. `<id>` is a short hash (12 characters) of the data directory path.

| Resource | Name | Notes |
| --- | --- | --- |
| Container | `wabgpt-neo-<id>` | The same official, digest-pinned Neo image as `compose.yaml`; hosted-mode settings, 1 GB shared memory, 20 s stop grace, restart policy `unless-stopped`; not privileged, no host network or PID namespace |
| Profile volume | `wabgpt-neo-<id>-data` | Mounted at `/data`; holds the isolated ChatGPT profile and persists across restarts |
| Labels | `io.wabgpt.owner=wabgpt`, `io.wabgpt.role=browser`, `io.wabgpt.scope=<id>` | wabgpt only reuses a container or volume that carries them; a same-name object without them is reported and left alone |
| Settings | [`deploy/neo.toml`](../../deploy/neo.toml) | Uploaded with `docker container cp` into `/etc/neo/neo.toml`, not bind-mounted, so no host path has to be shared with the Docker VM and a global install in any folder works. It turns automatic tab grouping on, as in Compose |

wabgpt reuses a container and volume it owns and never removes or recreates your profile automatically. It refuses to touch an unrelated container or volume that happens to have the same name.

The profile is separate from your native BrowserOS profile and from the Compose stack's `browseros-data` volume. Do not copy cookies between them.

## Ports

Container ports 9010 (BrowserOS MCP) and 6080 (noVNC viewer) are published on **`127.0.0.1` with Docker-chosen random host ports**. This avoids clashing with a native BrowserOS on 9010, the default Compose stack's viewer on 6080 and any other tool, and neither is reachable from another machine.

- wabgpt reads the real ports back from `docker inspect`, refuses a container that publishes anything beyond `127.0.0.1` (before starting it), and writes `http://127.0.0.1:<port>/mcp` into `browserMcpUrl` in the config file, keeping your other keys. It remembers your previous native address in `onboarding.json` so choosing the native browser later restores it.
- This is the **only** case in this repository where MCP is published to the host, and it exists because a native process cannot reach a container's private network. The default Compose stack does not publish MCP, and nothing is ever bound to a LAN or public interface.
- Both ports are unauthenticated: anything that can reach your computer's loopback can drive that browser, so use it only on a computer you trust. See [SECURITY.md](../../SECURITY.md).

## Lifecycle

- Every later bare `wabgpt` starts the container again if it is stopped, waits for BrowserOS's readiness endpoint (bounded, abortable) and refreshes `browserMcpUrl`, because Docker can give a restarted container new host ports. It reuses the container and profile.
- Quitting wabgpt does not stop or delete the container or volume, so the ChatGPT login persists and the container keeps running. `unless-stopped` also brings it back when the Docker engine starts.
- `wabgpt serve` and `wabgpt token` do not start or check the container. If you use them with a managed browser, run bare `wabgpt` first, which starts the container and records its current address in `config.json`. After the container restarts its ports can change, and only bare `wabgpt` updates the config.

### Find and stop it

This does not touch the default Compose stack or any other container. The Compose stack's containers do not carry these labels, so the filter lists only managed browsers (one per data directory).

```sh
docker ps -a --filter label=io.wabgpt.owner=wabgpt
docker stop wabgpt-neo-<id>      # use the name that command printed; the next bare `wabgpt` starts it again
```

### Discard the managed profile

Only do this if you want to delete the managed profile, which also deletes its ChatGPT login. Stop and remove that container with `docker rm`, then remove its `-data` volume with `docker volume rm`. The next bare `wabgpt` creates a fresh pair and you sign in again.

Never use `docker compose` commands on it (`docker compose down` included): it was not created by Compose.

## Related

- The Compose host-network override (`compose.host-browser.yaml`) runs the app in Docker and is separate from the managed browser: see [Host browser](host-browser.md).
- Backups, updates and uninstalling: see [maintenance](../runbooks/maintenance.md).
- Problems starting it: see [troubleshooting](../runbooks/troubleshooting.md).
