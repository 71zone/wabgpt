# Contributing

wabgpt is a single-owner tool: one WhatsApp account, one ChatGPT account, one BrowserOS profile. Contributions should keep it small, predictable and safe for that case. Multi-tenant hosting, an API-key model provider, automatic login or CAPTCHA solving, and a public MCP proxy are out of scope.

By contributing you agree that your contribution is licensed under the project's [MIT License](LICENSE).

## Setup

Requires Node.js 24 or newer.

```sh
npm ci
npm run check    # tsc --noEmit over src and tests
npm test         # tsx --test tests/*.test.ts
npm run build    # compiles to dist/ (swapped in only if the build succeeds)
```

`npm run build` is also the `prepare` script, so `npm install` builds. CI runs `check`, `test` and `build` on Node 24 and 26, and builds the Docker image without pushing it (`.github/workflows/ci.yml`). Run the same three commands before opening a change.

Tests live in `tests/`; read them for what is covered rather than relying on a list here. Setup and managed-browser tests use synthetic WhatsApp and ChatGPT adapters and a fake Docker runner that checks the managed browser's ownership and loopback-only rules; they never touch a real account, a real contact or your own containers. Full message delivery, a real Docker engine and the account sign-ins need live sessions and a human, and the automated suite does not verify them. Honest manual checks so far: a packed, freshly installed `wabgpt` launched from another folder in a real terminal chose the managed Docker browser (container ready, signed-out ChatGPT detected and blocking the next step), stopped cleanly with Ctrl-C leaving its checkpoint and resumed on the next launch with the same container; the full setup journey, including contact choice and the explicit-consent prompt, was also run in a terminal against synthetic adapters; the project picker is exercised by running the dashboard in a terminal. No real WhatsApp pairing, ChatGPT sign-in or message was part of those. When you exercise something by hand, say exactly what you ran and what you did not.

## Where things go

See [docs/guides/extending.md](docs/guides/extending.md) for the layout and the contracts. In short:

- `src/core/` is provider-neutral and must not import adapters, the filesystem, config, Baileys, BrowserOS or UI code.
- Provider specifics (WhatsApp, ChatGPT DOM and URLs, the BrowserOS MCP transport, JSON storage) live in `src/adapters/`.
- Frontends (`src/interfaces/tui`, `src/interfaces/http`, static files in `web/`) talk to `Application` only.
- `src/bootstrap.ts` is the only place that composes concrete providers.
- `src/onboarding/` is the first-run terminal setup (`wabgpt`, `wabgpt setup`): `prepare.ts` picks the browser before the Application exists, `wizard.ts` runs the remaining steps against it, `state.ts` owns the private `onboarding.json`, and `browser.ts` is the managed Docker browser backend (it only runs the `docker` CLI). `serve`, `token` and `--help` must never start it.
- Tests go in `tests/*.test.ts`; shared helpers in `tests/support/`.

Do not add compatibility re-exports or alias paths; change callers instead.

## Invariants to preserve

Changes that touch delivery must keep these, with tests:

- No automatic replay of a prompt whose acceptance is uncertain; a failed route pauses until the owner re-enables it.
- A message is journaled before it is submitted, and the journal deduplicates across identity aliases.
- Read receipts are sent only after the prompt is confirmed in its conversation, and never delay the reply.
- Pausing is re-checked before a reply is sent.
- Conversation lifetimes are fixed from the conversation's first saved reference; project and conversation ownership stay unique per contact.
- Message and reply bodies are never persisted or logged.
- State files are private (directory 0700, files 0600), written atomically, and only after validation. Persisted `state.json` is versioned; older versions are migrated in memory and covered by tests.
- No environment variables are required to run.
- BrowserOS MCP is reached only through a validated loopback URL, and the HTTP server never proxies it.
- First-run setup never signs in, solves challenges or submits a prompt, never enables a contact without an explicit `yes`, and never overwrites an invalid or newer-version `onboarding.json`. A config file alone does not mean setup is complete; installations with saved state or WhatsApp credentials keep their startup.
- The managed Docker browser touches only containers and volumes that carry its ownership labels, never removes a profile automatically, and publishes only on `127.0.0.1`.

## Data, tests and fixtures

- Never commit real phone numbers, JIDs, ChatGPT project or conversation IDs, names, tokens, logs or screenshots from a live account. Use obviously synthetic values (repeated digits, `a`×32 project ids).
- Never write tests that message real contacts or submit real prompts. Use fake adapters; see `tests/support/core-fixtures.ts`.
- Do not commit anything from a data directory (`state.json`, `whatsapp/`, `server-token`, `bridge.lock`), a BrowserOS profile, `.env*` files or backups. `.gitignore`, `.dockerignore` and the `package.json` `files` list exclude them; do not weaken those allowlists.

## Dependencies and licenses

Every new runtime dependency changes what a distribution contains. Prefer none. If you add one, record its declared license in `THIRD_PARTY_NOTICES.md`, and raise it in the change description if it is copyleft. The project is `"private": true` on purpose and CI never publishes. Do not change that, add a publish workflow or push container images without an explicit maintainer decision (see `THIRD_PARTY_NOTICES.md` for the unresolved license questions).

## Docker and docs

- `compose.yaml` pins the official BrowserOS Neo image by digest, and `src/onboarding/browser.ts` uses the same digest; bump both together, deliberately, and say why. Never publish a port in a Compose file without the `127.0.0.1:` prefix and never publish MCP (9010) there. The only MCP publication is the managed browser that `wabgpt` itself creates, on `127.0.0.1` with random host ports; keep it loopback-only and do not widen it.
- `compose.host-browser.yaml` is an opt-in override for Docker wabgpt with an existing native BrowserOS (host networking). Keep it limited to the network mode, the dependency reset and the config mount. It must never publish ports, add a `host.docker.internal` or remote MCP URL, or bind the dashboard beyond `127.0.0.1`; document any change in [docs/guides/host-browser.md](docs/guides/host-browser.md), including its commands with both `-f` flags, and in [docs/runbooks/maintenance.md](docs/runbooks/maintenance.md) if operating commands change.
- Keep `deploy/config.json` and `deploy/config.host-browser.json` secret-free.
- User-facing behavior changes need README or `docs/` updates in the same change (guides and concepts in `docs/`, reference in `docs/reference/`, operating commands in `docs/runbooks/`; start at [docs/index.md](docs/index.md)). Do not document behavior you have not exercised.

## Reporting problems

Functional bugs: open an issue on the repository's tracker with the steps, versions and sanitized logs. Security issues: do not use the public tracker; see [SECURITY.md](SECURITY.md).
