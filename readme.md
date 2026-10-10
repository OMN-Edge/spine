# Spine

Personal medical document archive. Upload PDFs and scans, let AI extract and index the content, review it, and share a read-only link with a doctor when needed.

Runs on a Raspberry Pi. No cloud storage — all data stays local.

## What it does

- Upload PDFs and scanned images (drag-and-drop, multi-file)
- Automatically splits a merged multi-document PDF into logical documents using AI boundary detection
- Extracts metadata per document: date, provider, type, summary, and individual fields (diagnoses, medications, lab values, etc.)
- Every extracted field links back to its exact position on the original page — hover over a field to highlight its source
- Review queue to accept, correct, or override anything the AI got wrong
- Full-text and filtered search across all documents
- Create expiring, revocable read-only share links to send a doctor a subset of your history — no account or app needed on their end

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — target architecture, trust boundaries, ports and adapters, migration path
- [SECURITY.md](SECURITY.md) — security principles, implemented controls, and the open gaps
- [docs/deployment-gcp.md](docs/deployment-gcp.md) — Vertex AI as an inference provider, EU residency, IAM

### Direction

What runs today is **single-user**, SQLite-coupled and Anthropic-only. The intended
shape is multi-user with local accounts, storage and inference behind interfaces, and
hybrid ingestion that routes scans and handwriting to a multimodal model. Hosting stays
self-hosted on a Raspberry Pi — GCP is used for inference only, never as an app host.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the delta and the ordered migration path.

## Stack

| | |
|---|---|
| Server | Node.js + Fastify (API + serves the React build) |
| Web | React + Vite + Tailwind CSS |
| Database | SQLite (single file, zero ops) |
| Parsing | Python + Unstructured (a local service on port 8000), optionally a vision model for scanned pages |
| AI | Anthropic API (Claude Haiku — continuation detection + field extraction) |
| Web server | nginx (from `packages/nginx`) with Let's Encrypt |

## First install

### 1. Dependencies

```bash
sudo ./install.sh -d
```

Installs Node.js LTS, Python 3, tesseract, poppler-utils.

### 2. Config

```bash
cp .env.example .env
nano .env
```

Fill in:
- `ANTHROPIC_API_KEY` — get one at console.anthropic.com (or configure Vertex instead; see `.env.example`)
- `SESSION_SECRET` — a random string of at least 32 characters (`openssl rand -base64 48`)
- `SPINE_DOMAIN` — the domain you'll serve from (e.g. `spine.yourdomain.com`)

There is no shared password. Each person has an account with their own email and password.

### 3. Build

```bash
./install.sh -b
```

Builds the React app, compiles the TypeScript server, creates the Python venv and installs Unstructured.

### 4. Services

```bash
sudo ./install.sh -s
```

Installs and starts `spine-web` (port 3000) and `spine-ingestion` (port 8000) as systemd services, plus a daily backup timer. It refuses to run if `SESSION_SECRET` is missing, short or still the placeholder.

### 5. Your account

By default there is no signup page; create accounts from the command line (or set `SPINE_REGISTRATION=open` with a mailer, see `.env.example`):

```bash
cd server
npm run cli -- create-user you@example.com   # prints a password once
npm run cli -- list-users
npm run cli -- set-password you@example.com  # signs that user out everywhere
npm run cli -- reset-link you@example.com    # a one-time link to choose a new password
npm run cli -- delete-user you@example.com   # says what it would remove; add --yes to do it
```

Pass `--password-stdin` to choose the password instead of generating one (12+ characters).

### 6. nginx

```bash
sudo ./install.sh -n
```

Reads `SPINE_DOMAIN` from `.env`, calls `nginx-domains.sh cert` from the nginx package to issue the Let's Encrypt cert, installs the Spine site config, and reloads nginx.

## After code changes

```bash
./install.sh -b
sudo systemctl restart spine-web
# If the ingestion service changed:
sudo systemctl restart spine-ingestion
```

## Service management

```bash
sudo systemctl status spine-web
sudo systemctl status spine-ingestion
journalctl -u spine-web -f
journalctl -u spine-ingestion -f
```

## Data

Everything lives in `data/` (set `DATA_DIR` to move it; the default is `<repo>/data`):
- `data/spine.db` — SQLite database
- `data/originals/<user>/<year>/` — uploaded source files, never modified
- `data/pages/` — rasterized page images (PNG, ~200 DPI); regenerable

A daily timer copies the database and the originals to `backups/` beside `data/`, keeping the last 7 snapshots. That protects against corruption and mistakes, not against losing the disk: point `SPINE_BACKUP_DIR` at removable or network storage for that.

**Upgrading from the single-user version:** the database layout changed and cannot be upgraded in place. Spine refuses to start on the old one and tells you how many records it holds. If it is empty, delete `spine.db`, `spine.db-wal` and `spine.db-shm` and restart. If it is not, do not delete it.

## Reading handwriting

The local parser is exact on typed PDFs and weak on handwriting. `SPINE_PARSER=hybrid` keeps it for typed pages and sends only the scanned or blank ones, as images, to your LLM provider. It needs `SPINE_MULTIMODAL_ENABLED=true` as well — sending images is a separate decision — and the startup log says whether it is on. Those pages are marked "Read by AI · position approximate" in the review screen.

## Share links

From the Share Links page, create a link scoped to all history, a tag, a date range, or specific documents. Default expiry is 7 days. Links can be revoked instantly. The doctor opens the link in any browser — no account or setup needed.

## Tests

```bash
cd server
npm test              # run all tests
npm run test:coverage      # run with coverage report
```

325 tests across 24 files. Coverage as of last run: **98.14% statements, 94.28% branches**.

| Area | Files | Notes |
|---|---|---|
| Isolation | `isolation.test.ts` | A second user against the first user's data, every route and every repository method; every route refuses an unauthenticated request |
| Response shape | `response-shape.test.ts` | Whole responses scanned for `user_id`, server paths, checksums, tokens |
| Auth | `auth.test.ts` | Email login, no account enumeration, session fixation, password change, rate limits |
| Accounts | `accounts.test.ts`, `cli.test.ts` | Signup, verification, recovery links, rate limits; the CLI commands, including deletion |
| Mail | `mail.test.ts` | Brevo adapter, no attachment field, config refusals, neutral wording |
| Config | `config.test.ts`, `llm.test.ts` | Startup refuses bad secrets, providers and endpoints |
| Documents | `documents.test.ts` | CRUD, tag updates, split/merge boundaries, column whitelist |
| Upload | `upload.test.ts`, `source-files.test.ts` | Multipart upload, per-user storage, duplicate detection, status polling |
| Share links | `share.test.ts`, `public-share-scoped.test.ts`, `share-token.test.ts` | Scope validation, fail-closed reads, hashed tokens, the recipient's page |
| Store | `legacy-database.test.ts` | An old-shape database is refused |
| Backup | `backup.test.ts` | Snapshot is a readable database; originals mirror; retention |
| Parser | `parser.test.ts`, `read-page.test.ts` | Box scaling, one entry per page, which pages hybrid sends, fallback, the two-switch rule, the image message |
| Ingestion pipeline | `pipeline.test.ts`, `reconcile.test.ts` | Splitting, grounding, error paths, restart recovery, a blank page not shifting images, model-read pages |
| AI | `continuation.test.ts`, `grounding.test.ts` | Validation and fallbacks, tested through fake task clients |
| Page images | `page-image.test.ts` | Auth required, streams PNG, 404 on missing row or file |

### What isn't covered

- `ingestion-client.ts` — real HTTP call to the Python sidecar; needs a live sidecar. So the sidecar adapter's box scaling is tested against synthetic output, **not a real sidecar**
- `rasterize.ts` — PDF rasterizer; needs actual PDF files
- the `invoke` paths in `llm/adapters/*` — need live provider credentials, so no real page has been read by a model; the image message was checked against both providers' request builders and the configuration refusals are covered

Tests use in-memory SQLite (`SPINE_DB_PATH=:memory:`) with a `resetStore()` call between files so no state leaks across test files. Fixtures are built through the store interface, not raw SQL.
