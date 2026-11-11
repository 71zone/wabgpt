# Owner dashboard and HTTP API

`wabgpt serve` runs the same bridge as the terminal dashboard, headless, with a web dashboard for one trusted owner. It is not a multi-user service and has had no independent security audit. Keep it on loopback or a private network.

Code: `src/interfaces/http/` (`server.ts` routes and event streams, `auth.ts` token file, sessions and login limiter, `policy.ts` Host/Origin rules and headers, `view.ts` response shaping). Static assets: `web/index.html`, `web/app.js`, `web/app.css` (plain JavaScript, no build step).

```ts
startHttpServer({ application, settings, limits? }): Promise<{ url: string; close(): Promise<void> }>
readOrCreateOwnerToken(path: string): Promise<string>
```

`settings` is the loaded `server` config: `{ host, port, tokenFile, publicOrigin? }`. The server does not restore or close the `Application`; the runtime does. Start it first so it already follows changes and QR codes when `application.restore()` runs. `close()` stops serving, ends every event stream, removes its `Application` listeners and is idempotent. `limits` is optional and only meant for tests.

## Signing in

The owner token is 32 random bytes (base64url) in `server.tokenFile` (default `<dataDir>/server-token`, mode 0600, parent created 0700, created exclusively). Print it on a terminal with `wabgpt token`. The server never logs it, never serves it and never accepts it in a URL, header or cookie other than the one JSON `POST /api/login` body. The web page keeps nothing in `localStorage`; the session is an `HttpOnly` cookie and the CSRF token lives only in page memory.

Smoke test with curl (run `wabgpt token --config /path/config.json` separately in an interactive terminal, then paste its output at `read`; command substitution is deliberately refused). Every POST needs `Origin`, `Content-Type: application/json`, and mutations need the CSRF token:

```sh
umask 077
BASE=http://127.0.0.1:8788
IFS= read -r TOKEN
JAR=$(mktemp)
printf '{"token":"%s"}' "$TOKEN" | curl -si -c "$JAR" \
  -H "Origin: $BASE" -H 'Content-Type: application/json' \
  --data-binary @- "$BASE/api/login"             # returns {"csrfToken": ...}
unset TOKEN
curl -s -b "$JAR" "$BASE/api/state"
curl -s -b "$JAR" -X POST -H "Origin: $BASE" -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: <csrfToken>" -d '{}' "$BASE/api/forwarding/pause"
rm "$JAR"
```

## Security rules

- Listens on `server.host` (default `127.0.0.1`, port 8788). The container image binds `0.0.0.0` inside its own network namespace and publishes only a loopback host port. BrowserOS/MCP, noVNC and this API must not be internet-facing.
- **Host allow list.** `localhost`, `127.0.0.1` and `[::1]` on any port (so SSH forwards and remapped ports work), the specific bind address when `host` is not a wildcard, and the host of `publicOrigin`. Anything else gets `421`. Protects against DNS rebinding.
- **Public origin.** For a TLS reverse proxy set `server.publicOrigin` to the exact external origin (`https://wabgpt.example.com`). The proxy must forward the original `Host` header. Requests for that host use cookie `__Host-wabgpt_session` with `Secure`, and `Origin` must equal `publicOrigin`. `X-Forwarded-*` headers are ignored.
- **Sessions.** Random 256-bit ids, only a hash is kept server-side. Absolute 12 hour lifetime, at most 8 sessions (oldest revoked first). Cookie `wabgpt_session` (loopback) or `__Host-wabgpt_session` (public HTTPS): `HttpOnly; SameSite=Strict; Path=/; Max-Age`. Logout, expiry, eviction and re-login revoke the session and close its event streams.
- **CSRF.** Every mutation is `POST`, requires `Content-Type: application/json`, a same-origin `Origin` header and `X-CSRF-Token` equal to the session's token (compared in constant time). No GET changes state.
- **Reads and streams.** A request with a foreign `Origin` or `Sec-Fetch-Site` other than `same-origin`/`none` is refused with `403`. No CORS headers are sent.
- **Limits.** Login body 4 KiB, other bodies 8 KiB (`413`), 30 s request timeout, strict JSON schemas (unknown fields `400`), 5 failed logins per remote address per minute and 50 per minute overall (`429` with `Retry-After`, applied before the token is checked), 4 event streams per session and 16 overall, 200 activity entries.
- **Responses.** Private responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and a CSP of `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`. The dashboard inserts server text with `textContent` only.
- **Surface.** Only the routes below. No arbitrary MCP, script, URL, file or config access. Errors are single-line, at most 300 characters, with URLs replaced by `[address]`. Pairing QR codes and project catalogs are only returned to a signed-in session. Conversation references are never sent; the API reports only whether a conversation is saved and when it expires.

Not covered: anyone who can read the token file, the data directory or the host's loopback traffic is the owner. A compromised local process is outside this model.

## Routes

All bodies and responses are JSON. Errors are `{ "error": "<code>", "message": "<text>" }`. Successful commands return `{ "ok": true, "state": State }`.

| Method and path | Auth | Body | Result |
| --- | --- | --- | --- |
| `GET /`, `/index.html`, `/app.js`, `/app.css` | public | | static dashboard (no private data) |
| `GET /api/session` | public | | `{ authenticated:false }` or `{ authenticated:true, csrfToken, expiresAt, app }` |
| `POST /api/login` | public, Origin required | `{ token }` | `{ csrfToken, expiresAt, app }` and the session cookie; `401`, `429` |
| `POST /api/logout` | session + CSRF | `{}` | `{ ok:true }`, clears the cookie, ends its streams |
| `GET /api/state` | session | | `State` plus `activity` |
| `GET /api/events` | session | | server-sent events (below) |
| `GET /api/projects` | session | | `{ projects:[{ name, ref, owner:{ id, name }\|null }] }`; `502` if the assistant cannot list them |
| `POST /api/channel/connect` | session + CSRF | `{}` | calls `application.login()` (saved login or pairing QR) |
| `POST /api/browser/check` | session + CSRF | `{}` | `application.checkBrowser()`; `502` on failure |
| `POST /api/forwarding/resume` | session + CSRF | `{}` | `application.resume()`; `409` e.g. when nothing is enabled |
| `POST /api/forwarding/pause` | session + CSRF | `{}` | `application.pause()` |
| `POST /api/contacts` | session + CSRF | `{ input }` | resolves a phone number or JID through the channel, enables it and resumes; `422` for unusable input |
| `POST /api/contacts/enabled` | session + CSRF | `{ contactId, enabled }` | idempotent desired state (`setContactEnabled`); enabling resumes forwarding; `404` unknown contact |
| `POST /api/contacts/project` | session + CSRF | `{ contactId, projectRef: string\|null }` | assigns or clears the project; never enables the contact; `409` if taken or invalid |
| `POST /api/contacts/ttl` | session + CSRF | `{ contactId, ttl }` | `ttl` uses the terminal grammar (`90m`, `12h`, `3d`, `never`, empty = `24h`); `400` if invalid |

`contactId` must be an id from the current directory (`State.contacts`); names are never accepted from the client.

### State

```ts
{
  app: { channelName, assistantName },
  armed: boolean,                  // forwarding active
  channelStatus: string, assistantStatus: string,
  enabledCount: number, now: number,
  qr: string | null,               // PNG data URL of the current pairing code, rendered server-side with `qrcode`
  contacts: [{
    id, name, enabled, hasRoute, error: string | null,
    projectRef: string | null, ttlMinutes: number | null, ttl: string,
    conversation: { active, startedAt, expiresAt, expired },
    saved, lastMessageAt: number | null, unread, archived
  }]
}
```

### Events (`GET /api/events`)

`text/event-stream`. First `event: snapshot` (State + `activity: [{ id, at, message }]`), then `event: state` (State, coalesced after `Application` change events and QR updates) and `event: activity` (one entry per log line). A `: keep-alive` comment every 25 s. The stream ends when the session is logged out, expires or is evicted, or the server closes. `EventSource` reconnects on its own; a closed stream with `401` means sign in again.

## Dashboard element locators

Stable ids for scripted checks: login `#login`, `#login-form`, `#login-token`, `#login-submit`, `#login-error`; shell `#dashboard`, `#connection`, `#btn-logout`; status `#channel-status`, `#assistant-status`, `#forwarding-status`, `#enabled-count`, `#notice`; global controls `#btn-connect`, `#btn-browser`, `#btn-resume`, `#btn-pause`; QR `#qr-panel`, `#qr-image`; contacts `#add-form`, `#add-input`, `#add-submit`, `#contact-search`, `#contact-filter`, `#contact-list` (items `li[data-contact-id]` with `.pick` and `.toggle` buttons); detail `#detail-body`, `#detail-name`, `#detail-state`, `#detail-toggle`, `#project-select`, `#project-refresh`, `#project-save`, `#ttl-input`, `#ttl-save`; log `#activity-log`.

## Remote access

Preferred: keep `127.0.0.1` and use `ssh -L 8788:127.0.0.1:8788 host` or a VPN, then open `http://localhost:8788`. For a TLS reverse proxy, set `"server": { "publicOrigin": "https://wabgpt.example.com" }`, forward `Host` unchanged and restrict the proxy to the owner (VPN, mTLS or an authenticating proxy in addition to the owner token). Do not publish the BrowserOS MCP or noVNC ports.
