# Agentic Commerce Ledger — single-image deploy.
#
# One Node process runs the commerce-agent, which starts the catalog MCP
# server in-process on loopback (EMBED_CATALOG=true) and serves the
# dashboard as static files. Nothing else to orchestrate.
#
#   docker build -t agentic-bazaar .
#   docker run -p 4200:4200 --env-file .env agentic-bazaar

FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# --- deps (cached unless a package.json changes) ---
COPY package.json package-lock.json* ./
COPY catalog-server/package.json ./catalog-server/
COPY commerce-agent/package.json ./commerce-agent/
RUN npm install --omit=dev --no-audit --no-fund

# --- app ---
COPY . .
RUN node seed/generate-catalog.js

# The hash-chained ledger, Ed25519 keys and shopper memory live here.
# Mount a volume at /data and set ACL_DATA_DIR=/data to persist them
# across restarts; otherwise they start fresh each boot (fine for a demo).
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]

USER node
EXPOSE 4200
ENV PORT=4200 HOST=0.0.0.0 EMBED_CATALOG=true

HEALTHCHECK --interval=30s --timeout=4s --start-period=15s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

CMD ["node", "commerce-agent/src/index.js"]
