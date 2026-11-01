# Architecture

Spine is a self-hosted, multi-user medical document archive. It ingests PDFs and scans, uses an LLM to split them into logical documents and extract structured fields, and issues scoped, expiring links so a doctor can read a subset without an account.

It must run on hardware as small as a Raspberry Pi, and must not be tied to any single LLM vendor.

The detail is in three pages under [docs/architecture/](docs/architecture/README.md): [interfaces](docs/architecture/interfaces.md), [the ingestion pipeline and what is built on it](docs/architecture/ingestion.md) and [the data](docs/architecture/data.md).

Everything described here is built, except what [Not done yet](#not-done-yet) lists. For the security posture this is expected to hold, see [SECURITY.md](SECURITY.md). For the Vertex AI provider specifically, see [docs/deployment-gcp.md](docs/deployment-gcp.md).

## Where the code runs now

The sections below describe the application's logic: uploads, reading, grouping, search, chat, links, shares. **That logic no longer runs on the server.** It runs as a core in the browser (a Web Worker, `web/src/core/`), over the same store interface and the same route files, on a SQLite database in WebAssembly that is saved to the server only as sealed pieces ([docs/crypto-design.md](docs/crypto-design.md), SECURITY.md **M-34** to **M-37**). Read "the server" in those sections as "the core", on the device.

What the server does:

- **Accounts**: sign-in on a value the browser derives from the master password (the server never receives the password), sessions, second factor, passkeys, reset and mail.
- **The vault**: keys it cannot open and sealed objects it stores and returns (`routes/vault.ts`).
- **Sealed shares**: the bytes of a share, its end time, the approval handshake and where in the world a link was opened (`routes/shared.ts`).
- **The relay's pass** (`routes/relay.ts`); the relay itself (`server/src/relay/`) runs a device's model calls through the configured provider adapter and stores nothing.
- **The trust anchors** an operator lists for signatures (`GET /api/trust-anchors`) and **the legal texts** (`GET /api/legal/:doc`).
- **The app and the address a recipient is given.**

`server/src/index.ts` registers nothing else, so the server has no route that reads or writes a record. The route files for documents, uploads, tags, chat and the rest are in `core/src/routes/` because the core runs them; the server's tests register them to hold that code (`server/src/__tests__/helpers/app.ts`). The server's database is made from `schema-accounts.ts` alone, so it has no table for a record, and its store is a type of its own (`AccountsStore`) with no repository of records, so code written for the server cannot reach one; the device builds `schema-accounts.ts` and `schema-records.ts` and holds both kinds of repository (`Store`).

The rules that keep this shape, each with the check that enforces it, are in [docs/structure-rules.md](docs/structure-rules.md).

## Design goals

1. **Multi-user, with real isolation.** Users of the same instance are separate adversaries. One user must never be able to read another's records, by any route.
2. **Runs on a Raspberry Pi.** The Pi is the **floor**, not the target: nothing the server does may need more than a Pi, and nothing should be capped by one (the heavy work, reading and rendering files, runs on the owner's device).
3. **Provider-agnostic inference.** A model is behind one interface; Claude and Gemini have adapters, and another provider is one adapter file. Model IDs and endpoints are configuration, never code.
4. **Self-hosted, operator-owned.** Each deployment is its own data controller. The software must be safe *by default*, because operators will not be security experts.
5. **EU data residency for this deployment.** Inference is processed inside the EU, which fixes the provider to Vertex AI on the `eu` multi-region with a service account. That is a requirement of this instance, not of the software, hence a configurable adapter.
6. **Code to interfaces.** Storage, inference, parsing, embeddings and mail are interfaces with swappable adapters, so a Pi deployment and a larger one differ by configuration, not by branch.

The operator of an instance is its data controller and owns the risk; the author is not a processor for anyone else's medical data. Unsafe configurations must be unreachable rather than documented against — see [SECURITY.md](SECURITY.md) **P3**.

## Deployment model

The application assumes nothing about where it runs or which model serves inference, and reaches its database only through an interface (SQLite is the one adapter). Everything environment-specific sits behind an adapter, so a deployment is a *configuration*, not a build.

The author's instance is a Raspberry Pi with the SQLite adapter, the PDF text reader running on the owner's device and a hosted model provider behind the relay. That is one configuration among several, and the one that sets the lower bound on resource use. GCP appears only as an **inference adapter** (Vertex AI, EU multi-region), not as a host.

## Component map

Three places run code. The records exist only in the first.

```
  THE DEVICE (the owner's browser)                     THE SERVER (Pi or container)            THIRD PARTIES
  ┌──────────────────────────────────────┐             ┌─────────────────────────────┐
  │ Page (React)                         │             │ nginx / Caddy :443 (TLS)    │
  │   keys from the master password      │  sign-in    │   └▶ Fastify :3000          │
  │   (libsodium); the server never      │◀───────────▶│       accounts, sessions,   │
  │   receives it                        │  value only │       2FA, passkeys, mail ──┼──▶ Brevo (account mail)
  │        │ postMessage                 │             │       vault: sealed objects │
  │ Core (Web Worker, spine-core)        │  sealed     │         it cannot open      │
  │   the routes (LocalApp), the store,  │◀───────────▶│       sealed shares + where │
  │   ingestion, chat, search, export    │  pieces     │         they were opened    │
  │   SQLite in WebAssembly              │             │       relay pass (10 min)   │
  │   native tools: PDF.js, Tesseract.js,│             │       SQLite: accounts only │
  │   canvas, pdf-lib, fflate            │             └─────────────────────────────┘
  │        │ model calls + pass          │             ┌─────────────────────────────┐
  │        └─────────────────────────────┼────────────▶│ Relay (own process/image)   │──▶ Anthropic | Vertex AI (eu)
  └──────────────────────────────────────┘             │   checks the pass and a     │
  A recipient's browser: the same core over one        │   daily count, runs the     │
  sealed share copy, opened with the key after the #   │   task; stores/logs no      │
                                                       │   content                   │
                                                       └─────────────────────────────┘
```

A document is read, grouped, searched and answered about on the device. What leaves it: sealed pieces to the vault, sealed copies for shares, the account sign-in value, and the text and (only if enabled) page images of a model call, which pass through the relay to the provider ([Egress](#egress-what-leaves-the-host)). The relay sees the plaintext of a call while it runs it; it does not store or log it.

### Trust boundaries

Five. The third arrives with multi-user and is the one a routine change can break without anything failing.

1. **Internet → nginx.** All inbound traffic is untrusted. nginx terminates TLS and is the only publicly bound listener.
2. **Proxy → Fastify.** Fastify trusts `X-Forwarded-*` only from the loopback proxy (`trust-proxy.ts`) and nginx overwrites `X-Forwarded-For` with the peer it saw, so a client cannot choose the address the rate limits key on (SECURITY.md **S-31**); Fastify must still never be directly reachable — otherwise those headers are attacker-controlled. It binds `127.0.0.1` unless `SPINE_HOST` overrides it (`config.ts`).
3. **User A ↔ User B.** Two accounts of the same instance. Neither may read, modify, or enumerate the other's records. Records are on each owner's device and the server holds them only sealed under keys it does not have, so the server cannot cross this line by a bug; what it can still get wrong is the vault's and the shares' per-account access (`isolation.test.ts`). The store-layer scoping below still holds on the device and in the tests that run the whole app — see [Multi-user model](#multi-user-model).
4. **Owner vs. share reader.** A share is a sealed copy of a subset of *one* owner's documents; whoever holds its key can open that copy and nothing else.
5. **Host → third parties.** The only egress: the inference provider, and the mail provider for account links. See [Egress](#egress-what-leaves-the-host).

There is no parser service: PDF text is read on the device by PDF.js in the core's Web Worker (`ingestion/pdf-text.ts`, `web/src/core/native/`), and the server parses no file, so there is no second listener to protect. The Python sidecar that did this before ([docs/sidecar.md](docs/sidecar.md)) was loopback-bound with no authentication and read any path it was given; that exposure is gone with it.

## Interfaces and adapters

Five interfaces — store, LLM, parser, embedder, mailer — each defined by the application, with the implementation chosen by configuration at startup. The detail (naming, the registry, each interface and its adapters) is in [docs/architecture/interfaces.md](docs/architecture/interfaces.md): [the store](docs/architecture/interfaces.md#store-interface), [the model](docs/architecture/interfaces.md#llm-interface), [the parser](docs/architecture/interfaces.md#parser-interface) and [the mailer](docs/architecture/interfaces.md#mailer-interface).

## Multi-user model

### Identity

**Local accounts only.** An email and a master password. The password is checked on the device (12–256 characters, not a common word or pattern, not part of the address) and never sent: the device derives a sign-in value from it, and the server stores an argon2id hash of that value (19 MiB / 2 passes / 1 lane). An account the operator makes with the CLI has no vault, and for it the server hashes the password itself under the same policy. No external identity provider: an instance must work with no internet reachability beyond its chosen inference provider. Sessions are server-side cookies holding a user id, that user's `auth_version` and the id of a `user_sessions` row; every request re-resolves them against the database, so a changed password ends other sessions on the next request, an unused sign-in ends after 24 hours and any after 14 days, and the owner can list and end them from the account page (SECURITY.md **M-27**). The server's own sensitive calls (deleting the account, adding or removing a passkey, making a vault, changing a credential) ask for the password again if it was not typed in the last ten minutes. The whole-archive export and a share link that shows page images run on the device, which is open only after the master password (or a passkey that opens the vault) was used, so they ask for nothing more. Login issues a new session id, and an unknown email is indistinguishable from a wrong password in both answer and time.

**Second factor (optional, per user):** TOTP, so it too needs no external service. After a user enrols from the account page, the right password only starts a *pending* login (held in the session for five minutes), and a valid code or a recovery code completes it. Reset links do not bypass it. Details and residual risks: SECURITY.md **M-12**, **S-20**, **S-21**, **S-22**.

Accounts come from the operator (`npm run cli -- create-user <email>`; also `set-password`, `reset-link`, `disable-2fa`, `delete-user`, `list-users`) or, if enabled, from open signup.

### People (profiles)

An account keeps records for one or more people (`profile` objects in the vault, **M-48**). The device's worker holds one person's core at a time: `switchProfile` saves it, starts the core on the other person's sealed objects and the page starts over (`web/src/profiles.ts`, `pages/Profiles.tsx`). The list is read once at sign-in and added to when someone is made. The plan's `profiles` limit is enforced where a profile object is created (`routes/vault.ts`).

### Children and teenagers

A child's profile is a profile with `kind: child` and a birth date in its sealed record (`core/src/family.ts` has the ages; the server never sees them). Co-guardians are `guardian` grants; the child's own account, offered from sixteen, is a `self` grant. See SECURITY.md **M-50**.

### Promotion at eighteen

The person a profile is of takes it into their own vault (`POST /api/delegations/:id/promote`, `DelegationRepository.promote`): new profile key under their account key, every data key and the profile record re-sealed, the objects moved between vaults in one transaction, the others' grants moved to them paused. See SECURITY.md **M-51**.

### Letting another account in

A profile can be opened by another account (`routes/delegation.ts`, **M-49**): an invitation code, a grant holding the profile key sealed to the other account's key pair, and `/api/delegated/:grant/objects…`, which are the vault's own handlers with the profile fixed. The worker lists such profiles beside the account's own (`grant:<id>`), and opens one with a `VaultSession.delegated` on the grant. Ending access replaces the profile's key (`POST /api/vault/profiles/:id/rotate`).

### The emergency card

`core/src/emergency.ts` defines the card and the plain text an offline code holds; `routes/emergency.ts` (run by the device) edits it and turns it on and off through the share host's `publishCard` and `revokeCard`; the device seals it and sends it to the server as a `card` bundle (`routes/shared.ts`), which has no end, is one for each person the account keeps records for (at most ten), and is not counted as a share. The viewer is at the same `/share/<id>` address as a share (`ShareRouter` asks the server which it is), so the proxy's rules for shared addresses, the content security policy and the shell route needed no change. The card may also keep official details, each on it only when ticked (`publicCard` is what everything outward is made from), and can be printed bank-card sized. A card not looked at for a year is flagged and its owner mailed once a year (`remindCardReviews`); a lost code is replaced by turning the old bundle off and sending the card again under a new id and key. See SECURITY.md **M-47**.

### Plans and payment

`SPINE_BILLING=on` gives accounts a plan (**M-45**, [docs/billing.md](docs/billing.md)): a six-month trial, a free plan and Premium, worked out from the account's age and its subscription (`entitlementsOf` in `core/src/billing/plans.ts`, never stored). The relay asks `billing/gate.ts` before and after each call; the vault and sealed-share routes ask `billing/entitlements.ts`; Paddle's signed messages (`routes/billing.ts`) write the subscription; the app only sends a person to Paddle's checkout (`checkout/`, an origin of its own) and to its customer portal. Off, none of it runs, which is the state of a self-hosted or private instance.

### Registration

`SPINE_REGISTRATION` is `operator` (default; accounts come from the CLI), `open` or `approval`. `open` requires a mailer and refuses to start without one (**P3**). `approval` lets anyone ask for an account, which holds no session until the administrator approves it with `approve-user` or, for an address in `SPINE_ADMIN_EMAILS`, from the account page; it needs no mailer, because approval then stands for confirming the address (**M-44**). `SPINE_INSTANCE=private` labels the deployment as private and refuses `open`; this instance runs `open` with Brevo, and a fresh install defaults to `operator` so it boots with no mailer.

Signing up creates an **unverified** account with no session until the emailed link is used; the right password before that answers 403 with a code the page uses to offer a new link. Signup is rate limited per source and per address (**P5**), and an existing address gets the same answer as a new one and is left unchanged. The links, their handling and the throttles are in SECURITY.md **M-6** and **M-11**.

### Account recovery

Two paths, because a self-hosted instance may have no mail provider:

- **Mailer configured** — `POST /api/auth/forgot`, then a one-hour link to a page that sets a new password. Same answer whether or not the address exists.
- **No mailer** — `npm run cli -- reset-link <email>` prints the same kind of one-time link for the operator to hand over. `set-password` works only for an account with no vault; with one, the password is chosen on the person's device.

Either way the link is a single-use capability (SECURITY.md **M-11**). Using it sets a new sign-in value, which ends the user's sessions (**P13**), and confirms the address, since receiving the link proves the mailbox. It cannot restore access to the records: with the recovery kit the device re-wraps the account key under the new password, without it the person gets an empty vault, and the page says so first (docs/crypto-design.md). A too-short new password is refused *before* the link is spent.

### Ownership and isolation

Every row of user data belongs to exactly one user: the record tables on the device (`source_files`, `pages`, `documents`, `extracted_fields`, `tags`, `share_links` and the rest of `schema-records.ts`) and the identity and vault tables on the server (`user_tokens`, `user_totp`, `user_recovery_codes`, `user_sessions`, `vault_*`, the shared-bundle tables) carry a `user_id`. The server keeps an account's sealed files under `data/vault/<user>/`. Tags are **per-user**: a shared vocabulary would leak the existence of other users' categories and let one user's rename affect another's records.

> Every read and write is scoped by owner at the store layer. A repository method that
> does not take an acting user id, or that can return a row the acting user does not
> own, is a defect.

Reads for a share are the deliberate exception to scoping by session: they are scoped by the *link's* owner and scope, resolved from the link's id. Every branch of a share query still filters by that owner, so a link can never return another user's document.

### Roles

None. Every user is an equal owner of their own records, and no application path reads another user's documents. An operator with shell access can read the accounts database and the sealed objects, not the records in them, and could serve a different web app to users (SECURITY.md, "Adversaries we design against"; docs/key-hierarchy.md); that is inherent to self-hosting. Instance setup (first account, provider) is configuration and CLI, not an in-app superuser.

## Request flow

```
Page → Core (Worker) → LocalApp → route → store interface → SQLite (WebAssembly)      records, on the device
Page → nginx (TLS) → Fastify :3000 → account / vault / shared / relay-pass routes      accounts and sealed bytes
Core → Relay → provider                                                                model calls
```

The records routes below are in `core/src/routes/`: the device registers them in production, and the server's tests register them to run the whole app on Node. Fastify serves two kinds of traffic from one process:

- **`/api/*`** — JSON. All of it requires a session except the sign-in calls (`/api/auth/login` and its second step, `options`, `kdf`, `register`, `verify`, `resend-verification`, `forgot`, `reset`, `reset/keys`, the passkey sign-in pair, a device's request to be let in and its collection (`/api/enrol/request`, `/api/enrol/claim`: the id is made by a one-time code the server never sees), `me`, `logout`), the legal texts (`/api/legal/:doc`), the trust anchors, and the public side of a sealed share (`/api/shared/:id/...`: metadata, sealed bytes, an access request, the note that a link was opened, the pass for a share's model calls). The list is `PUBLIC` in `isolation.test.ts`, except the trust anchors, whose route that test's app does not register (`trust-anchors.test.ts` covers it).
- **everything else** — the built React app from `web/dist`, with a not-found handler falling through to `index.html` so React Router owns client-side routing. The fallback excludes `/api` and `/share/` (trailing slash, so the owner's `/share` page still reaches the SPA while a recipient's `/share/:id` reaches its own handler, `shareShellRoutes`). That means `GET /share/:id` **must serve the app shell itself**; returning JSON there was S-15.

Auth is enforced by `requireAuth` (`routes/middleware.ts`), a `preHandler` (added to a whole records route file with `addHook`, and per route in the server's own files) that resolves the session to a live user and sets `req.userId`; handlers pass that to the store. A route registered without it is public, so one added in the wrong way is silently public — which is why `isolation.test.ts` requests every registered route without a session and fails on any that does not answer 401 and is not on its short allow-list (**P1**, **P12**).

## Ingestion pipeline

From upload to documents the owner can read: parsing, hybrid routing, reading and grouping, and the features built on the result (the document page, trends and doctors, chat, care chains, episodes, similarity, the library, export and import). Fire-and-forget, with the browser polling for status. The detail is in [docs/architecture/ingestion.md](docs/architecture/ingestion.md); the parts most often cited are [Hybrid routing](docs/architecture/ingestion.md#hybrid-routing), [Confirming the grouping](docs/architecture/ingestion.md#confirming-the-grouping), [What the owner edits stays edited](docs/architecture/ingestion.md#what-the-owner-edits-stays-edited) and [Ask your records: chat](docs/architecture/ingestion.md#ask-your-records-chat).

## Data

What is kept where and whether it is backed up, the schema (and why there is no migration runner), and share links as sealed copies. The detail is in [docs/architecture/data.md](docs/architecture/data.md): [At rest](docs/architecture/data.md#at-rest), [Schema](docs/architecture/data.md#schema) and [Share links](docs/architecture/data.md#share-links).

## Egress: what leaves the host

Page images are the most sensitive egress in the system and are off unless asked for twice (see [Hybrid routing](docs/architecture/ingestion.md#hybrid-routing)).

Every row marked "configured provider" is a call the owner's device makes to the relay, which runs it through the provider it is configured with (Vertex or Anthropic) and stores and logs nothing ([docs/relay.md](docs/relay.md), SECURITY.md **M-35**). The server itself calls no model. The relay sees the plaintext of a call while it runs it.

| Path | Payload | Destination |
|---|---|---|
| Continuation detection | the text of two adjacent pages | configured provider |
| Field extraction | the document's full text (split into chunks only if it would exceed the context window), **and the names of the tests already in this person's archive** (up to 300, within 5% of the context window; names only, never values, dates or documents) so one test is named one way, **and, when a document is read again, the owner's notes on it** (context only; a first reading has none) | configured provider |
| Reading again after a split or join | the same, for each document the change touched | configured provider |
| Page reading (`hybrid`) | **full page images**, only for pages with no text layer that local OCR could not read | configured provider |
| Page reading (`multimodal`; `hybrid` for the pages it cannot read locally; a photo; "Read page with AI") | **full page images** | configured provider |
| Page reading ("Read page with AI", one or more pages) | **full page images**, only the pages chosen | configured provider |
| "Read whole document" | per the configured parser: the text layer sends nothing; OCR sends nothing; `hybrid` sends **page images** only for pages still without text; `multimodal` sends every page. Then the page **text** for extraction | configured provider |
| Signature stamps (PDFs only, `readSignatures`) | **small cropped images** from each document's last page that look like a stamp: no whole page and no logo or QR code; only with image reading on | configured provider |
| Photo upload (JPEG, PNG) | **the photo**, upright and at most 2600 px a side; only with image reading on, otherwise refused | configured provider |
| Translation (a document opened in another language, or a share link made in one) | the document's **title, summary, extracted values, labels the app has no name for, measurement names, specialties and the owner's notes**, as text; once per document and language, kept until the document changes. Off with `SPINE_TRANSLATION=off` | configured provider |
| Embeddings (`SPINE_EMBEDDINGS=vertex`, off by default) | each document's short **summary card** (title, type, provider, date, summary, doctors, diagnoses and similar key fields, test names; never page text) when it is new or changed, and the **search words** when searching by meaning | the configured Vertex endpoint |
| Ask your records (`SPINE_CHAT`, on by default) | **the question, up to six earlier turns, a description of what is on screen**, and what the agent's read-only tools return (up to 120,000 characters a question): **summary cards, the owner's notes, results with values and reference ranges, and field values** of the documents it opens; never a page image, and page text only through `read_pages` (a few pages of one upload, when the owner is sorting it). One question can be up to eight rounds of tools, each a model call. When the model cannot take tools, or the agent fails, it is one call over a fixed set | configured provider |
| A share recipient's question (`allow_chat` on the link, `SPINE_CHAT` not off) | the **question, up to six earlier turns the page sends**, the link's label, and what the agent's tools return for the **shared documents only** (summary cards, the owner's notes, results, doctors, field values); never page text or an image. Up to five rounds of tools. Counted for the share, not an account | configured provider |
| Care chains (`SPINE_LINKING`, on by default) | the **summary cards** of one document and up to six candidates per call (same content as the embeddings row, plus each doctor's role and the **owner's notes**, first 600 characters), after an upload, a re-reading, or when asked; never page text. Only when the data finds a candidate | configured provider |
| Sorting a mixed upload (the owner confirms; chat card or the upload's report) | the **text read from the pages** of that one upload, a page or so each, to judge each candidate group (at most 60 calls, groups of at most 8 pages); where embeddings are on, the pages' text to the embedder. Never an image | configured provider |
| Parsing (text layer) | nothing — local | — |
| Account mail (verification, reset, a sign-in from a new browser, a changed security setting, a share waiting for approval) | recipient address, a link, the time of the event. **Never document content** | configured mail provider |

Residency is a property of the endpoint. For Vertex that means the `eu` multi-region host and service-account credentials, never an API key. See SECURITY.md **P8**, **M-8** and [docs/deployment-gcp.md](docs/deployment-gcp.md).

### The mail path

Brevo is French (formerly Sendinblue), runs EU data centres and holds ISO 27001. **Confirm that in their DPA before relying on it**: what is public is third-party summary, not contractual terms. Mail is a lower bar than inference under **P8**: a recipient address, a link and the time of an account event, never health data, so the provider processes personal data only. Metadata still leaks, since a sender or domain naming the service says the recipient uses it, which is the operator's call. The subjects are plain account wording (see Mailer interface above), a test fails on clinical wording, and `SPINE_MAIL_SENDER` is required with no default so the operator chooses the name on purpose. The links point at `SPINE_DOMAIN`, so the domain is visible too.

### Languages

The interface is available in English, Romanian, French and German (`web/src/i18n/`). A string is written in English where it is used, `t('Share links')`, and the English is the key into `ro.json`, `fr.json` and `de.json`; a string a dictionary lacks shows in English. Plurals use `tn(n, one, other)` with the dictionary key `one|other` and the forms joined by `|` (Romanian has three). `core/src/__tests__/i18n-coverage.test.ts` reads the web source and fails when a string is missing from a dictionary, a dictionary holds one no screen uses, or a placeholder differs. The reader's choice is kept in the browser (`spine.lang`) and defaults to the browser's language. Messages produced by the server (errors, the reading's step names) stay in English.

**Content is translated separately from the interface.** A document is stored in the language it was written in (`documents.language`, found at extraction, editable). Opening it in another language asks `GET /api/documents/:id/translation?lang=` for its title, summary, notes, extracted values, measurement names and specialties (`translation.ts`); the page shows the original at once, swaps in the title, summary, notes and specialties after one short model call (`?part=head`), and the fields and results when the second stage finishes (`?part=full`, which joins the same in-progress run, so the model is asked once per stage however many requests there are), with "Show original". The page first looks at what is kept (`?cached=1`, which never asks a model and answers 204 when nothing whole is kept), so it shows that it is translating only when it really is. The result is kept in `document_translations`, **validated by a digest of the text that was translated** rather than by explicit invalidation: editing, re-extracting, reordering pages or changing the language alters the digest and the next request translates again, so a stale translation cannot be served. A share link has an optional language the owner presets; the recipient's page starts in it unless they chose one in their browser, has a switcher, and gets translations through the public equivalents (`/meta`, `?lang=` on the list, `/documents/:id/translation`). Creating a link warms the translations for the documents in scope in the background. Field labels the app knows (`KNOWN_FIELD_LABELS`) are translated by the interface and never sent. The model's answer is checked item by item: a value that is missing, or that rambles (several times the length of the original, or with arrows between alternatives), is asked for again once and otherwise shown in the original; a translation that is still incomplete **is stored with what was usable and is marked `incomplete`**, never served as whole (the page asks again, and the kept copy answers at once), and the missing part alone is asked for again once ten minutes have passed. A document whose language was never recorded is told it by the model's answer (`source_language`) and is then not translated into the language it is already in. See SECURITY.md **M-13**.

## Frontend

React + Vite + Tailwind, built to `web/dist`, served by Fastify. Pages: the front page (`/` with no session: what Spine does, how records are sealed, who can see what and what it is not; `pages/Landing.tsx`; a session shows the timeline there instead; its Try the demo opens the app with the sample records in a core with no vault and no share host, and, where the operator allows it, reads a few files of the visitor's own through the relay with a pass of the demo's, SECURITY.md **M-39**), timeline, upload (and an upload's pages and grouping), camera scan, review, search, trends, episodes, doctors, library, share links (and one link's page and a waiting request), account (master password, recovery kit, passkeys, two-factor, sign-ins, your data and account deletion), login, register, verify, forgot/reset, the privacy notice, terms and purpose, and the public `/share/:id` view, each in four languages (see [Languages](#languages)). Every page works at phone width: below 1280 px (`xl`, where the full header fits) the navigation collapses into a menu, and below `md` the review screen stacks the fields above the page image. One palette serves the whole app and is defined once, in `web/tailwind.config.js`: `brand` (a teal; `brand-600` is the main colour, 5.5:1 with white) and warm paper-to-ink greys in place of Tailwind's blue and cool greys, so a screen names a colour and never picks one. Inter is the typeface; IBM Plex Mono is loaded by the front page only. Both ship with the app (`@fontsource-*`, OFL-1.1), so `font-src 'self'` holds. In dev, `npm run dev` runs Vite separately and proxies `/api` and `/share` to port 3000 (`web/vite.config.ts`).

`web/tsconfig.json` sets `noEmit: true` deliberately. Without it `tsc` writes `.js` next to every `.tsx`, and Vite resolves `.js` *before* `.ts`, so stale output silently shadows real sources.

## Configuration

Everything environment-specific comes from the environment. [`.env.example`](.env.example) lists the variables; this section holds the rules.

`core/src/config.ts` (the settings every host shares) and `server/src/config.ts` (the ones only the server has) validate and read the sections once at startup, exiting non-zero with every problem listed rather than falling back (**P3**). Core reads no environment itself: each host registers the settings (`useSettings`); the server passes the ones that name no secret to each device with its relay pass settings (`routes/relay.ts`).

1. **Validate at startup, fail loudly.** A missing or short `SESSION_SECRET`, an empty model id, a bad number or a switch combination that makes no sense stops the server with every problem listed; an unknown provider, or a Vertex model without its endpoint, region and project, stops the relay (`relay/serve.ts` builds its default client before it listens). Neither waits for a failed ingestion.
2. **No silent fallbacks for anything with a compliance meaning.** A Vertex endpoint never defaults to a global one (Anthropic's has no regional form and defaults to `api.anthropic.com`), and image egress never enables itself by being implied (**P8**).
3. **Provider and model are instance-wide, not per user.** One destination for inference keeps egress auditable and the compliance surface one decision wide. A person may pick another model for one reading only from the list the operator offered (`SPINE_LLM_MODELS`), on the same provider.
4. **Log the resolved configuration at startup** — provider, model, endpoint, whether image egress is on — with secrets redacted. If residency has to be provable it has to be observable: `journalctl -u spine-web | grep "model settings given to devices"` shows what an instance tells its devices to use without reading `.env` (the relay logs the provider it actually calls). One line, emitted by the composition root.

## Not done yet

Everything above is built. What is left, in the order it matters:

- **A migration runner**, before the first change to an existing table once the archive holds real records. Not a gate today: an empty database needs none.
- **Live checks nobody has run:** Anthropic behind the relay (Vertex has been run through it on invented records); the Cloud Run deployment of the relay; a real Brevo send; argon2id timing on the Pi; the OCR thresholds on real scans of handwriting; the CI browser jobs on a real runner; a restore of a backup to a blank machine.
- **Brevo's DPA**, to be confirmed by reading it.
- **Requiring two-factor** instance-wide (SECURITY.md **S-20**).
- **Requirements the code does not yet meet:** the list in [docs/requirements.md](docs/requirements.md), "Where the code differs from these rows" (delegation, key rotation, identifier masking, a signed list of the build's hashes published apart from the site; the page itself has a manifest and, on purpose, no service worker).
- **Choosing the model** on Vertex (`gemini-3.8-flash` or `claude-sonnet-5`) by running 50–100 real Romanian handwriting samples through each, and a rotation cadence for the service-account key.
- The open facts in [docs/deployment-gcp.md](docs/deployment-gcp.md#open-items).

Settled, recorded so they are not reopened by accident:

- **EU data residency is required** here: Vertex AI, `eu` multi-region, service account.
- Registration is **open on this instance** with mandatory email verification; the software default is `operator`.
- Links carry their token in the URL fragment and are spent by a `POST`.
- Two-factor is **TOTP, optional per user**, with recovery codes and an operator CLI reset. Not SMS, which is weaker; TOTP needs no external service. A passkey (WebAuthn) is a separate way to sign in that counts as both factors (SECURITY.md **M-33**).
- The store has **one adapter** by intent; the interface is for portability.
- Recovery works **without a mailer** via the operator CLI (a one-time link; the records themselves need the recovery kit); `none` is valid only with registration closed.

## Build, deploy, testing

`install.sh` is the deployment story: `-d` system packages (Node LTS, curl and certificates, and `python3` for `node-gyp`; no poppler or Tesseract, since the server parses and renders nothing), `-e` writes `.env` (and `relay.env`, given a provider key) from the examples with generated secrets and never overwrites one, `-b` builds web and server (as the user who ran sudo), `-s` templates the systemd units and starts them — `spine-web` and the `spine-backup` timer — `-r` the relay beside them (`spine-relay`, loopback, its own hostname; `docs/relay.md`), and `-n` Let's Encrypt plus the site configs (the distribution's nginx and certbot when the nginx package is not there). `-a` runs them all in that order. `-s` refuses to proceed if `.env` carries a missing, short or placeholder secret, and `-r` if the relay's settings disagree. Docker Compose is the other one (`docs/self-host.md`), with the relay as a profile. `better-sqlite3` ships N-API prebuilds including `linux-arm64`, so there is no compilation step on the Pi.


**Tests.** `SPINE_DB_PATH=:memory:` is set in `vitest.config.ts`, not in test files: the store captures the path at module load and ESM hoists imports above any top-level assignment, so a test that sets it itself writes to the real `data/spine.db`. Some code is intentionally not covered because it needs real PDFs or live credentials: `rasterize.ts` and the adapters' `invoke` paths, and `server/src/index.ts`, which the coverage report leaves out (the smoke test starts it instead). The LLM interface is tested through fake task clients (real `Runnable`s built with `RunnableLambda.from`), not a mocked vendor SDK, so the tests describe what Spine does with a model's answer and do not change when the provider does.

The harness registers the same plugins as `index.ts`, including `@fastify/rate-limit` and `trustProxy`, because a control is untested unless the test drives it the way production does (**P10**). The login limits are options on `authRoutes` so a test can set a small max and assert the 429 instead of mocking the limiter out.
