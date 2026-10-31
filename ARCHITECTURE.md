# Architecture

Spine is a self-hosted, multi-user medical document archive. It ingests PDFs and scans, uses an LLM to split them into logical documents and extract structured fields, and issues scoped, expiring links so a doctor can read a subset without an account.

It must run on hardware as small as a Raspberry Pi, and must not be tied to any single LLM vendor.

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

Five of them: store, LLM, parser, embedder, mailer (`createEmbedder` and `getEmbedder` follow the same naming). Each is an interface the application defines; which implementation runs is chosen by configuration at startup.

### Naming

```ts
// Construction. Pure: validates its config, returns a new adapter, no global state.
createChatLlm(config: ChatLlmConfig): ChatLlm
createStore(config: StoreConfig): Store
createAccountsStore(config: StoreConfig): AccountsStore   // the server's: accounts only
createParser(config: ParserConfig, deps: ParserDeps): Parser
createMailer(config: MailerConfig): Mailer

// Access. Reads config on first use, memoizes.
getChatLlm(model?: string): ChatLlm
getStore(): Store
getAccountsStore(): AccountsStore
getParser(model?: string): Parser
getMailer(): Mailer

resetStore(): void    // tests only
```

`create*` is unit-testable with a config literal; `get*` reads config on first use. Reading config inside `get*` rather than at module load means nothing depends on an environment variable being set before a module is first imported. Both are synchronous and there is no `init` step. Nothing is wired by default: each host's entry point registers what the process uses (`useAccountsStore()`, `useDriver`, `useNativeTools`, `useFiles`, `useSettings`, the model providers) and a process that did not fails at first use, naming it (**S3**, [docs/structure-rules.md](docs/structure-rules.md)). The server's `index.ts` validates its configuration before it listens, so a bad setting stops the process there (**P3**) rather than at the first request.

### Dispatch is a registry, not a switch

```ts
// core knows one provider, `relay`; the relay service registers the vendors (server/src/providers.ts)
const ADAPTERS: Record<string, TaskClientsFactory> = {
  relay: createRelayChat,
};
export function registerLlmProvider(name: string, factory: TaskClientsFactory): void { ADAPTERS[name] = factory; }

export function createTaskClients(config: ChatLlmConfig): TaskClients {
  const factory = ADAPTERS[config.provider];
  if (!factory) throw new LlmConfigError(
    `unknown SPINE_LLM_PROVIDER "${config.provider}"; expected one of ${llmProviders().join(', ')}`,
  );
  return factory(config, buildTaskSpecs(config));
}
```

Adding a provider is an adapter file in `server/src/llm/adapters/` registered by `providers.ts`, never a new conditional. An unknown provider fails when the process asks for it, with the valid set named.

### Layout

The repository layout, file by file, is in [CLAUDE.md](CLAUDE.md). The directories that hold the interfaces: `core/src/llm/` (types, tasks, prompts, the `relay` adapter), `core/src/store/` (interfaces, registry, `sqlite/`, the only adapter, with all SQL), `core/src/parser/` (the contract, the registry, `adapters/{sidecar,ocr,multimodal,hybrid}.ts`; `sidecar.ts` is the text-layer parser), `core/src/embedding/`, `server/src/mail/` (`adapters/{none,brevo}.ts`) and `server/src/llm/adapters/` (the relay service's providers).

Two import rules, both review failures if broken. Nothing outside `core/src/store/sqlite/` writes SQL, and `core` imports no native library and no program at all (`better-sqlite3`, `sharp`, poppler ...): what it needs from the machine it asks for as a **native tool** (`core/src/native-tools.ts`), and what it stores in it over a **driver** the host chooses. Nothing outside `server/src/llm/adapters/` imports a **provider** package (`ChatAnthropic`, `ChatVertexAI`): `core` knows one provider, `relay`, and the relay service registers the others (`server/src/providers.ts`). `boundary.test.ts` holds both. `@langchain/core` is allowed above that line: an adapter returns one of its `Runnable`s per task, so it is the seam type, not a provider SDK.

### Store interface

Repository interfaces — on the device `Store` has one for each kind of record (`SourceFileRepository`, `PageRepository`, `DocumentRepository`, `ExtractedFieldRepository`, `TagRepository`, `ShareLinkRepository`, doctors, measurements, episodes, links, chat, embeddings ...) plus `users`, `maintenance` and `changes` (the sync log); the server's `AccountsStore` has only `users`, `sessions`, `usage`, `vault`, `shared` and `maintenance`. No SQL leaves the adapter and no handler holds a database handle: the only `.prepare()` calls outside `store/sqlite/` are in the drivers that wrap a SQLite library (`web/src/core/sqlite-wasm.ts`). Two properties pay for it: isolation becomes structural, because handlers cannot write queries; and a second adapter is additive.

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

- **Every method returns a `Promise`, though the only adapter is synchronous.** A networked store is async, and a sync interface would weld it to `better-sqlite3`.
- **`transaction` takes a `Store`, not a connection**, so repository code is identical inside and outside one. Ingestion writes a document, its tags and its fields together; a partial write leaves a document with no fields and no error. It uses explicit `BEGIN`/`COMMIT` (`db.transaction()` throws on a callback returning a promise) and `SAVEPOINT` for nesting. The connection is shared, so a statement issued elsewhere while the callback awaits lands inside the transaction. Several paths write in transactions (reading an upload, regrouping, moving a page, merging, restoring), which is why a callback should use only its `tx` and await nothing slow.
- **Every method takes the acting user's id** as its first parameter, so the signature forces the caller to have resolved identity:

```ts
interface DocumentRepository {
  listFor(userId: string, filter: DocumentFilter): Promise<Document[]>;
  findFor(userId: string, id: string): Promise<Document | null>;
  listForShare(link: ResolvedShareLink): Promise<Document[]>;   // one of five exceptions
}
```

There is no `find(id)` without a user. **Five exceptions**, enumerated in `store/types.ts` so a sixth has to be argued for: `shareLinks.findLive`, `createRequest` and `listForShare` (scoped by the link's owner, resolved from the link's id); `logAccess` (how the owner's device records an open the server reported, **P7**); `shared.*` (the public side of a sealed share, scoped by its random id, answering only metadata and sealed bytes); `maintenance.*` (boot-time work: stalled jobs, ended sign-ins, `snapshotTo`); and `users.*` (the identity layer — login must find a user before there is an acting user).

What a method does with a record the caller does not own:

- a read returns nothing, indistinguishable from "not found";
- an update or delete changes nothing;
- a create that names such a record throws and inserts nothing, since dropping a create silently would lose data;
- a call with no acting user at all throws, rather than matching nothing quietly.

Routes check first and answer 404, never 403. `__tests__/isolation.test.ts` exercises all of it as a second user.

Only the SQLite adapter exists, by intent: the interface is for portability, not because a second is planned. SQLite is single-writer. The device's database has one owner and the server's holds accounts only, so that is not a limit today; it would be the first thing to revisit if one database had to serve many writers.

### LLM interface

One interface covering what Spine asks of a model:

- `detectContinuation(pageA, pageB)` — are these the same logical document?
- `extractFields(documentText)` — structured metadata.
- `readPage(image)` — the text on one page image, no positions. Sends a page image off the host, so it is reached only through the `multimodal` adapter: the configured parser when it is `multimodal` or `hybrid`, and for a photo or a "Read page with AI" (all behind `SPINE_MULTIMODAL_ENABLED`).
- `readStamps(images)` — the doctors on a document's signature stamps (name, specialty, professional code). Sends small images, never a page, and only when the operator has allowed images to leave: `readSignatures` checks the same switch before it does anything.
- `translate`, `link`, `judgeGrouping` and `answerQuestion` — text only (a document's details, summary cards, page text for grouping, the question with matching records); `agentModel()` hands the chat agent the chat model itself.

Adapters: on the device one, `relay`, which sends the call to the relay; the relay service runs it through **Anthropic** (direct API) or **Vertex AI** (Gemini *and* Claude, EU multi-region), whichever its own `SPINE_LLM_PROVIDER` names. Configuration carries the provider, model ID and endpoint; model IDs change independently of the code (see [docs/deployment-gcp.md](docs/deployment-gcp.md) for current models, prices and retirement dates). Which model to run is an evaluation on real Romanian handwriting, not a design decision, and needs no code change. `SPINE_LLM_MODELS` lists further models for a person to pick when they ask for a reading ("Read page with AI", "Read whole document", extracting a document's details again): `getChatLlm(model)` builds a client for an offered id on the same provider, endpoint, region and project, once, and refuses any other, and the routes check the id against the list before using it. Uploads always use `SPINE_LLM_MODEL`.

**Vertex is a platform, not a model**, and what matters is which API serves the model:

| API | Models | Auth | EU residency |
|---|---|---|---|
| **Vertex AI**, standard endpoints | Gemini **and** Claude | service account (ADC); API keys are blocked | yes, via the `eu` endpoint |
| **Vertex AI Express** / **Gemini API** | Gemini only | API key | not the residency-bearing surface |
| **Anthropic API** | Claude only | API key | no EU-only processing commitment |

So a deployment that needs EU residency must use a service account on standard Vertex endpoints. Claude on Vertex cannot use an API key at all (`rawPredict` does not support one), and an API key present in the environment silently reroutes Google clients to a global host (**M-8** has the mechanism). **This deployment requires EU residency**; the interface still spans the other routes because another operator's instance may not.

#### How the model is used

Independent, stateless, single-turn prompts. No chaining, no agent loop, no tool use, no multi-turn state: any chat-completion API can back the interface, whereas tool-use and conversation formats differ across vendors. **One exception, kept out of the ingestion path: the chat agent** (below), which is handed the chat model itself by `ChatLlm.agentModel()` and binds its own read-only tools to it with LangGraph. Everything that reads or writes the archive's documents on upload is still stateless single-turn calls, and a model that cannot take tools simply gets the fixed pipeline.

| Call | Input | Output | `max_tokens` |
|---|---|---|---|
| `detectContinuation(prev, curr)` | the whole text of page N-1 and page N | `{is_continuation, confidence, reasoning}` | 1024 |
| `extractFields(text)` | the whole document, each page under a `--- page N ---` marker | language, title, date, provider, type, summary, tags, `doctors[]`, `fields[]`, `measurements[]` | 16384 |
| `readPage(image)` | one page image | `regions[]`: text blocks, no positions | 16384 |

```
parse → [continuation × (N-1)] → group into documents → [extract × M] → ground locally
```

A 10-page upload with 3 documents is 9 continuation calls and 3 extraction calls, plus a `readPage` per page the model has to read. Grounding is not a model call.

#### What is extracted for each type

The model decides the document's type, then follows that type's guide (`llm/doc-types.ts`, the one definition used by the prompt and the review form): labs get a measurement per analyte with unit and reference range; prescriptions get repeating groups of drug, dose, frequency and duration; vaccinations a group per vaccine; imaging its modality, findings and impression; discharge notes and consultations their diagnoses, plan and follow-up, with vitals as measurements; and every type names its doctors. A clinic's "raport medical" is a consultation whose sections are free text: services performed (one `service` field each, with its result as an `investigations` field), history split into family, personal, habits and current treatment, the reason for the visit (`reason_for_visit`, which is not a symptom: a pre-travel visit has one and no complaint), symptoms and examination, the diagnosis with its ICD code (`diagnosis`, `diagnosis_code`, and `diagnosis_uncoded` for what the report left uncoded), and recommendations split into tests, vaccines, prevention such as malaria prophylaxis, lifestyle advice and medication. A medicine is a `drug` group only when prescribed or taken now; one merely advised for a travel kit or "in caz de" goes in a single `recommended_medication` field. Lab values and hormone levels quoted in that text become measurements, each with the date it was taken, which is often earlier than the visit; a date printed as a month ("03.2026") is kept as the month (`YYYY-MM`) and charted at its start, shown as "month only". The patient's national ID number, patient code and age are never extracted.

A lab bulletin is dated by when the sample was collected, not issued or released, since that is the date a trend should use. Its reference range is the one beside the result; the ranges listed for other groups (by sex, age, pregnancy) are ignored, and a bound printed as `<0.5` or `≤ 5.8` is the upper bound alone. A page numbered "1 / 1" after one numbered "3 / 3" starts a new document, which is how one PDF holding two bulletins splits.

Signing doctors and their professional codes are usually printed in a **stamp**, which is a small picture embedded in the PDF and has no text, so they are absent from a reading of the page text. `ingestion/signatures.ts` finds them without rendering a page: PDF.js lists the pictures embedded in the file on the device (poppler's `pdfimages -list` does the same in the Node tests), and the candidates are those on a document's last page that are

- not a mask, and at least 100 x 40 px;
- wider than tall but not a strip (aspect 1.2 to 4.0), which leaves out QR codes and round seals (square) and letterhead logos (long strips);
- not repeated on another page of the file, which is what a letterhead is;
- at most four, the largest first. There is no size ceiling: one real stamp was a 1580 x 878 scan.

Only those are extracted, reduced to 1000 px on their longer side, and shown to the model, which returns a name, specialty and code for each that is a doctor's stamp, and a code only if every character is legible (a wrong code is worse than none). They are filed as the document's authors, marked as coming from a stamp, so reading the text again replaces the doctors the text named and leaves these. The thresholds are first guesses to tune from what is sent (the log says how many images go per page). With image reading off, for a photo, or if anything fails, nothing is added and the upload is unaffected. Doctors are entered by hand when a stamp is not an embedded image (a scanned page, a stamp too faint to read) or is absent.

A PDF may instead carry a **digital signature**, whose certificate names the signer. `readDigitalSigners` checks it locally, so it does not depend on the image switch and sends nothing: on the device with `ingestion/signatures-cms.ts` (WebCrypto reads the CMS in the file, checks the digest of the bytes the signature covers and the signature itself, RSA and ECDSA; poppler's `pdfsig` is the Node tests' reference, run with `TZ=UTC`). The bytes must still match the signature. With the operator's trust anchors the certificates in the file are also followed to one of them; without, a name is a label from the file (SECURITY.md **S-23**). A signer counts only with both a given name and a surname in the certificate (a personal signature; a company seal has neither); the certificate's serial number is not kept. The signature covers the whole file, so the signer is filed as an author of every document in it, marked `signature` (`verified_signature` when the certificates chain to a trust anchor) so a re-read of the text leaves it. Verified against one real signed PDF (not a clinic's), where the device and `pdfsig` give the same name; the wording of clinics' certificates is untested.

The answer is validated leniently (a missing list means none; a reference range read as `"12"` is fine) and normalised on our side: decimal commas, a flag worked out from the value and range, the document's date where a row has none. A reading with no doctors or measurements is still a reading.

#### Limits and concurrency

The only cap on the text in a request is the model's context window, `SPINE_LLM_CONTEXT_CHARS` (default 300,000 characters): nothing is shortened to save money or to send less. A document over it is split into chunks at page boundaries (details from the first chunk, tags and fields gathered from all; if any chunk fails the document counts as failed). Pages are labelled with their real numbers so a field lands on the right page, including for documents that start after page 1. Because the whole text now goes to the provider, more document text leaves the host than before (see the egress table).

Reading pages, checking page pairs and extracting documents are independent, so they run in parallel, at most `SPINE_LLM_CONCURRENCY` at once (default 4). Only the waiting is parallel: every database write stays sequential, and nothing is written until the model calls for that step have succeeded.

#### How it is built

LangChain.js supplies the provider implementations (`@langchain/anthropic`, `@langchain/google-vertexai`) and the shared `Runnable` type; zod validates. An adapter is given the task definitions (`llm/tasks.ts`: output budget and schema, both fixed at startup) and returns one bound client per task. Anthropic takes `maxTokens`, Google `maxOutputTokens`, both at construction; the adapters also hold each provider's credentials, endpoint and residency checks.

- **`withStructuredOutput` is an optimisation, not the validation.** Adapters bind the schema to each client; the interface validates every response with zod, so a provider that ignores the schema cannot write an unchecked shape. A validation failure logs and degrades to a reviewable fallback rather than failing the upload.
- **Residency is configuration, not code inspection.** The Vertex adapter requires endpoint, region and project to be stated (nothing defaults to a global host) and refuses to construct if a Google API key is in the environment. It does not assert the shape of the outgoing URL: that would encode Google's URL scheme and say nothing about Azure or Bedrock. Verify residency against the provider's request logs on first deployment, which works for any provider.

### Parser interface

`parse({ sourceFileId, filePath, pages }) → pages with text and boxes`. `SPINE_PARSER` picks the adapter:

- **`text`** (default; `sidecar` is the old name) — the PDF's own text layer with exact boxes, read by PDF.js on the device (`ingestion/pdf-text.ts`; the retired Unstructured sidecar is described in [docs/sidecar.md](docs/sidecar.md)). A page with no text layer comes back with no elements. Nothing leaves the host.
- **`ocr`** — the text layer where a page has one, local OCR (Tesseract) for the others, kept whatever its confidence. Nothing leaves the host, and handwriting is what it does poorly on.
- **`multimodal`** — every page image goes to the configured LLM provider, which returns the text in blocks, with no positions. A page the model cannot read fails the upload and names the page; there is nothing to fall back to.
- **`hybrid`** — text layer first, then local OCR (unless `SPINE_OCR=off`), then the model, per page. See [Hybrid routing](#hybrid-routing).

The contract every adapter keeps, so nothing downstream has to guess:

- **One entry per page image, in order.** A blank page is an entry with no elements, not an absence, so the pipeline can pair text with images by page number.
- **`image_width`/`image_height` are the image's pixel size and every box is in that space.** The text layer's boxes are in PDF points (72 per inch) while the page PNG is 200 DPI, so the text-layer adapter scales them into the image's pixels.

> **Box scaling checked on one real PDF, not in a browser.** Words and sizes were compared with the old sidecar's output on a real report; a highlight drawn on the page image has not been seen. Check one native-text PDF against a real highlight on first deploy. Likewise no real page has been sent to a real
> model provider; the image message was checked against both providers' request builders only.

### Mailer interface

**Implemented.** `send({ to, subject, text })`, plus `enabled`. It exists for account messages only: verifying an address, a reset link, a notice of a sign-in from a new browser or of a changed security setting, and a share request waiting for approval; nothing else in the application sends mail. There is no attachment field and no way to add one, which is the control: a document cannot leave by this route because the route has no place to put it.

Adapters, chosen by `SPINE_MAILER`:

- **`none`** — the default. Sends nothing and reports itself disabled. The server starts with it only when registration is `operator`; `open` with `none` refuses to start.
- **`brevo`** — Brevo's transactional API over `fetch`: one request, a 10-second timeout, no retry (sending is user-triggered and a silent retry could mail a link twice). An error names the status and never the message, which holds a live link. Needs `BREVO_API_KEY`, `SPINE_MAIL_SENDER` and `SPINE_DOMAIN`.

Mail is sent **after the response**, so how long the provider takes does not depend on whether an address has an account. A failure is logged, and the page tells the user to request another link.

#### Residency of the mail path

Brevo is French (formerly Sendinblue), runs EU data centres and holds ISO 27001, which fits this deployment. **Confirm it in their DPA before relying on it** — what is available publicly is third-party summary, not contractual terms.

It is a lower bar than inference regardless: under **P8** email carries a recipient address, a link and when an account event happened, never document text, a summary, a field or an attachment. So a mail provider processes personal data, never health data.

Metadata still leaks: a sender, subject or domain naming a service tells the provider, and anyone seeing the inbox, that the recipient uses it. That is the operator's call, as it is for any clinic or pharmacy that mails its patients under its own name, and it is not a legal requirement either way. The subjects are plain account wording ("Confirm your email address", "Reset your password", "New sign-in to your account", "A security setting on your account changed", "Someone is waiting for your approval"), a test fails if the text mentions anything clinical, and the sender is **required configuration with no default** (`SPINE_MAIL_SENDER`) so the operator chooses the name on purpose. The links point at `SPINE_DOMAIN`, so the domain is visible too.

## Multi-user model

### Identity

**Local accounts only.** An email and a master password. The password is checked on the device (12–256 characters, not a common word or pattern, not part of the address) and never sent: the device derives a sign-in value from it, and the server stores an argon2id hash of that value (19 MiB / 2 passes / 1 lane). An account the operator makes with the CLI has no vault, and for it the server hashes the password itself under the same policy. No external identity provider: an instance must work with no internet reachability beyond its chosen inference provider. Sessions are server-side cookies holding a user id, that user's `auth_version` and the id of a `user_sessions` row; every request re-resolves them against the database, so a changed password ends other sessions on the next request, an unused sign-in ends after 24 hours and any after 14 days, and the owner can list and end them from the account page (SECURITY.md **M-27**). The server's own sensitive calls (deleting the account, adding or removing a passkey, making a vault, changing a credential) ask for the password again if it was not typed in the last ten minutes. The whole-archive export and a share link that shows page images run on the device, which is open only after the master password (or a passkey that opens the vault) was used, so they ask for nothing more. Login issues a new session id, and an unknown email is indistinguishable from a wrong password in both answer and time.

**Second factor (optional, per user):** TOTP, so it too needs no external service. After a user enrols from the account page, the right password only starts a *pending* login (held in the session for five minutes), and a valid code or a recovery code completes it. Reset links do not bypass it. Details and residual risks: SECURITY.md **M-12**, **S-20**, **S-21**, **S-22**.

Accounts come from the operator (`npm run cli -- create-user <email>`; also `set-password`, `reset-link`, `disable-2fa`, `delete-user`, `list-users`) or, if enabled, from open signup.

### The emergency card

`core/src/emergency.ts` defines the card and the plain text an offline code holds; `routes/emergency.ts` (run by the device) edits it and turns it on and off through the share host's `publishCard` and `revokeCard`; the device seals it and sends it to the server as a `card` bundle (`routes/shared.ts`), which has no end, one per account, and is not counted as a share. The viewer is at the same `/share/<id>` address as a share (`ShareRouter` asks the server which it is), so the proxy's rules for shared addresses, the content security policy and the shell route needed no change. See SECURITY.md **M-47**.

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

Fire-and-forget; the browser polls `GET /api/source-files/:id/status`. An upload can be deleted with `DELETE /api/source-files/:id` (the button on its pages screen): the documents, fields, measurements and pages made from it, the page images and the original with the unprocessed photos of a camera scan; the vault's sealed copies of the original go at the device's next save. Tags and doctors stay, being the user's, and it is refused while the upload is being read.

```
upload  →  write original, sha256 checksum (per-user de-duplication)
        →  rasterize            PDF.js on a canvas → PNG, 200 DPI, fonts a file embeds drawn as shapes (`disableFontFace`; as web fonts in the worker every letter came out as an empty box) (poppler's pdftoppm in the Node tests)
        →  parse                parser interface; with `hybrid`, per page:
                                text layer → local OCR → model
        →  detectContinuation   per adjacent page pair → document boundaries
        →  store pages and the proposed grouping          (documents held back)
              ── the owner confirms the grouping ──
        →  extractFields        per logical document
        →  grounding            map each field to a box on its page
        →  store
        →  signatures           (PDFs; stamps only with image reading on) the stamps on each document's
                                last page → readStamps → doctors; digital signatures are checked locally
```

### Uploads: PDFs, and photos when image reading is on

A file is what its contents say it is (the `%PDF-` signature in the first kilobyte, or a JPEG or PNG signature at the very start), not what its name or the browser's type claims; anything else is refused, and a refused file or a duplicate is not left on disk. The recorded type is the detected one.

**Other formats are converted on arrival** (`ingestion/convert.ts`, requirement FR-ING-01). An iPhone **HEIC** photo becomes a JPEG (`heic-convert`, a WebAssembly decoder, since sharp has none) and is then an ordinary photo, with the same switch; a **Word document** (`.docx`: a zip with `word/document.xml`, whose text is taken paragraph by paragraph, so tables come out cell by cell and pictures, headers and footers are left) and a **text file** (small, valid UTF-8, no NUL) become a PDF with a real text layer in DejaVu Sans, so accents survive, and the text parser reads it with no model. Each is recognised by its contents, like a PDF. The converted file is what is kept as the original; the checksum that recognises a repeat is that of the file sent. A text of more than 900,000 characters is cut off. The ZIP route lets a Word document through as one document, not an archive. Not converted: spreadsheets, slides, RTF, ODT, HEIC burst or live photos beyond the first image.

A **photo** has no text layer and nothing local can read it well, so it is not tried against OCR: it goes **straight to the model** as a one-page upload. It is prepared first (`ingestion/photo.ts`): turned upright by its EXIF orientation (phones store most photos sideways and set a flag the model would not apply, which would also put every box in the wrong place), shrunk so its longer side is at most 2600 px, flattened onto white if it has transparency, and written as a PNG. The original is kept as it was sent. Because reading it sends the image off the host, a photo is accepted only when the operator has switched image reading on; otherwise it is refused at upload with that reason, and the Upload page offers photos only when they would be read, and says where they are sent. A photo is always read by the model parser whatever `SPINE_PARSER` is; a PDF is never sent to the model just because image reading is on. Pages scanned with the camera (`/scan`) arrive as a photo set, one PDF with a page each: local OCR reads it when the parser is `ocr`, or `hybrid` with OCR on, and otherwise the model does, which needs the same switch.

**Several photos of one document** (`POST /api/source-files/upload-photos`, sent by the Scan screen, which photos chosen on the Upload page are handed to first) are saved in the order sent, checked by their contents like any photo, and made into **one PDF with a page each** (`ingestion/photo-set.ts`: upright, at most 2600 px a side, flattened onto white, kept as high-quality JPEGs, so the same photos in the same order make the same bytes and a repeat is a duplicate by checksum). The PDF is the original (the photos are not kept), and the upload carries `source_files.photo_set`, which makes everything that reads it use the model parser as for a single photo (`readsByModel`), because the pages have no text layer. After that it is an ordinary multi-page upload: grouping, regrouping, moving pages, export and restore need nothing special (the export carries `photo_set`, so a restored set is read by a model again). Refused as a whole, with nothing kept, if image reading is off, any file is not a photo, or there are more than 40.

### Failed uploads

A failure (the provider was down, a page could not be read) marks the upload failed with its reason and keeps the original. It is not the file's fault, so it should not need re-uploading, which the duplicate check would refuse: `POST /api/source-files/:id/retry` (the Upload page's Try again) runs it again, and so does uploading the same file again, whose checksum matches only an upload that failed. It reads the way the first attempt did (the configured parser, never the model for every page unless it is a photo), and, like a re-read, removes what the failed attempt left only after the new reading has succeeded. Only a failed upload can be retried.

### Hybrid routing

The aim is to spend as little as possible — money, time and privacy — on pages a model does not need to read. Most documents are digital PDFs, so the order is cheapest first, and each step only sees the pages the one before could not settle:

| Step | Signal | What happens |
|---|---|---|
| 1 | The page has a **text layer**: the text layer holds at least `SPINE_TEXT_LAYER_MIN_CHARS` (default 50) non-whitespace characters for it | Use it, with the text layer's exact boxes. Nothing else runs. |
| 2 | **Local OCR is confident** (Tesseract, run on the page image) | Keep it. Boxes are exact and in the image's own pixels. Nothing leaves. |
| 3 | Otherwise | The model reads the page. |

Step 2 uses Tesseract's own word confidence: the page is kept if the mean is at least `SPINE_OCR_MIN_CONFIDENCE` (default 85) and no more than `SPINE_OCR_MAX_LOW_SHARE` (default 0.10) of its words are under 60. **No words at all fails it too**, which is what a blank page and a badly tilted one both look like. Rough measurements (English pack, handwriting approximated with cursive fonts, so a guide and not a result):

| Page | Words | Mean | Under 60 | Route |
|---|---|---|---|---|
| Clean print | 64 | 93 | 0% | local |
| Print tilted 3° | 64 | 87 | 6% | local — every word was right |
| Print tilted 8° | **0** | — | — | model |
| Cursive fonts | 64 | 76–81 | 11–23% | model |

Past about 8° of tilt Tesseract finds nothing and nothing in this path deskews, so a tilted scan goes to the model. The thresholds are first guesses and need tuning on real pages; every page logs one structured `page routed` line in the browser's console (route and, as they apply, words, mean confidence, weak share and why) for that.

**No LLM screens first.** Looking at the image is the same egress as reading it, and a screening call is a second round trip, so it would cost the privacy of reading and add cost for every page that then needs reading anyway.

**The PDF's text layer is the one source for "does this page have text".** PDF.js reads it and nothing else: no OCR, no layout model, decided page by page. A page it returns text for has a text layer; a page it returns nothing for does not. The character count, rather than "any element", keeps a scan whose only text is a stray page number from counting as having one. The file is read once, always. If it cannot be opened, **the upload fails** rather than treating every page as scanned, which would push digital PDFs through OCR and the model because of a damaged file.

The model can only improve a page, never lose one. If it fails or answers with nothing usable, the page keeps what local OCR read (or comes back empty if that failed too) and the failure is logged. Pages are read in parallel, up to `SPINE_LLM_CONCURRENCY` (default 4), one image per call; local OCR stays one page at a time. This keeps load and rate limits predictable. The model is not asked for positions (its estimate of where text sits was unreliable), so those pages are stored as `multimodal` with text and no boxes: a field read from one keeps its source page and gets no highlight.

**Tesseract ships with the web app.** The device runs Tesseract.js with the English and Romanian packs (`SPINE_OCR_LANGS`, default `ron+eng`), so nothing is installed and nothing can be missing: the server no longer checks for a program, because it runs none.

**Sending images is asked for twice**: `multimodal` or `hybrid` is one switch and `SPINE_MULTIMODAL_ENABLED=true` the other; either alone does nothing or is refused at startup (SECURITY.md **M-7**). Images go to whatever `SPINE_LLM_PROVIDER` is, so a deployment with a residency requirement should use Vertex at an `eu` endpoint.

### Reading a page with AI

A misreading is a property of a page (handwriting, a tilt, a table the OCR scrambled), so that is what can be read again with the model, not a document. It is offered on the **document page**, where the scan, the extracted fields and their highlights already are: a **Scan | Text** switch shows either the page image or the text the app read from it at a readable size, with how it was read (text layer, OCR or AI); the ways to read it again are in the **Read again** menu below. A page with no text says so and, if the server may use the model, how to have it read. The grouping screen's thumbnails mark the pages that were not read from a text layer, and its large preview is only a viewer with a link to the page's document (`/documents/:id?page=N`).

When a page has no text at all, nothing needs doing in `hybrid` with image reading allowed: it goes to the model at upload. The button is for a page that was read, but badly, which the routing cannot see; in `text` mode, or when the model failed, an empty page stays empty until it is used.

- Only the chosen page's image is sent, through the same model parser and operator switch as every other route that sends an image. The API takes up to 200 pages a request; the document page asks for one, and the chat's proposal ("read these pages again") can name several. One reading per upload at a time.
- Every page is read before anything is written, so a page the model cannot read leaves the upload exactly as it was. Their text and `multimodal` source are then written together.
- Only the documents that contain a page that was read are extracted again (once each, however many of their pages changed), from their pages' text. That replaces title, date, provider, type, summary, tags and fields, except what the owner edited or added by hand (**What the owner edits stays edited**), keeps the owner's notes, and puts the document back in review. If extracting a document fails, its page text is already updated and its details stay as they were; the result says so and "Read whole document" retries.
- It runs as a background job the browser polls (progress by page, then by document). The panel's confirmation says what will be replaced and what is kept, where an image would go, and that a reviewed document goes back to review.
- Both actions are in a **Read again** menu beside the Review button: **Read page with AI** (this page's image goes to a model) and **Read whole document** (the document's pages again, as an upload reads them). Choosing one opens a panel saying what it will do (and where an image would go) with a model picker (and, for a page, a "Think harder" option), and it runs on confirmation. A small "Extraction: <how this page was read>" label above the scan says how the page in view was read.
- **Read whole document** is the document-level action: the same job with `strategy: configured`. It parses the document's visible pages once with the configured parser (the text layer, then OCR, then a model, as set), so a PDF is parsed once and not once a page; a photo goes to the model, as at upload. The grouping is kept, a page the parser reads nothing from keeps its earlier text, and the document is extracted again. It sends an image only if the configured parser does, so it needs the operator switch only then. It is for after an update, when the pages are grouped right and only the reading and the details should be redone. (`POST /api/documents/:id/reextract` still extracts from the stored text alone, but no screen calls it any more; the regrouping screen's Done and the chat's regroup proposal use `POST /api/source-files/:id/extract`, which does the same for the documents they changed.)

### The document page

One page per document, `/documents/:id`, in two modes. **Reading** is what a tile on the timeline opens: the extracted details and fields beside the scans. **Review** turns the same page into an editor: title, date, type, provider, tags, summary, notes, the doctors, the measurements (test, value, unit, reference range, date) and every extracted field (change, remove, add). Fields that share a group number are shown together in reading mode, and the label box suggests what this type of document usually holds. The doctors box suggests names already in the directory, so someone met before is chosen, not spelled a second way. **Done** saves it all, marks the document reviewed and returns to reading; Review again edits again; Discard changes drops the edits. A document opened from the review queue starts in edit mode (`?edit=1`), anywhere else in reading mode. Old `/review/:id` links redirect.

An edit session is one `PATCH /api/documents/:id`, carrying the details, the tags, the field changes (`fields: { update, remove, add }`), the measurement changes (the same shape), the document's doctors (the list sent replaces the current one) and `reviewed`. The flag on a measurement is worked out again from its value and range on every save. Marking a document reviewed is refused (409) until its upload's grouping is confirmed. Everything is validated first and written in one transaction, so a bad field cannot leave the rest half applied:

- text has length limits, a date must be a real day, a type one the app knows; empty text clears a detail;
- a field to change or remove must be on *this* document, and a new field must be on one of its pages, otherwise the whole request is refused (400) and nothing changes;
- a corrected field keeps where it was read from; a field the owner adds has no source box.

Reading the file again with AI is not offered while editing, since the edits on screen are not saved yet and the reading would replace the values under them.

### Trends and doctors

**Trends** (`/trends`) lists every test with its latest value and flag. A test opens as a line chart over time (`/trends?name=…`): the printed reference range of the newest value as a band, each point coloured low/high/in range and linking to its document, and a table of every value beside it so the chart is never the only way to read them. It is drawn as SVG by hand: one shape, no chart library. A line only joins values that can be compared (a unit written two ways, "mUI/mL" and "mIU/mL", "µg" and "ug", is one unit); a consultation that quotes a lab's value gives the same test, day and value twice, so it is drawn once, from the report that has a reference range, and the other stays listed, so the series uses the unit most of its values have; a value in another unit (13.5 g/dL against 135 g/L), one that is not a number (`<0.5`, `pozitiv`) or one with no date is listed but not drawn. Tests are grouped by a canonical name, and three things keep one test under one name across labs. The model is told the names already in the archive and asked to reuse one when a measurement is the same test ("Hb" and "Hemoglobina" both become `hemoglobin`). Where it still names a test two ways, the owner merges them on the test's page ("Same test under another name?"): the values move to the chosen name and the old name is remembered, so later documents land there too; there is no automatic merging, since two tests with similar names, units and ranges can still be different tests. A merge is undone by editing the values, not by a button. Renaming a measurement in the review form gives it a new name unless that name was merged, in which case it joins the merged test.

**Doctors** (`/doctors`) is the directory the readings build: each doctor with specialty, clinic, how many documents name them and when last. A doctor opens to their documents and role on each; the owner can rename, fill in a specialty or clinic, merge another entry into this one (two spellings of one person), or delete an entry no document names. A code that already belongs to another doctor is refused (merge them instead); a name another entry already has is kept as a second person of that name, never merged silently (SECURITY.md **M-30**). Entries that are probably one person under two spellings are *suggested*, never merged automatically (`suggestDuplicates`, `GET /api/doctors/duplicates`): the shorter name's words must each be found in the longer as the same word or an initial of it, with at least one whole word in common and at least two words in the shorter, and two different specialties, or two different printed codes, rule a pair out. The owner merges into the fuller name or says "not the same", which is kept in that browser only. A wrong automatic merge would silently combine two people, where a duplicate is visible and fixable, so this errs toward asking.

### Ask your records: chat

A chat panel on every page of the app (`ChatPanel`, a quiet button in the corner that opens a floating card beside the page, which makes room for it; `POST /api/chat`), owner only. A share link can also let its recipient ask (below, **Share links**; SECURITY.md **M-20**): the same agent over the link's documents alone. It answers from the person's own documents, knows what they are looking at, and can point at the part of the page an answer came from.

**It is an agent (LangGraph), in `chat/agent.ts`.** A graph of an `agent` node (the chat model with tools bound), a `tools` node (`ToolNode`) and a `finish` node. The model decides what to look up, instead of our code deciding for it, using sixteen **read-only tools** (`TOOL_KINDS`), the first five being `search_documents` (keywords, and meaning where embeddings are on, optional type and dates), `get_document` (summary, notes, doctors, results, fields of one), `get_test_series` (a test's values over time), `list_tests`, `get_connected_documents` (what asked for a document, what followed it up); the others list or open uploads, results, doctors, share links, the library, suggested links and a regrouping plan, and `read_pages` returns the text of named pages. The tools are plain functions in the process, defined once, and the graph is compiled once per model. What belongs to a question (`userId`, the labels it has given, the reading budget, where progress goes) is in the **state of the graph** and each tool reads it from the `ToolRuntime` it is handed as its second argument; none of it is in a tool's schema, so the model neither sees it nor can write it, and it chooses only the arguments of the schema (a query, a label, a test name). A tool reads through the store as that `userId`, so only documents that are shown (not set aside, grouping confirmed) are reachable. The model never handles an id: documents are **labels given by this request** (`D1`, `D2`), mapped back to documents by the request; a label it was never given opens nothing. The loop is capped: at most eight rounds of tool calls (five for a share recipient), after which the pending request is dropped and the model is told to answer with what it has (`finish`); each result is cut to 12,000 characters, a question may read 120,000 in all (after which tools only say so), and the whole run has a 90 second deadline. The answer is prose; the citations in it (`[D1]`, `[D1.results]`) are checked against what was shown to the model, and the reply carries `looked`, a list of what the agent searched and opened, for debugging; the panel does not show it (the sources already say what the answer rests on).

**The answer is streamed.** `POST /api/chat` with `stream: true` answers in JSON lines (NDJSON) instead of one body: `step` (what the agent is looking up, as a kind and a detail the page words in its own language: searching, reading a document, a test's values, the tests, a document's connections, the text of named pages, and for the other tools their own: fields, results, share links, doctors, uploads, the regrouping plan, the library), `delta` (a piece of the answer as the model writes it), `reset` (what was shown was a lead-in before a tool call, not the answer: clear it), then `done` with the same reply the plain form sends, or `error`; the route also writes a `ping` every ten seconds and sets `X-Accel-Buffering: no`, left from when it was served through nginx; on the device nothing sits between the core and the page. Every refusal (validation, a conversation that is not theirs, a full one) happens before the first byte and is an ordinary 4xx. Text is shown as it comes but **nothing is trusted until `done`**: citations are hidden while the text is a draft, and numbered, checked against what the model was shown, and tied to sources only in the final reply, which is also what is stored. A question the person stops (the Stop button, closing the tab, leaving the conversation) aborts the model call and the loop and **keeps nothing**. The fixed-pipeline fallback has no tokens to stream: its answer arrives at `done`, and when the agent fails after text was shown, `reset` clears it first. A model that cannot stream is read as one piece. Streaming needed one repair that only the real service showed: Gemini 3 signs what it thought before a function call and wants the signature back with the tool's result, and the Google library drops it when the signatures of a streamed reply are joined chunk by chunk (400 "missing a thought_signature"); the Vertex adapter's agent model (`withStreamSafety` in `vertex-tasks.ts`) sends the chunks without theirs and one last chunk with the list a single reply would have had.

**Actions are proposals** (`chat/actions.ts`, `chat/proposals.ts`). Every tool is declared `read` or `action` in `TOOL_KINDS`; the action tools are named `propose_*` and a test holds that, and that running them writes nothing to the store. An action tool checks its arguments against the same limits as the route Confirm will call, resolves **labels the request itself handed out** (`D3` a document, `F2` a field, `P4` a doctor, `L1` a share link; never an id the model writes) and puts a `Proposal` in the reply (`reply.proposals`, also in the stream's `done`). The page shows it as a card (`ProposalCard`) whose words it writes itself from the proposal's data, in the person's language: the model supplies only the data (a note, a value, which documents). **Confirm** sends the proposal's requests to the ordinary authenticated routes (`api.chat.run`, which runs only the shapes the chat prepares), so every check the routes make is made again; a change announces itself (`dataChanged.ts`) and the open pages read again. Proposals are not stored: they belong to the reply that made them, and a reopened conversation has the words only, so an old proposal cannot be confirmed later. At most five proposals per question. The actions today: a **share link** (documents by label, name, length; the card lets the person remove documents and set scans, approval and recipient questions, which the model cannot set), a **note** appended to a document, a **correction** (title, date, provider, type; fields changed, added or removed, shown before and after), **tags** and **reviewed** for several documents, a **care link** between two documents (earlier to later), **revoking a share link**, and **merging duplicates**: directory doctors, tests, tags and providers written several ways; **results** (a value, unit, reference range or date changed, added or removed, by `M` labels from `get_results`); and **changing an existing share link** (`get_share_link`; its name, length and documents, never what it exposes); also **moving, turning and hiding a page**, **confirming or dismissing suggested links**, **merging documents** and **analysing an upload's pages**. A merge card shows the variants and the one **final form** they would all become (name, specialty, clinic, professional code; or the test's name), editable, with each variant and each group optional; entries with different professional codes are never grouped, and tests whose values carry different units get a warning. SECURITY.md **M-21**. A share recipient's agent is built without any of these tools. Two more actions serve the review of an upload: **confirming the grouping** and **reading pages again** (the card says an image goes to the model provider; the route and `aiReadingAllowed()` check the switch).

**Sorting a mixed upload.** `regroup/` finds which pages of an upload belong together (SECURITY.md **M-24**): `features.ts` makes, per page, its weighted words, reference numbers, dates and "page k of n" marker, and a similarity for every pair (embeddings blended in where they are on; a marker clash or the same page number twice makes a pair impossible); `cluster.ts` joins pages by average linkage into candidate groups of at most eight; `analyze.ts` asks the model about each (`judgeGrouping`) and uses its answer where it differs from the clustering, then offers each left-over page to the nearest group and asks whether it belongs. It runs as a background job (`regroup/jobs.ts`; 60 model calls at most, four at a time), stores the plan (`regroup_plans`) and says so in the conversation it was asked in, the one the upload came in with, or Activity (`announceRegroup`, `kind: 'regroup'`). In the chat: `propose_analyse_pages` (a card; Confirm starts it), `get_regroup_plan` (groups `G1…` with the verdict, the title and the documents the pages are in now), and `propose_regroup` (a card with each group as the new document it would make, its pages as small pictures, the verdict and reason; groups and single pages can be left out). Confirm sends the kept groups to `POST /api/source-files/:id/regroup` (`ingestion/regroup.ts`: `planRegroup` is pure, `applyRegroup` is one transaction, the general form of a page move) and then reads the changed documents again.

**The app starts conversations.** When the pipeline finishes an upload (or fails) `announceUploadLater` (`chat/notices.ts`) adds an assistant message of `kind: 'upload'` to the owner's **Activity** conversation (`origin = 'activity'`, one for all the app's reports, so the history stays the owner's questions; a full one is left and a new one started; older accounts may still hold the single-report conversations of `origin` `upload` and `regroup`): facts as JSON (`data`: the documents read, pages, how many pages had no text, how many documents no date, whether the grouping still waits) which `UploadNoticeMessage` draws in the person's language, and `content`, the same in English, for the model. The conversation is `unread` until opened, and unread again with each new report (`chat_conversations.unread`, `origin`; `chat_messages.kind`, `data`: defaulted columns, added in place). The page asks `GET /api/chat/unread` on load, when it returns to the front and every 30 seconds (and after a confirmed change), shows a badge on the Ask button and a note beside it that opens the conversation (`POST /api/chat/conversations/:id/read`). A reply in such a conversation carries the upload on screen (taken from the notice, not from the browser), and the assistant reads it with `list_uploads` and `get_upload` (labels `U1`, then `D` labels for its documents, even before the grouping is confirmed), points out what looks wrong, and proposes fixes, reading a page again and confirming the grouping, all as proposals. SECURITY.md **M-23**. **Attaching a file in the chat** (paste, drop or the paperclip) uploads it through the ordinary route (`POST /api/chat/attachments`, which shares `acceptParts` with the Upload page) and ties it to the conversation (`source_files.chat_conversation_id`), so the app's reports (the upload read, the analysis of a mixed upload ready) are added to that conversation instead of starting new ones; while a file is read its message shows the same progress as the Upload page. The finished-upload report asks what may be a duplicate (`matching/`: new doctors, tests, tags and providers against what is held, with a reason; yes merges through the ordinary route, no is remembered in `match_decisions`; a professional code that differs from the directory's is asked about too, from `document_doctors.printed_code`; SECURITY.md **M-26**) and adds what was found: doctors added and matched, pairs that may be duplicates, new tests, and whether the pages look mixed (`looksMixed`, local, no model), with one-press actions: check the pages with AI, tidy the doctors. SECURITY.md **M-25**.

**Helping a person start, and Spine explaining itself.** `core/src/help.ts` holds a few fixed answers about how Spine works (adding a document, the grouping, the "check" marks, sharing, privacy, the master password, what the assistant does; and where results and trends, doctors, connected documents, episodes and the Library come from), in English; the page shows them translated (the dictionaries hold them, and `i18n-coverage.test.ts` reads that file). They are used three ways, and none calls a model to show them: the chat's welcome offers the first seven as questions (`START_TOPICS`), and `POST /api/chat/help` writes the question and its answer into the conversation the person is in, or their **Getting started** conversation (`origin = 'guide'`, `kind: 'help'`, drawn from `data.topic`, with the English in `content` for the model); a tip's "Tell me more" does the same; and the assistant reads them with `explain_spine`, a read tool, when asked how the app works rather than about the records (the agent now runs on an empty archive too, so a new person's first question reaches it). **What was shown** is a table of the records, `guide_marks` (`routes/guide.ts`: `GET /api/guide`, `POST /api/guide/:key/shown`, `/done`; keys `welcome`, `tip.grouping`, `tip.read`, `tip.share`, `tip.results`, `tip.doctors`, `tip.connections`, `checklist`), synced like the rest so a second device does not greet again, never in a share and not exported; `GET /api/guide` also says how far the person has got from their own records (uploads that are not sample records, groupings confirmed and waiting, their documents marked reviewed, share links made). `web/src/guide.tsx` decides: the first time the records are opened with nothing uploaded, the chat opens on the welcome; the next three times a note beside Ask offers it, and can be put away; then nothing. Anything done from it, or a first upload, ends it. A tip (`GuideTip`) shows once when its moment comes (an upload waiting for its grouping, documents read, a link made, a document's results or doctors, a suggested connection) until "Got it"; the results and doctors tips are also on Trends and Doctors under the same key, so whichever is met first is the one shown, and a document page shows one tip at a time, and the timeline's **Get started** list ticks off adding a document, reviewing what was read (it leads to the upload screen while a grouping waits, since those documents are not in the review queue yet) and making a link, and goes when they are done or hidden. None of it runs in the demo. SECURITY.md **M-42**.

**The fixed pipeline remains** (`chat/index.ts`, `retrieval.ts`) as the fallback: it is used when the model cannot be given tools, and when the agent throws (which is logged). Our code finds the documents (keywords searched one by one and fused by rank, plus meaning where on; the care chains of the top hits; the series of a test the question names), builds labelled records, and one structured call answers from them.

**What is on screen.** Each question carries `screen`: pointers, not text. The page (from the address, plus what the page registers with `useScreen`), the document or upload or doctor id, the ids a list shows, a search text and filters, the test on a chart, the field or result selected, whether the document is being edited. The core resolves them through the store (`chat/screen.ts`), so an id that is not the person's resolves to nothing, and tells the model in record `S0` what they are looking at ("this", "here" mean it). The document on screen is `D1` and is given **in sections**, each its own record: `D1.summary`, `D1.notes`, `D1.doctors`, `D1.results`, `D1.fields`, `D1.chain`. This is the one place a document of an upload whose grouping is not confirmed reaches the model: the owner has it open, and asking "is this grouped right?" is the point of that screen; searches never find it.

**Conversations are kept** (`chat_conversations`, `chat_messages`; new tables, so no migration). The first question starts a conversation titled by it; each answered question adds its two messages, with the sources the answer cited as they were shown. The panel's **History** lists the person's conversations (most recent first), reopens one to continue it, and deletes one or all (a second click confirms in place); **New conversation** starts another. The browser remembers only which one was open (`localStorage`), so a reload comes back to it; the conversation itself comes from the store. The history the model sees is read from the store, never sent by the browser, the last six turns, with the citation markers removed (`[D1]` named a document for the request that wrote it and means nothing in the next). A failed question writes nothing. At most 200 conversations per person (the oldest go) and 200 messages in one (then a new one must be started). They are medical text: scoped by `user_id`, a 404 for anyone else's, deleted with the account, kept on the device and saved to the vault sealed like the rest of the records (so they are in the vault's backup as ciphertext), and **not exported** (they are not the archive's documents and quote them) and never reachable from a share link.

**Pointing at a part of the page.** An answer cites `[D1.results]`; the panel shows it as a small number (1, 2, …) in the text, with the numbered sources listed below by document title and section name, and each links to `/documents/:id?section=results`, and the document page scrolls to the element with that id and lights it for two seconds (`summary`, `notes`, `doctors`, `results`, `fields`, `chain`). Following the same link again does it again. On a phone the panel closes when a link is followed.

**What is sent.** The question, up to six earlier turns (each cut to 1,500 characters), what is on screen, and whatever the tools return: summary cards, the owner's notes (600 characters), results with values and reference ranges, field values for the document on screen or when asked for; never a page image, snippets, ids or paths, and page text only through `read_pages` (at most 6 pages of one upload, 2,500 characters each, owner's agent only, shown in the panel as a step). Bounded by the relay's daily allowance, since one question can be several model calls. `SPINE_CHAT=off` removes it.

### Care chains: what asked for what

A consultation asks for tests, a test is read at a follow-up, an admission ends in a discharge. `document_links` records these as `from` (the earlier document) `to` (the later one) with a kind: `requests` (the earlier asked for the later), `follow_up` (the later follows up the earlier) or `same_episode` (stored once, earlier first). Each link has a `source` (`auto` or `owner`) and a `state`: an automatic link starts `proposed`, the owner `confirm`s or `dismiss`es it, and a link the owner adds is `confirmed`. A dismissed pair is never proposed again, whatever the kind. The chain on a document page is the connected set of documents (at most 30, ordered by date) through links that are not dismissed, each link written under its later document; a suggestion is drawn differently and carries Confirm and Not related.

**Finding links** (`linking/index.ts`) is two steps, so a model is called only when there is something to judge:

1. **Candidates, no model.** The person's other visible documents are scored by what the data says (`relatedSignals`: shared tests, doctors, tags), by meaning when embeddings are on (`similarTo`), and by time: two dated documents more than 24 months apart are not candidates, and a consultation, prescription or discharge is offered the nearest laboratory and imaging documents within 90 days after it (and the reverse). At most six are kept, at most three of them on time alone. **No candidates, no model call.** A pair the owner dismissed is not a candidate.
2. **Judge, one model call per document** (the `linking` task, no deliberation, a small token budget). The model sees the summary card of the target and of each candidate (`similarity/card.ts` plus each doctor's role, a `referrer` being the strongest sign of "requested by"), under short labels rather than database ids, and answers with the candidates that are related, and a relation from a fixed list; it gives no reason (what is shown as one is made from the data, `linking/why.ts`). Code maps the relation to `(from, to, kind)`, drops a candidate label it did not send, and drops a request or follow-up whose dates run the wrong way. The prompt tells the model to be conservative and that the cards are data, not instructions.

Links that repeat each other are not kept (`linking/reduce.ts`): one line for a pair, the most informative kind (request over follow-up over same episode), and no "same episode" between documents that other links already join, so five documents of one hospital stay are a group and not ten links. A search adds only what the links that stand do not already say, the chain is drawn reduced, and `tidyLinks` removes the automatic repeats after a search; the owner's links and dismissed pairs are never touched. A search replaces only the `proposed` automatic links of the pairs it judged again (the document and each candidate it showed the model), in one transaction, and only if the model answered; a suggestion about any other pair, and every confirmed or dismissed link, is left alone, so searching one document never undoes what a search of another suggested or what the owner decided. It runs in the background (`scheduleLinking`, one person at a time, failures logged) when linking has something settled to judge: when the owner confirms an upload's grouping (all of its documents), after a document is read again, and on "Look for links again". Documents of an unconfirmed upload are not visible, so they are neither targets nor candidates. The owner's notes on a document go to the model with its card, trimmed to 600 characters (`POST /api/documents/:id/chain/refresh`, 202). A restore does not call a model, so restored documents are linked from that button. `SPINE_LINKING=off` stops all of it; adding and deciding links by hand still works. Links are deleted with their document, with an upload's derived data and with the account; the whole-archive export carries them (below) so the owner's confirmations and dismissals survive a restore. Links are owner-only: no share route returns them.

### Episodes: documents that belong together

An **episode** is a group of one person's documents that the owner confirms belong together (`episodes`, `episode_documents`; a document is in one proposed or confirmed episode at a time, kept by the repository in one transaction, and leaves a document's place when the document is deleted, by `ON DELETE CASCADE`). The app **proposes** them from the data only (`episodes/index.ts`): two documents are joined when a link joins them (suggested or confirmed, not dismissed) or when the same provider issued both within 14 days, and a group of 2 to 12 is proposed. **No model is asked and no title is written**: a proposal has an empty title and is shown as the provider and the dates, so an episode's name cannot state a clinical inference (FR-ORG-08); the owner may give it a title of their own. A proposal for the same documents keeps its id across searches; the owner confirms, or says it is not an episode and it is not proposed again. A search runs after an upload is read and after links are looked for.

The timeline and the search filter by episode, facility (the document's provider) and specialty (of a doctor named on the document). A **share link may name confirmed episodes** (`scope: 'episode'`, SECURITY.md **M-32**); the documents it shares are read from the episodes each time the link's copy is built (at creation and at each refresh while the owner's device is open). The whole-archive export carries episodes (manifest version 3), and a restore writes them back with the links, once every file is restored.

### Similarity: related documents and search by meaning

Two ways documents are related, kept apart on purpose:

- **From the data**, always on: a shared test (the same canonical name, so a lab and a clinic that call it differently still match), a shared doctor, shared tags, the same provider (`documents.relatedSignals`, one grouped query each). Exact, never stale, and free. A test or a doctor makes two documents related; a tag or a provider alone does not.
- **By meaning**, when embeddings are on: documents that read alike (another lab's report on the same condition, a consultation with a similar diagnosis, the same thing in Romanian and English), and search that finds a paraphrase.

**Embeddings** sit behind the same kind of interface as the LLM and the mailer (`core/src/embedding/`: `types.ts`, `index.ts` registry, `adapters/{none,relay}.ts`; the Vertex embedder is the relay service's, `server/src/embedding/adapters/vertex.ts`). Only Vertex exists, at a stated endpoint, region and project (inherited from the chat model's when that is Vertex), one text per call, `outputDimensionality` 768 by default, unit-length vectors. The method depends on the model, because Google serves them differently: `gemini-embedding-2` (the default, and the only embedding model the `eu` multi-region lists) is called with `:embedContent` and has no task-type field, so a document is sent as `title: none | text: …` and the search words as `task: search result | query: …`, as Google documents; older models (`gemini-embedding-001`, `text-embedding-005`) use `:predict` with `RETRIEVAL_DOCUMENT` / `RETRIEVAL_QUERY`, but are not served on the `eu` multi-region (`:predict` on them answered 404). Nothing defaults to a global endpoint and a Google API key in the environment is refused, as for the chat models (**P8**, **M-8**). Off unless `SPINE_EMBEDDINGS=vertex`; `npm run cli -- check-embeddings` tests it with one sentence and, if that fails, asks the endpoint which embedding models it serves (a metadata listing, no text).

**What is embedded** is a *card* (`similarity/card.ts`), not the pages: title, type, provider, date, summary, doctors, the fields that say what it is about (reason, diagnoses, recommendations), and the test names, cut to about 2,400 characters. Cards are short, say more per word, are built only from the database, and leave exact words and codes to the full-text index.

**Keeping vectors tied to documents** (`document_embeddings`, keyed `(document, model)`):

- Each vector stores the **model id** (`vertex:<model>:<dims>`, the vector space) and a **digest of the exact card** with the model and a card-version number. A vector is current only while the document's card still hashes to it. Editing a document, reading it again or moving a page changes the card, so the next sync finds the mismatch and embeds it again; no list of events to keep in step (the same idea as translations).
- Vectors of different models are **never compared**. Changing the model or dimensions creates a new space: documents are embedded into it in the background, search uses the new space as it fills, and once every document has a vector the old ones are removed (`pruneOtherModels`). The cards can always be rebuilt from the database, so a retired or replaced model costs a re-embedding of the archive, not a lost feature.
- Vectors are deleted with their document, with an upload's derived data and with the account; they are **not exported** (they are made again after a restore) and never returned by any route.
- A background sync (`scheduleSync`, debounced, one per person at a time, never blocking a request, failures logged) runs after an upload, a reading, a restore and an edit, and when the related routes find vectors missing. Documents the owner set aside are neither embedded nor found.

**Comparing** is a dot product over all of one person's vectors in memory: for hundreds or thousands of documents that takes milliseconds, so there is no vector index (and no `sqlite-vec`, which is pre-1.0 and a native extension) to keep in step. If an archive ever outgrew that, it is a store-adapter change.

**Search by words and meaning** (`GET /api/search/hybrid`) runs the full-text query and the vector query and merges them by rank (reciprocal rank fusion): a document both find rises, one that only one finds still appears. Meaning hits are cut to those near the best and above a floor, because every pair of texts has some cosine. The thresholds are first guesses to tune on real archives.

### The Library

Extraction names things as it reads them, so what it extracts and the app reuses can arrive spelled several ways: **tags**, **providers** (the clinic or laboratory on a document), **tests** (the names behind the trends) and **doctors**. The Library page (`/library`) manages the first three, and the doctors directory the fourth, the same way: each entry shows how many documents or values it holds, **rename** it (a name another entry already has makes the two one), or remove it. Documents are never deleted by any of it.

- Tags are kept in one form from every source (`tags.ts` `cleanTag`: trimmed, spaces collapsed, lower case), so "Cardiology" and "cardiology" are one tag. A rename or merge rewrites the tag scope of share links that use it in the same transaction; removing a tag leaves such a link with a tag that holds nothing, so it shares nothing (**P2**), never more.
- Providers are free text on documents; renaming rewrites `documents.provider` (the search index follows through its own trigger). Clearing one sets it to null.
- A test is renamed by moving its values to the new canonical name, setting their display name, and remembering the old name as an alias, so a later document that prints it is filed under the new name; renaming to another test's name merges them. Deleting a test deletes its values and its aliases.
- The model is given the person's own tags (as it is given their test names) and told to prefer them and add one only when none fits, so the vocabulary stops fragmenting at the source. The starting tags are one list, `STARTER_TAGS`.
- All of it is scoped by user in the store (**P12**); an id or name that is not the caller's is a 404.

### Reading an upload in two stages

An upload is read in two stages (SECURITY.md **M-29**). **Stage one**, `pipeline.ts`: rasterize, parse with the configured parser (`text`, `ocr`, `multimodal` or `hybrid`), decide where documents start (`continuation.ts`), store the pages and make one document per run of pages with `needs_reading = 1`. Nothing is read from a document's text: no title, date, fields, results, tags or doctors, and no stamps or signatures. The upload is `done` and unconfirmed, and the owner is told the pages are grouped (the first notice). **Stage two**, `read-upload.ts`, starts when the owner confirms the grouping: every document still marked `needs_reading` is read once (`rereadDocuments`, at most `SPINE_LLM_CONCURRENCY` at a time; progress is in the upload's layout as `reading`), then the doctors named by stamps and digital signatures are filed, then the grouping is confirmed (so the documents appear only fully read), vectors are made, links are looked for, and a second notice reports what was read. A document the model could not read stays marked and can be read again; it does not hold the others back, and if no document could be read the upload stays unconfirmed with the failure shown. A change to a document's pages (a move, a split, a join, a page set aside) marks the documents it touched, and "Done" (`/extract`) reads them at once on a confirmed upload and only marks them on an unconfirmed one. A restart in the middle loses nothing: pressing confirm again reads what is still marked. The point is that a grouping fixed by hand costs no reading, and the text goes to the provider once, for the grouping the owner approved.

### Confirming the grouping

Splitting a scan into documents is the step most likely to be wrong, and everything downstream (search, shares, trends, links, vectors) is built on it, so it is checked by the owner before anything is shown, except for an upload of exactly one page (a photo, a one-page PDF), which is one document whatever the grouping: the pipeline starts reading it itself with the grouping confirmed when that is over, so there is nothing to check and the report in the conversation is the one that says what was read. When the pipeline finishes an upload it sets `source_files.grouping_confirmed = 0` (before the status becomes `done`); `POST /api/source-files/:id/grouping/confirm` starts the reading of the documents (answering 202 while it runs) and, when that is over, sets it to 1 and then schedules the embeddings sync and the link search for the upload's documents. The column defaults to 1, so uploads made before it, restores (`archive/import-file.ts`) and tests are confirmed. One SQL fragment, `VISIBLE` in `store/sqlite/visibility.ts` (not set aside **and** upload confirmed), is what every listing of the owner's documents, the share queries, trends, doctors' lists, vectors and links use; the upload and regrouping screens ask for the documents anyway (`includeUnconfirmed`, or `includeHidden` for the regrouping screen). A document of an unconfirmed upload cannot be marked reviewed (409). Regrouping afterwards does not unconfirm the upload.

### What the owner edits stays edited

A new reading (a split or join, "Read whole document", "Read page with AI", read again) must not undo the owner's work. The store records it: `documents.owner_edited` lists the headline columns (title, doc_date, provider, doc_type, ai_summary) the owner set to a value different from the stored one, `extracted_fields.owner_edited` and `measurements.owner_edited` mark values the owner added or changed, and `removed_readings` keeps a key (`store/reading-keys.ts`: label and value, or test, value and day, lower-cased and with spaces collapsed) for each field or result the owner removed. `applyReading` leaves the edited columns alone, deletes only the unedited fields and results (`deleteUnedited`), and `storeReading` skips a new value whose key was removed or whose place (label and group, or test and day) the owner already holds. Clearing a headline value hands the column back. Tags and doctors are replaced by a reading as before. The first reading of a document has nothing to keep, so none of this applies at upload. An export of version 2 or later carries it (below), so a restore keeps it.

### Regrouping an upload

Boundary detection will sometimes be wrong, most of all in a long scan holding many documents. Every upload stays in the Upload page's history, named by the documents it became, and opens a **Pages and grouping** screen: the upload's pages as thumbnails, grouped into documents on a spine, with a split control between any two pages of a document and a join control between two documents.

- A split shortens the document and makes a new one for the rest of its pages; extracted fields move with the page they were read from, and the new document starts with the first one's tags, type, provider and date until it is read.
- A join is only with the document directly after, in the same upload; anything else is refused, since it would leave a page range that skips pages or runs backwards.
- Either way the documents it touched are **read again** (`extractFields` on their own pages' text, the same payload as at upload) and go back to review. The owner's notes are kept. The new grouping is saved first and stands even if reading fails, in which case the previous reading is kept rather than overwritten with "extraction failed".
- Clicking a thumbnail opens a large preview of that page and nothing else: arrow keys or buttons step through every page of the upload, tapping toggles zoom, Escape closes. It is deliberately view-only. Editing a document's details, its fields and re-reading it belong to the review screen, which is the separate and more capable place.
- **Neither reads at once.** The route takes `defer` and only saves the grouping; the screen keeps the touched documents (in the tab, so a reload remembers them) and **Done** calls `POST /api/source-files/:id/extract` once for all of them. That reads each from its stored page text, never the images, and answers `done`, `failed` or `skipped` (a document with every page hidden has nothing to read).
- **Moving a page.** The upload is an ordered list of pages cut into documents of consecutive pages, so a move is a change to a list of lists (`ingestion/move-page.ts`: `planMove` is pure, `movePage` applies it in one transaction): remove the page, insert it before a named page of a document (or last), or in a new document before a named one, then number the pages again in order and set each document's range from the numbers its pages have. Document order never changes. The page's fields and results follow it into its new document, a document left with no pages is folded into where its page went (as a join does), and the documents touched go back to review for Done. `page_number` is therefore a page's place in the upload, and the new `pages.source_page` is its index in the file, set once from `page_number` and never changed: the parser and the stamp reader count pages of the file, so reading a page again asks for it by `source_page` (`ai-reading.ts`). `POST /api/pages/:id/move`; 409 while the upload is being read. `source_page` is filled from `page_number` when an existing database is opened, since pages were in file order until now.
- **Hiding.** `pages.hidden` (0 or 1, added to an existing database in place, see below) sets a page aside: it stays, with its image and text, but `listForDocument`, the search view and the reading skip it. `PATCH /api/pages/:id` does one page and `PATCH /api/documents/:id/hidden` every page of a document in one statement; both send the documents back to review. A document is **set aside** when it has pages and none is shown (`store/sqlite/visibility.ts`, one SQL fragment used everywhere): then `listFor` leaves it out unless the regrouping screen asks (`includeHidden`), and so do `listForShare`, a doctor's counts and list, and the measurement trends. The screen marks it and offers to show its pages; the upload list counts it (`hidden_documents`).
- Whatever this screen changes lands in the review queue, since the queue is simply the unreviewed documents: new documents from an upload, and any document a split or join touched, are unreviewed, even if they were reviewed before.
- Thumbnails are the full-size page images, loaded lazily. A 100-page upload is heavy on a phone connection; smaller thumbnails made at rasterize time are the obvious next step.

### Export and import

**Export** is a zip with a `manifest.json` and the files it describes. One document (`GET /api/documents/:id/export`) is cut down to its own pages, not set aside by the owner (by the device's PDF tool; poppler in the Node tests), so what is handed over is not the rest of the file it was scanned with; the whole archive (`GET /api/export`) carries every finished upload as it is, with its grouping, hidden pages and the owner's edits. The manifest (`archive/manifest.ts`, validated with zod) holds, per file, the pages (text, where each word sat, how it was read, hidden or not, their order) and the documents (details, fields with their boxes, results, doctors, tags, notes, reviewed). The whole archive also holds the **links** between its documents (the care chain, in every state, so a confirmation or a dismissal survives): each names its two documents by their place in the manifest (which file, which document in it), never by id, and a single document's export has none, because a link needs both ends. A restore writes the links once the last file is restored (each file is restored in the background, and a document has an id only then), those whose two documents were both restored; a link to a document that was already in the archive, or set aside, or whose file failed, is left out, since the archive keeps its own. Version 2 of the manifest also holds what the owner keeps beside the documents (version 3 adds the episodes): which headline columns, fields and results the owner edited and which readings they removed (so a new reading still keeps and omits them), each doctor's source (text, stamp, signature) and printed code, the doctors' **directory** (`people`: those no document names too, and two people of one name as two, which documents name by position), every tag, the test names merged under another, and the answers to "are these the same?" (doctors by position, tags by name). A restore puts the directory back first (`archive/directory.ts`) so a document names the same person whichever file it is in; a version 1 export has none of it and is read as before (its doctors found by name and code). A single document's export carries only the doctors it names. It holds no ids, no paths and no user, and **no share links** (an access someone was given, with a token that is not kept) or **translations** (made again). Page images are not in it either: they are made again from the file.

**Import** goes through the upload route. A zip is told by its contents, not its name:

- `manifest.json` in the export format (`format: "spine-export"`) is a **Spine export** and is restored. The file is written out, its sha256 is taken, and `archive/import-file.ts` turns it into page images and writes the pages, documents and everything read from them as the manifest says, in one transaction. **No model is called and nothing leaves the host**; the cost is rasterising, so a large archive is a background job per file, polled like an upload. A manifest from a version this one does not know (above 3), or one that does not parse, is refused as such; one that does not fit its file (a different number of pages) leaves nothing behind and the upload is marked failed.
- anything else (including a zip with a `manifest.json` that is not an export) is a folder of files: each PDF, and each photo if photos are allowed, is uploaded as if sent alone, so it is read the way an upload is. Hidden entries, `__MACOSX`, and Office documents (also zips) are not mistaken for it.

**Duplicates** are decided twice. A file whose sha256 is already held is skipped (this also covers restoring the same archive twice). A document exported on its own is a *new* file, so its checksum cannot match; its **fingerprint** (sha256 of the normalised text of its pages, `documentFingerprint`) is compared with those of every document held, and one that matches is skipped. If a file holds some documents already present and some new, it is restored whole and the ones already present are *set aside* (their pages hidden), so nothing is twice in the timeline, search and trends, and nothing is lost if the match was wrong. A document with too little text to fingerprint (an unread scan) is recognised only by its file. The result of an upload names each zip's kind and counts (`restored`, `duplicates`, `failed`, `accepted`, `refused`) for the interface to say.

### Listing documents

`GET /api/documents` is paged: 50 by default, at most 500 per request, and a limit or offset that is not a usable number falls back to the default instead of failing. The pages that show an archive (timeline, review queue, search) fetch everything by paging in chunks, so none of them stops at the first 50 documents.

### Job state

Progress lives in an in-memory `Map` (`ingestion/jobs.ts`) — the one piece of state that does not survive a restart. `resumeStalledJobs()` runs when the device's core starts (`web/src/core/boot.ts`): a row still `pending` or `processing` has no job behind it in a fresh process, but its row and file are in the vault, so the upload is read again from its file, as Try again would (it removes what the interrupted attempt left only once the new reading has succeeded). A row made by restoring an export (`source_files.from_export`, which has no model and needs its manifest, which only the request held) and one whose file did not reach the vault before the page closed are failed instead, so they do not poll for ever.

### Grounding

Extraction returns a `source_snippet` per field; grounding locates it among the parser's per-page elements and stores a **fractional** (0–1) bounding box, so overlays scale to any rendered width. Exact substring match first, then LCS fuzzy match at 60% of the needle length.

The multimodal path gives no boxes: a model's own estimate of where text sits was unreliable, so pages it reads carry text only, and a field read from one shows the page it came from and no highlight. Boxes come from the PDF's text layer (PDF.js, exact) and from Tesseract. Pages read before this change keep the boxes they were stored with, but the UI does not draw them.

## Data

### At rest

| What | Where | Backed up? |
|---|---|---|
| Accounts: users, sessions, tokens, second factor, passkeys, consent, the vault's wrapped keys and index, share metadata (no record) | server `data/spine.db` (WAL) | **yes, required** (`VACUUM INTO` snapshot) |
| The sealed objects of every person's records and files | the object store, `vault/<user>/` (files under `data/` by default, or a bucket with `SPINE_OBJECTS=gcs`) | **yes, required** (mirror of the files; for a bucket, its versioning or soft delete) |
| Sealed share copies | the object store, `shares/<id>/` | no: a share is meant to end |
| The records themselves: documents, pages, fields, tags, shares' source rows, search index | the owner's device, in memory while the vault is open (SQLite in WebAssembly); saved as sealed objects to the vault | through the vault |
| A copy of the sealed objects the device fetched or wrote (ciphertext only), so opening the records again fetches only what is new | the owner's browser, IndexedDB `spine-sealed`, up to about 300 MB; removed at sign-out (**M-43**) | no: it is a cache of what the vault holds |
| Daily snapshots + vault mirror | `backups/` (`SPINE_BACKUP_DIR`) | it *is* the backup |

The server writes no original and no page image (it never sees one). `DATA_DIR` is set explicitly by the systemd units and the Compose file; core resolves it in one place (`resolveDataDir`) from the settings a host registered, and a process that registered none fails; the server's default is `<repo>/data`.

### Schema

Two schema files: `schema-accounts.ts` (the server's database, and the device's too) and `schema-records.ts` (the device only). The first four entries below are in the first (with `user_sessions`, `user_passkeys`, `user_devices`, `model_usage`, `vault_keys`, `vault_objects` and the `shared_*` tables, which have no entry here); the rest are the records, which only a device builds.

- `users` — id, email (unique, case-insensitive), argon2id hash, `auth_version`, `email_verified_at`, created_at.
- `user_tokens` — verification and reset links (hashed, single use).
- `user_totp` — one row per user who has started enrolling: the encrypted secret, `confirmed_at` (NULL until the first code is accepted; the factor only applies once it is set) and `last_step` (replay guard).
- `user_recovery_codes` — sha256 of each code, `used_at`.
- `source_files` — one row per upload. `status`: `pending | processing | done | error`.
- `documents` — one *logical* document: a page range within a source file. The unit that gets shared. `title` is the document's own printed title, or one extraction generated when it has none; the owner can edit it, and the UI names documents by it, never by the upload's file name (falling back to type and provider when it is empty).
- `pages` — one per rasterized page, with parser elements and the absolute `image_path`.
- `extracted_fields` — label/value per document, with page id and fractional bbox. Fields that belong together (one prescription line, one vaccine) share a `group_no`.
- `measurements` — numeric results (lab values, vitals): the name as printed and a `canonical` name that is the same across documents, the value as printed and as a number, unit, printed reference range, a low/high/normal flag, and the date taken. Trends are drawn from these.
- `measurement_aliases` — "this name means that test", written when two tests are merged (below), so a later document that uses the old name is filed under the new one. Per user; `canonical` is always a name that measurements use, and a chain of merges is flattened, never left pointing at a removed name.
- `doctors`, `document_doctors` — a per-user directory built as documents are read. A doctor's `key` is the name without titles, accents, case or word order, so "Dr. Popescu Ion" and "Ion Popescu" are one entry; initials are not guessed at, and two entries for one person are merged by hand. A document names its doctors with a role (author, prescriber, referrer, other). A doctor may also carry the professional code printed beside a signature (`license_code`, upper case without punctuation, unique per user). A reading looks the code up first, so one doctor spelled two ways joins one entry when both carry the code; a code only fills a blank and never replaces one. Signature stamps are usually pictures, so the model rarely sees the code in a scan's text: it is mostly entered by hand on the doctor's page.
- `tags`, `document_tags` — many-to-many, **scoped per user**; a new user gets starter tags.
- `share_links`, `share_link_access_log`.
- `documents_fts` — FTS5, one row per document: `title`, `doc_type`, `provider`, `ai_summary`, `user_notes`, and `body`, which holds the text of the document's pages, its extracted values, its measurements' names and its doctors' names. The view `document_search_source` says what one document contributes, and triggers on documents, pages, fields, measurements, doctor links and doctor names rebuild the rows a change touches, so no code path can change one of those and forget the index. Accents are folded ("lombara" finds "lombară"). The index is shared; search results are filtered by joining back to `documents.user_id`, and `body` is built only from that user's rows, so it leaks nothing. Typed text is never passed to the index as query syntax: each run of letters and digits becomes a quoted word that matches by its start, all words must match, and a hit in the title ranks above one deep in a page (`search-query.ts`). A search also returns, per result, a `snippet`: FTS5's excerpt from the best-matching column of that user's own row, with each match wrapped in control characters (U+0001, U+0002), never markup, which the page turns into highlighting as text nodes.

There is **no migration runner**: the schema files (`schema-accounts.ts`, `schema-records.ts`) is idempotent `CREATE TABLE IF NOT EXISTS`, re-applied every boot. That adds a new *table* to an existing database but cannot add a *column* to an existing one. So a change to an existing table needs the runner (ordered migration files plus a table recording which have run; neither exists), or an empty database. **One kind of change is made in place:** a new column with a default (`pages.hidden` was the first). `addColumnsInPlace` in `store/sqlite/connection.ts` adds it on open if it is missing, and drops and lets the schema files (`schema-accounts.ts`, `schema-records.ts`) remake any view or trigger that names it, because `CREATE ... IF NOT EXISTS` would keep the old ones. Each step is idempotent and is tested against a database made without the column. Renaming or removing a column, or changing a type, still needs the runner. Startup refuses a database from an older shape, saying how many uploads and documents it holds and whether it is safe to delete. **Build the runner before loading real records**; see [Not done yet](#not-done-yet).

### Share links

A share has a random id and a scope, and is opened with a key that lives only in the address after the `#` (**M-36**). There is no token to store: the id names a sealed copy at the server, and the recipient's browser answers `/api/share/:link/...` from the opened copy, which holds one link.

| Scope | `scope_value` | Meaning |
|---|---|---|
| `all` | — | every document **of the link's owner** |
| `tag` | tag name | that owner's documents carrying the tag |
| `document_ids` | array of ids | exactly those; ids not owned by the creator are rejected at creation |
| `date_range` | `{from, to}` | that owner's documents in range |
| `episode` | array of episode ids | the documents of those confirmed episodes, read when the copy is built and rebuilt (**M-32**) |

Expiry 1–720 hours or 1–30 days, default 7 days. Revocation deletes the sealed copy at the server. The recipient's routes run in the recipient's browser over the opened copy, so they log nothing and bind no one: what the server records is that a share was opened, when and from which country (`routes/shared.ts`), and the relay counts the calls a share's questions and translations cause. A recipient can open one document (its summary, fields, results, doctors and notes, with explicit columns: no owner id, path, source text or box). Under it the page shows the documents connected to it (the owner's confirmed links) and the shared documents that read alike, from `GET /api/share/:link/documents/:id/connections`: only documents the link shares, links as direction and kind, no reason or score (SECURITY.md **M-28**). **Page images are off unless the owner ticked `include_scans` for that link** (`share_links.include_scans`, default off): then `/api/share/:link/pages/:id/image` serves a page, but only one belonging to a document the link's scope resolves to and that the owner has not hidden, and answers 404 otherwise. A document is looked up in `listForShare(link)`, so scope and the rule that a document with every page hidden is not shared apply to both routes. The copy was built from the allow-list in the first place (`store/slice-policy.ts`), so what is outside the scope is not in it at all.

**Managing a link.** `/share-links/:id` (`ShareLinkDetail.tsx`, from Manage on the list) shows one link: what it allows now (name, expiry counted from now, scans, approval, recipient questions, language: `PATCH /api/share-links/:id`), what it shares now (and a picker to choose the documents instead, which makes the scope `document_ids`), who has read it (counts per country, the latest reads), who asked to open it (with Approve, Deny and Withdraw), and its history. Changes are checked as at creation (`checkScope`), a revoked link cannot be changed, and switching approval on drops the held requests. SECURITY.md **M-22**.

**Approval.** A link made with `require_approval` (default off) has no key in its address. The visitor's browser makes a key pair and asks the server (`/api/shared/:id/access-request`); the owner sees waiting requests at the top of the Share links page and in a mail (when a mailer exists) whose link opens `/share-requests/:id`, where Approve and Deny are `POST /api/share-requests/:id/decision`; signing in from that link returns to it (`PrivateRoute` passes the path in router state). The owner's device answers by wrapping the share key to the browser's key. SECURITY.md **M-19**, **M-36**.

**Questions from a recipient.** A link made with `allow_chat` (default off) shows a small chat on the recipient's page (`SharedChat.tsx`; `/meta` says `chat: true`). `POST /api/share/:link/chat` runs the same LangGraph agent as the owner's chat with a `Scope` in its state: the link's documents (`listForShare`) and their ids. The tools search, list tests and read series only inside it, the care-chain tool is not built for it (`buildTools(shared)`), the system prompt is `buildSharedAgentSystemPrompt` (the asker is a recipient, "the patient" is someone else, the link's label as quoted context), and nothing is stored: the page keeps the conversation and sends the last turns back. SECURITY.md **M-20**.

The recipient's page is the timeline and the document page, read-only (`PublicShareView.tsx`, sharing `DocumentCard`, the doctors and results lists and the trend views with the owner's pages): the list grouped by year, a document opening to its details beside its scans when allowed (`?d=<id>`), and a **Trends** tab when any shared document has results. Values over time come from `/api/share/:link/trends` and `/trends/series`, which are built from the shared documents' own results only: the owner's `measurements.names` and `series` cover every document, and a "latest value" from one that was not shared would leak, so the names are aggregated from `listForShare` and the series is filtered to its document ids (a test asserts a newer value in an unshared document appears nowhere). Nothing on the page links into the owner's directory or trends. Making a link: a tag is picked from the owner's tags, documents from a searchable list, a date range from two dates, and the form says how many documents the link would share.

## Egress: what leaves the host

Page images are the most sensitive egress in the system and are off unless asked for twice (see [Hybrid routing](#hybrid-routing)).

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
