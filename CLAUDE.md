# CLAUDE.md

Personal medical document archive running on a Raspberry Pi. Uploads PDFs, uses AI to split, extract, and index content, and generates scoped share links for doctors.

## Conventions

- **No AI attribution in git history.** Do not add `Co-Authored-By`, `Claude-Session`, or any similar trailer to commit messages or PR descriptions. This overrides the default Claude Code attribution behaviour.
- **Commit when a unit of work is complete**, not per exchange. Leave in-progress work in the working tree and say what is pending instead of sealing a draft.
- **Do not hard-wrap prose** in docs or Markdown. A paragraph or list item is one line; the editor wraps it, and a diff shows the sentence that changed.
- **Structure is checked, not judged.** `docs/structure-rules.md` defines what "clean" means here (rules S1-S13, two known exceptions, E1 and E2); `core/src/__tests__/architecture.test.ts` and `server/scripts/smoke-entrypoints.mjs` enforce it. A change that needs an exception edits the test and that page in the same commit. "Done" for a structural change means those, `check:browser` and `check:app` pass, not only the unit tests.

## Repo layout

```
spine/
├── ARCHITECTURE.md         # Components, trust boundaries, data flows
├── SECURITY.md             # Principles, controls, known gaps, how to report a vulnerability
├── CONTRIBUTING.md         # GitHub is canonical; licence, checks, no real data
├── Dockerfile, compose.yaml, Caddyfile  # one-command self-host (docs/self-host.md)
├── install.sh              # All install steps: -a (all of them), -d (deps), -e (.env and relay.env, secrets generated), -b (build), -s (services), -r (the relay here), -n (nginx+cert)
├── relay.env               # The relay's provider credential when it runs beside the server (copy from relay.env.example); the server never reads it
├── .env                    # Runtime config (copy from .env.example)
├── package.json            # npm workspaces: core, server, web (one install, one lockfile at the root)
├── core/                   # `spine-core`: everything the device's core (a Web Worker) runs, and the server too. Built to core/dist; web and the tests use core/src
│   └── src/
│       ├── config.ts       # env parsed + validated once at startup; resolveDataDir() is the one place DATA_DIR is decided
│       ├── consent.ts      # the versions of the texts a person agrees to, and whether an account has agreed (the device's own user is created with them)
│       ├── share-host.ts   # port: what a device does for a share (seal and send the copy, answer a request); the device registers it, and a process without one cannot make a share
│       ├── http.ts         # the request, reply and app the route files are written against (core's own types; no framework): the server's tests give them Fastify (`server/src/http-host.ts`), the device its own router (`web/src/core/local-app.ts`)
│       ├── logger.ts       # the logger for modules without the app; server/src/index.ts points it at the structured log
│       ├── parser/         # parser interface: types.ts (the contract), index.ts (registry), adapters/{sidecar,ocr,multimodal,hybrid}.ts (`sidecar.ts` is the `text` parser), ocr.ts (asks the OCR tool)
│       ├── files.ts, digest.ts  # ports: the files (originals, page images, scratch) and the hashing the shared code uses, registered with useFiles / useDigests by the device and by the tests' setup (Node's); settings (the environment) are a port too, `useSettings` in config.ts
│       ├── native-tools.ts # NativeTools: what the shared code asks the machine for (render a PDF, OCR, pictures, zips ...), registered by the device and by the server's tests
│       ├── relay/protocol.ts  # the neutral wire format of a device's model calls (the relay service itself is in server/)
│       ├── translation.ts  # translateDocument(): on-demand, cached by digest; languages.ts lists the four languages
│       ├── embedding/      # embedder interface: types.ts, index.ts (registry), adapters/{none,relay}.ts (`vertex` is the relay service's)
│       ├── similarity/     # card.ts (what a document is embedded as), index.ts (sync, related, hybrid search)
│       ├── chat/           # agent.ts (the LangGraph agent and its read-only tools), screen.ts (what is on screen, resolved), index.ts (askQuestion; the fixed-pipeline fallback), retrieval.ts (keywords, fused search)
│       ├── episodes/       # index.ts: proposing episodes from the data (no model), scheduleEpisodes()
│       ├── linking/        # index.ts: candidates (no model), the judge, links as proposals, the chain
│       ├── billing/plans.ts # the plans, what each includes, entitlementsOf() and taskCost(): the one place a limit is written (the server enforces, the account page shows)
│       ├── emergency.ts    # the emergency card: what is on it (zod), cardText() for the offline code; routes/emergency.ts edits and publishes it through the share host
│       ├── tags.ts         # STARTER_TAGS and cleanTag(): what a tag is and a new account starts with
│       ├── share-scope.ts  # the only place a share-link scope is validated or resolved
│       ├── llm/            # LLM interface: types.ts, prompts.ts, chat-llm.ts, budget.ts (daily call allowance), index.ts (registry), adapters/
│       ├── store/          # store interface: types.ts (interfaces), index.ts (registry), sync.ts (the rules for syncing devices, any store), slice-policy.ts (what a share copy holds), visibility.ts (which documents are shown), ids.ts, owner.ts, sqlite/ (records and accounts; browser.ts is the one file the device imports), postgres/ (the server's accounts only, over a pool the host registers with `usePool`: `pool.ts` is the port, `query.ts` the helpers and transaction type, `store.ts` the assembly and `schema-accounts.ts` the tables, with one file for each group of repositories: `users.ts`, `small.ts` (sessions, usage, enrolments), `vault.ts`, `shared.ts`, `billing.ts`, `delegations.ts`, `maintenance.ts`)
│       ├── archive/        # export.ts (a document or the whole archive as a zip), import.ts (Spine export or plain zip), import-file.ts (restore one file, no model), manifest.ts (zod schema, fingerprint), zip-read.ts, pdf-pages.ts
│       ├── ingestion/      # accept-upload.ts, jobs.ts, pipeline.ts, extraction.ts, continuation.ts, grounding.ts, rasterize.ts, pdf-text.ts (the PDF text layer, PDF.js)
│       ├── routes/         # the records routes (documents.ts, source-files.ts, share.ts, public-share.ts, tags.ts, trends.ts, doctors.ts, ...) and middleware.ts; the device's LocalApp registers these
│       ├── testing/        # (in no build; the tests and the server's type-check read the source) helpers the tests of core and server share (seed data, a scripted model, a software authenticator, the store contract suite)
│       └── __tests__/      # Vitest tests of core (the units; the tests that drive the whole composed app are in server/)
├── server/                 # `spine-server`: Node.js + Fastify. Only what the server runs; the records routes are registered by the device, not here
│   └── src/
│       ├── index.ts        # registers the account routes, the vault, sealed shares and the relay pass; sets the accounts-only store scope
│       ├── config.ts       # the settings only the server has (port, secret, registration, mailer, session, vault and share limits); loadConfig reads them with core's
│       ├── store.ts        # useAccountsStore(): the store this process keeps (accounts only); session-auth.ts: sessions, `authenticate` and the server's RequestAuth
│       ├── http-host.ts, rate-limit.ts  # Fastify as core's HttpApp (asHttp, asPlugin); windowLimiter(): per-key limits the Fastify plugin cannot stack
│       ├── accounts.ts, sessions.ts, user-tokens.ts, legal.ts, vault-files.ts, shared-files.ts  # accounts, sign-ins, one-time tokens, the legal texts, the vault's and sealed shares' files
│       ├── mail/           # mailer interface: types.ts, index.ts (registry), adapters/{none,brevo}.ts
│       ├── native/         # the Node versions of the tools the shared code asks for (poppler, Tesseract, sharp, pdfkit, yauzl, yazl, maxmind): for the tests that run the whole app on Node; none is used in production
│       ├── objects/        # the object store the sealed bytes go to: types.ts (the port), filesystem.ts and gcs.ts (the adapters), index.ts (SPINE_OBJECTS; `useObjects` is called by `useAccountsStore`); vault-files.ts and shared-files.ts build the keys
│       ├── billing/        # config.ts (SPINE_BILLING and Paddle's settings), paddle.ts (signature check, checkout, portal), entitlements.ts (an account's limits for the routes), gate.ts (what the relay asks before and after a call)
│       ├── geo.ts          # the country a share was opened from (maxmind, reading data/geoip/country.mmdb or SPINE_GEOIP_DB; looked at again every minute): the one native library the production server uses
│       ├── geoip-update.ts # downloads that file (ip-location-db "user-country", public domain) and checks it before it replaces the one in use; best effort, always ends well; run by install.sh -s and daily before the backup
│       ├── providers.ts    # registers the model providers the relay service runs; llm/adapters/ (anthropic, vertex) and embedding/adapters/ (vertex) hold them
│       ├── driver-native.ts, driver-pg.ts # the native SQLite driver and the `pg` pool, both registered by useAccountsStore(); the store config says which is opened
│       ├── passwords.ts    # argon2id hash/verify, policy, email normalisation
│       ├── totp.ts         # RFC 6238 codes, secret encryption at rest, recovery codes (pure; no store)
│       ├── second-factor.ts # checkSecondFactor(): joins totp.ts to the store; atomic spend
│       ├── cli.ts          # operator commands: create-user, set-password, reset-link, disable-2fa, delete-user, list-users
│       ├── trust-proxy.ts  # the only addresses whose X-Forwarded-For is believed (loopback); limiters key on req.ip
│       ├── notify.ts       # account mail (new browser, password or 2FA change); never records
│       ├── passkeys.ts, trust-anchors.ts, vault-keys.ts, backup.ts  # WebAuthn, the signature trust anchors, the vault's keys, the VACUUM INTO snapshot + vault mirror run by spine-backup.timer
│       ├── relay/          # the relay service: token.ts (the pass), relay.ts (checks, runs the task through the configured provider adapter, stores nothing), serve.ts (reads the settings and listens), main.ts (`node dist/relay/main.js`: registers the store and the vendors, then serves)
│       ├── routes/         # auth.ts (login + second step), accounts.ts, totp.ts, passkeys.ts, enrolment.ts (a device let in by one that is signed in), sessions.ts, own-account.ts, vault.ts, shared.ts, relay.ts, trust-anchors.ts
│       ├── testing/        # stand-in.ts (a model for tests) and stand-in-relay.ts (the relay's entry point with it, for check:app): in no build
│       └── __tests__/      # Vitest tests that drive the composed app, plus helpers/app.ts (buildTestApp) and helpers/seed.ts
├── web/                    # React + Vite + Tailwind
├── checkout/               # Paddle's checkout page, served from an origin of its own so its script never runs beside the vault (docs/billing.md)
├── nginx/                  # Site config template (spine.conf), security.txt template, /source /docs /security redirects
└── systemd/                # spine-web.service, spine-backup.{service,timer}
```

## Common commands

```bash
# Everything, first time (asks for what is not in the environment)
sudo SPINE_DOMAIN=spine.example.com ./install.sh -a

# Install deps (first time, needs sudo)
sudo ./install.sh -d

# Write .env (and relay.env, given ANTHROPIC_API_KEY) with generated secrets; an existing file is left alone
./install.sh -e

# Build everything (server TS + React)
./install.sh -b

# Install and start systemd services
sudo ./install.sh -s

# The relay on this machine (needs relay.env and SPINE_RELAY_DOMAIN)
sudo ./install.sh -r

# Issue Let's Encrypt cert and install nginx config (the relay's too when SPINE_RELAY_DOMAIN is set)
sudo ./install.sh -n

# Restart after code changes
./install.sh -b && sudo systemctl restart spine-web

# Accounts (the operator creates them; SPINE_REGISTRATION=open lets people sign up; =approval lets them ask and waits for the operator)
cd server && npm run cli -- create-user you@example.com      # prints a password once
cd server && npm run cli -- set-password you@example.com     # an account with no vault only; ends that user's sessions
cd server && npm run cli -- reset-link you@example.com       # one-time link; works with no mailer
cd server && npm run cli -- approve-user you@example.com      # an account waiting under SPINE_REGISTRATION=approval; list-users marks it
cd server && npm run cli -- disable-2fa you@example.com      # lost phone and recovery codes
cd server && npm run cli -- delete-user you@example.com      # shows what it would remove; --yes to do it
cd server && npm run cli -- list-users

# Install and build (npm workspaces: one install at the root; core is built first because server and web use it)
npm ci && npm run build

# Tests (core: the units; server: the tests that drive the composed app; the tests run on core's source, not its build)
npm test -w spine-core
npm test -w spine-server
npm run test:accounts -w spine-server   # the server's own tests on the accounts-only database (M-37); core has one too
npm run test:shim -w spine-server       # the same on the WebAssembly SQLite the browser uses; core has one too
npm run test:postgres -w spine-server   # the accounts' tests on the Postgres adapter, over PGlite (Postgres in WebAssembly)
npm run test:coverage -w spine-server

# The checks CI runs (tests, typecheck, dependency audit, gitleaks, semgrep): needs `brew install gitleaks semgrep` for `scan`
./scripts/check.sh [server|web|scan|all]
```

## Architecture

What it must do (the `FR-`, `TR-` and `CR-` IDs cited around the repo): [docs/requirements.md](docs/requirements.md). Target architecture, trust boundaries, interfaces/adapters and the migration path: [ARCHITECTURE.md](ARCHITECTURE.md). Security principles, current controls and known gaps: [SECURITY.md](SECURITY.md) — read it before touching routing, auth, share links, storage, providers or static serving.

**The sections below describe what runs today:** multi-user with local accounts (CLI or open signup with email verification), a store interface (SQLite only), an LLM interface with Anthropic and Vertex adapters, a mailer interface (`none`, `brevo`). Hosting stays on a Pi; GCP is inference only.

**Request flow:** records: page → core (Web Worker) → `LocalApp` → route → store → SQLite in WebAssembly, on the device. Accounts, the vault, shares and the relay's pass: browser → nginx (TLS) → Fastify (port 3000) → the accounts database and `data/vault/`. Model calls: core → relay → provider.

**Ingestion flow** (a photo skips `rasterize.ts` and the text reader: `photo.ts` makes it an upright PNG page and the model parser reads it, and it is accepted only with `SPINE_MULTIMODAL_ENABLED`): Upload → `source-files.ts` keeps the original as a file in the device's store (saved to the vault sealed) → `pipeline.ts` (fire-and-forget) → `rasterize.ts` (PDF→PNG) → `pdf-text.ts` (PDF.js text layer) → `continuation.ts` (Claude Haiku, per page pair) → SQLite as pages and unread documents (`needs_reading`), held back until the owner confirms the grouping → on confirm, `read-upload.ts`: `extraction.ts` (Claude Haiku, per logical doc) → `grounding.ts` (bbox matching) → stamps and signatures → the documents appear

**PDF text layer** (`ingestion/pdf-text.ts`): PDF.js, in the device's core, returns per-page paragraph elements with bounding boxes in PDF points. There is no sidecar any more; what the retired Python/Unstructured one offered is in `docs/sidecar.md`.

**AI model:** configuration, not code. `SPINE_LLM_PROVIDER` (`anthropic` | `vertex`) and `SPINE_LLM_MODEL`, defaulting to `claude-haiku-4-5-20251001` for both continuation detection and field extraction. Everything provider-specific is behind the LLM interface in `core/src/llm/`, which knows one provider, `relay` (a device's); `anthropic` and `vertex` are the relay service's, in `server/src/llm/adapters/`, registered by `server/src/providers.ts`. **No vendor package may be imported outside `server/src/llm/adapters/`, and `core` imports no native library at all** (`boundary.test.ts`).

## Where the details are

| To change | Read |
|---|---|
| Anything: where the code runs, trust boundaries | [ARCHITECTURE.md](ARCHITECTURE.md) and its detail pages in [docs/architecture/](docs/architecture/README.md) |
| Routing, auth, share links, storage, providers, static serving | [SECURITY.md](SECURITY.md): the principles and the checklist at its end |
| The store, SQL, schema, sync | [docs/design-decisions.md](docs/design-decisions.md#records-and-the-store) |
| Reading an upload: parser, pipeline, grouping, what the owner edits | [docs/design-decisions.md](docs/design-decisions.md#reading-an-upload) |
| A model call, the relay, a provider | [docs/design-decisions.md](docs/design-decisions.md#models-and-the-relay) and [docs/relay.md](docs/relay.md) |
| Share links | [docs/design-decisions.md](docs/design-decisions.md#sharing) |
| The chat and its tools | [docs/design-decisions.md](docs/design-decisions.md#the-assistant) |
| Sign-in, sessions, two-factor, passkeys | [docs/design-decisions.md](docs/design-decisions.md#accounts-and-sign-in) |
| Profiles, family, the emergency card | [docs/design-decisions.md](docs/design-decisions.md#people-family-and-the-emergency-card) |
| The device core, the vault, native tools | [docs/design-decisions.md](docs/design-decisions.md#the-device-and-the-vault) and [docs/crypto-design.md](docs/crypto-design.md) |
| A setting | [docs/configuration.md](docs/configuration.md) |
| Where a file belongs | [docs/structure-rules.md](docs/structure-rules.md) |

## Rules that fail a test when broken

Each is explained in [docs/design-decisions.md](docs/design-decisions.md); the test that holds it is named there.

- All data access goes through `getStore()`; no SQL and no `better-sqlite3` outside `core/src/store/sqlite/`. Every repository method takes the acting user's id first.
- A new table carries `user_id`, a new query lists explicit columns (never `SELECT *`), and a new table of records is added to `REPLICATED` in `store/sync.ts`.
- Every new query over the owner's documents uses `VISIBLE` (`store/sqlite/visibility.ts`).
- A schema change other than a new defaulted column needs an empty database; there is no migration runner.
- No vendor package outside `server/src/llm/adapters/`, and `core` imports no native library.
- A new path to a model calls `spendModelCall()`; a new agent tool is `read` (or returns a proposal) and respects the share `Scope`.
- A new share-copy column or table is named in `store/slice-policy.ts`; a scope is validated only in `share-scope.ts`.
- A new screen string needs an entry in `ro.json`, `fr.json` and `de.json`; a changed legal text raises its version.
- `startSession` is called only by the sign-in steps (`second-factor.test.ts`).
- A fix comes with a test that fails without it; structure follows `docs/structure-rules.md`.

## Tests

`npm test` runs the suite; `npm run test:coverage -w spine-server` reports coverage of the server's code and the core's through its tests, and fails below the thresholds in `server/vitest.config.ts`. **`npm run test:integration`** (server/) runs the flows against the real model in `.env` and poppler (`src/__integration__/`, `*.it.ts`, `docs/testing.md`): it is never part of `npm test` (which blanks the provider key so a unit test cannot call a model), forces an in-memory database, a temporary data directory and no mailer, and asserts what must hold whatever the model says. Run it after changing a prompt, a tool, the pipeline or the model; when it fails and the unit tests pass, add a unit test for the real state first. A new user-facing flow needs a scenario in `docs/scenarios.md` and, if it depends on what a model returns, an integration flow.

Intentionally uncovered (integration tests would need real PDFs or live provider credentials):
- `rasterize.ts` — PDF rasterizer
- the `invoke` paths in `llm/adapters/*` — they need live provider credentials. Their configuration refusals (missing endpoint/region/project, stray Google API key) are covered, and the interface is tested through fake task clients built with `RunnableLambda.from`, not a mocked vendor SDK
