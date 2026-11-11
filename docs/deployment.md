# Self-hosted server deployment

This guide runs wabgpt as a **single-user** server with Docker Compose: one WhatsApp account, one ChatGPT account, one owner. It is not a multi-tenant or public service, and nothing here makes it one. If you only want the terminal dashboard on your own computer, you do not need this guide: install `wabgpt`, run it, and its first-run setup can start a managed Docker browser for you (see [Guided setup with a managed Docker browser](#guided-setup-with-a-managed-docker-browser)).

In the default (bundled) setup two containers are involved; [Choose where BrowserOS runs](#choose-where-browseros-runs) covers using an existing native BrowserOS instead:

| Service | Image | Role |
| --- | --- | --- |
| `browseros` | Official `ghcr.io/browseros-ai/neo`, pinned by digest, pulled from its publisher | BrowserOS Neo on a virtual display, with its MCP server and a noVNC viewer |
| `wabgpt` | Built from this repository's `Dockerfile` | WhatsApp connection, routing and the owner dashboard |

BrowserOS Neo is AGPL-3.0 software that this repository neither copies nor modifies. Compose downloads the official image directly from GitHub Container Registry; see `THIRD_PARTY_NOTICES.md`.

## What is exposed

| Port | Served by | Published on the host? | Authentication |
| --- | --- | --- | --- |
| 8788 | wabgpt owner dashboard | `127.0.0.1` only | Owner token, then a server-side session cookie |
| 6080 | BrowserOS noVNC viewer | `127.0.0.1` only | **None** |
| 9010 | BrowserOS MCP (and its local API) | **Not published at all** | **None** |

- Docker publishes ports only on the host's loopback address. Remote access is an SSH tunnel or a private VPN, not an open port.
- The `wabgpt` container joins the `browseros` container's network namespace (`network_mode: service:browseros`). wabgpt therefore reaches MCP at `127.0.0.1:9010` inside that shared namespace, and Docker never maps 9010 to the host. The dashboard on 8788 is wabgpt's listener inside the same namespace, published through the `browseros` service.
- Keep the `127.0.0.1:` prefix on the `ports:` entries in `compose.yaml`. Without it Docker publishes on every interface and, on Linux, bypasses firewalls such as `ufw`.
- noVNC gives full mouse and keyboard control of a browser that is signed in to your ChatGPT account. MCP lets a caller drive that browser and run scripts in it. Never put either behind a public port, and never proxy them without your own authentication layer.
- No application environment variables are needed. The only configuration is `deploy/config.json` (secret-free), or `deploy/config.host-browser.json` in host-browser mode.
- The statement that MCP is never published describes this Compose stack. The one deliberate exception is the managed browser that the native `wabgpt` command starts for itself, described [below](#guided-setup-with-a-managed-docker-browser): there MCP and the viewer are published on `127.0.0.1` only, on random host ports. Neither Compose file does that.

## Choose where BrowserOS runs

wabgpt talks to one BrowserOS MCP endpoint, always a loopback URL (`http://127.0.0.1:9010/mcp` by default). Four setups are supported. The two Docker Compose modes (bundled and host-browser) are the same Compose project and share the `wabgpt-data` volume, so they use the same WhatsApp credentials, owner token and `bridge.lock`, and the same dashboard port 8788: run only one of them at a time and switch by stopping first. Native `wabgpt` (the terminal dashboard or `wabgpt serve`) is independent: it keeps its own data directory, `~/.wa-chatgpt` by default, and does not use that volume. The managed Docker browser belongs to that native data directory and is described next to it.

| Mode | wabgpt runs in | BrowserOS runs in | Config | Sign in to ChatGPT |
| --- | --- | --- | --- | --- |
| **Bundled Docker** (default) | Docker (`compose.yaml`) | Docker, the digest-pinned `browseros` service | `deploy/config.json` | noVNC at `127.0.0.1:6080` |
| **Native BrowserOS, native wabgpt** | Your machine (`wabgpt`, `wabgpt serve`) | Your machine, an existing BrowserOS Neo | `~/.wa-chatgpt/config.json` | In your own BrowserOS window |
| **Native BrowserOS, Docker wabgpt** (expert) | Docker, host networking (`compose.host-browser.yaml`) | Your machine, an existing BrowserOS Neo | `deploy/config.host-browser.json` | In your own BrowserOS window |
| **Managed Docker browser, native wabgpt** | Your machine (`wabgpt`) | A container the native `wabgpt` creates (not Compose) | `~/.wa-chatgpt/config.json`, written by setup | The viewer address setup prints |

Everything else in this guide describes the bundled Docker default unless a section says otherwise. Which mode is active is decided by the command you run; nothing detects it for you. The native modes (bare `wabgpt` and `wabgpt serve`) are the same program the [README](../README.md) describes; the Compose modes remain valid expert setups, and `serve`, `token` and `--help` never run the interactive setup.

### Native wabgpt with existing BrowserOS

No Docker involved. Install and launch as the [README](../README.md) describes. First launch asks you to choose this (option 1) or the managed browser; keep BrowserOS Neo running and leave `browserMcpUrl` at its loopback URL in `~/.wa-chatgpt/config.json`. This is also the setup behind [Alternative topology](#alternative-topology-desktop-browseros).

### Guided setup with a managed Docker browser

Choosing option 2 in the first-run setup (`wabgpt`, or `wabgpt setup` to redo it) makes the native `wabgpt` process run a BrowserOS Neo container for you. It is independent of everything in this guide: no Compose project, no `compose.yaml`, no app container and no checkout needed, from any working directory after a normal install. Docker must already be installed and running; wabgpt does not install it. The process only runs the `docker` command-line client, and Docker's socket is never exposed over HTTP.

What it creates, scoped to the data directory (`<id>` is a 12-character hash of its path):

| Resource | Name | Notes |
| --- | --- | --- |
| Container | `wabgpt-neo-<id>` | The same official, digest-pinned Neo image as `compose.yaml`; hosted-mode settings, 1 GB shared memory, 20 s stop grace, restart policy `unless-stopped`; not privileged, no host network or PID namespace |
| Profile volume | `wabgpt-neo-<id>-data` | Mounted at `/data`; holds the isolated ChatGPT profile, persists across restarts |
| Labels | `io.wabgpt.owner=wabgpt`, `io.wabgpt.role=browser`, `io.wabgpt.scope=<id>` | wabgpt only reuses a container or volume that carries them; a same-name object without them is reported and left alone |
| Settings | `deploy/neo.toml` | Uploaded with `docker container cp` into `/etc/neo/neo.toml`, not bind-mounted, so no host path has to be shared with the Docker VM. It turns automatic tab grouping on, as in Compose |

Ports. Container ports 9010 (MCP) and 6080 (noVNC viewer) are published on **`127.0.0.1` with Docker-chosen random host ports**. This avoids clashing with a native BrowserOS on 9010, the default stack's viewer on 6080 and any other tool. wabgpt reads the real ports back from `docker inspect`, refuses a container that publishes anything beyond `127.0.0.1` (before starting it), and writes `http://127.0.0.1:<port>/mcp` into `browserMcpUrl` in the config file. This is the **only** case in this repository where MCP is published to the host, and it exists because a native process cannot reach a container's private network. The default Compose stack still does not publish MCP, and nothing is ever bound to a LAN or public interface. As in every other mode, both ports are unauthenticated: anything that can reach your computer's loopback can drive that browser, so use it only on a computer you trust.

Lifecycle:

- Every later bare `wabgpt` starts the container if it is stopped, waits for BrowserOS's readiness endpoint (bounded, abortable) and refreshes `browserMcpUrl`, because Docker can give a restarted container new host ports. It reuses the container and profile and never removes or recreates them.
- Quitting wabgpt does not stop or delete the container or volume. `unless-stopped` also brings it back when the Docker engine starts.
- If Docker is missing, not running or denies your user, setup reports it in plain words and lets you retry (or go back and choose the native browser on first setup).
- `wabgpt serve` and `wabgpt token` do not start or check the container. Start the browser with bare `wabgpt` first; after the container restarts its ports can change and only bare `wabgpt` updates the config.

Find and stop it without touching the default Compose stack or anything else:

```sh
docker ps -a --filter label=io.wabgpt.owner=wabgpt
docker stop wabgpt-neo-<id>        # the name printed above; the next bare `wabgpt` starts it again
```

The Compose stack's containers do not carry those labels, so the filter lists only managed browsers (one per data directory). To discard a managed profile and its ChatGPT login, remove that container and then its `-data` volume with `docker rm` and `docker volume rm`; wabgpt will create a fresh pair on its next launch and you sign in again. Never use `docker compose` commands on it.

Docker app container plus a native browser override (`compose.host-browser.yaml`, above) stays supported and is separate: it runs the app in Docker and does not use the managed browser.


### Docker wabgpt with existing native BrowserOS (host networking)

Use this when you want wabgpt in a container but your own BrowserOS Neo, already signed in to ChatGPT on your machine, as the browser. `compose.host-browser.yaml` is an opt-in override of `compose.yaml`. It:

- runs `wabgpt` with `network_mode: host`, so `127.0.0.1` inside the container is the **host's** loopback and reaches native BrowserOS MCP at `127.0.0.1:9010`;
- removes the dependency on the bundled `browseros` service, so you start only `wabgpt`;
- replaces the config mounted at `/etc/wabgpt/config.json` with `deploy/config.host-browser.json`. It is identical to `deploy/config.json` except that `server.host` is `127.0.0.1` (not `0.0.0.0`), `browserMcpUrl` is `http://127.0.0.1:9010/mcp`, and `dataDir` and `tokenFile` stay under `/data`.

Start it, from the repository root, naming only `wabgpt` and always with both `-f` flags:

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

What changes in this mode:

- **Dashboard.** Served on the host's `127.0.0.1:8788` by the container itself, because host networking ignores `ports:` and the config binds loopback only. Reach it at <http://127.0.0.1:8788>, or from another machine through `ssh -N -L 8788:127.0.0.1:8788 you@your-machine`. Log in with the owner token as usual.
- **No noVNC (6080).** There is no bundled browser. Sign in to ChatGPT yourself, locally, in the existing BrowserOS window that owns the profile its MCP server drives. wabgpt does not log in for you and does not check automatically that you did; use the dashboard's browser check and project refresh as described in [First-time setup](#first-time-setup-human-steps).
- **MCP stays on loopback.** The MCP URL is still `http://127.0.0.1:9010/mcp`, a loopback URL, and the app still refuses anything else. Do not publish or rebind 9010 on a LAN interface, and do not add a remote, LAN or `host.docker.internal` URL instead. In an ordinary (bridge-network) container `127.0.0.1` is the container itself, not your machine, which is why bundled mode shares a network namespace with `browseros` and this mode uses host networking.
- **Different profiles.** Native BrowserOS uses your desktop profile; the bundled one uses the `browseros-data` volume. They never share cookies and you must not copy one into the other (see the Linux fresh login note below). Switching modes means the other browser may need its own ChatGPT sign-in. Sign in with the **same ChatGPT account** if you want to keep using the saved project and conversation references in `wabgpt-data`: those references point at conversations in that account, and nothing migrates cookies, history or conversations between browsers or accounts. A different account will not find them.
- **Broader network reach.** Host networking removes the container's network isolation. The `wabgpt` process can connect to any service listening on the host's loopback, and any local user or process that can reach host loopback can reach the dashboard port. Loopback is not authentication; the owner token is. The override changes only the network, the dependency and the config mount; the container is still non-root, read-only, with all capabilities dropped and `no-new-privileges`. The unauthenticated native MCP endpoint is reachable by anything that can reach host loopback, with or without Docker.
- **No ad-hoc exposure.** Do not set `server.host` to `0.0.0.0` in this mode: under host networking that binds every host interface. Do not publish ports or add remote URLs to work around a problem.

Platform support, from the primary documentation:

- **Docker Engine on Linux** supports `network_mode: host` ([Docker: host network driver](https://docs.docker.com/engine/network/drivers/host/)). Native BrowserOS must listen on `127.0.0.1:9010`.
- **Docker Desktop** supports it from version **4.34** and only after you sign in to Docker and enable **Settings → Resources → Network → Enable host networking**, then **Apply and restart**. It works in both directions (a host-networked container can reach servers on the host's `localhost`), at layer 4 (TCP and UDP) only. It does not work with Enhanced Container Isolation enabled, and only for Linux containers ([Docker: host network driver, Docker Desktop section](https://docs.docker.com/engine/network/drivers/host/#docker-desktop)).
- **OrbStack** supports host networking out of the box: servers on the Mac are reachable from the container on `localhost` ([OrbStack: host networking](https://docs.orbstack.dev/docker/host-networking)).
- The override uses Compose's `!reset` tag, which needs **Docker Compose v2.24.4 or newer**.
- Tested here, on macOS with OrbStack only: an ephemeral `docker run --network host wabgpt:local` container fetched native BrowserOS's `http://127.0.0.1:9010/system/ready` and got HTTP 200 with status `ok`; and an isolated test instance started through this Compose override, with no BrowserOS container, became healthy, called the native BrowserOS MCP (open and script calls returned a marker object, touching no tabs and sending no messages), served its dashboard on host loopback (login page 200, private routes 401), and refused connections on the Mac's non-loopback IPv4 addresses. The bundled default stack kept answering throughout. No WhatsApp link, ChatGPT sign-in or message was exercised, and none of this has been exercised on Linux or Docker Desktop.

### Switching modes

The two Compose modes are mutually exclusive. Stop the running one first, then start the other. Never use `down -v`; it deletes the volumes (see [Reset and uninstall](#reset-and-uninstall)).

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

The first run creates, inside the `wabgpt-data` volume: `server-token` (owner token, mode 0600), `state.json`, `bridge.lock` and a `whatsapp/` directory with WhatsApp credentials after you link an account. If the volume starts from state written by an older release (schema version 1, for example a restored backup), the first save keeps that file as `state.json.v1.bak` beside the new `state.json`; it is private but as sensitive as the state itself. The `browseros-data` volume holds the BrowserOS profile.

## Reach the dashboard and viewer

From your own workstation, open an SSH tunnel to the server (replace the user and host):

```sh
ssh -N -L 8788:127.0.0.1:8788 -L 6080:127.0.0.1:6080 you@your-server
```

Do **not** forward 9010; nothing on your workstation needs it.

- Dashboard: <http://127.0.0.1:8788>
- noVNC viewer: <http://127.0.0.1:6080>

A private VPN works the same way as long as the Docker host's published ports stay bound to `127.0.0.1` and you reach them through a tunnel or forward you control. Even inside a VPN, the dashboard asks for the owner token; another VPN member is not automatically authorized, and noVNC has no such protection.

Open the dashboard through the same hostname you tunneled (`127.0.0.1` or `localhost`). The server rejects unexpected `Host` values; see [`http.md`](http.md) for the exact API and rules.

## Get the owner token

The token is created on first use and stored in `/data/server-token`. Print it on the server, in an interactive terminal:

```sh
docker compose exec wabgpt wabgpt token --config /etc/wabgpt/config.json
```

The command refuses to print into a non-interactive pipe, never writes the token to logs and never puts it in a URL. Paste it into the dashboard's login form. Treat it like a password: whoever holds it can pair your WhatsApp account and enable forwarding. To rotate it, see [Reset and uninstall](#reset-and-uninstall); every existing session ends.

Anyone who can run `docker` on the host is effectively root there and can read both volumes.

## First-time setup (human steps)

These steps need a person. wabgpt does not log in for you, solve CAPTCHAs, or bypass Cloudflare or OpenAI challenges.

### 1. Sign in to ChatGPT through noVNC

*Bundled mode only.* With an existing native BrowserOS (native or host-browser mode) skip noVNC: sign in to `https://chatgpt.com` yourself in that BrowserOS window, and continue at step 2.

1. Open <http://127.0.0.1:6080> through the SSH tunnel. BrowserOS Neo fills the tab.
2. In the remote browser, go to `https://chatgpt.com` and sign in yourself: email or SSO, multi-factor prompts, and any Cloudflare verification that appears. Use the remote keyboard and mouse.
3. Confirm you land on the signed-in ChatGPT page.

The profile lives in the `browseros-data` volume, so the login survives restarts and image updates. Hosted-mode BrowserOS disables Chromium's password saving and autofill, so expect to sign in manually again if the session expires.

**Linux fresh login is required.** The profile in this Compose stack is new and isolated. Do not copy a macOS or Windows BrowserOS or Chrome profile into it: those cookies are encrypted with the desktop OS keychain, which Linux cannot read, and copying a personal profile would also move unrelated logins. Your desktop profile and this container profile never share state.

**Datacenter IP caveat.** Cloudflare and OpenAI treat datacenter addresses (VPS providers) with more suspicion than residential connections. You may see repeated verification challenges, temporary blocks or rate limits on `chatgpt.com`. This is probabilistic: some ranges work fine, and residential connections still get occasional checks. There is no workaround in this project. If challenges make a VPS unusable, see [Alternative topology](#alternative-topology-desktop-browseros).

### 2. Open the dashboard and check the browser

Log in with the owner token and run the browser check. It verifies that wabgpt can reach the BrowserOS MCP server and that a ChatGPT message composer is available, without sending a prompt. A signed-out ChatGPT page can still show a composer, so the check alone does not prove you are signed in. Refresh the project list as well: it reports "ChatGPT is signed out in BrowserOS" until the remote browser is actually signed in.

### 3. Link WhatsApp in the owner dashboard

1. In the dashboard connect WhatsApp. A QR code renders from the raw pairing payload.
2. On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan the QR.
3. The directory fills from WhatsApp's sync. The QR is shown only to an authenticated owner and never appears in logs or on unauthenticated endpoints.

WhatsApp can restrict accounts that use unofficial clients, and linking from an unfamiliar datacenter address can make that more likely. This project uses an unofficial protocol library; accept that risk before linking a number you depend on.

### 4. Choose contacts and enable them

Pick a project (optional) and a conversation lifetime per contact, then enable only contacts whose messages you are authorized to share with ChatGPT. Enabling a contact sends their incoming text to ChatGPT and sends ChatGPT's answers from your WhatsApp account. See the main [README](../README.md) for delivery behavior.

## Operate

```sh
docker compose ps                    # health
docker compose logs -f wabgpt        # activity (no message bodies)
docker compose logs -f browseros     # BrowserOS output
docker compose stop                  # graceful: waits for an in-progress browser operation
docker compose up -d --wait          # start again; saved state resumes
```

Use `stop` (or `down` without `-v`) rather than killing containers. The wabgpt container has a 30 second grace period so it can finish a browser operation and release its lock.

If the `browseros` container is recreated (for example after an image change), run `docker compose up -d` again so `wabgpt` is recreated into its new network namespace.

The commands above are for bundled mode. In host-browser mode add `-f compose.yaml -f compose.host-browser.yaml` to every `docker compose` command and name `wabgpt` where a service is needed (see [Docker wabgpt with existing native BrowserOS](#docker-wabgpt-with-existing-native-browseros-host-networking)); there is no `browseros` service to start, stop or read logs from. To update wabgpt there, rerun the `up -d --build --wait wabgpt` command from that section.

### Update

- wabgpt: update the repository, then `docker compose build wabgpt && docker compose up -d --wait`.
- BrowserOS Neo: the image is pinned to one multi-arch digest. To move to a newer upstream build, read upstream's release notes, replace the `@sha256:...` digest in `compose.yaml` with the new index digest (`docker buildx imagetools inspect ghcr.io/browseros-ai/neo:<tag>` prints it), then `docker compose pull browseros && docker compose up -d --wait`. The image disables BrowserOS's in-browser updater, so the browser stays at the pinned version.

### Browser sandbox

Upstream's image defaults to `NEO_SANDBOX=false`, which starts Chromium with `--no-sandbox`, because Docker's default seccomp profile blocks the user namespaces Chromium's sandbox needs. Pages therefore run without Chromium's process sandbox, and the container boundary is the only wall. This stack keeps that upstream default and does not use `privileged`, `seccomp=unconfined`, `apparmor=unconfined` or host mounts to change it. Only sign in to sites you trust in this browser, and keep the host patched. If you want the sandbox and accept relaxing Docker's security profile for that container, read upstream's "Security" section and add the settings yourself.

### Dashboard behind HTTPS (optional)

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

## Backups and private volumes

Both volumes are secrets:

- `wabgpt_wabgpt-data`: WhatsApp linked-device credentials, routing state and delivery journal, contact names and JIDs, the owner token. Anyone with a copy can act as your linked WhatsApp device and as the dashboard owner.
- `wabgpt_browseros-data`: the Chromium profile, containing your ChatGPT session cookies. In a container Chromium encrypts them with a built-in key (`--password-store=basic`), so anyone who can read the files can read the cookies.

Back up only to storage you would trust with those credentials, encrypt the archives at rest, and never put them in Git, an image, an npm package or a shared folder. The repository's `.gitignore`, `.dockerignore` and npm `files` allowlist exclude these paths on purpose; do not weaken them.

Cold backup (stop first so files are consistent; volume names assume the default Compose project name `wabgpt`):

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

The archives are owned by root with mode 0600. Check the volume names with `docker volume ls` first; if you changed the Compose project name they differ.

Restore into **empty** volumes with the stack stopped, using the reverse command (`tar -xzf <archive> -C /data`), then set ownership to uid 1000 for `wabgpt_wabgpt-data` (`chown -R 1000:1000 /data`). BrowserOS's entrypoint fixes ownership of its own volume. Never run two copies of the same WhatsApp credentials or the same BrowserOS profile at once; the lock file only protects one data directory on one host.

## Reset and uninstall

- Stop everything and keep state: `docker compose down`.
- **Destroy all state** (WhatsApp link, routing, token, ChatGPT login): `docker compose down -v`. You must link WhatsApp and sign in to ChatGPT again.
- Rotate only the owner token: `docker compose stop wabgpt`, then
  `docker run --rm --entrypoint rm -v wabgpt_wabgpt-data:/data wabgpt:local -f /data/server-token`, then `docker compose up -d --wait` and print the new token.
- After a crash, the app refuses to start if `bridge.lock` remains. Confirm no wabgpt container is running (`docker compose ps`), then remove only that file:
  `docker run --rm --entrypoint rm -v wabgpt_wabgpt-data:/data wabgpt:local -f /data/bridge.lock`.
  Do not remove it while any process might still use the same credentials.

## Alternative topology: desktop BrowserOS

If a VPS address triggers constant challenges, run the wabgpt app (not this Compose stack) where BrowserOS Neo is signed in on a residential connection, for example your desktop. A server can also reach your desktop's BrowserOS through an SSH reverse tunnel such as `ssh -R 9010:127.0.0.1:9010 user@server`, with `browserMcpUrl` left at `http://127.0.0.1:9010/mcp`. The loopback-only check on `browserMcpUrl` stays, so the MCP endpoint is never configured as a remote URL. This depends on the desktop staying awake and online, carries unauthenticated MCP over your tunnel, and is not exercised by this repository's Compose smoke test. Do not use `deploy/config.json` there; use the default `~/.wa-chatgpt/config.json`, run `wabgpt serve` or the TUI, and keep the dashboard on its default `127.0.0.1` listener.

If you want wabgpt itself in Docker but BrowserOS native on the same machine, use the host override described in [Choose where BrowserOS runs](#choose-where-browseros-runs) instead of this topology.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `docker compose up --wait` times out | `docker compose ps` and `docker compose logs browseros`. Give the first start about two minutes. |
| Chromium tabs crash ("Aw, Snap!") | `shm_size: 1g` must stay on `browseros`. |
| `port is already allocated` | Another program uses 8788 or 6080; stop it or change the host side of the `ports:` mappings. Keep the `127.0.0.1:` prefix. In host-browser mode only 8788 is used, and the bundled stack must be stopped first because it publishes the same port. |
| Dashboard loads but reports the browser unavailable | Run the browser check and refresh the project list; confirm noVNC (bundled) or your native BrowserOS window (host-browser or native mode) shows a signed-in ChatGPT page. In host-browser mode also confirm native BrowserOS is running and its MCP answers on `127.0.0.1:9010`. For a managed Docker browser, run bare `wabgpt` to restart it and refresh the port. |
| Host-browser mode cannot reach `127.0.0.1:9010` | Docker Desktop needs 4.34 or later with **Enable host networking** turned on and Enhanced Container Isolation off; check `docker compose -f compose.yaml -f compose.host-browser.yaml logs wabgpt`. Do not switch to a `host.docker.internal` or LAN URL; the app only accepts loopback. |
| `wabgpt token` fails or shows the wrong state in host-browser mode | Pass both `-f compose.yaml -f compose.host-browser.yaml` so the command resolves against the host-browser definition, and check that you did not run `docker compose up` without the override, which recreates `wabgpt` in bundled mode. |
| Constant verification pages on chatgpt.com | See the datacenter IP caveat. Do not try to automate around them. |
| wabgpt keeps restarting with a lock error | See the `bridge.lock` item under Reset. |
| `wabgpt token` refuses to print | Run it with a TTY (the default for `docker compose exec`); do not pass `-T` or pipe it. |
