# The relay for model calls (docs/relay.md): the same code as the server, run as `node dist/relay/main.js`. Build from the repository root:
#   docker build -f relay.Dockerfile -t spine-relay .
FROM node:22-bookworm-slim AS build
# better-sqlite3 compiles when no prebuilt binary fits the platform (the server shares its dependencies)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci
COPY server server
RUN cd server && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app/server
COPY --from=build /app/server/package.json .
COPY --from=build /app/server/node_modules node_modules
COPY --from=build /app/server/dist dist
USER node
ENV NODE_ENV=production
# The daily count is kept in the process unless the deployment names a store (SPINE_STORE, DATA_DIR, SPINE_DB_PATH; docs/relay.md).
ENV SPINE_DB_PATH=:memory:
# Cloud Run sets PORT; the relay listens on it (8080 otherwise).
CMD ["node", "dist/relay/main.js"]
