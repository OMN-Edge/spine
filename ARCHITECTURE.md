# Architecture

Spine is a self-hosted, multi-user medical document archive. It ingests PDFs and scans,
uses an LLM to split them into logical documents and extract structured fields, and
issues scoped, expiring links so a doctor can read a subset without an account.

It must run on hardware as small as a Raspberry Pi, and must not be tied to any single
LLM vendor.

> **Most of this is built.** Multi-user, the store and LLM interfaces and hybrid
> *storage* work; open signup, the mailer and the parser interface do not.
> [Current state vs. target](#current-state-vs-target) lists the delta and
> [Migration path](#migration-path) the order.

For the security posture this is expected to hold, see [SECURITY.md](SECURITY.md). For
the Vertex AI provider specifically, see [docs/deployment-gcp.md](docs/deployment-gcp.md).

## Design goals

1. **Multi-user, with real isolation.** Users of the same instance are separate
   adversaries. One user must never be able to read another's records, by any route.
2. **Runs *even* on a Raspberry Pi.** The Pi is the **floor**, not the target. Nothing
   in the design may *require* more than a Pi, but nothing should be capped by one
   either.
3. **Provider-agnostic inference.** Any LLM — Claude, Gemini, others — behind one
   interface. Model IDs and endpoints are configuration, never code.
4. **Self-hosted, operator-owned.** Each deployment is its own data controller. The
   software must be safe *by default*, because operators will not be security experts.
5. **EU data residency for this deployment.** Inference must be processed inside the EU,
   which fixes the provider to Vertex AI on the `eu` multi-region with a service account.
   It is a requirement of this instance, not of the software — hence a configurable
   adapter rather than a hardcoded one.
6. **Code to interfaces.** Storage, inference and parsing are ports with swappable
   adapters, so a Pi deployment and a larger one differ by configuration, not by branch.

### Distribution and risk

The operator of an instance is its data controller and owns the risk; the author is not
a processor for anyone else's medical data. Operators are not security experts, so unsafe
configurations must be unreachable rather than documented against — see
[SECURITY.md](SECURITY.md) **P3**.

## Deployment model

**The application is host-agnostic.** It makes no assumption about where it runs, what
database backs it, or which model serves inference. Everything environment-specific sits
behind an adapter, so a deployment is a *configuration*, not a build.

```
   ┌───────────────────────────────────────────┐
   │  Any host: Pi, VPS, container, GCE, …     │
   │                                           │
   │   reverse proxy ──▶ Spine (Fastify)       │
   │                          │                │
   │        ┌─────────────────┼─────────┐      │
   │        ▼                 ▼         ▼      │
   │   store interface        parser interface   LLM interface│
   └────────┼─────────────────┼──────────┼─────┘
            │                 │          │
            ▼                 ▼          ▼
     SQLite  (today)    local sidecar   Anthropic API
     Postgres (later)   multimodal      Vertex AI (eu)
     any other adapter                  any other adapter
```

Each one is reached **over an API or a driver**, never by reaching into the host:

- **LLM interface** — HTTPS to whichever provider is configured. Nothing model-specific
  leaks upward; the application never imports a vendor SDK.
- **Store interface** — repository methods over a driver. SQLite today, embedded in
  process; a networked database later is just another adapter.
- **Parser interface** — the local sidecar over loopback HTTP, or a multimodal model over
  HTTPS.

Because each is an interface, the same build runs on a Raspberry Pi with SQLite and on a
large host with a networked database. Nothing in the design may *require* more than
a Pi, and nothing may be *capped* by one.

### The reference deployment

The author's own instance is a Raspberry Pi with the SQLite adapter, a local parser
sidecar, and a hosted model provider. That is one configuration among several, and it is
the one that sets the lower bound on resource use — not a constraint on where the
software can run.

GCP currently appears only as an **inference adapter** (Vertex AI, EU multi-region), not
as a host. Nothing prevents hosting the app there; it simply is not the author's
deployment, and the store adapter that would make it comfortable does not exist yet.

## Component map

```
                           ┌──────────────────────────────────────────────┐
  Internet                 │  Host                                        │
 ──────────                │                                              │
                           │   ┌────────────────────────────────────┐     │
  Owner's browser ─────────┼──▶│ nginx :443                         │     │
  (account login)          │   │  TLS, HSTS, security headers,      │     │
                           │   │  rate limits                       │     │
  Doctor's browser ────────┼──▶│                                    │     │
  (share token, no account)│   └───────────────┬────────────────────┘     │
                           │                   │ proxy_pass              │
                           │                   ▼  127.0.0.1:3000         │
                           │   ┌────────────────────────────────────┐     │
                           │   │ Fastify                            │     │
                           │   │  ┌──────────────────────────────┐  │     │
                           │   │  │ HTTP routes                  │  │     │
                           │   │  ├──────────────────────────────┤  │     │
                           │   │  │ services (user-scoped)       │  │     │
                           │   │  ├────────┬──────────┬──────────┤  │     │
                           │   │  │ Store  │ Llm      │ Parser   │  │ ports
                           │   │  │ port   │ port     │ port     │  │     │
                           │   │  └───┬────┴────┬─────┴────┬─────┘  │     │
                           │   └──────┼─────────┼──────────┼────────┘     │
                           │          ▼         │          ▼              │
                           │   ┌───────────┐    │   ┌──────────────┐      │
                           │   │ SQLite    │    │   │ sidecar :8000│      │
                           │   │ + data/   │    │   │ Unstructured │      │
                           │   └───────────┘    │   └──────────────┘      │
                           └────────────────────┼─────────────────────────┘
                                                ▼
                                    Anthropic | Vertex AI (eu) | …
```

### Trust boundaries

Five. The third arrives with multi-user and is the one a routine change can break
without anything failing.

1. **Internet → nginx.** All inbound traffic is untrusted. nginx terminates TLS and is
   the only publicly bound listener.
2. **nginx → Fastify.** Fastify trusts `X-Forwarded-*` (`trustProxy: true`,
   `index.ts:38`), so it must never be directly reachable — otherwise those headers are
   attacker-controlled. It therefore binds `127.0.0.1` unless `SPINE_HOST` overrides it
   (`config.ts`); it listened on `0.0.0.0` until [SECURITY.md](SECURITY.md) S-13.
3. **User A ↔ User B.** Two authenticated users of the same instance. Neither may read,
   modify, or enumerate the other's source files, documents, pages, fields, tags or
   share links. **Enforced in the store layer, not in route handlers** — see
   [Multi-user model](#multi-user-model).
4. **Authenticated user vs. share-token reader.** A token grants read-only access to a
   subset of *one* user's documents and nothing else.
5. **Host → inference provider.** The only egress. See
   [Egress](#egress-what-leaves-the-host).

The parser sidecar sits inside the innermost boundary: loopback-bound, no
authentication, and it accepts a filesystem path which it reads directly. Anything that
can reach it can read any file the service user can. It must never be exposed.

## Interfaces and adapters

Four of them. Each is an interface the application defines; which implementation runs
is chosen by configuration at startup.

### Naming

Two layers, mirroring the existing `getDb()` / `resetDb()` convention:

```ts
// Construction. Pure: validates its config, returns a new adapter, no global state.
createChatLlm(config: ChatLlmConfig): ChatLlm
createStore(config: StoreConfig): Store
createParser(config: ParserConfig): Parser
createMailer(config: MailerConfig): Mailer

// Access. Reads config on first use, memoizes. No separate init step.
getChatLlm(): ChatLlm
getStore(): Store
getParser(): Parser
getMailer(): Mailer

resetStore(): void    // tests only, as resetDb() is today
```

`create*` constructs and is unit-testable with a config literal; `get*` reads config on
first use and memoizes. Reading config *inside* `get*` rather than at module load is what
avoids `getDb()`'s problem, where `SPINE_DB_PATH` had to be set before the module was
first imported.

**Both are synchronous**, and there is no `init` step. This note previously said
`createChatLlm` had to be `async` "because `initChatModel` is" — but `initChatModel` is
unused and no adapter awaits anything. An async factory would force an `await` in every
caller or a separate `initChatLlm()` so the accessor could stay sync. The composition
root just calls `get*()` once, so a bad provider stops the process there (**P3**).

### Dispatch is a registry, not a switch

```ts
const CHAT_LLM_ADAPTERS = {
  anthropic: createAnthropicChatLlm,
  vertex:    createVertexChatLlm,
} satisfies Record<string, ChatLlmFactory>;

export async function createChatLlm(config: ChatLlmConfig): ChatLlm {
  const factory = CHAT_LLM_ADAPTERS[config.provider];
  if (!factory) throw new ConfigError(
    `unknown SPINE_LLM_PROVIDER "${config.provider}"; expected one of ${Object.keys(CHAT_LLM_ADAPTERS).join(', ')}`,
  );
  return factory(config);
}
```

Adding a provider is a map entry plus an adapter file — no edit to a conditional that
every provider has to pass through. An unknown provider fails at startup with the valid
set named, rather than at first ingestion.

### Layout

```
src/config.ts              parse + validate env once, export a typed Config
src/llm/
  types.ts                 ChatLlm, ChatLlmConfig, schemas
  index.ts                 createChatLlm / getChatLlm + adapter registry
  adapters/anthropic.ts
  adapters/vertex.ts
src/store/
  types.ts                 Store, repository interfaces
  index.ts                 createStore / getStore / resetStore + registry
  sqlite/                  the only adapter; all SQL lives here
    connection.ts          open, pragmas, schema
    schema.sql             SQLite DDL
    migrations/            empty; see Schema
    source-files.ts pages.ts documents.ts fields.ts tags.ts share-links.ts maintenance.ts
src/parser/
  types.ts, index.ts, adapters/
src/mail/
  types.ts, index.ts, adapters/brevo.ts, adapters/none.ts
```

The same applies to the store: nothing outside `store/sqlite/` imports `better-sqlite3`
or writes SQL.

Nothing above an interface imports a **provider** package. `ChatAnthropic`, `ChatVertexAI` and
anything else vendor-specific stay inside `adapters/`; an import of one outside that
directory is a review failure.

`@langchain/core` is the exception, deliberately: an adapter returns one of its
`Runnable`s per task, so that type appears in `llm/tasks.ts` and `llm/chat-llm.ts`. It is
the shared abstraction package rather than a provider SDK, and using it as the seam is
using the library as intended. An earlier version wrapped it in a one-method
`StructuredChat` interface of our own, which bought only the ability to swap LangChain for
another framework without touching `chat-llm.ts` — speculative, and a few lines to pay if
it ever happens. Deleting it removed a concept without weakening the boundary that
matters.

### Store interface

**Implemented.** Repository interfaces — `SourceFileRepository`, `PageRepository`,
`DocumentRepository`, `ExtractedFieldRepository`, `TagRepository`, `ShareLinkRepository`,
`MaintenanceRepository`. No SQL leaves the adapter and no handler holds a database
handle: **zero `.prepare()` calls outside `store/sqlite/`**, where 39 statements live.

Two properties pay for it: isolation becomes structural, because handlers cannot write
queries; and a second adapter is additive.

`createStore(config)` returns a `Store` holding the repositories, not a connection:

```ts
export interface Store {
  sourceFiles: SourceFileRepository;
  pages:       PageRepository;
  documents:   DocumentRepository;
  fields:      ExtractedFieldRepository;
  tags:        TagRepository;
  shareLinks:  ShareLinkRepository;
  users:       UserRepository;
  maintenance: MaintenanceRepository;

  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

Three things shape it:

- **Every method returns a `Promise`, though the only adapter is synchronous.** A
  networked store is async, and a sync interface would weld the interface to
  `better-sqlite3`. An earlier draft of this document mixed the two — async methods under
  a sync `transaction<T>(fn: (tx: Store) => T): T` — which cannot compose.
- **`transaction` takes a `Store`, not a connection**, so repository code is identical
  inside and outside one. Ingestion writes a document, its tags and its fields together;
  a partial write leaves a document with no fields and no error.

  Implemented with explicit `BEGIN`/`COMMIT`, since `db.transaction()` throws on a
  callback returning a promise (*"Transaction function cannot return a promise"*).
  Nesting uses `SAVEPOINT`. The connection is shared, so a statement issued elsewhere
  while the callback awaits lands inside the transaction — acceptable while ingestion is
  the only multi-statement writer, and why the callback should use only its `tx`.
- **Every method takes the acting user's id** — just the id, so the signature forces the
  caller to have resolved identity:

```ts
interface DocumentRepository {
  listFor(userId: string, filter: DocumentFilter): Promise<Document[]>;
  findFor(userId: string, id: string): Promise<Document | null>;
  listForShare(link: ResolvedShareLink): Promise<Document[]>;   // one of four exceptions
}
```

There is no `find(id)` without a user, so a method that could return a row the caller
does not own is visible at review rather than at runtime. **Four exceptions**,
enumerated in `store/types.ts` so a fifth has to be argued for: share-token resolution
and `listForShare`; `logAccess` (**P7** — the reader is unauthenticated by definition);
`maintenance.*` (boot-time work with no acting user — stalled jobs, the S-4 rewrite,
`snapshotTo`); and `users.*` (the identity layer — login must find a user before there
is an acting user).

**Isolation is enforced.** Every user-owned table has a `user_id` and every statement on
it filters by that id. What a method does with a record the caller does not own:

- a read returns nothing, indistinguishable from "not found";
- an update or delete changes nothing;
- a create that names such a record throws and inserts nothing, since dropping a create
  silently would lose data;
- a call with no acting user at all throws, rather than matching nothing quietly.

Routes check first and answer 404, never 403. `__tests__/isolation.test.ts` exercises all
of it as a second user.

**Only the SQLite adapter exists, and that is the intended state** — the interfaces exist
so a second is possible, not because one is planned. Everything SQLite-specific lives in
`store/sqlite/`: connection and pragmas, the schema DDL, `VACUUM INTO`, and the
(empty) migrations directory.

> SQLite is single-writer; WAL lets readers proceed during a write. Fine for a handful of
> family users, and the first thing to revisit if concurrent ingestion becomes common.

### LLM interface

One interface covering what Spine actually asks of a model:

- `detectContinuation(pageA, pageB)` — are these the same logical document?
- `extractFields(documentText | pageImages)` — structured metadata.

Adapters: **Anthropic** (direct API), **Vertex AI** (Gemini *and* Claude, EU
multi-region), and room for others including local models.

Configuration carries the provider, model ID and endpoint. This is not speculative
flexibility — Claude Sonnet 5 on Vertex has a published retirement date and the Gemini
3.8 Flash price is introductory until 31 December 2026, so model IDs *will* change
independently of the code. See [docs/deployment-gcp.md](docs/deployment-gcp.md).

Residency is a property of the **endpoint**, not the model, so an adapter that falls back
to a global one loses it. See [SECURITY.md](SECURITY.md) **P8**.

Credential shape differs per adapter, and the interface must not assume one.

**Vertex is a platform, not a model.** Gemini *and* Claude both run on it; "Vertex or
Gemini" is a category error. The real distinction is which *API* serves the model:

| API | Models | Auth | EU residency |
|---|---|---|---|
| **Vertex AI**, standard endpoints (`aiplatform.*`) | Gemini **and** Claude | service account via ADC. **API keys are blocked here** | yes, via the `eu` multi-region endpoint |
| **Vertex AI Express** | Gemini only | API key | not the residency-bearing surface |
| **Gemini API** (`generativelanguage.*`) | Gemini only | API key | no guarantee |
| **Anthropic API** | Claude only | API key | no EU-only processing commitment |

Three verified constraints make the service account mandatory here, not merely
recommended:

1. **API keys only work on Vertex AI Express endpoints** and are blocked on the standard
   endpoints — which are the ones that carry the `eu` multi-region residency guarantee.
   OAuth/ADC works on all of them.
2. **Claude on Vertex cannot use an API key at all.** It is served via the `rawPredict`
   endpoint, which does not support API-key auth. So picking `claude-sonnet-5` forecloses
   the API-key route outright.
3. **An API key present in the environment can silently reroute to global.** Not a
   theoretical risk and no longer second-hand: reproduced against the installed
   `@langchain/google-vertexai`, where a stray `GOOGLE_API_KEY` sends the request to
   `https://aiplatform.googleapis.com/v1/publishers/google/models/<model>:generateContent`
   — global host, configured endpoint dropped, no `/locations/<region>/` in the path —
   and bypasses the per-request residency check entirely. See
   [SECURITY.md](SECURITY.md) **M-8** for the mechanism and
   [docs/deployment-gcp.md](docs/deployment-gcp.md) for the provider notes.

**This deployment requires EU residency**, so it uses Vertex AI on the `eu` multi-region
and a service account. The two API-key routes are therefore not available to it — but the
port still spans them, because another operator's instance may not have that requirement.

The remaining choice is the *model* on Vertex, which is an evaluation rather than a
design decision:

| Model | ~USD/page | Note |
|---|---|---|
| `gemini-3.8-flash` | ~0.003 | First pick on cost. Introductory price ends 31 Dec 2026 |
| `claude-sonnet-5` | ~0.009 | Stronger reasoning; retirement no sooner than 24 Dec 2026 |

Both accept images and both have documented EU processing. No benchmark found covered
Romanian diacritics, so the note's instruction stands: run 50–100 real handwriting
samples through each before choosing. Because the model is `SPINE_LLM_MODEL`, that
evaluation needs no code change — which is the point of the interface.

#### How the model is actually used — no chains

**No chaining, no agent loop, no tool use, no multi-turn conversation.** Independent,
stateless, single-turn prompts — two for text, and a third that reads a page image:

| Call | Input | Output | `max_tokens` |
|---|---|---|---|
| `detectContinuation(prev, curr)` | last 500 chars of page N-1 + first 500 of page N | `{is_continuation, confidence, reasoning}` | 256 |
| `extractFields(text)` | first 6000 chars of a logical document | date, provider, type, summary, tags, `fields[]` | 2048 |
| `readPage(image)` | one page image (`multimodal`/`hybrid` only) | `regions[]`: text + a box as fractions of the page | 4096 |

The model never sees its own prior output. The dependency is in the orchestration, not
the prompts: continuation results group the pages, and the grouping decides what text
each extraction call gets.

```
parse → [continuation × (N-1)] → group into documents → [extract × M] → ground locally
```

A 10-page upload containing 3 documents: 9 continuation calls + 3 extraction calls, plus
a `readPage` per scanned page when the multimodal path is on.
Grounding is **not** a model call — `groundSnippet` is local string matching.

Because every call is a stateless completion returning JSON, any chat-completion API can
back the interface. Tool use or multi-turn state would have made provider-agnosticism
substantially harder, since those formats differ across vendors.

#### Framework choice

**Implemented.** `@langchain/core` 1.2, `@langchain/anthropic` 1.5,
`@langchain/google-vertexai` 2.3 and `zod` 4 — 42 packages, 37 MB, 106 ms cold import,
below the estimate this decision was based on.

Two departures from the sketch below:

- **`initChatModel` is unused.** The adapter registry already does config-driven routing,
  so the adapters construct `ChatAnthropic` and `ChatVertexAI` directly.
- **`withStructuredOutput` is an optimisation, not the validation.** Adapters bind JSON
  Schema to each client and return parsed-but-unvalidated JSON; the interface validates with
  zod, so a provider that ignores the schema cannot write an unchecked shape.

An adapter is handed the two task definitions once and returns one bound `Runnable` per
task (`llm/tasks.ts`), because both the output budget and the schema are fixed at
startup. It then invokes `clients[task].invoke(prompt)` and validates. Anthropic
takes `maxTokens`, Google `maxOutputTokens`, both at construction — that naming
difference is the only reason the adapter layer exists. 34 lines for Anthropic, 84 for
Vertex.

Before the interface, both prompts were string templates against the vendor SDK parsed with
`JSON.parse` in a `try/catch`, with the model ID as a literal.

LangChain.js does provide the interfaces *and* the implementations this needs, verified
rather than assumed:

| Need | LangChain | Measured |
|---|---|---|
| Config-driven provider routing | `initChatModel(model, { modelProvider })` | returns a `ConfigurableModel`; routes `anthropic` and `google-vertexai` |
| Schema-constrained output | `withStructuredOutput(schema)` | present |
| Retry with backoff | `maxRetries` constructor option | present |
| Provider implementations | `@langchain/anthropic`, `@langchain/google-vertexai` | present |

Cost is not a real objection:

| Stack | Disk | Packages | Cold import |
|---|---|---|---|
| `@anthropic-ai/sdk` (today) | 22 MB | 7 | 22 ms |
| `ai` + 2 providers + zod | 42 MB | 46 | 30 ms |
| `@langchain/*` + 2 providers + zod | 89 MB | 53 | 87 ms |

67 MB over the status quo is irrelevant on any plausible host, and the ~65 ms import
delta is paid once at service start, not per request. **Use a library for the
implementations** rather than hand-rolling adapters.

What still belongs to us is the **the line between the two**, for one concrete reason rather than
preference: **residency has to be provable** (**P8**, **M-8**).

Measured against 2.3.2: `endpoint` and `apiEndpoint` both reach the request and produce
`https://aiplatform.eu.rep.googleapis.com/v1/projects/<p>/locations/eu/publishers/google/models/<model>:generateContent`
(`endpoint` is the declared option). Neither is readable back off the instance, nor is
`location`.

So the adapter requires endpoint and region to be stated, and refuses to construct if a
Google API key is present — the one case known to ignore them (**M-8**).

It does **not** assert the shape of the outgoing URL. An earlier version wrapped the
library's HTTP client and checked the host plus a `/locations/<region>/` segment per
request. Removed: that encodes Google's URL scheme, so it says nothing about an Azure or
Bedrock endpoint, and the API-key path bypasses it anyway.

### Parser interface

**Implemented.** `parse({ sourceFileId, filePath, pages }) → pages with text and boxes`.
`SPINE_PARSER` picks the adapter:

- **`sidecar`** (default) — the local Unstructured service. Exact boxes for native text,
  weak OCR on handwriting. Nothing leaves the host.
- **`multimodal`** — every page image goes to the configured LLM provider, which returns
  the text in blocks with a box each. A page the model cannot read fails the upload and
  names the page; there is nothing to fall back to.
- **`hybrid`** — the sidecar first, the model only for the pages the sidecar is bad at.
  See Hybrid routing.

The contract every adapter keeps, so nothing downstream has to guess:

- **One entry per page image, in order.** A blank page is an entry with no elements, not
  an absence. The sidecar leaves blank pages out, and the pipeline used to pair its output
  with the images by position, so one blank page would have put every later page's text on
  the previous page's image.
- **`image_width`/`image_height` are the image's pixel size and every box is in that
  space.** The sidecar reports boxes in its own coordinate system, and says how big it is.
  The pipeline used to ignore that and divide by the PNG's size. For native text
  Unstructured works in PDF points (72 per inch) and the PNG is 200 DPI, so highlights
  would have been about 2.8 times too small and sat near the top-left. The sidecar adapter
  now scales its boxes into the image's pixels.

> **Not verified against a live sidecar.** Its pinned dependency (`unstructured==0.15.0`)
> does not install on the Python on this development machine, so the scaling follows from
> reading the code, the Unstructured coordinate model and the sidecar's own output, not
> from a measurement. Check one native-text PDF against a real highlight on first deploy.

The model-read path has the same status in a different way: the message that carries the
image was checked against both providers' request builders (Anthropic produces a base64
`image` block, Vertex an `inlineData` part), but no real page has been sent.

### Mailer interface

**Implemented.** `send({ to, subject, text })`, plus `enabled`. It exists to verify an
address and recover an account; nothing else in the application sends mail. There is no
attachment field and no way to add one, which is the control: a document cannot leave by
this route because the route has no place to put it.

Adapters, chosen by `SPINE_MAILER`:

- **`none`** — the default. Sends nothing and reports itself disabled. The server starts
  with it only when registration is `operator`; `open` with `none` refuses to start.
- **`brevo`** — Brevo's transactional API over `fetch`: one request, a 10-second timeout,
  no retry (sending is user-triggered and a silent retry could mail a link twice). An
  error names the status and never the message, which holds a live link. Needs
  `BREVO_API_KEY`, `SPINE_MAIL_SENDER` and `SPINE_DOMAIN`.

Mail is sent **after the response**, so how long the provider takes does not depend on
whether an address has an account. A failure is logged, and the page tells the user to
request another link.

#### Residency of the mail path

Brevo is French (formerly Sendinblue), runs EU data centres and holds ISO 27001, which
fits this deployment. **Confirm it in their DPA before relying on it** — what is
available publicly is third-party summary, not contractual terms.

It is a lower bar than inference regardless: under **P8** email carries a recipient
address and a single-use link, never document text, a summary, a field or an attachment.
So a mail provider processes personal data, never health data.

Metadata still leaks. A subject or sender naming a medical records system tells the
provider — and anyone seeing the inbox on a clinic machine — that the recipient holds
medical records. The subjects are "Confirm your email address" and "Reset your password",
a test fails if the text mentions anything clinical or the product name, and the sender is
**required configuration with no default** (`SPINE_MAIL_SENDER`) so the operator picks a
neutral name. The links point at `SPINE_DOMAIN`, so a domain that says "medical" says it
too.

## Multi-user model

### Identity

**Local accounts only.** Email plus a password hashed with a memory-hard KDF (argon2id).
No external identity provider: an instance must work with no internet reachability
beyond its chosen inference provider, and a Pi behind a flaky connection must still let
its users log in.

**Implemented**, replacing the single shared password. Sessions are server-side cookies
holding a user id and that user's `auth_version`; every request re-resolves them against
the database, so a changed password ends other sessions on the next request. Login issues
a new session id. Passwords are 12–256 characters, argon2id at the OWASP minimum
(19 MiB, 2 passes, 1 lane), and an unknown email is made indistinguishable from a wrong
password in both answer and time.

Accounts are created by the operator: `npm run cli -- create-user <email>`, also
`set-password` and `list-users`. There is no signup page yet — see Registration.

Consequences of having no IdP to delegate to: credential storage, login throttling,
password change and reset, and session invalidation on password change. All but reset
links are built.

### Registration

**Implemented, closed by default.** `SPINE_REGISTRATION` is `operator` (accounts come
from the CLI) or `open`. `open` requires a mailer and refuses to start without one
(**P3**); this instance is intended to run `open` with Brevo. A fresh install defaults to
`operator`, so it boots with no mailer.

Signing up creates an **unverified** account that has no session, so it holds and does
nothing until the emailed link is used. Signing in with the right password before that
answers 403 with a code the page uses to offer a new link.

- Rate limited **per source and per address** (**P5**). The per-address limit keeps the
  endpoint from flooding someone's inbox, and uses `src/rate-limit.ts` because the Fastify
  plugin cannot stack two limiters on a route.
- An existing address gets the same answer as a new one, and is not changed: it keeps its
  password and gets no mail. The password is hashed in both cases.
- The link is single-use and carries its token in the URL **fragment**, which is never
  sent to the server, so it stays out of nginx's access log and the Referer header. The
  page removes it from the address bar after reading it. It is spent by a `POST`, so a
  mail scanner that follows links cannot spend it.
- The answer says "if that address can receive mail, a link is on its way". It does not
  say whether one was sent, which is what stops it being a way to list accounts.

### Account recovery

Two paths, because a self-hosted instance may have no mail provider:

- **Mailer configured** — `POST /api/auth/forgot`, then a one-hour link to a page that
  sets a new password. Same answer whether or not the address exists.
- **No mailer** — `npm run cli -- reset-link <email>` prints the same kind of one-time
  link. The operator hands it over; nobody edits the database. `set-password` is the
  blunter alternative.

Either way the token is a capability, handled like a share token: 256 bits of CSPRNG
output, only its **sha256 stored** (**P6**), spent by a single atomic `UPDATE`, so two
simultaneous requests cannot both succeed. A newer request replaces an older one. Using
it sets the password, which **ends the user's sessions** (**P13**), and confirms the
address, since receiving the link proves the mailbox.

A too-short new password is refused *before* the link is spent.

### Ownership and isolation

Every row belongs to exactly one user. Eight tables carry a `user_id`: `source_files`,
`pages`, `documents`, `extracted_fields`, `tags`, `document_tags`, `share_links`,
`share_link_access_log`. Originals are stored under `data/originals/<user>/<year>/`.

Tags are **per-user**, not global. A shared tag vocabulary would leak the existence of
other users' categories and let one user's rename affect another's records.

The isolation rule, stated so it can be checked:

> Every read and write is scoped by owner at the store layer. A repository method that
> does not take an acting user id, or that can return a row the acting user does not
> own, is a defect.

Share-token reads are the deliberate exception to scoping by session: they are scoped by
the *link's* owner and scope, resolved from the token. Every branch of a share query
still filters by that owner, so a link can never return another user's document.

### Roles

None. Every user is an equal owner of their own records. No admin can read another
user's documents — an operator with shell access can read the database, which is
inherent to self-hosting and is stated plainly rather than designed around.

Instance-level setup (creating the first account, configuring a provider) is an
operator task done through configuration and CLI, not an in-app superuser.

## Request flow

```
Browser → nginx (TLS) → Fastify :3000 → service → store port → SQLite
```

Fastify serves two kinds of traffic from one process:

- **`/api/*`** — JSON. All of it requires a session except login/registration and
  `/api/share/:token/documents`.
- **everything else** — the built React app from `web/dist`, with a not-found handler
  falling through to `index.html` so React Router owns client-side routing
  (`index.ts:82`). The fallback excludes `/api` and `/share/`, which means
  `GET /share/:token` **must serve the app shell itself** — it is the only thing
  answering a recipient's URL. Returning JSON there was S-15. The fallback excludes `/api` and `/share/` (trailing slash, so the
  owner's `/share` page still reaches the SPA while public `/share/:token` URLs reach
  their own handler).

Auth is enforced per route *file* by `addHook('preHandler', requireAuth)`
(`routes/middleware.ts`), which resolves the session to a live user and sets
`req.userId`; handlers pass that to the store. Being in a file without the hook is what
makes a route public, so a route added to the wrong file is silently public — which is
why `isolation.test.ts` requests every registered route without a session and fails on
any that does not answer 401 and is not on its short allow-list. See **P1** and **P12**.

## Ingestion pipeline

Fire-and-forget; the browser polls `GET /api/source-files/:id/status`.

```
upload  →  write original, sha256 checksum (per-user de-duplication)
        →  rasterize            pdftoppm → PNG, 200 DPI
        →  ROUTE by page type ──┬─ native text ──▶ sidecar (exact boxes, no egress)
                                └─ scan / handwriting ──▶ multimodal model
        →  detectContinuation   per adjacent page pair → document boundaries
        →  extractFields        per logical document
        →  grounding            map each field to a box on its page
        →  store
```

### Hybrid routing

The sidecar's OCR is weakest exactly where this archive is hardest: handwritten Romanian
clinical notes. A model reads those far better, but costs more and needs the page image
sent off the host.

So the choice is per page, not per deployment, and keyed on what the sidecar reports:

| The sidecar says | What happens |
|---|---|
| `native_text` | Kept. Exact, free, local. The model is never called. |
| `mixed` | Kept. Part of it is exact text already. |
| `ocr` | Sent to the model. |
| nothing found | Sent to the model: handwriting OCR often returns nothing at all. |

The model can only improve a page, never lose one. If it fails, or answers with nothing
usable, the page keeps what the sidecar read and the failure is logged. Pages are sent one
at a time, which keeps load and rate limits predictable on a Pi.

Boxes from the model are its own estimate and less exact than the sidecar's. Those pages are
stored as `multimodal`, and the UI draws their highlight dashed with a "Read by AI ·
position approximate" label.

**Sending images is asked for twice.** Choosing `multimodal` or `hybrid` is one switch;
`SPINE_MULTIMODAL_ENABLED=true` is the other, and either alone is refused at startup (or
does nothing, for the second alone). Picking a parser therefore never turns image egress on
by implication. The startup log states the result plainly — `imageEgress: true` and a
warning naming the provider and endpoint — and each image sent is logged.

Which provider that is matters. Images go to whatever `SPINE_LLM_PROVIDER` is. The Anthropic
adapter has no EU-only processing commitment, so a deployment with a residency requirement
should not enable this on it; Vertex on the `eu` endpoint is the one that fits.

### Job state

Progress lives in an in-memory `Map` (`ingestion/pipeline.ts:11`) — the one piece of
state that does not survive a restart. `reconcileStalledJobs()` runs at startup and
fails over any row still `pending` or `processing`, since a fresh process cannot have a
job behind it.

### Grounding

Extraction returns a `source_snippet` per field; grounding locates it among the parser's
per-page elements and stores a **fractional** (0–1) bounding box, so overlays scale to
any rendered width. Exact substring match first, then LCS fuzzy match at 60% of the
needle length.

Boxes from the multimodal path are model-reported and less reliable than the sidecar's.
The UI should not imply equal precision.

## Data

### At rest

| What | Where | Backed up? |
|---|---|---|
| All metadata, fields, tags, users, share links, access log | `data/spine.db` (WAL) | **yes — required** |
| Original uploads, never modified | `data/originals/<user>/<year>/` | **yes — required** |
| Rasterized page PNGs | `data/pages/<source_file_id>/` | no — regenerable |
| Daily snapshots + originals mirror | `backups/` (`SPINE_BACKUP_DIR`) | it *is* the backup |

Originals become per-user paths so a filesystem mistake cannot cross users as easily as
a query mistake.

`DATA_DIR` is set explicitly by both systemd units. The in-code fallback resolves
relative to the process working directory and differs between modules, so set
`DATA_DIR` rather than relying on it.

### Schema

- `users` — id, email (unique, case-insensitive), argon2id hash, `auth_version`, created_at.
- `source_files` — one row per upload. `status`: `pending | processing | done | error`.
- `documents` — one *logical* document: a page range within a source file. The unit
  that gets shared.
- `pages` — one per rasterized page, with parser elements and the absolute `image_path`.
- `extracted_fields` — label/value per document, with page id and fractional bbox.
- `tags`, `document_tags` — many-to-many, **scoped per user**; a new user gets starter tags.
- `share_links`, `share_link_access_log`.
- `documents_fts` — FTS5 over `doc_type`, `provider`, `ai_summary`, `user_notes`, kept
  in sync by three triggers. The index is shared; search results are filtered by joining
  back to `documents.user_id`, so it leaks nothing.

There is **no migration runner**: `schema.sql` is idempotent `CREATE TABLE IF NOT
EXISTS`, re-applied every boot. That cannot add a column to a table that already exists,
so it only works while the database can be recreated.

It could be, because the archive held no records, so multi-user changed `schema.sql`
directly. A database from before it is **refused at startup** with a message saying how
many uploads and documents it holds and whether it is safe to delete.

**Once the archive holds real records, any schema change needs a runner first** —
ordered files in `store/sqlite/migrations/` plus a table recording which have run.
Registration, email verification and recovery links all need new columns or tables, so
build them before loading real documents or write the runner first.

### Share links

A 32-byte random token (`randomBytes(32).toString('base64url')`, 256 bits) plus a scope.
**The token is stored as `sha256(token)`** (`share-token.ts`): reading the database does
not yield usable links, and the raw value exists only in the creation response. Both
public routes hash what the recipient presented before looking it up.

Scopes:

| Scope | `scope_value` | Meaning |
|---|---|---|
| `all` | — | every document **of the link's owner** |
| `tag` | tag name | that owner's documents carrying the tag |
| `document_ids` | array of ids | exactly those, all owned by the link's owner |
| `document_ids` | | ids not owned by the creator must be rejected at creation |
| `date_range` | `{from, to}` | that owner's documents in range |

Expiry 1–30 days, default 7. Revocation is a soft flag checked on every read. Both
public routes append to `share_link_access_log` before returning anything, so a probed
token leaves a trace; `view_count` is bumped only by
`/api/share/:token/documents`, because that number means "the documents were read".

The share view is **text only** — no page images, so no image URL reaches a recipient.

## Egress: what leaves the host

Page images leave the host only on the multimodal path, which is the most sensitive egress
in the system and is off unless asked for twice (see Hybrid routing).

| Path | Payload | Destination |
|---|---|---|
| Continuation detection | ~500 chars from each of two adjacent pages | configured provider |
| Field extraction (text) | first ~6000 chars of a document's text | configured provider |
| Page reading (`multimodal`, `hybrid`) | **full page images**, one per scanned or blank page (all pages for `multimodal`) | configured provider |
| Parsing (sidecar adapter) | nothing — local | — |
| Account recovery | recipient address + single-use link. **Never document content** | configured mail provider |

Residency is a property of the endpoint. For Vertex, that means the `eu` multi-region
host and service-account credentials, never an API key — a known bug has API-key calls
ignore the configured location. See [docs/deployment-gcp.md](docs/deployment-gcp.md).

## Frontend

React + Vite + Tailwind, built to `web/dist`, served by Fastify. Routes: `/` (timeline),
`/upload`, `/review`, `/review/:id`, `/search`, `/share`, `/login`, `/share/:token`.
Multi-user adds registration and account management.

In dev, `npm run dev` runs Vite separately and proxies `/api`, `/share` and `/data` to
port 3000 (`web/vite.config.ts`).

`web/tsconfig.json` sets `noEmit: true` deliberately. Without it `tsc` writes `.js` next
to every `.tsx`, and Vite resolves `.js` *before* `.ts`, so stale output silently shadows
real sources.

## Current state vs. target

| Concern | Today | Still to do |
|---|---|---|
| Users | **done** — local accounts, argon2id; CLI or open signup with email verification | — |
| Isolation | **done** — `user_id` on eight tables, every statement filters, tested as a second user | — |
| Data access | **done** — all SQL inside `store/sqlite/` | — |
| Store | **done** — store interface, SQLite adapter | — |
| LLM | **done** — interface in `src/llm/`, Anthropic and Vertex adapters, config-driven | — |
| Parsing | **done** — parser interface; sidecar, multimodal and hybrid, routed per page | a live check of the sidecar's box scaling |
| Egress | text only by default; images only if `SPINE_PARSER` and `SPINE_MULTIMODAL_ENABLED` both say so | — |
| Mail | **done** — mailer interface, `none` and `brevo` | Brevo's DPA, to be confirmed |
| Migrations | none; empty database recreated | a runner, once the archive holds records |
| Account recovery | **done** — emailed link, or `reset-link` from the CLI | — |
| Hosting | Pi | host-agnostic; Pi is the reference deployment and the resource floor |

## Configuration

Everything environment-specific comes from the environment.

### Today

`DATA_DIR`, `SPINE_DB_PATH`, `PORT`, `SPINE_HOST`, `NODE_ENV`, `SESSION_SECRET`,
`SPINE_DOMAIN`, `INGESTION_URL`, `SPINE_BACKUP_DIR`, `SPINE_BACKUP_KEEP`, the
`SPINE_LLM_*` set, and `ANTHROPIC_API_KEY` for the Anthropic adapter. There is no shared
password variable any more.

`src/config.ts` validates `SESSION_SECRET` and `PORT`, and reads the store and LLM
sections, once at startup, exiting non-zero with every problem listed rather than falling
back (**P3**). `DATA_DIR` is resolved in one place (`resolveDataDir`): the variable if
set, otherwise `<repo>/data` wherever the process was started. It used to be resolved
separately in four modules with three different fallbacks.

### Target

Selecting an adapter and its parameters must never require a code change:

| Variable | Purpose |
|---|---|
| `SPINE_HOST` | interface Fastify binds. Defaults to `127.0.0.1`; only set it if a local reverse proxy is not what reaches it |
| `SPINE_BACKUP_DIR` | where snapshots and the originals mirror go. Default is beside `data/`, which does not survive losing the medium — point it at removable or network storage |
| `SPINE_BACKUP_KEEP` | database snapshots to retain, default 7 |
| `SPINE_STORE` | store adapter — `sqlite` (only one implemented) |
| `SPINE_DB_PATH` | adapter-specific location or DSN |
| `SPINE_LLM_PROVIDER` | `anthropic` \| `vertex` \| … |
| `SPINE_LLM_MODEL` | model ID, e.g. `claude-haiku-4-5-20251001`, `gemini-3.8-flash` |
| `SPINE_LLM_ENDPOINT` | explicit endpoint. For Vertex: the `eu` multi-region host |
| `SPINE_LLM_REGION` | provider region where there is one. Stated, never parsed out of the endpoint |
| `SPINE_LLM_MAX_TOKENS_*` | per-task output caps, currently hardcoded at 256 / 2048 |
| `SPINE_PARSER` | `sidecar` \| `multimodal` \| `hybrid` |
| `SPINE_MAILER` | `none` (default) \| `brevo` |
| `BREVO_API_KEY` | required for `brevo` |
| `SPINE_MAIL_SENDER` | From address and display name |
| `SPINE_REGISTRATION` | `operator` (default) \| `open`. `open` requires a mailer |
| `SPINE_MULTIMODAL_ENABLED` | **opt-in for page images leaving the host.** Default off. Required by `multimodal` and `hybrid` |
| `SPINE_LLM_MAX_TOKENS_PAGE` | output cap for reading one page image, default 4096 |
| `SPINE_LLM_PROJECT` | cloud project id, where the provider needs one |
| `GOOGLE_APPLICATION_CREDENTIALS` | Vertex only: path to the service-account JSON. ADC reads it; no credential handling in app code |
| provider credentials | per-adapter; a file path or ADC, never a committed key |

Three rules on top of "read it from env":

1. **Validate at startup, fail loudly.** An unknown provider, a missing model ID, or a
   credential that cannot authenticate must stop the process with a clear message, not
   surface later as a failed ingestion. This is **P3** — an unsafe or broken
   configuration must be unreachable, not merely discouraged.
2. **No silent fallbacks for anything with a compliance meaning.** An endpoint must
   never default to a global one, and the multimodal path must never enable itself by
   being implied. See **P8**.
3. **Provider and model are instance-wide, not per user.** One configured provider and
   model for the whole deployment. Users do not choose, which keeps egress to a single
   auditable destination and keeps the compliance surface one decision wide.
4. **Log the resolved configuration at startup** — provider, model, endpoint, and
   whether image egress is on — with secrets redacted. If residency has to be provable,
   it has to be observable: `journalctl -u spine-web | grep "llm provider"` answers what an
   instance is actually pointed at, without reading `.env` or inferring from code. One
   line, emitted by the composition root; adapters return what they resolved to rather
   than logging it themselves, which is the only reason `ChatLlm.resolved` exists.

## Migration path

Ordered so each step is independently shippable and nothing depends on a later step.

1. ~~**Close the open security gaps first.**~~ **Done.** S-1 (share scoping failed
   open), S-2 (no login rate limit), S-3 (fallback session secret), S-6/S-7 (broken tag
   scope and the vacuous test), plus S-10, S-12 (request-body keys interpolated into
   SQL) and S-13 (Fastify bound `0.0.0.0`) found while fixing them. Multi-user would
   have multiplied the cost of every one — a scoping bug that leaks your own archive to
   a doctor becomes a cross-user leak. Then S-4, S-5, S-8 and S-11, plus S-14 and S-15
   found alongside them. Nothing in [SECURITY.md](SECURITY.md) is open; S-9, S-16, S-17 and
   S-19 are accepted.
2. ~~**LLM interface + adapters.**~~ **Done.** `createChatLlm` / `getChatLlm` with a provider
   registry, zod validation of every response, retries inside the adapter, the resolved
   provider/model/endpoint logged once at startup, and residency handled as explicit
   configuration plus the API-key refusal (**M-8**) rather than a URL assertion. Vertex,
   EU residency and model-id-in-config are unblocked; what remains is choosing the model
   by evaluating real handwriting samples, which is now a config change.
3. ~~**Store interface.**~~ **Done.** `createStore` / `getStore` / `resetStore`, all SQL
   in repository adapters, every signature taking an acting user id so multi-user
   changed the queries and not the signatures. Fixtures build state *through* the
   interface, which is also how it was shown to be complete.
4. ~~**Multi-user core.**~~ **Done.** `users` table, argon2id, login by email, `user_id` on
   the eight tables, every statement owner-scoped, owner-aware search, per-user originals
   and tags, an ownership check when a share link is created, and isolation tests written
   before the filtering and shown to fail without it. Accounts come from the CLI. Because
   the archive was empty, `schema.sql` changed directly.
5. ~~**Open signup, mailer, recovery links.**~~ **Done.** The mailer interface (`none`,
   `brevo`), email verification, single-use links, `SPINE_REGISTRATION`, `delete-user`,
   and a change-password page. They needed new columns and a table, so they went in
   **before real records were loaded**; the next schema change needs the runner.
6. **Migration runner** — only once the archive holds real records. Not a gate: it was
   position 4 until it was noticed that an empty database needs none.
7. ~~**Parser interface + hybrid routing.**~~ **Done.** Three adapters, per-page routing,
   image egress behind two switches, and the page/box contract above. What remains is
   running it on a real scanned page and a real native-text PDF, which needs credentials and
   a working sidecar.

## Decisions and remaining checks

No open design questions. Settled, recorded so they are not reopened by accident:

- **EU data residency is required** — Vertex AI, `eu` multi-region, service account.
  API-key providers are not available to this deployment.
- Provider and model are **instance-wide**, not per user.
- Registration is **open on this instance**, with mandatory email verification. The
  software default is `operator`, so a fresh install boots without a mailer.
- Links carry their token in the URL fragment, and are spent by a `POST`.
- The store has **one adapter** (SQLite) by intent; the interface exists for portability, not
  because a second is planned.
- Recovery works **without a mailer** via an operator CLI; `none` is only valid with
  registration closed.

Operational items to confirm during development, none blocking design:

- A rotation cadence for the Vertex service-account key.
- Which model to run — `gemini-3.8-flash` or `claude-sonnet-5` — decided by evaluating
  50–100 real Romanian handwriting samples, not by reading benchmarks.
- The five unverified facts in
  [docs/deployment-gcp.md](docs/deployment-gcp.md#open-items): prices, Claude 5.5 EU
  availability, Drive's storage region, folder-pick under `drive.file`, and whether
  `aiplatform.endpoints.predict` alone suffices.

## Build, deploy, testing

`install.sh` is the deployment story: `-d` system packages (Node LTS v22/24/26,
Python 3, poppler-utils, tesseract), `-b` builds web and server then the Python venv,
`-s` templates the systemd units and starts them — `spine-web`, `spine-ingestion` and
the `spine-backup` timer — and `-n` Let's Encrypt plus the site config. `-s` refuses to
proceed if `.env` carries a missing, short or placeholder secret.

`better-sqlite3` ships N-API prebuilds including `linux-arm64`, so there is no
compilation step on the Pi.

### Host requirement for the sidecar

The sidecar adapter needs **Python 3.11 or 3.12** on the host (`unstructured==0.15.0`
requires `>=3.9,<3.13`). `install.sh -b` builds the venv from whatever `python3`
resolves to, and a venv inherits its creating interpreter's version — so on a 3.13+ host
the install fails until a supported interpreter is present. That is host provisioning,
not an application concern; Raspberry Pi OS bookworm ships 3.11.

Worth noting only because it is another reason the parser interface exists: a host that
cannot satisfy this can run the multimodal adapter instead.

325 tests, in-memory SQLite. `SPINE_DB_PATH=:memory:` is set in `vitest.config.ts`
rather than in test files: `db/index.ts` captures the path at module load and ESM hoists
imports above any top-level assignment, so a test that sets it itself writes to the real
`data/spine.db`.

Three modules are mocked because testing them needs a live sidecar or real PDFs:
`ingestion-client.ts`, `rasterize.ts`, and the HTML entry-point half of
`public-share.ts`. The adapters' `invoke` paths are uncovered for the same reason — they
need live credentials. The interface is tested through fake task clients — real `Runnable`s
built from a function with `RunnableLambda.from` — rather than a mocked vendor SDK, so
the tests describe what Spine does with a model's answer and do not change when the
provider does. The adapters' own configuration refusals are covered.

The test harness registers the same plugins as `index.ts`, including
`@fastify/rate-limit` and `trustProxy`, because a control is untested unless the test
drives it the way production does (**P10**). The login limits are constructor options on
`authRoutes` so a test can set a small max and assert the 429, rather than mocking the
limiter out.
