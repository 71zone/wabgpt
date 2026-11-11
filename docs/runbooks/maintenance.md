---
type: Runbook
title: Operate, update, back up and reset wabgpt
description: Day-to-day commands for starting, stopping, updating, backing up, restoring, resetting and uninstalling wabgpt in each deployment mode.
---

# Operate, update, back up and reset wabgpt

Commands here are authoritative for running an existing installation. Setup is in the [guides](../guides/index.md); symptoms and fixes are in [Troubleshooting](troubleshooting.md).

Which mode is active is decided by the command you run; nothing detects it for you. Find your mode in the table, then use only that column's commands.

| Mode | wabgpt runs in | Data lives in | Guide |
| --- | --- | --- | --- |
| Native `wabgpt` or `wabgpt serve`, native or managed browser | Your machine | `~/.wa-chatgpt` by default (`dataDir` in `config.json`) | [Getting started](../guides/getting-started.md), [Managed browser](../guides/managed-browser.md), [Server](../guides/server.md) |
| Bundled Docker (default Compose stack) | Docker | Volumes `wabgpt_wabgpt-data` and `wabgpt_browseros-data` (default project name `wabgpt`) | [Docker Compose](../guides/docker-compose.md) |
| Docker wabgpt with native BrowserOS (host-browser override) | Docker, host networking | Volume `wabgpt_wabgpt-data` (shared with bundled mode) | [Host browser](../guides/host-browser.md) |

Native `wabgpt` is independent of both Compose modes: it keeps its own data directory and its own WhatsApp link. Never run it and a Compose `wabgpt` at the same time against copies of the same credentials, and never run two copies of the same WhatsApp credentials or the same BrowserOS profile at once. The lock file only protects one data directory on one host.

## Start, stop and read logs

### Native

- `wabgpt` opens the terminal dashboard. Quit with Q or Ctrl-C: settings are retained, forwarding is disarmed and wabgpt waits for an in-progress browser operation before it closes. Pausing prevents a pending reply from being sent but cannot retract a prompt already submitted to ChatGPT.
- `wabgpt serve [--config path]` runs the headless server with the same single-writer lock as the terminal dashboard, so you cannot run both against one data directory.
- Activity is in the dashboard's activity panel. It does not log message bodies.
- Quitting does not disable configured sessions. Previously active forwarding resumes on the next launch; see [Local data](../reference/local-data.md) and the [terminal reference](../reference/terminal.md).
- Setup pauses forwarding on entry. It can start replies for the chosen contact only after explicit consent; existing enabled contacts are not resumed implicitly. Otherwise, press R in the dashboard when you want to resume.

The managed Docker browser keeps running when wabgpt quits. Docker's `unless-stopped` policy restarts it after an engine restart unless you stopped the container manually. After `docker stop`, bare `wabgpt` starts it again. `wabgpt serve` and `wabgpt token` never start or check it; after the container restarts its host ports can change and only bare `wabgpt` rewrites `browserMcpUrl`.

Find and stop the managed browser without touching any other container, including the default Compose stack:

```sh
docker ps -a --filter label=io.wabgpt.owner=wabgpt
docker stop wabgpt-neo-<id>        # the name the first command printed; the next bare `wabgpt` starts it again
```

Compose containers do not carry those labels, so the filter lists only managed browsers (one per data directory). Never use `docker compose` commands on a managed browser.

### Bundled Docker

```sh
docker compose ps                    # health
docker compose logs -f wabgpt        # activity (no message bodies)
docker compose logs -f browseros     # BrowserOS output
docker compose stop                  # graceful: waits for an in-progress browser operation
docker compose up -d --wait          # start again; saved state resumes
```

Use `stop` (or `down` without `-v`) rather than killing containers. The wabgpt container has a 30 second grace period so it can finish a browser operation and release its lock.

If the `browseros` container is recreated (for example after an image change), run `docker compose up -d` again so `wabgpt` is recreated into its new network namespace. This is because `wabgpt` joins the `browseros` container's network namespace (`network_mode: service:browseros`).

### Host-browser override

Add `-f compose.yaml -f compose.host-browser.yaml` to every `docker compose` command and name `wabgpt` where a service is needed. There is no `browseros` service to start, stop or read logs from.

```sh
docker compose -f compose.yaml -f compose.host-browser.yaml ps
docker compose -f compose.yaml -f compose.host-browser.yaml logs -f wabgpt
docker compose -f compose.yaml -f compose.host-browser.yaml exec wabgpt wabgpt token --config /etc/wabgpt/config.json
docker compose -f compose.yaml -f compose.host-browser.yaml stop wabgpt
```

Plain `docker compose exec wabgpt ...` runs inside whichever `wabgpt` container already exists and does not reconfigure it. What switches modes is `docker compose up` run without the override: it recreates `wabgpt` from the bundled definition and starts `browseros`.

### Switching between the two Compose modes

The two Compose modes are mutually exclusive: they share the `wabgpt-data` volume, the dashboard port 8788 and `bridge.lock`. Stop the running one first. Never use `down -v`; it deletes the volumes (see [Reset and uninstall](#reset-and-uninstall)).

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

Either direction reuses the same `wabgpt-data` volume, so the WhatsApp link, routing state and owner token carry over. The ChatGPT browser profile does not: native BrowserOS and the bundled `browseros-data` profile never share cookies, and you must not copy one into the other. Sign in again, with the **same ChatGPT account** if you want to keep the saved project and conversation references in `wabgpt-data`. Nothing migrates cookies, history or conversations between browsers or accounts; a different account will not find them. See [Host browser](../guides/host-browser.md).

## Update

- **wabgpt, native:** update the repository checkout, then `npm install`, `npm run build` and `npm link` as in [Getting started](../guides/getting-started.md). State written by an older release is migrated on first save; see [Local data](../reference/local-data.md) for the `state.json.v1.bak` safety copy.
- **wabgpt, bundled Docker:** update the repository, then `docker compose build wabgpt && docker compose up -d --wait`.
- **wabgpt, host-browser mode:** rerun `docker compose -f compose.yaml -f compose.host-browser.yaml up -d --build --wait wabgpt`.
- **BrowserOS Neo in Compose:** the image is pinned to one multi-arch digest. To move to a newer upstream build, read upstream's release notes, replace the `@sha256:...` digest in `compose.yaml` with the new index digest (`docker buildx imagetools inspect ghcr.io/browseros-ai/neo:<tag>` prints it), then `docker compose pull browseros && docker compose up -d --wait`. The image disables BrowserOS's in-browser updater, so the browser stays at the pinned version. The managed browser uses the same digest, compiled into `src/onboarding/browser.ts`; see [CONTRIBUTING.md](../../CONTRIBUTING.md) before changing either.
- **Native BrowserOS:** update it yourself; wabgpt does not manage it.

## Backups and restore

Back up only while wabgpt is stopped, so files are consistent.

### What to protect

Everything below is a secret:

- The data directory (native: `~/.wa-chatgpt` by default) or the volume `wabgpt_wabgpt-data` (Docker): WhatsApp linked-device credentials, routing state and delivery journal, contact names and JIDs, the owner token. Anyone with a copy can act as your linked WhatsApp device and as the dashboard owner.
- `wabgpt_browseros-data` (bundled Docker) and the managed browser's `wabgpt-neo-<id>-data` volume: the Chromium profile, containing your ChatGPT session cookies. In a container Chromium encrypts them with a built-in key (`--password-store=basic`), so anyone who can read the files can read the cookies.

Back up only to storage you would trust with those credentials, encrypt the archives at rest, and never put them in Git, an image, an npm package or a shared folder. The repository's `.gitignore`, `.dockerignore` and npm `files` allowlist exclude these paths on purpose; do not weaken them. Keep a native data directory outside any Git checkout. wabgpt's own state avoids storing message and reply bodies, but a full BrowserOS profile, including its cookies and caches, can contain private content, so treat every browser profile backup as a secret. See [Local data](../reference/local-data.md).

### Cold backup, bundled Docker

Volume names assume the default Compose project name `wabgpt`; check them with `docker volume ls` first, because they differ if you changed the project name.

```sh
mkdir -p -m 700 "$HOME/wabgpt-backups"
docker compose stop
docker run --rm --user 0 --entrypoint sh \
  -v wabgpt_wabgpt-data:/data:ro \
  -v "$HOME/wabgpt-backups":/backup \
  wabgpt:local -c 'umask 077 && tar -C /data -czf /backup/wabgpt-data-$(date +%Y%m%d-%H%M%S).tar.gz .'
docker run --rm --user 0 --entrypoint sh \
  -v wabgpt_browseros-data:/data:ro \
  -v "$HOME/wabgpt-backups":/backup \
  wabgpt:local -c 'umask 077 && tar -C /data -czf /backup/browseros-data-$(date +%Y%m%d-%H%M%S).tar.gz .'
docker compose up -d --wait
```

The archives are owned by root with mode 0600.

### Restore

Restore into **empty** volumes with the stack stopped, using the reverse command (`tar -xzf <archive> -C /data`), then set ownership to uid 1000 for `wabgpt_wabgpt-data` (`chown -R 1000:1000 /data`). BrowserOS's entrypoint fixes ownership of its own volume. A restored `state.json` written by an older release (schema version 1) is kept as `state.json.v1.bak` on its first save; it is as sensitive as the state itself.

## Reset and uninstall

### Bundled Docker

- Stop everything and keep state: `docker compose down`.
- **Destroy all state** (WhatsApp link, routing, token, ChatGPT login): `docker compose down -v`. You must link WhatsApp and sign in to ChatGPT again.

### Native and managed browser

- Native state lives in the data directory (see [Local data](../reference/local-data.md)). This runbook gives no tested native reset recipe; stop wabgpt, back the directory up as described above and treat any removal as your own deliberate decision, after which you must link WhatsApp again.
- To discard a managed browser profile and its ChatGPT login, stop and remove that container, then its `-data` volume, with `docker rm` and `docker volume rm`. The next bare `wabgpt` creates a fresh pair and you sign in again. wabgpt never removes the profile automatically, and it refuses to touch a same-named container or volume that lacks its ownership labels. Do not use `docker compose down` for it: Compose did not create it.

### Rotate the owner token

Every existing dashboard session ends when the token is replaced.

Bundled Docker:

```sh
docker compose stop wabgpt
docker run --rm --entrypoint rm -v wabgpt_wabgpt-data:/data wabgpt:local -f /data/server-token
docker compose up -d --wait
docker compose exec wabgpt wabgpt token --config /etc/wabgpt/config.json
```

Host-browser mode: use `stop wabgpt` and the `exec` command with both `-f` flags as shown above; the `docker run ... rm` command is the same because it uses the same volume.

Native: this runbook documents no tested native rotation procedure. The token lives in `server-token` in the data directory (mode 0600) unless `tokenFile` in your config says otherwise; `wabgpt token [--config path]` prints it, creating it on first use. `wabgpt token` refuses to print into a non-interactive pipe, never writes the token to logs and never puts it in a URL. Treat it like a password: whoever holds it can pair your WhatsApp account and enable forwarding.

### Stale `bridge.lock` after a crash

The app refuses to start if `bridge.lock` remains. Never remove it while any process might still use the same credentials. Stale locks are never removed automatically.

Bundled Docker: confirm no wabgpt container is running (`docker compose ps`), then remove only that file:

```sh
docker run --rm --entrypoint rm -v wabgpt_wabgpt-data:/data wabgpt:local -f /data/bridge.lock
```

Host-browser mode: check with `docker compose -f compose.yaml -f compose.host-browser.yaml ps`; the same `rm` command applies.

Native: verify the previous terminal or `serve` process has stopped, then remove `bridge.lock` from the data directory (`~/.wa-chatgpt/bridge.lock` by default).

## Security reminders

Anyone who can run `docker` on the host is effectively root there and can read every volume. noVNC (6080) and MCP (9010) have no authentication and give full control of a browser signed in to your ChatGPT account; keep them on loopback and see [SECURITY.md](../../SECURITY.md). Unofficial WhatsApp client risk, ChatGPT UI changes and login or challenge friction are described in [Troubleshooting](troubleshooting.md) and [Delivery](../concepts/delivery.md).
