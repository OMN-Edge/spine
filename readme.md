# Spine

Personal medical document archive. Upload PDFs and scans, let AI extract and index the content, review it, and share a read-only link with a doctor when needed.

Your records are read, searched and kept on your own device, in your browser. The server, which runs on a Raspberry Pi, holds only your account and sealed pieces of your records that it cannot open (see [docs/key-hierarchy.md](docs/key-hierarchy.md)). Model calls go through a relay that stores and logs nothing.

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

- [ARCHITECTURE.md](ARCHITECTURE.md) — where the code runs, trust boundaries, ports and adapters
- [SECURITY.md](SECURITY.md) — security principles, implemented controls, and the open gaps
- [docs/structure-rules.md](docs/structure-rules.md) — what "clean" means here, as rules a test checks
- [docs/self-host.md](docs/self-host.md) — `docker compose up -d` on one machine, with HTTPS
- [docs/setup.md](docs/setup.md) — the full install guide for a Raspberry Pi
- [docs/relay.md](docs/relay.md) — the relay that runs model calls, and how to deploy it
- [docs/operator-checklist.md](docs/operator-checklist.md) — what the person who runs an instance must do or confirm that the software cannot check
- [docs/requirements.md](docs/requirements.md) — what it must do (the `FR-`, `TR-` and `CR-` IDs cited around the repository)
- [docs/testing.md](docs/testing.md) and [docs/scenarios.md](docs/scenarios.md) — every check, and what each user flow is tested by
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute; the repository is canonical on GitHub, and a deployed instance redirects `/source`, `/docs` and `/security` to it (set `SPINE_REPO_URL`)
- [docs/key-hierarchy.md](docs/key-hierarchy.md) — the key hierarchy and trust boundaries: who can see what ([docs/crypto-design.md](docs/crypto-design.md) is the build plan)
- [docs/deployment-gcp.md](docs/deployment-gcp.md) — Vertex AI as an inference provider, EU residency, IAM

### Direction

What runs today is multi-user with local accounts. The records are made and kept on each owner's device (a core running in a Web Worker, over SQLite in WebAssembly) and saved to the server only as sealed objects; shares are sealed copies opened with a key in the address; model calls go through a relay (Vertex or Anthropic behind it), and hybrid ingestion routes scans and handwriting to a multimodal model when you allow it. The server is self-hosted on a Raspberry Pi; GCP is used for inference only, never as an app host. See [ARCHITECTURE.md](ARCHITECTURE.md) for the design and what is left.

## Stack

| | |
|---|---|
| Server | Node.js + Fastify: accounts, the vault of sealed objects, sealed shares, the relay's pass; serves the React build. It holds no record |
| Device | React + Vite + Tailwind CSS; the core (the shared `spine-core` package) in a Web Worker, with libsodium for the keys |
| Database | SQLite: in WebAssembly on the device (the records), a file on the server (accounts only) |
| Parsing | On the device: PDF.js reads the PDF's text layer, Tesseract.js reads scans, and, optionally, a vision model reads pages the others could not |
| AI | Anthropic or Vertex AI behind the relay, set by its configuration (continuation detection, field extraction, translation, chat, optionally reading page images) |
| Web server | nginx (from `packages/nginx`) with Let's Encrypt, or Caddy in Docker Compose |

## First install

The steps below are the short version. [docs/setup.md](docs/setup.md) is the full guide: what to decide first, the relay, Vertex, reading scans, Brevo and open signup, nginx without the packages repository, and what to do when the server refuses to start.

### 1. Dependencies

```bash
sudo ./install.sh -d
```

Installs Node.js LTS, curl and certificates, and `python3`, which `node-gyp` needs to compile the SQLite module where no prebuilt binary fits. No PDF or OCR program is installed: the device reads and renders files itself.

### 2. Config

```bash
cp .env.example .env
nano .env
```

Fill in:
- `SESSION_SECRET` — a random string of at least 32 characters (`openssl rand -base64 48`)
- `SPINE_DOMAIN` — the domain you'll serve from (e.g. `spine.yourdomain.com`)
- `SPINE_RELAY_URL` and `SPINE_RELAY_SECRET` — the relay your devices send model calls to, and the secret you share with it (`openssl rand -base64 48`). Without them a device cannot call a model and says so; everything else works. The provider key (`ANTHROPIC_API_KEY`, or Vertex's settings) goes to the relay, not to this server: [docs/relay.md](docs/relay.md)

There is no shared password. Each person has an account with their own email and password.

### 3. Build

```bash
./install.sh -b
```

Builds the shared core, the TypeScript server and the React app.

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
npm run cli -- set-password you@example.com  # an account with no vault only; signs that user out everywhere
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

Reads `SPINE_DOMAIN` from `.env` and, if the [nginx package](https://gitlab.com/alexcocinda/packages.git) is cloned next to this folder as `../packages/nginx`, runs its `nginx-domains.sh cert` (needs certbot installed). Any nginx works; [docs/setup.md](docs/setup.md#6-https-and-nginx) has the commands with and without that package. It then issues the Let's Encrypt cert, installs the Spine site config, and reloads nginx.

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

The server keeps only what it cannot read (set `DATA_DIR` to move it; the default is `<repo>/data`):
- `data/spine.db` — SQLite database of accounts, sign-ins, the vault's index and share metadata. No record is in it
- `data/vault/<user>/` — the sealed objects (a person's records and files, encrypted on their device)
- `data/shares/` — sealed share copies, removed when a link ends or is revoked

The records themselves are in each owner's browser while it is open and in the vault as ciphertext. A daily timer copies the database and the vault to `backups/` beside `data/`, keeping the last 7 snapshots; shares are not backed up on purpose. That protects against corruption and mistakes, not against losing the disk: point `SPINE_BACKUP_DIR` at removable or network storage for that.

**Upgrading from the single-user version:** the database layout changed and cannot be upgraded in place. Spine refuses to start on the old one and tells you how many records it holds. If it is empty, delete `spine.db`, `spine.db-wal` and `spine.db-shm` and restart. If it is not, do not delete it.

## Reading handwriting

This runs on the device, with the settings of the server's `.env` (the ones that name no secret are passed to it). Most documents are digital PDFs, and those need no AI: their own text is used. `SPINE_PARSER=hybrid` handles the rest per page, cheapest first: the PDF's text layer, then local OCR (Tesseract) if it is confident, and only then your LLM provider, which sees a page only if both of those fell short. It needs `SPINE_MULTIMODAL_ENABLED=true` as well — sending images is a separate decision — and Tesseract, whose English and Romanian packs ship with the web app, unless you set `SPINE_OCR=off`, which goes from the text layer straight to the model. `SPINE_PARSER=ocr` is the same without any model: nothing leaves your machine, and handwriting reads poorly. Every page logs which way it went (in the browser's console), so the thresholds in `.env.example` can be tuned on your own documents. Pages the model read carry an "AI" chip whose hint says it gives the text and not where on the page it is, so nothing is highlighted.

If a document still comes out wrong — handwriting, a tilted or photographed page, a scan with a poor embedded text layer — open it and use **Read again** beside Review: **Read page with AI** sends this page's image to a model, **Read whole document** reads the document's pages again the way an upload does. Each tells you where any image goes and what it replaces before it does anything.

## Share links

From the Share Links page, create a link scoped to all history, a tag, a date range, or specific documents. Default expiry is 7 days. The device seals a copy of what the link shares and sends it to the server; the key that opens it is in the address after the `#` (or, with approval, given to the visitor's browser by your device). Links can be revoked instantly, which deletes the copy. The doctor opens the link in any browser — no account or setup needed. Your device must have been open to create or refresh a link.

## Tests

```bash
npm test                              # core, server and web (no model is ever called)
npm run test:coverage -w spine-server # run with coverage report
npm run test:integration -w spine-server   # the flows against the real model and PDFs from .env (minutes, a few hundred model calls)
cd web && npm run check:browser && npm run check:app   # the device and the whole app in real Chrome (after `npm run build`)
```

The code is three npm workspaces: `core/` (what the browser's core runs, and the server's tests), `server/` and `web/`. Install once at the root. The files below are in `server/src/__tests__/`, which drive the whole composed app, except the parser, OCR, read-page, continuation, grounding, legacy-database, i18n and llm ones, which are in `core/src/__tests__/`. [docs/testing.md](docs/testing.md) lists every check. Statement and branch coverage are both above 90%; the figures change with every commit, so they are not copied here.

| Area | Files | Notes |
|---|---|---|
| Isolation | `isolation.test.ts` | A second user against the first user's data, across the routes of its test app and the upload, document, field, tag, page, share link and result repositories; every route of that app refuses an unauthenticated request |
| Response shape | `response-shape.test.ts` | Whole responses scanned for `user_id`, server paths, checksums, tokens |
| Auth | `auth.test.ts` | Email login, no account enumeration, session fixation, password change, rate limits |
| Two-factor | `totp.test.ts`, `second-factor.test.ts` | RFC 4226/6238 vectors, drift and replay, encryption at rest, the two-step login, recovery codes, guess throttling, no bypass via reset |
| Accounts | `accounts.test.ts`, `cli.test.ts` | Signup, verification, recovery links, rate limits; the CLI commands, including deletion |
| Mail | `mail.test.ts` | Brevo adapter, no attachment field, config refusals, neutral wording |
| Config | `config.test.ts`, `llm.test.ts` | Startup refuses bad secrets, providers and endpoints |
| Documents | `documents.test.ts` | CRUD, tag updates, split/merge boundaries, column whitelist |
| Upload | `upload.test.ts`, `source-files.test.ts` | Multipart upload, per-user storage, duplicate detection, status polling |
| Share links | `share.test.ts`, `public-share-scoped.test.ts`, `public-share-detail.test.ts` | Scope validation, fail-closed reads, the sealed copy, the recipient's page |
| Store | `legacy-database.test.ts` | An old-shape database is refused |
| Backup | `backup.test.ts` | Snapshot is a readable database; vault mirror; retention |
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

- `rasterize.ts` — the Node PDF rasterizer; needs actual PDF files (the device's is checked in real Chrome by `check:browser`)
- the `invoke` paths in `llm/adapters/*` — need live provider credentials. The Vertex path has been run through the relay on invented records (`SPINE_CHECK_REAL=1`); Anthropic behind the relay never has

Tests use in-memory SQLite (`SPINE_DB_PATH=:memory:`) with a `resetStore()` call between files so no state leaks across test files. Fixtures are built through the store interface, not raw SQL.

## Credits

Countries in a share link's access log come from the [IP to Country Lite database by DB-IP.com](https://db-ip.com), licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Licence

GNU Affero General Public License v3.0 only (AGPL-3.0-only), see [LICENSE](LICENSE). Anyone who runs a modified version as a network service must offer its users the corresponding source. This is software for holding medical records, provided without warranty: read [SECURITY.md](SECURITY.md) before putting real records on an instance. Whoever runs an instance is the controller of its data.
