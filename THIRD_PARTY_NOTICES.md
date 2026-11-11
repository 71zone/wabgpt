# Third-party notices

wabgpt's original code is MIT-licensed (see `LICENSE`). Choosing MIT for that code does **not** relicense anything below, and it does not make a combined build, bundle or container image that includes these components MIT. Each component stays under its own terms. This file is an engineering inventory, not legal advice.

It was written from the repository's `package.json`, `package-lock.json` and the installed copies of the packages. Lockfile license fields are what the packages declare; they were not independently audited. Re-check them whenever dependencies change.

## Runtime dependencies that need attention

### libsignal 6.0.0 — GPL-3.0

- Pulled in by `@whiskeysockets/baileys` (declared MIT) and imported at run time for WhatsApp's end-to-end encryption. It is not a development-only tool.
- Package metadata and its `LICENSE` file declare GNU GPL version 3. A verbatim copy of that file is in `licenses/libsignal-GPL-3.0.txt`.
- Consequence for distribution: handing someone a *combined* work that includes libsignal (an npm tarball with dependencies bundled, a container image, a packaged binary) can carry GPLv3 conditions for that distribution, including offering corresponding source and keeping notices. Whether and how those conditions reach wabgpt's own MIT code in a particular combined artifact is **an open question that this project has not resolved and that needs a lawyer's review before anyone ships such an artifact**.
- Not the same as network use: merely running GPLv3 software as a service does not by itself trigger the AGPL-style network source-disclosure clause. This repository does not make a claim either way about other GPLv3 duties.
- What this repository does: ships source only, keeps `"private": true` in `package.json` (so `npm publish` is refused), and does not publish container images or npm packages. Dependencies are fetched by the person who installs or builds. The `Dockerfile` copies the dependency tree's own license files and `licenses/` into the image; anyone who publishes a built image takes on the review above.

### @whiskeysockets/baileys 7.0.0-rc14 — MIT

Copyright (c) 2025 Rajeh Taher/WhiskeySockets. Unofficial WhatsApp Web client, not affiliated with or endorsed by WhatsApp or Meta. Full text: `licenses/baileys-MIT.txt`. Its dependency libsignal is described above.

### Optional image-processing packages (sharp, libvips) — Apache-2.0 / LGPL-3.0-or-later

`package-lock.json` records `sharp` (Apache-2.0) and platform-specific `@img/sharp-*` binaries. The `@img/sharp-libvips-*` binary packages are declared `LGPL-3.0-or-later`; some Windows/WASM variants are declared `Apache-2.0 AND LGPL-3.0-or-later`. They are marked optional in the lockfile and are pulled in through a Baileys peer-dependency entry. wabgpt does not process media. LGPL terms for those binaries apply to anyone who redistributes them; each package ships its own license text in `node_modules`.

## Other runtime dependencies

Declared licenses taken from installed package metadata:

| Package | Version | License |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT |
| `ajv`, `ajv-formats` | 8.20.0, 3.0.1 | MIT |
| `blessed` | 0.1.81 | MIT |
| `pino` | 10.4.0 | MIT |
| `qrcode-terminal` | 0.12.0 | Apache-2.0 (declared as `"Apache 2.0"`; the package has no `license` field) |
| `zod` | 4.6.7 | MIT |

The server's dashboard also uses `qrcode` for browser QR rendering. Check its license in `package-lock.json` / `node_modules/qrcode/package.json` after installing.

The remaining transitive packages are mostly MIT, BSD-2/3-Clause, ISC, Apache-2.0, BlueOak-1.0.0 (`lru-cache`) and 0BSD (`tslib`). Each installed package keeps its own license file in `node_modules/<name>/`; do not strip them when producing an image or archive.

Development-only packages (TypeScript, tsx, linkedom and their dependencies) are not part of the runtime image.

## BrowserOS Neo — GNU AGPL-3.0 (separate program)

- Source and license: <https://github.com/browseros-ai/BrowserOS> (AGPL-3.0, plus ungoogled-chromium and Chromium component licenses as that project documents).
- wabgpt neither vendors, modifies nor copies BrowserOS. It talks to a BrowserOS Neo process over a loopback Streamable HTTP MCP connection.
- `compose.yaml` references the official image `ghcr.io/browseros-ai/neo`, pinned by digest, which each user pulls directly from GitHub Container Registry. Nothing in this repository's Docker build or package contains BrowserOS binaries.
- Whoever republishes a BrowserOS image, a modified build, or a bundle containing its binaries must follow upstream's license and source-offer requirements for that artifact. Pulling the official image from its publisher does not change upstream's terms.
- It is our position, not a legal ruling, that a separate client talking to an AGPL program over a network protocol is a separate work. If your use differs (for example modifying BrowserOS or linking its code), review it yourself.

## Trademarks

WhatsApp, ChatGPT, OpenAI, BrowserOS and Chromium are trademarks of their respective owners. wabgpt is unaffiliated with them.

## Items still needing a human decision

1. Counsel review of libsignal GPLv3 against any *distributed combined* artifact (npm bundle, container image, release archive).
2. Approval to publish anything. No publishing workflow exists, and `package.json` stays `"private": true`, until that approval is given separately.
3. Confirmation that `qrcode` and any later dependency licenses are compatible with the intended distribution.
