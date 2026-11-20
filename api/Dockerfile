# syntax=docker/dockerfile:1
# Build context: repository root (needs api/ and sdk/).
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY api/tsconfig.json ./
COPY api/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
ENV NODE_ENV=production
# Pick up Alpine security fixes released after the pinned base image.
RUN apk upgrade --no-cache
WORKDIR /app/api
COPY --from=build /app/api/node_modules ./node_modules
COPY --from=build /app/api/dist ./dist
COPY api/package.json ./
COPY api/migrations ./migrations
COPY sdk/roomsink.js /app/sdk/roomsink.js
# Non-root; the root filesystem is mounted read-only in compose.
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s --retries=3 CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
# Migrations run inside the server process on start (RUN_MIGRATIONS=true), before listening.
CMD ["node", "dist/server.js"]
