# The Spine server and the built web app. It holds accounts, the sealed vault and shares; records are read and kept on the device.
# Pinned by digest (the multi-architecture index, 2026-10-25), so a rebuild is the same Node and the same Debian. To move it: read the new digest of
# node:22-bookworm-slim from the registry (Docker-Content-Digest of its index), put it here, build both images, and run the checks.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
# better-sqlite3 compiles when no prebuilt binary fits the platform
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# core, server and web are npm workspaces: one lockfile at the root, one install, and core is built before the other two
COPY package.json package-lock.json ./
COPY core/package.json core/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY core core
COPY server server
COPY web web
# The commit the web app says it is (docs/verify-build.md); an image has no .git to ask: docker build --build-arg SPINE_COMMIT=$(git rev-parse HEAD) .
ARG SPINE_COMMIT
ENV SPINE_COMMIT=$SPINE_COMMIT
RUN npm run build
# Every entry point is started once, as it will be, before the image is made. Test support is not built into core/dist or server/dist at all.
RUN npm run smoke -w spine-server
# What the server runs, without the build tools or the web app's own packages (they are in web/dist now)
RUN rm -rf node_modules && npm ci --omit=dev --workspace spine-server

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
# The server parses and renders nothing (the device's core does, in the browser), so there is no poppler or Tesseract here: they exist only for the tests that run the whole app on Node.
RUN mkdir /data /backups && chown node:node /data /backups
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/core/package.json core/
COPY --from=build /app/core/dist core/dist
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
# The privacy notice, terms and intended purpose the app serves; mount your own over this or set SPINE_LEGAL_DIR
COPY docs/legal docs/legal
USER node
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app/server
CMD ["node", "dist/index.js"]
