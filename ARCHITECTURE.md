# Architecture

Spine is a self-hosted, multi-user medical document archive. It ingests PDFs and scans,
uses an LLM to split them into logical documents and extract structured fields, and
issues scoped, expiring links so a doctor can read a subset without an account.

It must run on hardware as small as a Raspberry Pi, and must not be tied to any single
LLM vendor.

Everything described here is built, except what [Not done yet](#not-done-yet) lists. For
the security posture this is expected to hold, see [SECURITY.md](SECURITY.md). For the
Vertex AI provider specifically, see [docs/deployment-gcp.md](docs/deployment-gcp.md).

## Design goals

1. **Multi-user, with real isolation.** Users of the same instance are separate
   adversaries. One user must never be able to read another's records, by any route.
2. **Runs on a Raspberry Pi.** The Pi is the **floor**, not the target: nothing may
   require more than a Pi, and nothing should be capped by one.
3. **Provider-agnostic inference.** Any LLM — Claude, Gemini, others — behind one
   interface. Model IDs and endpoints are configuration, never code.
4. **Self-hosted, operator-owned.** Each deployment is its own data controller. The
   software must be safe *by default*, because operators will not be security experts.
5. **EU data residency for this deployment.** Inference is processed inside the EU, which
   fixes the provider to Vertex AI on the `eu` multi-region with a service account. That
   is a requirement of this instance, not of the software, hence a configurable adapter.
6. **Code to interfaces.** Storage, inference, parsing and mail are interfaces with
   swappable adapters, so a Pi deployment and a larger one differ by configuration, not by
   branch.

The operator of an instance is its data controller and owns the risk; the author is not a
processor for anyone else's medical data. Unsafe configurations must be unreachable rather
than documented against — see [SECURITY.md](SECURITY.md) **P3**.

## Deployment model

The application assumes nothing about where it runs, what database backs it or which
model serves inference. Everything environment-specific sits behind an adapter, so a
deployment is a *configuration*, not a build.

The author's instance is a Raspberry Pi with the SQLite adapter, the local parser sidecar
and a hosted model provider. That is one configuration among several, and the one that
sets the lower bound on resource use. GCP appears only as an **inference adapter**
(Vertex AI, EU multi-region), not as a host.

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
                           │                   │ proxy_pass               │
                           │                   ▼  127.0.0.1:3000          │
                           │   ┌────────────────────────────────────┐     │
                           │   │ Fastify                            │     │
                           │   │  HTTP routes (requireAuth)         │     │
                           │   │  ─────────────────────────────     │     │
                           │   │  interfaces:                       │     │
                           │   │  Store | LLM | Parser | Mailer     │     │
                           │   └───┬──────┬───────┬────────┬────────┘     │
                           │       ▼      │       ▼        │              │
                           │  ┌─────────┐ │  ┌──────────┐  │              │
                           │  │ SQLite  │ │  │ sidecar  │  │              │
                           │  │ + data/ │ │  │ :8000    │  │              │
                           │  └─────────┘ │  └──────────┘  │              │
                           └──────────────┼────────────────┼──────────────┘
                                          ▼                ▼
                              Anthropic | Vertex AI (eu)   Brevo (mail)
```

### Trust boundaries

Five. The third arrives with multi-user and is the one a routine change can break
without anything failing.

1. **Internet → nginx.** All inbound traffic is untrusted. nginx terminates TLS and is
   the only publicly bound listener.
2. **nginx → Fastify.** Fastify trusts `X-Forwarded-*` (`trustProxy: true`), so it must
   never be directly reachable — otherwise those headers are attacker-controlled. It
   binds `127.0.0.1` unless `SPINE_HOST` overrides it (`config.ts`).
3. **User A ↔ User B.** Two authenticated users of the same instance. Neither may read,
   modify, or enumerate the other's source files, documents, pages, fields, tags or
   share links. **Enforced in the store layer, not in route handlers** — see
   [Multi-user model](#multi-user-model).
4. **Authenticated user vs. share-token reader.** A token grants read-only access to a
   subset of *one* user's documents and nothing else.
5. **Host → third parties.** The only egress: the inference provider, and the mail
   provider for account links. See [Egress](#egress-what-leaves-the-host).

The parser sidecar sits inside the innermost boundary: loopback-bound, no
authentication, and it accepts a filesystem path which it reads directly. Anything that
can reach it can read any file the service user can. It must never be exposed.

## Interfaces and adapters

Four of them: store, LLM, parser, mailer. Each is an interface the application defines;
which implementation runs is chosen by configuration at startup.

### Naming

```ts
// Construction. Pure: validates its config, returns a new adapter, no global state.
createChatLlm(config: ChatLlmConfig): ChatLlm
createStore(config: StoreConfig): Store
createParser(config: ParserConfig): Parser
createMailer(config: MailerConfig): Mailer

// Access. Reads config on first use, memoizes.
getChatLlm(): ChatLlm
getStore(): Store
getParser(): Parser
getMailer(): Mailer

resetStore(): void    // tests only
```

`create*` is unit-testable with a config literal; `get*` reads config on first use.
Reading config inside `get*` rather than at module load means nothing depends on an
environment variable being set before a module is first imported. Both are synchronous and
there is no `init` step: `index.ts` calls `get*()` once at startup, so a bad provider stops
the process there (**P3**) rather than at the first upload.

### Dispatch is a registry, not a switch

```ts
const CHAT_LLM_ADAPTERS = {
  anthropic: createAnthropicChatLlm,
  vertex:    createVertexChatLlm,
} satisfies Record<string, ChatLlmFactory>;

export function createChatLlm(config: ChatLlmConfig): ChatLlm {
  const factory = CHAT_LLM_ADAPTERS[config.provider];
  if (!factory) throw new ConfigError(
    `unknown SPINE_LLM_PROVIDER "${config.provider}"; expected one of ${Object.keys(CHAT_LLM_ADAPTERS).join(', ')}`,
  );
  return factory(config);
}
```

Adding a provider is a map entry plus an adapter file. An unknown provider fails at
startup with the valid set named.

### Layout

```
src/config.ts              parse + validate env once, export typed config
src/llm/                   types.ts, tasks.ts, prompts.ts, chat-llm.ts, index.ts (registry),
                           adapters/{anthropic,vertex}.ts
src/store/                 types.ts (interfaces), index.ts (registry),
                           sqlite/ — the only adapter; all SQL lives here
src/parser/                types.ts (the contract), index.ts (registry), ocr.ts,
                           adapters/{sidecar,multimodal,hybrid}.ts
src/mail/                  types.ts, index.ts (registry), adapters/{none,brevo}.ts
```

Two import rules, both review failures if broken. Nothing outside `store/sqlite/` imports
`better-sqlite3` or writes SQL. Nothing above `llm/adapters/` imports a **provider**
package (`ChatAnthropic`, `ChatVertexAI`). `@langchain/core` is allowed above that line:
an adapter returns one of its `Runnable`s per task, so it is the seam type, not a provider
SDK.

### Store interface

Repository interfaces — `UserRepository`, `SourceFileRepository`, `PageRepository`,
`DocumentRepository`, `ExtractedFieldRepository`, `TagRepository`, `ShareLinkRepository`,
`MaintenanceRepository`. No SQL leaves the adapter and no handler holds a database handle:
there are no `.prepare()` calls outside `store/sqlite/`. Two properties pay for it:
isolation becomes structural, because handlers cannot write queries; and a second adapter
is additive.

`createStore(config)` returns a `Store` holding the repositories, not a connection:

```ts
export interface Store {
  users:       UserRepository;
  sourceFiles: SourceFileRepository;
  pages:       PageRepository;
  documents:   DocumentRepository;
  fields:      ExtractedFieldRepository;
  tags:        TagRepository;
  shareLinks:  ShareLinkRepository;
  maintenance: MaintenanceRepository;

  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

- **Every method returns a `Promise`, though the only adapter is synchronous.** A
  networked store is async, and a sync interface would weld it to `better-sqlite3`.
- **`transaction` takes a `Store`, not a connection**, so repository code is identical
  inside and outside one. Ingestion writes a document, its tags and its fields together;
  a partial write leaves a document with no fields and no error. It uses explicit
  `BEGIN`/`COMMIT` (`db.transaction()` throws on a callback returning a promise) and
  `SAVEPOINT` for nesting. The connection is shared, so a statement issued elsewhere while
  the callback awaits lands inside the transaction. That is acceptable while ingestion is
  the only multi-statement writer, and is why the callback should use only its `tx`.
- **Every method takes the acting user's id** as its first parameter, so the signature
  forces the caller to have resolved identity:

```ts
interface DocumentRepository {
  listFor(userId: string, filter: DocumentFilter): Promise<Document[]>;
  findFor(userId: string, id: string): Promise<Document | null>;
  listForShare(link: ResolvedShareLink): Promise<Document[]>;   // one of four exceptions
}
```

There is no `find(id)` without a user. **Four exceptions**, enumerated in `store/types.ts`
so a fifth has to be argued for: share-token resolution and `listForShare` (scoped by the
link's owner, resolved from the token); `logAccess` (**P7** — the reader is
unauthenticated by definition); `maintenance.*` (boot-time work: stalled jobs, the S-4
rewrite, `snapshotTo`); and `users.*` (the identity layer — login must find a user before
there is an acting user).

What a method does with a record the caller does not own:

- a read returns nothing, indistinguishable from "not found";
- an update or delete changes nothing;
- a create that names such a record throws and inserts nothing, since dropping a create
  silently would lose data;
- a call with no acting user at all throws, rather than matching nothing quietly.

Routes check first and answer 404, never 403. `__tests__/isolation.test.ts` exercises all
of it as a second user.

Only the SQLite adapter exists, by intent: the interface is for portability, not because a
second is planned. SQLite is single-writer (WAL lets readers proceed during a write), which
is fine for a handful of family users and the first thing to revisit if concurrent
ingestion becomes common.

### LLM interface

One interface covering what Spine asks of a model:

- `detectContinuation(pageA, pageB)` — are these the same logical document?
- `extractFields(documentText)` — structured metadata.
- `readPage(image)` — the text on one page image, with boxes. The only call that sends an
  image off the host, so only the `multimodal` and `hybrid` parsers reach it.

Adapters: **Anthropic** (direct API) and **Vertex AI** (Gemini *and* Claude, EU
multi-region). Configuration carries the provider, model ID and endpoint; model IDs change
independently of the code (see [docs/deployment-gcp.md](docs/deployment-gcp.md) for
current models, prices and retirement dates). Which model to run is an evaluation on real
Romanian handwriting, not a design decision, and needs no code change.

**Vertex is a platform, not a model**, and what matters is which API serves the model:

| API | Models | Auth | EU residency |
|---|---|---|---|
| **Vertex AI**, standard endpoints | Gemini **and** Claude | service account (ADC); API keys are blocked | yes, via the `eu` endpoint |
| **Vertex AI Express** / **Gemini API** | Gemini only | API key | not the residency-bearing surface |
| **Anthropic API** | Claude only | API key | no EU-only processing commitment |

So a deployment that needs EU residency must use a service account on standard Vertex
endpoints. Claude on Vertex cannot use an API key at all (`rawPredict` does not support
one), and an API key present in the environment silently reroutes Google clients to a
global host (**M-8** has the mechanism). **This deployment requires EU residency**; the
interface still spans the other routes because another operator's instance may not.

#### How the model is used

Independent, stateless, single-turn prompts. No chaining, no agent loop, no tool use, no
multi-turn state: any chat-completion API can back the interface, whereas tool-use and
conversation formats differ across vendors.

| Call | Input | Output | `max_tokens` |
|---|---|---|---|
| `detectContinuation(prev, curr)` | the whole text of page N-1 and page N | `{is_continuation, confidence, reasoning}` | 256 |
| `extractFields(text)` | the whole document, each page under a `--- page N ---` marker | title, date, provider, type, summary, tags, `doctors[]`, `fields[]`, `measurements[]` | 4096 |
| `readPage(image)` | one page image | `regions[]`: text + a box as fractions of the page | 4096 |

```
parse → [continuation × (N-1)] → group into documents → [extract × M] → ground locally
```

A 10-page upload with 3 documents is 9 continuation calls and 3 extraction calls, plus a
`readPage` per page the model has to read. Grounding is not a model call.

#### What is extracted for each type

The model decides the document's type, then follows that type's guide (`llm/doc-types.ts`, the one
definition used by the prompt and the review form): labs get a measurement per analyte with unit and
reference range; prescriptions get repeating groups of drug, dose, frequency and duration; vaccinations
a group per vaccine; imaging its modality, findings and impression; discharge notes and consultations
their diagnoses, plan and follow-up, with vitals as measurements; and every type names its doctors.
A clinic's "raport medical" is a consultation whose sections are free text: services performed
(one `service` field each, with its result as an `investigations` field), history split into
family, personal, habits and current treatment, symptoms and examination, the diagnosis with
its ICD code (`diagnosis`, `diagnosis_code`, and `diagnosis_uncoded` for what the report left
uncoded), and recommendations split into tests, lifestyle advice and medication. Lab values and
hormone levels quoted in that text become measurements, each with the date it was taken, which
is often earlier than the visit; a date printed as a month ("03.2026") is kept as the month
(`YYYY-MM`) and charted at its start, shown as "month only". The patient's national ID number,
patient code and age are never extracted.

A lab bulletin is dated by when the sample was collected, not issued or released, since that is
the date a trend should use. Its reference range is the one beside the result; the ranges listed
for other groups (by sex, age, pregnancy) are ignored, and a bound printed as `<0.5` or `≤ 5.8`
is the upper bound alone. A page numbered "1 / 1" after one numbered "3 / 3" starts a new
document, which is how one PDF holding two bulletins splits.

Signing doctors and their professional codes are usually printed in a stamp image, which has no
text, so they are missing from a reading of the page text. Reading that page with AI (an image
read) can pick them up; otherwise they are entered by hand.

The answer is validated leniently (a missing list means none; a reference range read as `"12"` is
fine) and normalised on our side: decimal commas, a flag worked out from the value and range, the
document's date where a row has none. A reading with no doctors or measurements is still a reading.

#### Limits and concurrency

The only cap on the text in a request is the model's context window, `SPINE_LLM_CONTEXT_CHARS` (default 300,000 characters): nothing is shortened to save money or to send less. A document over it is split into chunks at page boundaries (details from the first chunk, tags and fields gathered from all; if any chunk fails the document counts as failed). Pages are labelled with their real numbers so a field lands on the right page, including for documents that start after page 1. Because the whole text now goes to the provider, more document text leaves the host than before (see the egress table).

Reading pages, checking page pairs and extracting documents are independent, so they run in parallel, at most `SPINE_LLM_CONCURRENCY` at once (default 4). Only the waiting is parallel: every database write stays sequential, and nothing is written until the model calls for that step have succeeded.

#### How it is built

LangChain.js supplies the provider implementations (`@langchain/anthropic`,
`@langchain/google-vertexai`) and the shared `Runnable` type; zod validates. An adapter is
given the task definitions (`llm/tasks.ts`: output budget and schema, both fixed at
startup) and returns one bound client per task. Anthropic takes `maxTokens`, Google
`maxOutputTokens`, both at construction; that naming difference is the only reason the
adapter layer exists.

- **`withStructuredOutput` is an optimisation, not the validation.** Adapters bind the
  schema to each client; the interface validates every response with zod, so a provider
  that ignores the schema cannot write an unchecked shape. A validation failure logs and
  degrades to a reviewable fallback rather than failing the upload.
- **Residency is configuration, not code inspection.** The Vertex adapter requires
  endpoint, region and project to be stated (nothing defaults to a global host) and
  refuses to construct if a Google API key is in the environment. It does not assert the
  shape of the outgoing URL: that would encode Google's URL scheme and say nothing about
  Azure or Bedrock. Verify residency against the provider's request logs on first
  deployment, which works for any provider.

### Parser interface

`parse({ sourceFileId, filePath, pages }) → pages with text and boxes`. `SPINE_PARSER`
picks the adapter:

- **`sidecar`** (default) — the local Unstructured service, run with its `fast` strategy:
  the PDF's own text layer with exact boxes. A page with no text layer comes back with no
  elements. Nothing leaves the host.
- **`multimodal`** — every page image goes to the configured LLM provider, which returns
  the text in blocks with a box each. A page the model cannot read fails the upload and
  names the page; there is nothing to fall back to.
- **`hybrid`** — text layer first, then local OCR, then the model, per page. See
  [Hybrid routing](#hybrid-routing).

The contract every adapter keeps, so nothing downstream has to guess:

- **One entry per page image, in order.** A blank page is an entry with no elements, not an
  absence, so the pipeline can pair text with images by page number.
- **`image_width`/`image_height` are the image's pixel size and every box is in that
  space.** Unstructured reports native-text boxes in PDF points (72 per inch) while the
  page PNG is 200 DPI, so the sidecar adapter scales its boxes into the image's pixels.

> **Not verified against a live sidecar.** The scaling follows from reading the code and the
> library's coordinate model, not from a measurement. Check one native-text PDF
> against a real highlight on first deploy. Likewise no real page has been sent to a real
> model provider; the image message was checked against both providers' request builders only.

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

**Local accounts only.** Email plus a password hashed with argon2id (12–256 characters,
19 MiB / 2 passes / 1 lane). No external identity provider: an instance must work with no
internet reachability beyond its chosen inference provider. Sessions are server-side
cookies holding a user id and that user's `auth_version`; every request re-resolves them
against the database, so a changed password ends other sessions on the next request. Login
issues a new session id, and an unknown email is indistinguishable from a wrong password in
both answer and time.

**Second factor (optional, per user):** TOTP, so it too needs no external service. After a
user enrols from the account page, the right password only starts a *pending* login (held
in the session for five minutes), and a valid code or a recovery code completes it. Reset
links do not bypass it. Details and residual risks: SECURITY.md **M-12**, **S-20**,
**S-21**, **S-22**.

Accounts come from the operator (`npm run cli -- create-user <email>`; also `set-password`,
`reset-link`, `disable-2fa`, `delete-user`, `list-users`) or, if enabled, from open signup.

### Registration

`SPINE_REGISTRATION` is `operator` (default; accounts come from the CLI) or `open`. `open`
requires a mailer and refuses to start without one (**P3**); this instance runs `open` with
Brevo, and a fresh install defaults to `operator` so it boots with no mailer.

Signing up creates an **unverified** account with no session until the emailed link is
used; the right password before that answers 403 with a code the page uses to offer a new
link. Signup is rate limited per source and per address (**P5**), and an existing address
gets the same answer as a new one and is left unchanged. The links, their handling and the
throttles are in SECURITY.md **M-6** and **M-11**.

### Account recovery

Two paths, because a self-hosted instance may have no mail provider:

- **Mailer configured** — `POST /api/auth/forgot`, then a one-hour link to a page that
  sets a new password. Same answer whether or not the address exists.
- **No mailer** — `npm run cli -- reset-link <email>` prints the same kind of one-time
  link for the operator to hand over. `set-password` is the blunter alternative.

Either way the link is a single-use capability (SECURITY.md **M-11**). Using it sets the
password, which ends the user's sessions (**P13**), and confirms the address, since
receiving the link proves the mailbox. A too-short new password is refused *before* the
link is spent.

### Ownership and isolation

Every row of user data belongs to exactly one user: the eight data tables (`source_files`,
`pages`, `documents`, `extracted_fields`, `tags`, `document_tags`, `share_links`,
`share_link_access_log`) and the three identity tables (`user_tokens`, `user_totp`,
`user_recovery_codes`) carry a `user_id`. Originals are stored under
`data/originals/<user>/<year>/`. Tags are **per-user**: a shared vocabulary would leak the
existence of other users' categories and let one user's rename affect another's records.

> Every read and write is scoped by owner at the store layer. A repository method that
> does not take an acting user id, or that can return a row the acting user does not
> own, is a defect.

Share-token reads are the deliberate exception to scoping by session: they are scoped by
the *link's* owner and scope, resolved from the token. Every branch of a share query still
filters by that owner, so a link can never return another user's document.

### Roles

None. Every user is an equal owner of their own records, and no application path reads
another user's documents. An operator with shell access can read the database, which is
inherent to self-hosting. Instance setup (first account, provider) is configuration and
CLI, not an in-app superuser.

## Request flow

```
Browser → nginx (TLS) → Fastify :3000 → route → store interface → SQLite
```

Fastify serves two kinds of traffic from one process:

- **`/api/*`** — JSON. All of it requires a session except login (both steps),
  registration, recovery, and `/api/share/:token/documents`.
- **everything else** — the built React app from `web/dist`, with a not-found handler
  falling through to `index.html` so React Router owns client-side routing. The fallback
  excludes `/api` and `/share/` (trailing slash, so the owner's `/share` page still reaches
  the SPA while public `/share/:token` URLs reach their own handler). That means
  `GET /share/:token` **must serve the app shell itself**; returning JSON there was S-15.

Auth is enforced per route *file* by `addHook('preHandler', requireAuth)`
(`routes/middleware.ts`), which resolves the session to a live user and sets `req.userId`;
handlers pass that to the store. Being in a file without the hook is what makes a route
public, so a route added to the wrong file is silently public — which is why
`isolation.test.ts` requests every registered route without a session and fails on any
that does not answer 401 and is not on its short allow-list (**P1**, **P12**).

## Ingestion pipeline

Fire-and-forget; the browser polls `GET /api/source-files/:id/status`.

```
upload  →  write original, sha256 checksum (per-user de-duplication)
        →  rasterize            pdftoppm → PNG, 200 DPI
        →  parse                parser interface; with `hybrid`, per page:
                                text layer → local OCR → model
        →  detectContinuation   per adjacent page pair → document boundaries
        →  extractFields        per logical document
        →  grounding            map each field to a box on its page
        →  store
```

### Hybrid routing

The aim is to spend as little as possible — money, time and privacy — on pages a model
does not need to read. Most documents are digital PDFs, so the order is cheapest first, and
each step only sees the pages the one before could not settle:

| Step | Signal | What happens |
|---|---|---|
| 1 | The page has a **text layer**: the sidecar returned at least `SPINE_TEXT_LAYER_MIN_CHARS` (default 50) non-whitespace characters for it | Use it, with the sidecar's exact boxes. Nothing else runs. |
| 2 | **Local OCR is confident** (Tesseract, run on the page image) | Keep it. Boxes are exact and in the image's own pixels. Nothing leaves. |
| 3 | Otherwise | The model reads the page. |

Step 2 uses Tesseract's own word confidence: the page is kept if the mean is at least
`SPINE_OCR_MIN_CONFIDENCE` (default 85) and no more than `SPINE_OCR_MAX_LOW_SHARE`
(default 0.10) of its words are under 60. **No words at all fails it too**, which is what a
blank page and a badly tilted one both look like. Rough measurements (English pack,
handwriting approximated with cursive fonts, so a guide and not a result):

| Page | Words | Mean | Under 60 | Route |
|---|---|---|---|---|
| Clean print | 64 | 93 | 0% | local |
| Print tilted 3° | 64 | 87 | 6% | local — every word was right |
| Print tilted 8° | **0** | — | — | model |
| Cursive fonts | 64 | 76–81 | 11–23% | model |

Past about 8° of tilt Tesseract finds nothing and nothing in this path deskews, so a tilted
scan goes to the model. The thresholds are first guesses and need tuning on real pages;
every page logs one structured `page routed` line (route, words, mean confidence, weak
share, and why) for that.

**No LLM screens first.** Looking at the image is the same egress as reading it, and a
screening call is a second round trip, so it would cost the privacy of reading and add
cost for every page that then needs reading anyway.

**The sidecar is the one source for "does this page have text".** It runs Unstructured
with `strategy="fast"` and nothing else: the PDF's own text layer, no OCR, no layout model.
(`auto` is one decision for the whole file, not per page, so a typed PDF with one scanned
page would have returned that page empty.) A page it returns text for has a text layer; a
page it returns nothing for does not. The character count, rather than "any element", keeps
a scan whose only text is a stray page number from counting as having one. The sidecar is
called once per file, always. If it is down, **the upload fails** rather than treating every
page as scanned, which would push digital PDFs through OCR and the model because of an
outage.

The model can only improve a page, never lose one. If it fails or answers with nothing
usable, the page keeps what local OCR read (or comes back empty if that failed too) and the
failure is logged. Pages are read in parallel, up to `SPINE_LLM_CONCURRENCY` (default 4), one image per call; local OCR stays one page at a time. This keeps load and rate limits predictable on
a Pi. Boxes from the model are its own estimate and less exact than OCR's, so those pages
are stored as `multimodal` and the UI draws their highlight dashed with a "Read by AI ·
position approximate" label.

**Needs Tesseract and its language packs.** `hybrid` refuses to start without them
(`SPINE_OCR_LANGS`, default `ron+eng`). A missing pack does not fail; it only reads
diacritics worse, which scores lower and sends more pages to the model — cost and egress
with nothing to say why.

**Sending images is asked for twice**: `multimodal` or `hybrid` is one switch and
`SPINE_MULTIMODAL_ENABLED=true` the other; either alone does nothing or is refused at
startup (SECURITY.md **M-7**). Images go to whatever `SPINE_LLM_PROVIDER` is, so a
deployment with a residency requirement should use Vertex at an `eu` endpoint.

### Reading a page with AI

A misreading is a property of a page (handwriting, a tilt, a table the OCR scrambled), so that is
what can be read again with the model, not a document. It is offered on the **document page**, where
the scan, the extracted fields and their highlights already are: a **Scan | Text** switch shows either
the page image or the text the app read from it at a readable size, with how it was read (text layer,
OCR or AI) and "Read this page with AI" beside it. A page with no text says so and, if the server may
use the model, how to have it read. The grouping screen's thumbnails mark the pages that were not read
from a text layer, and its large preview is only a viewer with a link to the page's document
(`/documents/:id?page=N`).

When a page has no text at all, nothing needs doing in `hybrid` with image reading allowed: it goes to
the model at upload. The button is for a page that was read, but badly, which the routing cannot see; in
`sidecar` mode, or when the model failed, an empty page stays empty until it is used.

- Only the chosen page's image is sent, through the same model parser and operator switch as every
  other route that sends an image. The API takes up to 200 pages a request (for a future multi-select);
  the app asks for one. One reading per upload at a time.
- Every page is read before anything is written, so a page the model cannot read leaves the upload
  exactly as it was. Their text, boxes and `multimodal` source are then written together.
- Only the documents that contain a page that was read are extracted again (once each, however many
  of their pages changed), from their pages' text. That replaces title, date, provider, type,
  summary, tags and fields, keeps the owner's notes, and puts the document back in review. If
  extracting a document fails, its page text is already updated and its details stay as they were; the
  result says so and "Extract details again" retries.
- It runs as a background job the browser polls (progress by page, then by document). The confirmation
  states how many images go where, how many documents will be extracted again, and, if some are already
  reviewed, that their edits will be replaced.
- **Extract details again** is the document-level action, and the cheap one: the same extraction on
  the text already there, no image, so it needs no switch.

The whole-file button below lives on each upload in the Upload history.

### Reading a file again with AI

The cascade cannot see everything: a scan whose scanner app embedded its own poor OCR layer
passes step 1, and handwriting added to a typed form has a text layer for the typed part.
For those, a finished upload has a **"Read this file with AI"** button on the review screen.

- It re-runs the upload with the `multimodal` parser, so **every page** goes to the model.
- It needs `SPINE_MULTIMODAL_ENABLED` too, and the button is not shown without it.
- It asks first, names the provider and endpoint, and says what it replaces: the documents
  made from the file, including edits to them and any share link that names them. The
  original file is not touched.
- The old documents are removed **after the new reading has succeeded**, so a failed
  reading leaves them alone. A failure later, in boundary detection or field extraction,
  can happen after they are gone; the file is still there to read again.

It is a per-document decision made after seeing that a document needs it, in place of an
upload-time checkbox that would ask on every upload and could not be undone (re-uploading
the same file is refused as a duplicate).

### The document page

One page per document, `/documents/:id`, in two modes. **Reading** is what a tile on the
timeline opens: the extracted details and fields beside the scans. **Review** turns the same
page into an editor: title, date, type, provider, tags, summary, notes, the doctors, the
measurements (test, value, unit, reference range, date) and every extracted field (change,
remove, add). Fields that share a group number are shown together in reading mode, and the
label box suggests what this type of document usually holds. The doctors box suggests names
already in the directory, so someone met before is chosen, not spelled a second way. **Done** saves it all, marks the document reviewed and returns
to reading; Review again edits again; Discard changes drops the edits. A document opened from
the review queue starts in edit mode (`?edit=1`), anywhere else in reading mode. Old
`/review/:id` links redirect.

An edit session is one `PATCH /api/documents/:id`, carrying the details, the tags, the field
changes (`fields: { update, remove, add }`), the measurement changes (the same shape), the
document's doctors (the list sent replaces the current one) and `reviewed`. The flag on a
measurement is worked out again from its value and range on every save. Everything is validated first and
written in one transaction, so a bad field cannot leave the rest half applied:

- text has length limits, a date must be a real day, a type one the app knows; empty text
  clears a detail;
- a field to change or remove must be on *this* document, and a new field must be on one of its
  pages, otherwise the whole request is refused (400) and nothing changes;
- a corrected field keeps where it was read from; a field the owner adds has no source box.

Reading the file again with AI is not offered while editing, since it replaces the document and
would discard the edits.

### Trends and doctors

**Trends** (`/trends`) lists every test with its latest value and flag. A test opens as a line
chart over time (`/trends?name=…`): the printed reference range of the newest value as a band,
each point coloured low/high/in range and linking to its document, and a table of every value
beside it so the chart is never the only way to read them. It is drawn as SVG by hand: one
shape, no chart library on a Pi. A line only joins values that can be compared (a unit written two ways, "mUI/mL" and "mIU/mL", "µg" and "ug", is one unit); a consultation that quotes a lab's value gives the same test, day and value twice, so it is drawn once, from the report that has a reference range, and the other stays listed, so the series
uses the unit most of its values have; a value in another unit (13.5 g/dL against 135 g/L), one
that is not a number (`<0.5`, `pozitiv`) or one with no date is listed but not drawn. Tests are
grouped by a canonical name, and three things keep one test under one name across labs. The model
is told the names already in the archive and asked to reuse one when a measurement is the same test
("Hb" and "Hemoglobina" both become `hemoglobin`). Where it still names a test two ways, the owner
merges them on the test's page ("Same test under another name?"): the values move to the chosen
name and the old name is remembered, so later documents land there too; there is no automatic
merging, since two tests with similar names, units and ranges can still be different tests. A merge
is undone by editing the values, not by a button. Renaming a measurement in the review form gives it
a new name unless that name was merged, in which case it joins the merged test.

**Doctors** (`/doctors`) is the directory the readings build: each doctor with specialty,
clinic, how many documents name them and when last. A doctor opens to their documents and role
on each; the owner can rename, fill in a specialty or clinic, merge another entry into this one
(two spellings of one person), or delete an entry no document names. A name that already
belongs to another doctor is refused rather than silently merged.

### Regrouping an upload

Boundary detection will sometimes be wrong, most of all in a long scan holding many
documents. Every upload stays in the Upload page's history, named by the documents it
became, and opens a **Pages and grouping** screen: the upload's pages as thumbnails,
grouped into documents on a spine, with a split control between any two pages of a
document and a join control between two documents.

- A split shortens the document and makes a new one for the rest of its pages; extracted
  fields move with the page they were read from, and the new document starts with the
  first one's tags, type, provider and date until it is read.
- A join is only with the document directly after, in the same upload; anything else is
  refused, since it would leave a page range that skips pages or runs backwards.
- Either way the documents it touched are **read again** (`extractFields` on their own
  pages' text, the same payload as at upload) and go back to review. The owner's notes
  are kept. The new grouping is saved first and stands even if reading fails, in which
  case the previous reading is kept rather than overwritten with "extraction failed".
- Clicking a thumbnail opens a large preview of that page and nothing else: arrow keys or
  buttons step through every page of the upload, tapping toggles zoom, Escape closes. It is
  deliberately view-only. Editing a document's details, its fields and re-reading it
  belong to the review screen, which is the separate and more capable place.
- Whatever this screen changes lands in the review queue, since the queue is simply the
  unreviewed documents: new documents from an upload, and any document a split or join
  touched, are unreviewed, even if they were reviewed before.
- Thumbnails are the full-size page images, loaded lazily. A 100-page upload is heavy on
  a phone connection; smaller thumbnails made at rasterize time are the obvious next step.

### Listing documents

`GET /api/documents` is paged: 50 by default, at most 500 per request, and a limit or offset
that is not a usable number falls back to the default instead of failing. The pages that show
an archive (timeline, review queue, search) fetch everything by paging in chunks, so none of
them stops at the first 50 documents.

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

Originals are per-user paths so a filesystem mistake cannot cross users as easily as a
query mistake. `DATA_DIR` is set explicitly by the systemd units; if unset it resolves in
one place (`resolveDataDir`) to `<repo>/data`.

### Schema

- `users` — id, email (unique, case-insensitive), argon2id hash, `auth_version`,
  `email_verified_at`, created_at.
- `user_tokens` — verification and reset links (hashed, single use).
- `user_totp` — one row per user who has started enrolling: the encrypted secret,
  `confirmed_at` (NULL until the first code is accepted; the factor only applies once it
  is set) and `last_step` (replay guard).
- `user_recovery_codes` — sha256 of each code, `used_at`.
- `source_files` — one row per upload. `status`: `pending | processing | done | error`.
- `documents` — one *logical* document: a page range within a source file. The unit that
  gets shared. `title` is the document's own printed title, or one extraction generated when
  it has none; the owner can edit it, and the UI names documents by it, never by the
  upload's file name (falling back to type and provider when it is empty).
- `pages` — one per rasterized page, with parser elements and the absolute `image_path`.
- `extracted_fields` — label/value per document, with page id and fractional bbox. Fields that
  belong together (one prescription line, one vaccine) share a `group_no`.
- `measurements` — numeric results (lab values, vitals): the name as printed and a `canonical`
  name that is the same across documents, the value as printed and as a number, unit, printed
  reference range, a low/high/normal flag, and the date taken. Trends are drawn from these.
- `measurement_aliases` — "this name means that test", written when two tests are merged (below), so a
  later document that uses the old name is filed under the new one. Per user; `canonical` is always a
  name that measurements use, and a chain of merges is flattened, never left pointing at a removed name.
- `doctors`, `document_doctors` — a per-user directory built as documents are read. A doctor's
  `key` is the name without titles, accents, case or word order, so "Dr. Popescu Ion" and "Ion
  Popescu" are one entry; initials are not guessed at, and two entries for one person are merged
  by hand. A document names its doctors with a role (author, prescriber, referrer, other).
  A doctor may also carry the professional code printed beside a signature (`license_code`,
  upper case without punctuation, unique per user). A reading looks the code up first, so one
  doctor spelled two ways joins one entry when both carry the code; a code only fills a blank
  and never replaces one. Signature stamps are usually pictures, so the model rarely sees the
  code in a scan's text: it is mostly entered by hand on the doctor's page.
- `tags`, `document_tags` — many-to-many, **scoped per user**; a new user gets starter tags.
- `share_links`, `share_link_access_log`.
- `documents_fts` — FTS5, one row per document: `title`, `doc_type`, `provider`, `ai_summary`,
  `user_notes`, and `body`, which holds the text of the document's pages, its extracted values, its
  measurements' names and its doctors' names. The view `document_search_source` says what one
  document contributes, and triggers on documents, pages, fields, measurements, doctor links and
  doctor names rebuild the rows a change touches, so no code path can change one of those and
  forget the index. Accents are folded ("lombara" finds "lombară"). The index is shared; search
  results are filtered by joining back to `documents.user_id`, and `body` is built only from that
  user's rows, so it leaks nothing.
  Typed text is never passed to the index as query syntax: each run of letters and digits becomes
  a quoted word that matches by its start, all words must match, and a hit in the title ranks
  above one deep in a page (`search-query.ts`).

There is **no migration runner**: `schema.sql` is idempotent `CREATE TABLE IF NOT EXISTS`,
re-applied every boot. That adds a new *table* to an existing database but cannot add a
*column* to an existing one. So a change to an existing table needs the runner (ordered
files in the placeholder `store/sqlite/migrations/` plus a table recording which have
run), or an empty database. Startup refuses a database from an older shape, saying how
many uploads and documents it holds and whether it is safe to delete. **Build the runner
before loading real records**; see [Not done yet](#not-done-yet).

### Share links

A 32-byte random token (`randomBytes(32).toString('base64url')`, 256 bits) plus a scope.
**The token is stored as `sha256(token)`** (`share-token.ts`): reading the database does
not yield usable links, and the raw value exists only in the creation response. Both public
routes hash what the recipient presented before looking it up.

| Scope | `scope_value` | Meaning |
|---|---|---|
| `all` | — | every document **of the link's owner** |
| `tag` | tag name | that owner's documents carrying the tag |
| `document_ids` | array of ids | exactly those; ids not owned by the creator are rejected at creation |
| `date_range` | `{from, to}` | that owner's documents in range |

Expiry 1–30 days, default 7. Revocation is a soft flag checked on every read. Both public
routes append to `share_link_access_log` before returning anything, so a probed token
leaves a trace; `view_count` is bumped only by `/api/share/:token/documents`, because that
number means "the documents were read". The share view is **text only** — no page images,
so no image URL reaches a recipient.

## Egress: what leaves the host

Page images are the most sensitive egress in the system and are off unless asked for twice
(see [Hybrid routing](#hybrid-routing)).

| Path | Payload | Destination |
|---|---|---|
| Continuation detection | the text of two adjacent pages | configured provider |
| Field extraction | the document's full text (split into chunks only if it would exceed the context window), **and the names of the tests already in this person's archive** (up to 300, within 5% of the context window; names only, never values, dates or documents) so one test is named one way | configured provider |
| Reading again after a split or join | the same, for each document the change touched | configured provider |
| Page reading (`hybrid`) | **full page images**, only for pages with no text layer that local OCR could not read | configured provider |
| Page reading ("Read the whole file with AI", `multimodal`) | **full page images**, every page of the file | configured provider |
| Page reading ("Read this page / these pages with AI") | **full page images**, only the pages chosen | configured provider |
| "Extract details again" | the document's page **text**, as at upload; no image | configured provider |
| Parsing (sidecar) | nothing — local | — |
| Verification and recovery mail | recipient address + single-use link. **Never document content** | configured mail provider |

Residency is a property of the endpoint. For Vertex that means the `eu` multi-region host
and service-account credentials, never an API key. See SECURITY.md **P8**, **M-8** and
[docs/deployment-gcp.md](docs/deployment-gcp.md).

### The mail path

Brevo is French (formerly Sendinblue), runs EU data centres and holds ISO 27001. **Confirm
that in their DPA before relying on it**: what is public is third-party summary, not
contractual terms. Mail is a lower bar than inference under **P8**: a recipient address and
a link, never health data, so the provider processes personal data only. Metadata still
leaks if a subject or sender names a medical system, so the subjects are "Confirm your
email address" and "Reset your password", a test fails on clinical wording or the product
name, and `SPINE_MAIL_SENDER` is required with no default so the operator picks a neutral
name. The links point at `SPINE_DOMAIN`, so a domain that says "medical" says it too.

## Frontend

React + Vite + Tailwind, built to `web/dist`, served by Fastify. Pages: timeline, upload,
review, search, share links, account (password and two-factor), login, register, verify,
forgot/reset, and the public `/share/:token` view. Every page works at phone width: below
the `md` breakpoint the navigation collapses into a menu and the review screen stacks the
fields above the page image. In dev, `npm run dev` runs Vite
separately and proxies `/api` and `/share` to port 3000 (`web/vite.config.ts`).

`web/tsconfig.json` sets `noEmit: true` deliberately. Without it `tsc` writes `.js` next to
every `.tsx`, and Vite resolves `.js` *before* `.ts`, so stale output silently shadows real
sources.

## Configuration

Everything environment-specific comes from the environment. [`.env.example`](.env.example)
lists the variables; this section holds the rules.

`src/config.ts` validates and reads the sections once at startup, exiting non-zero with
every problem listed rather than falling back (**P3**).

1. **Validate at startup, fail loudly.** An unknown provider, a missing model ID or a
   missing secret stops the process with a clear message, not a failed ingestion later.
2. **No silent fallbacks for anything with a compliance meaning.** An endpoint never
   defaults to a global one, and image egress never enables itself by being implied (**P8**).
3. **Provider and model are instance-wide, not per user.** One destination for inference
   keeps egress auditable and the compliance surface one decision wide.
4. **Log the resolved configuration at startup** — provider, model, endpoint, whether
   image egress is on — with secrets redacted. If residency has to be provable it has to be
   observable: `journalctl -u spine-web | grep "llm provider"` shows what an instance is
   pointed at without reading `.env`. One line, emitted by the composition root.

## Not done yet

Everything above is built. What is left, in the order it matters:

- **A migration runner**, before the first change to an existing table once the archive
  holds real records. Not a gate today: an empty database needs none.
- **Live checks nobody has run:** the sidecar's box scaling against a real native-text
  PDF; a real page sent to a real model provider; a real Brevo send; argon2id timing on the
  Pi; the OCR thresholds on real scans of handwriting.
- **Brevo's DPA**, to be confirmed by reading it.
- **Requiring two-factor** instance-wide (SECURITY.md **S-20**).
- **Choosing the model** on Vertex (`gemini-3.8-flash` or `claude-sonnet-5`) by running
  50–100 real Romanian handwriting samples through each, and a rotation cadence for the
  service-account key.
- The open facts in [docs/deployment-gcp.md](docs/deployment-gcp.md#open-items).

Settled, recorded so they are not reopened by accident:

- **EU data residency is required** here: Vertex AI, `eu` multi-region, service account.
- Registration is **open on this instance** with mandatory email verification; the software
  default is `operator`.
- Links carry their token in the URL fragment and are spent by a `POST`.
- Two-factor is **TOTP, optional per user**, with recovery codes and an operator CLI reset.
  Not WebAuthn or SMS: TOTP needs no external service, and SMS is weaker.
- The store has **one adapter** by intent; the interface is for portability.
- Recovery works **without a mailer** via the operator CLI; `none` is valid only with
  registration closed.

## Build, deploy, testing

`install.sh` is the deployment story: `-d` system packages (Node LTS, Python 3,
poppler-utils, tesseract), `-b` builds web and server then the Python venv, `-s` templates
the systemd units and starts them — `spine-web`, `spine-ingestion` and the `spine-backup`
timer — and `-n` Let's Encrypt plus the site config. `-s` refuses to proceed if `.env`
carries a missing, short or placeholder secret. `better-sqlite3` ships N-API prebuilds
including `linux-arm64`, so there is no compilation step on the Pi.

**Sidecar Python.** `unstructured==0.15.0` needs Python `>=3.9,<3.13`, so build with 3.11 or
3.12: `PYTHON=python3.12 ./install.sh -b` (without `PYTHON`, the venv uses `python3`).

**Tests.** `SPINE_DB_PATH=:memory:` is set in `vitest.config.ts`, not in test files: the
store captures the path at module load and ESM hoists imports above any top-level
assignment, so a test that sets it itself writes to the real `data/spine.db`. Some code is
intentionally not covered because it needs a live sidecar, real PDFs or live
credentials: `ingestion-client.ts`, `rasterize.ts`, the HTML entry-point half of
`public-share.ts`, and the adapters' `invoke` paths. The LLM interface is tested through
fake task clients (real `Runnable`s built with `RunnableLambda.from`), not a mocked vendor
SDK, so the tests describe what Spine does with a model's answer and do not change when the
provider does.

The harness registers the same plugins as `index.ts`, including `@fastify/rate-limit` and
`trustProxy`, because a control is untested unless the test drives it the way production
does (**P10**). The login limits are options on `authRoutes` so a test can set a small max
and assert the 429 instead of mocking the limiter out.
