# syntax=docker/dockerfile:1
#
# wabgpt application image (WhatsApp <-> ChatGPT bridge, owner dashboard).
# BrowserOS Neo is NOT part of this image: Compose pulls the official upstream
# image separately. See compose.yaml and docs/deployment.md.
#
#   docker compose build wabgpt

# --- build: compile TypeScript with dev dependencies -------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the "prepare" script runs the build before sources exist.
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# --- deps: production dependencies only --------------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# --- runtime ------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="wabgpt" \
      org.opencontainers.image.description="Single-user WhatsApp to ChatGPT bridge with an owner dashboard" \
      org.opencontainers.image.licenses="MIT AND GPL-3.0-only (see /usr/share/doc/wabgpt/THIRD_PARTY_NOTICES.md)"

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# dist/interfaces/http/server.js resolves ../../../web/ to /app/web.
COPY web ./web

# Licence texts travel with the image. Each dependency also keeps its own
# LICENSE file inside node_modules.
COPY LICENSE THIRD_PARTY_NOTICES.md /usr/share/doc/wabgpt/
COPY licenses/ /usr/share/doc/wabgpt/licenses/

# Secret-free deployment config; the owner token is generated into /data on
# first start and never baked into the image.
COPY deploy/config.json /etc/wabgpt/config.json

# Convenience launcher so `docker compose exec wabgpt wabgpt token ...` works.
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/wabgpt \
 && chmod 0755 /usr/local/bin/wabgpt \
 && install -d -m 0700 -o node -g node /data

# Non-root. A new named volume mounted at /data inherits this ownership.
USER node
VOLUME ["/data"]
EXPOSE 8788

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve", "--config", "/etc/wabgpt/config.json"]
