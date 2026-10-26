# The relay for model calls (docs/relay.md): the same code as the server, run as `node dist/relay/main.js`. Build from the repository root:
#   docker build -f relay.Dockerfile -t spine-relay .
# Pinned by digest (the multi-architecture index, 2026-10-25), so a rebuild is the same Node and the same Debian. To move it: read the new digest of
# node:22-bookworm-slim from the registry (Docker-Content-Digest of its index), put it here, build both images, and run the checks.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
# better-sqlite3 compiles when no prebuilt binary fits the platform (the server shares its dependencies)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY core core
COPY server server
RUN npm run build:server && npm run smoke -w spine-server && rm -rf node_modules && npm ci --omit=dev --workspace spine-server

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/core/package.json core/
COPY --from=build /app/core/dist core/dist
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
WORKDIR /app/server
USER node
ENV NODE_ENV=production
# The daily count is kept in the process unless the deployment names a store (SPINE_STORE, DATA_DIR, SPINE_DB_PATH; docs/relay.md).
ENV SPINE_DB_PATH=:memory:
# Cloud Run sets PORT; the relay listens on it (8080 otherwise).
CMD ["node", "dist/relay/main.js"]
