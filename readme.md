# Spine

Personal medical document archive. Upload PDFs and scans, let AI extract and index the content, review it, and share a read-only link with a doctor when needed.

Runs on a Raspberry Pi. No cloud storage — all data stays local.

## What it does

- Upload PDFs, including scans (drag-and-drop, multi-file), Word documents and text files, which are turned into PDFs on arrival, and iPhone HEIC photos, which become JPEGs. Photos (JPEG, PNG) are read by the AI model when image reading is switched on, and are refused otherwise; files are checked by their contents, not their names
- Full-text search over titles, summaries, notes, the text of every page, extracted values and doctors' names, with accents ignored
- Automatically splits a merged multi-document PDF into logical documents using AI boundary detection
- Extracts metadata per document: date, provider, type, summary, and individual fields (diagnoses, medications, lab values, etc.)
- Every extracted field links back to the page it came from — click a field to open that page, with its exact position highlighted where the page has a text layer or was read by local OCR
- Lab values and vitals are kept as numbers, so each test can be charted over time against its reference range
- A doctors directory that grows as documents are read: who wrote, prescribed or referred, with their documents. With image reading on, a clinic's signature stamp (name, specialty, professional code) is read too

- Review queue to accept, correct, or override anything the AI got wrong
- A library of the names the AI extracted and reuses — tags, providers, tests, and the doctors directory — to rename, merge and remove duplicates
- Full-text and filtered search across all documents
- Expiring, revocable read-only share links to send a doctor a subset of your history — everything, a tag, documents you pick or a date range. The recipient gets the timeline, the document pages and the trends, read-only, with no account or app
- Episodes: documents that belong together, suggested from the provider, the dates and the links between documents and confirmed by you; the timeline and the search filter by episode, facility and specialty, and a share link can name episodes
- Related documents (the same test or doctor, and, with Vertex embeddings on, ones that read alike) and search by words and meaning together
- The interface is in English, Romanian, French and German, and a document's extracted details and your notes are translated into the reader's language on demand (and kept), including on a shared page
- Export one document, or everything, as a zip with a manifest of what was read; upload that zip anywhere to restore it without the AI, with duplicates recognised. Any other zip of PDFs is added like separate uploads

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md) — target architecture, trust boundaries, ports and adapters, migration path
- [SECURITY.md](SECURITY.md) — security principles, implemented controls, and the open gaps
- [docs/self-host.md](docs/self-host.md) — `docker compose up -d` on one machine, with HTTPS
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute; the repository is canonical on GitHub, and a deployed instance redirects `/source`, `/docs` and `/security` to it (set `SPINE_REPO_URL`)
- [docs/key-hierarchy.md](docs/key-hierarchy.md) — the key hierarchy and trust boundaries planned for the hosted service (a design, not what runs today)
- [docs/deployment-gcp.md](docs/deployment-gcp.md) — Vertex AI as an inference provider, EU residency, IAM

### Direction

What runs today is multi-user with local accounts, with storage, inference, parsing and mail behind interfaces (SQLite the only store; Anthropic and Vertex for inference), and hybrid ingestion that routes scans and handwriting to a multimodal model when you allow it. Hosting stays self-hosted on a Raspberry Pi — GCP is used for inference only, never as an app host. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and what is left.

## Stack

| | |
|---|---|
| Server | Node.js + Fastify (API + serves the React build) |
| Web | React + Vite + Tailwind CSS |
| Database | SQLite (single file, zero ops) |
| Parsing | PDF.js reads the PDF's text layer in the server process; local Tesseract and, optionally, a vision model for scanned pages |
| AI | Anthropic or Vertex AI, set by configuration (continuation detection, field extraction, translation, optionally reading page images) |
| Web server | nginx (from `packages/nginx`) with Let's Encrypt |

## First install

The steps below are the short version. [docs/setup.md](docs/setup.md) is the full guide: what to decide first, Vertex, reading scans, Brevo and open signup, nginx without the packages repository, and what to do when the server refuses to start.

### 1. Dependencies

```bash
sudo ./install.sh -d
```

Installs Node.js LTS, tesseract, poppler-utils.

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

Builds the React app and compiles the TypeScript server.

### 4. Services

```bash
sudo ./install.sh -s
```

Installs and starts `spine-web` (port 3000) as a systemd service, plus a daily backup timer. It refuses to run if `SESSION_SECRET` is missing, short or still the placeholder.

### 5. Your account

By default there is no signup page; create accounts from the command line (or set `SPINE_REGISTRATION=open` with a mailer, see `.env.example`):

```bash
cd server
npm run cli -- create-user you@example.com   # prints a password once
npm run cli -- list-users
npm run cli -- set-password you@example.com  # signs that user out everywhere
npm run cli -- reset-link you@example.com    # a one-time link to choose a new password
npm run cli -- disable-2fa you@example.com   # lost phone and recovery codes
npm run cli -- delete-user you@example.com   # says what it would remove; add --yes to do it
```

Pass `--password-stdin` to choose the password instead of generating one (12+ characters).

**Two-factor sign-in** is optional and per user: **Account → Two-factor sign-in → Set up**, scan the QR code with any authenticator app, enter the first code, and save the ten recovery codes it then shows once. After that, signing in also asks for a code. It is not required of anyone, so on an open instance each user chooses. If `SESSION_SECRET` is ever changed, authenticator codes stop working (recovery codes still do); see SECURITY.md S-21.

### 6. nginx

```bash
sudo ./install.sh -n
```

Reads `SPINE_DOMAIN` from `.env` and, if the [nginx package](https://gitlab.com/alexcocinda/packages.git) is cloned next to this folder as `../packages/nginx`, runs its `nginx-domains.sh cert` (needs certbot installed). Any nginx works; [docs/setup.md](docs/setup.md#6-https-and-nginx) has the commands with and without that package. It then to issue the Let's Encrypt cert, installs the Spine site config, and reloads nginx.

## After code changes

```bash
./install.sh -b
sudo systemctl restart spine-web
```

## Service management

```bash
sudo systemctl status spine-web
journalctl -u spine-web -f
```

## Data

Everything lives in `data/` (set `DATA_DIR` to move it; the default is `<repo>/data`):
- `data/spine.db` — SQLite database
- `data/originals/<user>/<year>/` — uploaded source files, never modified
- `data/pages/` — rasterized page images (PNG, ~200 DPI); regenerable

A daily timer copies the database and the originals to `backups/` beside `data/`, keeping the last 7 snapshots. That protects against corruption and mistakes, not against losing the disk: point `SPINE_BACKUP_DIR` at removable or network storage for that.

**Upgrading from the single-user version:** the database layout changed and cannot be upgraded in place. Spine refuses to start on the old one and tells you how many records it holds. If it is empty, delete `spine.db`, `spine.db-wal` and `spine.db-shm` and restart. If it is not, do not delete it.

## Reading handwriting

Most documents are digital PDFs, and those need no AI: their own text is used. `SPINE_PARSER=hybrid` handles the rest per page, cheapest first: the PDF's text layer, then local OCR (Tesseract) if it is confident, and only then your LLM provider, which sees a page only if both of those fell short. It needs `SPINE_MULTIMODAL_ENABLED=true` as well — sending images is a separate decision — and `tesseract-ocr` with its language packs (it refuses to start without them), unless you set `SPINE_OCR=off`, which goes from the text layer straight to the model. `SPINE_PARSER=ocr` is the same without any model: nothing leaves your machine, and handwriting reads poorly. The startup log says whether images can leave, and every page logs which way it went, so the thresholds in `.env.example` can be tuned on your own documents. Pages the model read are marked "Read by AI · position approximate" in the review screen.

If a document still comes out wrong — handwriting, a tilted or photographed page, a scan with a poor embedded text layer — open it and use **Read again** beside Review: **Read page with AI** sends this page's image to a model, **Read whole document** reads the document's pages again the way an upload does. Each tells you where any image goes and what it replaces before it does anything.

## Share links

From the Share Links page, create a link scoped to all history, a tag, a date range, or specific documents. Default expiry is 7 days. Links can be revoked instantly. The doctor opens the link in any browser — no account or setup needed.

## Tests

```bash
cd server
npm test                   # run all tests (no model is ever called)
npm run test:coverage      # run with coverage report
npm run test:integration   # the flows against the real model and PDFs from .env (minutes, a few hundred model calls)
```

Run `npm test` (or `npm run test:coverage`) in `server/`. Statement and branch coverage are both above 90%; the figures change with every commit, so they are not copied here.

| Area | Files | Notes |
|---|---|---|
| Isolation | `isolation.test.ts` | A second user against the first user's data, every route and every repository method; every route refuses an unauthenticated request |
| Response shape | `response-shape.test.ts` | Whole responses scanned for `user_id`, server paths, checksums, tokens |
| Auth | `auth.test.ts` | Email login, no account enumeration, session fixation, password change, rate limits |
| Two-factor | `totp.test.ts`, `second-factor.test.ts` | RFC 4226/6238 vectors, drift and replay, encryption at rest, the two-step login, recovery codes, guess throttling, no bypass via reset |
| Accounts | `accounts.test.ts`, `cli.test.ts` | Signup, verification, recovery links, rate limits; the CLI commands, including deletion |
| Mail | `mail.test.ts` | Brevo adapter, no attachment field, config refusals, neutral wording |
| Config | `config.test.ts`, `llm.test.ts` | Startup refuses bad secrets, providers and endpoints |
| Documents | `documents.test.ts` | CRUD, tag updates, split/merge boundaries, column whitelist |
| Upload | `upload.test.ts`, `source-files.test.ts` | Multipart upload, per-user storage, duplicate detection, status polling |
| Share links | `share.test.ts`, `public-share-scoped.test.ts`, `public-share-detail.test.ts`, `share-token.test.ts` | Scope validation, fail-closed reads, hashed tokens, the recipient's page |
| Store | `legacy-database.test.ts` | An old-shape database is refused |
| Backup | `backup.test.ts` | Snapshot is a readable database; originals mirror; retention |
| Parser | `parser.test.ts`, `ocr.test.ts`, `read-page.test.ts`, `capabilities.test.ts` | Box scaling, one entry per page, the text-layer → OCR → model cascade and its thresholds, fallback, the two-switch rule, the image message, "Read with AI" |
| Ingestion pipeline | `pipeline.test.ts`, `reconcile.test.ts` | Splitting, grounding, error paths, restart recovery, a blank page not shifting images, model-read pages |
| AI | `continuation.test.ts`, `grounding.test.ts` | Validation and fallbacks, tested through fake task clients |
| Page images | `page-image.test.ts` | Auth required, streams PNG, 404 on missing row or file |
| Translation | `translation.test.ts`, `i18n-coverage.test.ts` | Digest-validated cache, two stages, retry of missing or rambling values, language detection, the public routes; every interface string present in all dictionaries |
| Export and import | `archive.test.ts` | Trimmed document export, whole archive, restore without a model, duplicates by checksum and by text, plain zips, Office files, damaged and tampered manifests (needs poppler) |
| Similarity | `similarity.test.ts` | The Vertex embedder against a fake service, stale vectors, model changes, related documents, search by words and meaning, other users and set-aside documents excluded |
| Chat history | `chat-history.test.ts` | Starting, titling, continuing (history read from the store, citations removed, never from the browser), listing, renaming, deleting one or all, other users' conversations a 404 everywhere, no owner id in responses, deletion with the account, caps |
| Chat agent | `chat-agent.test.ts` | A scripted model drives the real tools and graph: search, open, test series, connections; scope (other users', set-aside and unconfirmed documents, ids that are not labels); the screen (listed documents, upload, selected field); round and size limits; fallbacks and switches; no tool writes |
| Chat | `chat.test.ts` | What is sent (card, notes, results, trend, connections) and what never is (pages, ids, other users', set-aside or unconfirmed documents), keywords and ranking for a sentence, labels tied back to documents, history trimmed, validation, the switch, no call without a match |
| Grouping confirmation | `grouping-confirmation.test.ts` | Documents of an unconfirmed upload are out of the timeline, search, review queue and shares but on the upload; cannot be reviewed; no links; confirming shows them and starts linking; old uploads count as confirmed |
| Owner edits | `owner-edits.test.ts` | Headline, fields and results the owner set, added, changed or removed survive a new reading; clearing a value hands it back; an unchanged save marks nothing |
| Care chains | `linking.test.ts` | Candidates without a model, what the model is shown, the relation-to-link mapping and the date check, proposals replaced while confirmed and dismissed links stay, dismissed pairs not offered again, other users and set-aside documents excluded, cascade deletes, the routes' 404s |
| Library | `management.test.ts` | Tags, providers and tests: counts, rename, merge, remove, share links following a tag, another user's entries |

### Integration tests

`npm run test:integration` runs whole flows with the model named in `.env`, poppler, on a fresh in-memory database and a temporary data directory (never your `data/`, never the real mailer): attach a mixed export in the chat and follow it to the end, ask about the records, ask the assistant to share, correct, tag and tidy, a recipient asking about a shared link, and the calls the pipeline makes. It asserts what must hold whatever the model says. See [docs/testing.md](docs/testing.md); each scenario in [docs/scenarios.md](docs/scenarios.md) says whether it is covered (`auto`, `live`, `hand`).

### What isn't covered

- `rasterize.ts` — PDF rasterizer; needs actual PDF files
- the `invoke` paths in `llm/adapters/*` — need live provider credentials, so no real page has been read by a model; the image message was checked against both providers' request builders and the configuration refusals are covered

Tests use in-memory SQLite (`SPINE_DB_PATH=:memory:`) with a `resetStore()` call between files so no state leaks across test files. Fixtures are built through the store interface, not raw SQL.

## Credits

Countries in a share link's access log come from the [IP to Country Lite database by DB-IP.com](https://db-ip.com), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Licence

GNU Affero General Public License v3.0 only (AGPL-3.0-only), see [LICENSE](LICENSE). Anyone who runs a modified version as a network service must offer its users the corresponding source. This is software for holding medical records, provided without warranty: read [SECURITY.md](SECURITY.md) before putting real records on an instance. Whoever runs an instance is the controller of its data.
