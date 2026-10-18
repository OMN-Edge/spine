# CLAUDE.md

Personal medical document archive running on a Raspberry Pi. Uploads PDFs, uses AI to split, extract, and index content, and generates scoped share links for doctors.

## Conventions

- **No AI attribution in git history.** Do not add `Co-Authored-By`, `Claude-Session`, or any similar trailer to commit messages or PR descriptions. This overrides the default Claude Code attribution behaviour.
- **Commit when a unit of work is complete**, not per exchange. Leave in-progress work in the working tree and say what is pending instead of sealing a draft.
- **Do not hard-wrap prose** in docs or Markdown. A paragraph or list item is one line; the editor wraps it, and a diff shows the sentence that changed.

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
│       ├── parser/         # parser interface: types.ts (the contract), index.ts (registry), adapters/{sidecar,ocr,multimodal,hybrid}.ts (`sidecar.ts` is the `text` parser), ocr.ts (Tesseract)
│       ├── logger.ts       # the logger for modules without the app; index.ts points it at the structured log
│       ├── mail/           # mailer interface: types.ts, index.ts (registry), adapters/{none,brevo}.ts
│       ├── translation.ts  # translateDocument(): on-demand, cached by digest; languages.ts lists the four languages
│       ├── embedding/      # embedder interface: types.ts, index.ts (registry), adapters/{none,vertex}.ts
│       ├── similarity/     # card.ts (what a document is embedded as), index.ts (sync, related, hybrid search)
│       ├── chat/           # agent.ts (the LangGraph agent and its read-only tools), screen.ts (what is on screen, resolved), index.ts (askQuestion; the fixed-pipeline fallback), retrieval.ts (keywords, fused search)
│       ├── linking/        # index.ts: candidates (no model), the judge, links as proposals, the chain
│       ├── tags.ts         # STARTER_TAGS and cleanTag(): what a tag is and a new account starts with
│       ├── share-scope.ts  # the only place a share-link scope is validated or resolved
│       ├── share-token.ts  # token issuing + sha256-at-rest; shape predicates
│       ├── llm/            # LLM interface: types.ts, prompts.ts, chat-llm.ts, index.ts (registry), adapters/
│       ├── backup.ts       # VACUUM INTO snapshot + originals mirror; run by spine-backup.timer
│       ├── store/         # store interface: types.ts (interfaces), index.ts (registry), sqlite/ (the only adapter)
│       ├── hash-legacy-tokens.ts  # S-4 boot rewrite of plaintext share tokens
│       ├── archive/        # export.ts (a document or the whole archive as a zip), import.ts (Spine export or plain zip), import-file.ts (restore one file, no model), manifest.ts (zod schema, fingerprint), zip-read.ts, pdf-pages.ts
│       ├── ingestion/      # accept-upload.ts, jobs.ts, pipeline.ts, extraction.ts, continuation.ts, grounding.ts, rasterize.ts, ingestion-client.ts
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
| `SPINE_LLM_MODELS` | Other models offered in a picker for "Read page with AI" and "Read whole document": `id` or `id=Label`, comma separated, on the same provider, endpoint, region and project. The default model is always first; an id not listed is refused (400) |
| `SPINE_LLM_MAX_TOKENS_CONTINUATION` / `_EXTRACTION` | Output caps (1024 / 16384). `SPINE_LLM_MAX_TOKENS_PAGE` (16384) caps a page reading. All are ceilings: only generated tokens are billed |
| `SPINE_LLM_CONTEXT_CHARS` | Context window in characters, the only cap on request text (default 300000); longer documents are chunked |
| `SPINE_TRANSLATION` | `off` to stop translating documents (the interface stays translated; content shows in its original language). Default on: translating sends the document's extracted text and the owner's notes to `SPINE_LLM_PROVIDER` (SECURITY.md **M-13**) |
| `SPINE_EMBEDDINGS` | `none` (default) \| `vertex`: embed each document's summary card for related documents and search by meaning. Endpoint, region and project come from `SPINE_EMBEDDING_ENDPOINT/_REGION/_PROJECT` or the Vertex chat settings; **never defaulted**. `SPINE_EMBEDDING_MODEL` (default `gemini-embedding-2`, called with `embedContent`; what the `eu` multi-region serves) and `SPINE_EMBEDDING_DIMS` (768) define the vector space (SECURITY.md **M-15**) |
| `SPINE_CHAT` | `off` removes the chat panel. Default on: each question sends the question and the matching documents' summary cards, notes and results (never pages) to `SPINE_LLM_PROVIDER` (SECURITY.md **M-18**) |
| `SPINE_LINKING` | `off` to stop looking for links between documents (a consultation and the tests it asked for, a follow-up). Default on: it sends the summary cards of up to seven documents per call to `SPINE_LLM_PROVIDER` (SECURITY.md **M-16**). Links added by hand still work |
| `SPINE_LLM_CONCURRENCY` | Model calls in flight at once (1-16, default 4); DB writes stay sequential |
| `SPINE_LLM_MAX_RETRIES` | Retries inside the adapter (default 2) |
| `SESSION_SECRET` | ≥32 char random string for cookie signing |
| `SPINE_DOMAIN` | Domain nginx serves from (e.g. `spine.yourdomain.com`) |
| `DATA_DIR` | Where DB and uploads live (default `<repo>/data`, wherever the process starts) |
| `PORT` | Fastify listen port (default `3000`) |
| `SPINE_PARSER` | `text` (default: the PDF's own text layer; nothing leaves the host; `sidecar` is the old name) \| `ocr` (text layer, then local Tesseract; nothing leaves) \| `multimodal` (a vision model reads every page) \| `hybrid` (text layer first, then local OCR unless `SPINE_OCR=off`, then a vision model for the pages still unread) |
| `SPINE_MULTIMODAL_ENABLED` | `true` to allow page images to be sent to the LLM provider. **A second switch on purpose**: `multimodal`/`hybrid` without it refuse to start |
| `SPINE_OCR` | `off` skips local OCR in `hybrid`: a page with no text layer goes straight to the model, and Tesseract is not needed (default on) |
| `SPINE_TEXT_LAYER_MIN_CHARS`, `SPINE_OCR_MIN_CONFIDENCE`, `SPINE_OCR_MAX_LOW_SHARE`, `SPINE_OCR_LANGS` | `hybrid`'s screening thresholds (50 / 85 / 0.10) and Tesseract languages (`ron+eng`; startup refuses if a pack is missing, unless `SPINE_OCR=off`). First guesses: tune from the `page routed` log lines |
| `SPINE_REGISTRATION` | `operator` (default: accounts come from the CLI) \| `open` (signup with email verification; **refuses to start without a mailer**) |
| `SPINE_MAILER` | `none` (default) \| `brevo` |
| `BREVO_API_KEY`, `SPINE_MAIL_SENDER` | Required for `brevo`. The sender has no default: pick a neutral name, it is visible in the recipient's inbox |
| `SPINE_HOST` | Interface Fastify binds (default `127.0.0.1` — nginx is the only public listener) |
| `SPINE_BACKUP_DIR` | Snapshot + originals mirror target (default beside `data/`; set it to removable or network storage to survive media loss) |
| `SPINE_BACKUP_KEEP` | Snapshots to retain (default `7`) |

`SESSION_SECRET` (≥32 chars) is validated at startup and by `install.sh -s`: a missing, short or placeholder value stops the process rather than falling back to a default (SECURITY.md **P3**). There is no shared password: users sign in with an email and their own password.

## Architecture

Target architecture, trust boundaries, interfaces/adapters and the migration path: [ARCHITECTURE.md](ARCHITECTURE.md). Security principles, current controls and known gaps: [SECURITY.md](SECURITY.md) — read it before touching routing, auth, share links, storage, providers or static serving.

**The sections below describe what runs today:** multi-user with local accounts (CLI or open signup with email verification), a store interface (SQLite only), an LLM interface with Anthropic and Vertex adapters, a mailer interface (`none`, `brevo`). Hosting stays on a Pi; GCP is inference only.

**Request flow:** Browser → nginx (TLS) → Fastify (port 3000) → SQLite

**Ingestion flow** (a photo skips `rasterize.ts` and the sidecar: `photo.ts` makes it an upright PNG page and the model parser reads it, and it is accepted only with `SPINE_MULTIMODAL_ENABLED`): Upload → `source-files.ts` writes to `data/originals/` → `pipeline.ts` (fire-and-forget) → `rasterize.ts` (PDF→PNG) → `ingestion-client.ts` (HTTP to Python sidecar) → `continuation.ts` (Claude Haiku, per page pair) → `extraction.ts` (Claude Haiku, per logical doc) → `grounding.ts` (bbox matching) → SQLite, held back until the owner confirms the grouping

**Python sidecar** (`ingestion-service/`, port 8000): FastAPI wrapping Unstructured. Called by `ingestion-client.ts`. Returns per-page elements with bounding boxes.

**AI model:** configuration, not code. `SPINE_LLM_PROVIDER` (`anthropic` | `vertex`) and `SPINE_LLM_MODEL`, defaulting to `claude-haiku-4-5-20251001` for both continuation detection and field extraction. Everything provider-specific is behind the LLM interface in `server/src/llm/`; **nothing above `src/llm/adapters/` may import a vendor package.**

## Key design decisions

- **All data access goes through the store interface** — `getStore()` returns a `Store` of repositories. **No SQL and no `better-sqlite3` import may exist outside `server/src/store/sqlite/`**; there are currently zero `.prepare()` calls elsewhere. Every repository method takes the acting user's id as its first parameter, with exactly four exceptions enumerated in `store/types.ts` (share-token reads, access logging, boot-time maintenance, the users repository). Every statement on a user-owned table filters by `user_id`; a method called without a user throws; a record that is not the caller's answers 404. `__tests__/isolation.test.ts` checks all of it as a second user.
- **New tables carry `user_id` and new queries list explicit columns** — `SELECT *` on a table with `user_id` sends it to the client, including to share recipients. `response-shape.test.ts` scans whole responses.
- **Parsing goes through the parser interface** — one entry per page image, in order, with boxes in that image's pixel space (the sidecar adapter scales from its own coordinates).
  - The sidecar runs Unstructured with `strategy="fast"` only: the PDF's own text layer, no OCR, no layout model. A page with no text layer returns no elements. (`auto` is one decision for the whole file, and its `ocr` label is never set.)
  - `hybrid` goes cheapest first per page: text layer (what the sidecar returned, at least `SPINE_TEXT_LAYER_MIN_CHARS`) → local Tesseract if its confidence is good → the model. It never sends a page that has a text layer, and fails the upload if the sidecar is down rather than treating every page as scanned.
  - Images leave the host only via `readPage` (a page; `multimodal`/`hybrid`, or a photo) and `readStamps` (small signature-stamp crops from a PDF's last page, `ingestion/signatures.ts`), and only with `SPINE_MULTIMODAL_ENABLED`. If the model fails, the page keeps local OCR, and a failed stamp read adds no doctors and never fails the upload.
  - "Read page with AI" (`ingestion/ai-reading.ts`) sends only that page through the same parser and switch, then extracts only the documents that contain it again; "Read whole document" (`strategy: "configured"` on the same route) reads all of a document's visible pages in one call with the configured parser, as an upload does (text layer, then OCR, then a model, depending on `SPINE_PARSER`), keeps the grouping, and extracts again; it sends an image only if that parser does, so it needs the switch only then. A page that comes back unread keeps its earlier text.
  - Model-read pages are stored as `multimodal` with text and **no boxes** (a model's estimate of where text sits was unreliable, so it is not asked for): a field read from one keeps its source page and gets no highlight, and the UI draws none on such a page. Exact boxes come only from the PDF's text layer and from local OCR.
- **Verification and reset links** — tokens are hashed at rest, spent by one atomic `UPDATE`, carried in the URL **fragment** (never sent to the server, so not in nginx's log) and spent by a `POST`. Requests that name an address answer identically whether or not it has an account, and mail is sent after the response. Mail has no attachment field and neutral wording; a test fails on clinical words.
- **Schema changes need an empty database, except a new column with a default** — `CREATE TABLE IF NOT EXISTS` cannot alter a table, and startup refuses an old-shape database. A new defaulted column is added on open by `addColumnsInPlace` in `store/sqlite/connection.ts` (with a test against a database made without it); anything else (rename, remove, retype) needs a migration runner, which does not exist.
- **Two-factor** — optional TOTP per user (`totp.ts`, `routes/totp.ts`). With it on, the right password only starts a *pending* login in the session; `POST /api/auth/login/second-factor` completes it. The secret is AES-GCM encrypted under a key derived from `SESSION_SECRET` (rotating that secret orphans every enrolment); the last used step blocks replay; recovery codes are sha256-hashed and single use. Tables are new (`user_totp`, `user_recovery_codes`), because a new table needs no migration and a new column would.
- **Auth** — email + argon2id password; `requireAuth` re-resolves the session to a live user on every request and sets `req.userId`, which handlers pass to the store. A changed password bumps `auth_version`, ending that user's other sessions. An unknown email and a wrong password are indistinguishable in answer and time.
- **Repository methods are all async** even though SQLite is synchronous: the interface spans drivers, and a networked store is async. `transaction(fn)` uses explicit `BEGIN`/`COMMIT` with `SAVEPOINT` for nesting, because `db.transaction()` throws on an async callback.
- **Pages can be moved** — `page_number` is a page's place in the upload (ranges and the UI use it), `source_page` its immutable index in the file, which is what the parser, the sidecar and the stamp reader count: **anything that re-reads a page asks for `source_page`**, never `page_number`. A move (`ingestion/move-page.ts`, `POST /api/pages/:id/move`) rewrites a list of lists in one transaction and renumbers; document order never changes. Screens about the whole upload (cards, search, review, the grouping screen) show the file's number; a document's own screen numbers its pages from 1 and gives the file's number as a tooltip.
- **The grouping is confirmed before documents are shown** — the pipeline sets `source_files.grouping_confirmed = 0` when it finishes; until the owner confirms (`POST /api/source-files/:id/grouping/confirm`) the upload's documents are held back by the same fragment as set-aside ones (`VISIBLE = NOT_SET_ASIDE AND UPLOAD_CONFIRMED`, `store/sqlite/visibility.ts`) and cannot be marked reviewed; confirming schedules embeddings and links. The column defaults to 1: old uploads, restores and tests are confirmed. `includeUnconfirmed` (upload screens) or `includeHidden` (regrouping) list them anyway. **Every new query over the owner's documents uses `VISIBLE`.** ARCHITECTURE.md **Confirming the grouping**.
- **What the owner edits is sticky** — `documents.owner_edited` (headline columns), `extracted_fields.owner_edited`, `measurements.owner_edited` and `removed_readings`; a re-reading (`applyReading`/`storeReading`) keeps them, deletes only unedited values (`deleteUnedited`) and does not bring back what was removed. Tags and doctors are still replaced. The owner's notes go into the extraction prompt as context only. ARCHITECTURE.md **What the owner edits stays edited**.
- **Hidden pages and set-aside documents** — `pages.hidden` sets a page aside (kept, but out of the document's view, search and reading); a document with pages and none shown is *set aside* (`store/sqlite/visibility.ts`'s one SQL fragment) and is left out of the timeline, search, review, shares, doctors' lists and trends (through `VISIBLE`) unless `includeHidden` is passed (the regrouping screen only). Regrouping saves with `defer`, and Done reads the changed documents once (a fully hidden one is `skipped`).
- **Single SQLite file** — `data/spine.db` in WAL mode. No migration runner: schema is idempotent `CREATE TABLE IF NOT EXISTS`, which cannot alter an existing table, so a schema change other than a new defaulted column (see above) means editing `schema.sql` and deleting `data/spine.db*` — **only safe while the archive is empty**; startup refuses an old-shape database and says how many records it holds. A runner is needed before the first change to a populated database. Back up `data/spine.db` + `data/originals/`.
- **In-memory SQLite for tests** — `SPINE_DB_PATH=:memory:` is set in `vitest.config.ts`, not in test files. `resetStore()` is called in `buildTestApp()` between test files, and fixtures are built through the interface via `__tests__/helpers/seed.ts` rather than raw SQL (P10 — and it is what proves the interface is complete).
- **Ingestion pipeline is fire-and-forget** — `startIngestionJob(sourceFileId, userId)` returns immediately; status tracked in an in-memory registry, polled by the browser.
- **Structured extraction** — per-type guides in `llm/doc-types.ts`; numeric results are `measurements` (parsed and flagged in `ingestion/measurements.ts`), people are a per-user `doctors` directory (`doctors.ts` matches names), related fields share a `group_no`. Edits to all of these go through the one atomic `PATCH /api/documents/:id`.
- **Page images are authenticated** — served by `GET /api/pages/:id/image`, streamed from the absolute `pages.image_path`. Never mounted statically: `DATA_DIR` holds `spine.db` and the original scans.
- **Bbox grounding** — fractional coordinates (0–1). Exact string containment first, then LCS fuzzy match (threshold: 60% of needle length).
- **LLM access goes through the interface** — `getChatLlm()`, which reads the LLM config on first use and memoizes. No init step: `index.ts` just calls it once at startup so a bad provider stops the process there rather than at the first upload. Adding a provider is a map entry in `llm/index.ts` plus a file in `llm/adapters/`, never a new conditional. The two tasks are defined in `llm/tasks.ts` (budget + schema, both fixed at startup) and an adapter returns one bound LangChain `Runnable` per task. **No provider package (`ChatAnthropic`, `ChatVertexAI`) may be imported outside `llm/adapters/`**; `@langchain/core` above that line is fine — it is the shared abstraction, and the seam type. Every response is validated with zod before it reaches the database; a validation failure logs and degrades to a reviewable fallback rather than killing the upload.
- **Vertex residency is configuration, not code inspection** — endpoint, region and project must all be stated (nothing defaults to a global endpoint), and startup fails if `GOOGLE_API_KEY`/`GEMINI_API_KEY`/`GOOGLE_GENAI_API_KEY` is present at all, because that makes the library ignore both and call the global host. Residency itself is verified against the provider's request logs, not asserted from a URL's shape — that would only hold for one provider.
- **Share links** — 32-byte random token, **stored as `sha256(token)`**; the raw value only ever appears in the creation response. Scopes: `all` / `tag` / `document_ids` / `date_range`, default 7-day expiry. Every public route logs access; `view_count` counts document reads, not shell fetches or page images. A recipient sees the timeline and document pages read-only, can open one document (details, not source text), sees values over time for the shared documents only (`/api/share/:token/trends*`, filtered to `listForShare` ids), and, **only if the link has `include_scans`**, its page images; both look the document up in `listForShare`, so the scope and the hidden-document rule apply, and anything outside is one 404.
- **`GET /share/:token` must return the app shell** — the SPA fallback excludes `/share/`, so this route is the only thing answering a recipient's URL. Returning JSON there (S-15) meant doctors saw `{"ok":true}` instead of the documents.
- **Backups** — `spine-backup.timer` daily: `VACUUM INTO` for the DB (never a file copy, WAL makes that unsafe) and a forward-only mirror of `data/originals/`, which is immutable. `data/pages/` is not backed up.
- **Languages** — the web interface is English, Romanian, French and German: strings are English literals in `t()`/`tn()`/`tx()`/`msg()` and the dictionaries are `web/src/i18n/{ro,fr,de}.json`; `i18n-coverage.test.ts` fails on a missing, stale or mis-placeholdered entry, so **a new screen string needs an entry in all three**. Document content is translated on demand by `translation.ts` and cached in `document_translations`, validated by a digest of the translated text (no manual invalidation); shared pages translate through public routes bounded by language, once-per-document caching and a rate limit (SECURITY.md **M-13**). Server error messages stay English.
- **Export and import** — `GET /api/documents/:id/export` (trimmed to its own pages with poppler's `pdfseparate`/`pdfunite`) and `GET /api/export` (every finished upload as it is) give a zip of the files plus `manifest.json` (`archive/manifest.ts`: pages with text and word boxes, documents, fields, results, doctors, tags, notes). Uploading a zip goes through the ordinary upload route: a `manifest.json` in the export format means **restore** (`import-file.ts`: rasterize the file, write the rows from the manifest, **no model call**, every id made again, one transaction); any other zip's PDFs and photos are uploaded one by one. Duplicates: a file with a known sha256 is skipped; a document whose page text matches one already held (`documentFingerprint`) is skipped, or if its file also holds new documents, restored but set aside. Share links and translations are not exported. SECURITY.md **M-14**.
- **Similarity** — related documents come from the data first (shared tests by canonical name, doctors; `documents.relatedSignals`) and from meaning second (`embedding/` + `similarity/`, Vertex only, off by default). Vectors live in `document_embeddings` keyed `(document, model)` with a digest of the exact card: stale when the card changes, never compared across models, pruned when a new model is complete, deleted with the document, **never exported or returned by a route**. Comparison is in-memory over one person's vectors (no vector index). `scheduleSync` brings them up to date in the background. ARCHITECTURE.md **Similarity**.
- **Chat** — a panel on every page (`ChatPanel`, state in `ChatProvider` above the routes). `chat/agent.ts` is a LangGraph agent (agent → tools → agent, then `finish`) with five **read-only** tools, defined once, that read the signed-in user's id and the question's labels from the graph's state (`ToolRuntime`), never from an argument the model writes; the model passes labels (`D1`) this request gave it, never ids; capped at five rounds, 12k characters a result, 120k a question, 90 s. `TOOL_KINDS` declares each tool `read` or `action` and a test holds all `read`: **an action tool must return a proposal the owner confirms, never execute**. Each question carries `screen` (pointers: page, ids, search text, filters, selected id; no text), resolved by `chat/screen.ts`; the document on screen is `D1` in sections (`D1.results` …) and an answer's `[D1.results]` becomes a link to `/documents/:id?section=results`, which `DocumentPage` scrolls to (`#section-…`). The fixed pipeline (`chat/index.ts`) is the fallback. The reply streams (`stream: true`: NDJSON `step`/`delta`/`reset`/`done`/`error`); only `done` is trusted and stored, and a stopped question keeps nothing. Conversations are stored per user (`chat_conversations`, `chat_messages`; History in the panel; capped; deleted with the account; not exported) and the history the model sees is read from the store with citation markers stripped, never sent by the browser; owner only; rate limited; `SPINE_CHAT=off` removes it. If the model cannot take tools, or the agent throws, the question is answered by the fixed pipeline (`chat/index.ts`). ARCHITECTURE.md **Ask your records**.
- **Care chains** — `document_links` (`from` earlier, `to` later; `requests` | `follow_up` | `same_episode`; `auto`/`owner`; `proposed`/`confirmed`/`dismissed`). `linking/` finds candidates from the data with no model (no candidate, no call), then one `linking` call judges the cards; **a model's answer is only ever a `proposed` link**, and code drops a request or follow-up that runs backwards in time. Re-searching replaces only the proposals for the pairs it judged again, and never a confirmed or dismissed link; the owner's notes go into the linking cards and into the extraction prompt (as context, never as a source of values); links are looked for only once the upload's grouping is confirmed (and after a re-reading); a dismissed pair is never proposed again. Restore calls no model, so it does not link. Owner only; deleted with the document, the upload and the account; not exported. ARCHITECTURE.md **Care chains**.
- **Library** — tags, providers (`documents.provider`) and tests (`measurements.canonical` + `measurement_aliases`) are managed in `/library` (and doctors on their own page): rename (an existing name merges), remove. Tags always go through `cleanTag`; a tag rename/merge rewrites share links' tag scope in the same transaction. Extraction is given the person's tags and test names to prefer. ARCHITECTURE.md **The Library**.
- **Share scoping is fail-closed** — `share-scope.ts` is the single place a scope is validated. Creation rejects a scope it cannot fully resolve; the read path re-resolves the stored row and serves nothing if it cannot. No branch there may widen a query (SECURITY.md **P2**).
- **Login is rate limited** — per source via `@fastify/rate-limit`, plus an instance-wide cap written by hand because the plugin only applies its first hook per request. Both are options on `authRoutes` so tests drive the real limiter.
- **Interpolated SQL identifiers come from a whitelist** — `PATCH /api/documents/:id` builds its `SET` clause from column names, so request-body keys are checked against `UPDATABLE_COLUMNS` first. A `Body` type is not a runtime guard.

## Tests

`npm test` runs the suite; `npm run test:coverage` reports coverage (above 90% for statements and branches).

Intentionally uncovered (integration tests would need a live sidecar, real PDFs or live provider credentials):
- `ingestion-client.ts` — HTTP to Python sidecar
- `rasterize.ts` — PDF rasterizer
- the `invoke` paths in `llm/adapters/*` — they need live provider credentials. Their configuration refusals (missing endpoint/region/project, stray Google API key) are covered, and the interface is tested through fake task clients built with `RunnableLambda.from`, not a mocked vendor SDK
