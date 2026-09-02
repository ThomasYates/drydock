# ── stage 1: build the frontend ─────────────────────────────
FROM node:20-bookworm-slim AS web
WORKDIR /build
COPY web/package.json web/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ── stage 2: server dependencies ────────────────────────────
# better-sqlite3 and sharp ship prebuilt binaries for the common platforms;
# the toolchain is here so an architecture without one still builds.
FROM node:20-bookworm-slim AS deps
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

# ── stage 3: runtime ────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data && chown -R node:node /data

COPY --from=deps  --chown=node:node /build/node_modules ./node_modules
COPY --chown=node:node server/package.json ./package.json
COPY --chown=node:node server/src ./src
COPY --from=web   --chown=node:node /build/dist ./public

USER node
VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards SIGTERM, which is what lets the server close
# the database cleanly on `docker stop`.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]

LABEL org.opencontainers.image.title="Drydock" \
      org.opencontainers.image.description="A self-hosted workspace for planning games: moodboard, task board and branching story graph in one project." \
      org.opencontainers.image.source="https://github.com/ThomasYates/drydock" \
      org.opencontainers.image.licenses="MIT"
