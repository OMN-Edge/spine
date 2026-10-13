# CLAUDE.md

Personal medical document archive running on a Raspberry Pi. Uploads PDFs, uses AI to split, extract, and index content, and generates scoped share links for doctors.

## Conventions

- **No AI attribution in git history.** Do not add `Co-Authored-By`, `Claude-Session`,
  or any similar trailer to commit messages or PR descriptions. This overrides the
  default Claude Code attribution behaviour.
- **Commit when a unit of work is complete**, not per exchange. Leave in-progress work
  in the working tree and say what is pending instead of sealing a draft.

## Repo layout

```
spine/
├── ARCHITECTURE.md         # Components, trust boundaries, data flows
├── SECURITY.md             # Principles, controls, known gaps
├── install.sh              # All install steps: -d (deps), -b (build), -s (services), -n (nginx+cert)
├── .env                    # Runtime config (copy from .env.example)
├── server/                 # Node.js + Fastify — API + serves React build
│   └── src/
│       ├── config.ts       # env parsed + validated once at startup; resolveDataDir() is the one place DATA_DIR is decided
│       ├── passwords.ts    # argon2id hash/verify, policy, email normalisation
│       ├── totp.ts         # RFC 6238 codes, secret encryption at rest, recovery codes (pure; no store)
│       ├── second-factor.ts # checkSecondFactor(): joins totp.ts to the store; atomic spend
│       ├── cli.ts          # operator commands: create-user, set-password, reset-link, disable-2fa, delete-user, list-users
│       ├── accounts.ts     # verify/reset tokens and links, neutral mail text, deleteAccount()
│       ├── rate-limit.ts   # windowLimiter(): per-key limits the Fastify plugin cannot stack
│       ├── parser/         # parser interface: types.ts (the contract), index.ts (registry), adapters/{sidecar,multimodal,hybrid}.ts, ocr.ts (Tesseract)
│       ├── logger.ts       # the logger for modules without the app; index.ts points it at the structured log
│       ├── mail/           # mailer interface: types.ts, index.ts (registry), adapters/{none,brevo}.ts
│       ├── share-scope.ts  # the only place a share-link scope is validated or resolved
│       ├── share-token.ts  # token issuing + sha256-at-rest; shape predicates
│       ├── llm/            # LLM interface: types.ts, prompts.ts, chat-llm.ts, index.ts (registry), adapters/
│       ├── backup.ts       # VACUUM INTO snapshot + originals mirror; run by spine-backup.timer
│       ├── store/         # store interface: types.ts (interfaces), index.ts (registry), sqlite/ (the only adapter)
│       ├── hash-legacy-tokens.ts  # S-4 boot rewrite of plaintext share tokens
│       ├── ingestion/      # pipeline.ts, extraction.ts, continuation.ts, grounding.ts, rasterize.ts, ingestion-client.ts
│       ├── routes/         # auth.ts (login + second step), totp.ts, documents.ts, source-files.ts, share.ts, public-share.ts, tags.ts, trends.ts, doctors.ts
│       └── __tests__/      # Vitest tests + helpers/app.ts
├── web/                    # React + Vite + Tailwind
├── ingestion-service/      # Python FastAPI — PDF parsing via Unstructured (port 8000)
├── nginx/                  # Site config template (spine.conf)
└── systemd/                # spine-web.service, spine-ingestion.service, spine-backup.{service,timer}
```

## Common commands

```bash
# Install deps (first time, needs sudo)
sudo ./install.sh -d

# Build everything (server TS + React + Python venv)
./install.sh -b

# Install and start systemd services
sudo ./install.sh -s

# Issue Let's Encrypt cert and install nginx config
sudo ./install.sh -n

# Restart after code changes
./install.sh -b && sudo systemctl restart spine-web

# Accounts (the operator creates them, or SPINE_REGISTRATION=open lets people sign up)
cd server && npm run cli -- create-user you@example.com      # prints a password once
cd server && npm run cli -- set-password you@example.com     # ends that user's sessions
cd server && npm run cli -- reset-link you@example.com       # one-time link; works with no mailer
cd server && npm run cli -- disable-2fa you@example.com      # lost phone and recovery codes
cd server && npm run cli -- delete-user you@example.com      # shows what it would remove; --yes to do it
cd server && npm run cli -- list-users

# Tests
cd server && npm test
cd server && npm run test:coverage
```

## Environment variables (`.env`)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (required when `SPINE_LLM_PROVIDER=anthropic`) |
| `SPINE_LLM_PROVIDER` | `anthropic` (default) \| `vertex` |
| `SPINE_LLM_MODEL` | Model id (default `claude-haiku-4-5-20251001`) |
| `SPINE_LLM_ENDPOINT` | Explicit endpoint. **Required for `vertex`, never defaulted** — residency is a property of the endpoint |
| `SPINE_LLM_REGION` | Provider region (required for `vertex`, e.g. `eu`) |
| `SPINE_LLM_PROJECT` | GCP project (required for `vertex`) |
| `SPINE_LLM_MAX_TOKENS_CONTINUATION` / `_EXTRACTION` | Output caps (256 / 4096) |
| `SPINE_LLM_CONTEXT_CHARS` | Context window in characters, the only cap on request text (default 300000); longer documents are chunked |
| `SPINE_LLM_CONCURRENCY` | Model calls in flight at once (1-16, default 4); DB writes stay sequential |
| `SPINE_LLM_MAX_RETRIES` | Retries inside the adapter (default 2) |
| `SESSION_SECRET` | ≥32 char random string for cookie signing |
| `SPINE_DOMAIN` | Domain nginx serves from (e.g. `spine.yourdomain.com`) |
| `DATA_DIR` | Where DB and uploads live (default `<repo>/data`, wherever the process starts) |
| `PORT` | Fastify listen port (default `3000`) |
| `SPINE_PARSER` | `sidecar` (default, nothing leaves the host) \| `multimodal` \| `hybrid` (sidecar first, a vision model for scanned/blank pages) |
| `SPINE_MULTIMODAL_ENABLED` | `true` to allow page images to be sent to the LLM provider. **A second switch on purpose**: `multimodal`/`hybrid` without it refuse to start |
| `SPINE_TEXT_LAYER_MIN_CHARS`, `SPINE_OCR_MIN_CONFIDENCE`, `SPINE_OCR_MAX_LOW_SHARE`, `SPINE_OCR_LANGS` | `hybrid`'s screening thresholds (50 / 85 / 0.10) and Tesseract languages (`ron+eng`; startup refuses if a pack is missing). First guesses: tune from the `page routed` log lines |
| `SPINE_REGISTRATION` | `operator` (default: accounts come from the CLI) \| `open` (signup with email verification; **refuses to start without a mailer**) |
| `SPINE_MAILER` | `none` (default) \| `brevo` |
| `BREVO_API_KEY`, `SPINE_MAIL_SENDER` | Required for `brevo`. The sender has no default: pick a neutral name, it is visible in the recipient's inbox |
| `SPINE_HOST` | Interface Fastify binds (default `127.0.0.1` — nginx is the only public listener) |
| `SPINE_BACKUP_DIR` | Snapshot + originals mirror target (default beside `data/`; set it to removable or network storage to survive media loss) |
| `SPINE_BACKUP_KEEP` | Snapshots to retain (default `7`) |

`SESSION_SECRET` (≥32 chars) is validated at startup and by `install.sh -s`: a missing,
short or placeholder value stops the process rather than falling back to a default
(SECURITY.md **P3**). There is no shared password: users sign in with an email and their
own password.

## Architecture

Target architecture, trust boundaries, interfaces/adapters and the migration path:
[ARCHITECTURE.md](ARCHITECTURE.md). Security principles, current controls and known
gaps: [SECURITY.md](SECURITY.md) — read it before touching routing, auth, share links,
storage, providers or static serving.

**The sections below describe what runs today:** multi-user with local accounts (CLI or
open signup with email verification), a store interface (SQLite only), an LLM interface
with Anthropic and Vertex adapters, a mailer interface (`none`, `brevo`). Hosting stays on
a Pi; GCP is inference only.

**Request flow:**
Browser → nginx (TLS) → Fastify (port 3000) → SQLite

**Ingestion flow** (a photo skips `rasterize.ts` and the sidecar: `photo.ts` makes it an upright PNG page and the model parser reads it, and it is accepted only with `SPINE_MULTIMODAL_ENABLED`):
Upload → `source-files.ts` writes to `data/originals/` → `pipeline.ts` (fire-and-forget) → `rasterize.ts` (PDF→PNG) → `ingestion-client.ts` (HTTP to Python sidecar) → `continuation.ts` (Claude Haiku, per page pair) → `extraction.ts` (Claude Haiku, per logical doc) → `grounding.ts` (bbox matching) → SQLite

**Python sidecar** (`ingestion-service/`, port 8000): FastAPI wrapping Unstructured. Called by `ingestion-client.ts`. Returns per-page elements with bounding boxes.

**AI model:** configuration, not code. `SPINE_LLM_PROVIDER` (`anthropic` | `vertex`) and
`SPINE_LLM_MODEL`, defaulting to `claude-haiku-4-5-20251001` for both continuation
detection and field extraction. Everything provider-specific is behind the LLM interface in
`server/src/llm/`; **nothing above `src/llm/adapters/` may import a vendor package.**

## Key design decisions

- **All data access goes through the store interface** — `getStore()` returns a `Store` of
  repositories. **No SQL and no `better-sqlite3` import may exist outside
  `server/src/store/sqlite/`**; there are currently zero `.prepare()` calls elsewhere.
  Every repository method takes the acting user's id as its first parameter, with exactly
  four exceptions enumerated in `store/types.ts` (share-token reads, access logging,
  boot-time maintenance, the users repository). Every statement on a user-owned table
  filters by `user_id`; a method called without a user throws; a record that is not the
  caller's answers 404. `__tests__/isolation.test.ts` checks all of it as a second user.
- **New tables carry `user_id` and new queries list explicit columns** — `SELECT *` on a
  table with `user_id` sends it to the client, including to share recipients.
  `response-shape.test.ts` scans whole responses.
- **Parsing goes through the parser interface** — one entry per page image, in order, with
  boxes in that image's pixel space (the sidecar adapter scales from its own coordinates).
  - The sidecar runs Unstructured with `strategy="fast"` only: the PDF's own text layer, no
    OCR, no layout model. A page with no text layer returns no elements. (`auto` is one
    decision for the whole file, and its `ocr` label is never set.)
  - `hybrid` goes cheapest first per page: text layer (what the sidecar returned, at least
    `SPINE_TEXT_LAYER_MIN_CHARS`) → local Tesseract if its confidence is good → the model. It
    never sends a page that has a text layer, and fails the upload if the sidecar is down
    rather than treating every page as scanned.
  - Images leave the host only via `readPage` (a page; `multimodal`/`hybrid`, or a photo) and
    `readStamps` (small signature-stamp crops from a PDF's last page, `ingestion/signatures.ts`),
    and only with `SPINE_MULTIMODAL_ENABLED`. If the model fails, the page keeps local OCR, and a
    failed stamp read adds no doctors and never fails the upload.
  - "Read the whole file with AI" re-runs an upload through the `multimodal` parser and
    replaces its documents only after the new reading succeeds. "Read this page with AI"
    (`ingestion/ai-reading.ts`) sends only that page through the same parser and switch, then
    extracts only the documents that contain it again; "Extract details again" does that on the
    text already read, with no image.
  - Model-read pages are stored as `multimodal`, and the UI marks their highlights approximate.
- **Verification and reset links** — tokens are hashed at rest, spent by one atomic
  `UPDATE`, carried in the URL **fragment** (never sent to the server, so not in nginx's
  log) and spent by a `POST`. Requests that name an address answer identically whether or
  not it has an account, and mail is sent after the response. Mail has no attachment
  field and neutral wording; a test fails on clinical words.
- **Schema changes need an empty database** — `CREATE TABLE IF NOT EXISTS` cannot alter a
  table, and startup refuses an old-shape database. Load real records only after deciding
  how the next change will be made (a migration runner, which does not exist).
- **Two-factor** — optional TOTP per user (`totp.ts`, `routes/totp.ts`). With it on, the
  right password only starts a *pending* login in the session; `POST /api/auth/login/second-factor`
  completes it. The secret is AES-GCM encrypted under a key derived from `SESSION_SECRET`
  (rotating that secret orphans every enrolment); the last used step blocks replay;
  recovery codes are sha256-hashed and single use. Tables are new (`user_totp`,
  `user_recovery_codes`), because a new table needs no migration and a new column would.
- **Auth** — email + argon2id password; `requireAuth` re-resolves the session to a live
  user on every request and sets `req.userId`, which handlers pass to the store. A
  changed password bumps `auth_version`, ending that user's other sessions. An unknown
  email and a wrong password are indistinguishable in answer and time.
- **Repository methods are all async** even though SQLite is synchronous: the interface spans
  drivers, and a networked store is async. `transaction(fn)` uses explicit
  `BEGIN`/`COMMIT` with `SAVEPOINT` for nesting, because `db.transaction()` throws on an
  async callback.
- **Single SQLite file** — `data/spine.db` in WAL mode. No migration runner: schema is idempotent `CREATE TABLE IF NOT EXISTS`, which cannot alter an existing table, so a schema change today means editing `schema.sql` and deleting `data/spine.db*` — **only safe while the archive is empty**; startup refuses an old-shape database and says how many records it holds. A runner is needed before the first change to a populated database. Back up `data/spine.db` + `data/originals/`.
- **In-memory SQLite for tests** — `SPINE_DB_PATH=:memory:` is set in `vitest.config.ts`,
  not in test files. `resetStore()` is called in `buildTestApp()` between test files, and
  fixtures are built through the interface via `__tests__/helpers/seed.ts` rather than raw SQL
  (P10 — and it is what proves the interface is complete).
- **Ingestion pipeline is fire-and-forget** — `startIngestionJob(sourceFileId, userId)` returns immediately; status tracked in an in-memory registry, polled by the browser.
- **Structured extraction** — per-type guides in `llm/doc-types.ts`; numeric results are `measurements` (parsed and flagged in `ingestion/measurements.ts`), people are a per-user `doctors` directory (`doctors.ts` matches names), related fields share a `group_no`. Edits to all of these go through the one atomic `PATCH /api/documents/:id`.
- **Page images are authenticated** — served by `GET /api/pages/:id/image`, streamed from the
  absolute `pages.image_path`. Never mounted statically: `DATA_DIR` holds `spine.db` and the
  original scans.
- **Bbox grounding** — fractional coordinates (0–1). Exact string containment first, then LCS fuzzy match (threshold: 60% of needle length).
- **LLM access goes through the interface** — `getChatLlm()`, which reads the LLM config on
  first use and memoizes. No init step: `index.ts` just calls it once at startup so a bad
  provider stops the process there rather than at the first upload. Adding a provider is a map entry in `llm/index.ts` plus a file in
  `llm/adapters/`, never a new conditional. The two tasks are defined in `llm/tasks.ts`
  (budget + schema, both fixed at startup) and an adapter returns one bound LangChain
  `Runnable` per task. **No provider package (`ChatAnthropic`, `ChatVertexAI`) may be
  imported outside `llm/adapters/`**; `@langchain/core` above that line is fine — it is
  the shared abstraction, and the seam type. Every response is validated with zod before
  it reaches the database; a validation failure logs and degrades to a reviewable
  fallback rather than killing the upload.
- **Vertex residency is configuration, not code inspection** — endpoint, region and
  project must all be stated (nothing defaults to a global endpoint), and startup fails
  if `GOOGLE_API_KEY`/`GEMINI_API_KEY`/`GOOGLE_GENAI_API_KEY` is present at all, because
  that makes the library ignore both and call the global host. Residency itself is
  verified against the provider's request logs, not asserted from a URL's shape — that
  would only hold for one provider.
- **Share links** — 32-byte random token, **stored as `sha256(token)`**; the raw value
  only ever appears in the creation response. Scopes: `all` / `tag` / `document_ids` /
  `date_range`, default 7-day expiry. Both public routes log access;
  `view_count` counts document reads, not shell fetches.
- **`GET /share/:token` must return the app shell** — the SPA fallback excludes
  `/share/`, so this route is the only thing answering a recipient's URL. Returning JSON
  there (S-15) meant doctors saw `{"ok":true}` instead of the documents.
- **Backups** — `spine-backup.timer` daily: `VACUUM INTO` for the DB (never a file copy,
  WAL makes that unsafe) and a forward-only mirror of `data/originals/`, which is
  immutable. `data/pages/` is not backed up.
- **Share scoping is fail-closed** — `share-scope.ts` is the single place a scope is
  validated. Creation rejects a scope it cannot fully resolve; the read path re-resolves
  the stored row and serves nothing if it cannot. No branch there may widen a query
  (SECURITY.md **P2**).
- **Login is rate limited** — per source via `@fastify/rate-limit`, plus an
  instance-wide cap written by hand because the plugin only applies its first hook per
  request. Both are options on `authRoutes` so tests drive the real limiter.
- **Interpolated SQL identifiers come from a whitelist** — `PATCH /api/documents/:id`
  builds its `SET` clause from column names, so request-body keys are checked against
  `UPDATABLE_COLUMNS` first. A `Body` type is not a runtime guard.

## Tests

`npm test` runs the suite; `npm run test:coverage` reports coverage (above 90% for statements and branches).

Intentionally uncovered (integration tests would need a live sidecar, real PDFs or live
provider credentials):
- `ingestion-client.ts` — HTTP to Python sidecar
- `rasterize.ts` — PDF rasterizer
- the `invoke` paths in `llm/adapters/*` — they need live provider credentials. Their
  configuration refusals (missing endpoint/region/project, stray Google API key) are
  covered, and the interface is tested through fake task clients built with
  `RunnableLambda.from`, not a mocked vendor SDK
