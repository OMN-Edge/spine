# The Spine server and the built web app. PDF text is read in-process (pdfjs-dist); there is no second service.
FROM node:22-bookworm-slim AS build
# better-sqlite3 compiles when no prebuilt binary fits the platform
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY web/package.json web/package-lock.json web/
RUN cd web && npm ci
COPY web web
RUN cd web && npm run build
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci
COPY server server
RUN cd server && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# poppler: rasterizing and trimming PDFs. tesseract: local OCR (SPINE_PARSER=ocr or hybrid); add a language pack here
# and to SPINE_OCR_LANGS if you need one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-ron \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /data /backups && chown node:node /data /backups
WORKDIR /app
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/node_modules server/node_modules
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
# The privacy notice, terms and intended purpose the app serves; mount your own over this or set SPINE_LEGAL_DIR
COPY docs/legal docs/legal
USER node
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app/server
CMD ["node", "dist/index.js"]
