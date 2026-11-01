# Interfaces and adapters

Part of the [architecture](../../ARCHITECTURE.md): the five interfaces the application defines (the store, the model, the parser, the embedder and the mailer), how an implementation is chosen, and what each promises.

Five of them: store, LLM, parser, embedder, mailer (`createEmbedder` and `getEmbedder` follow the same naming). Each is an interface the application defines; which implementation runs is chosen by configuration at startup.

## Naming

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

`create*` is unit-testable with a config literal; `get*` reads config on first use. Reading config inside `get*` rather than at module load means nothing depends on an environment variable being set before a module is first imported. Both are synchronous and there is no `init` step. Nothing is wired by default: each host's entry point registers what the process uses (`useAccountsStore()`, `useDriver`, `useNativeTools`, `useFiles`, `useSettings`, the model providers) and a process that did not fails at first use, naming it (**S3**, [docs/structure-rules.md](../structure-rules.md)). The server's `index.ts` validates its configuration before it listens, so a bad setting stops the process there (**P3**) rather than at the first request.

## Dispatch is a registry, not a switch

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

## Layout

The repository layout, file by file, is in [CLAUDE.md](../../CLAUDE.md#repo-layout). The directories that hold the interfaces: `core/src/llm/` (types, tasks, prompts, the `relay` adapter), `core/src/store/` (interfaces, registry, `sqlite/`, the only adapter, with all SQL), `core/src/parser/` (the contract, the registry, `adapters/{sidecar,ocr,multimodal,hybrid}.ts`; `sidecar.ts` is the text-layer parser), `core/src/embedding/`, `server/src/mail/` (`adapters/{none,brevo}.ts`) and `server/src/llm/adapters/` (the relay service's providers).

Two import rules, both review failures if broken. Nothing outside `core/src/store/sqlite/` writes SQL, and `core` imports no native library and no program at all (`better-sqlite3`, `sharp`, poppler ...): what it needs from the machine it asks for as a **native tool** (`core/src/native-tools.ts`), and what it stores in it over a **driver** the host chooses. Nothing outside `server/src/llm/adapters/` imports a **provider** package (`ChatAnthropic`, `ChatVertexAI`): `core` knows one provider, `relay`, and the relay service registers the others (`server/src/providers.ts`). `boundary.test.ts` holds both. `@langchain/core` is allowed above that line: an adapter returns one of its `Runnable`s per task, so it is the seam type, not a provider SDK.

## Store interface

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

## LLM interface

One interface covering what Spine asks of a model:

- `detectContinuation(pageA, pageB)` — are these the same logical document?
- `extractFields(documentText)` — structured metadata.
- `readPage(image)` — the text on one page image, no positions. Sends a page image off the host, so it is reached only through the `multimodal` adapter: the configured parser when it is `multimodal` or `hybrid`, and for a photo or a "Read page with AI" (all behind `SPINE_MULTIMODAL_ENABLED`).
- `readStamps(images)` — the doctors on a document's signature stamps (name, specialty, professional code). Sends small images, never a page, and only when the operator has allowed images to leave: `readSignatures` checks the same switch before it does anything.
- `translate`, `link`, `judgeGrouping` and `answerQuestion` — text only (a document's details, summary cards, page text for grouping, the question with matching records); `agentModel()` hands the chat agent the chat model itself.

Adapters: on the device one, `relay`, which sends the call to the relay; the relay service runs it through **Anthropic** (direct API) or **Vertex AI** (Gemini *and* Claude, EU multi-region), whichever its own `SPINE_LLM_PROVIDER` names. Configuration carries the provider, model ID and endpoint; model IDs change independently of the code (see [docs/deployment-gcp.md](../deployment-gcp.md) for current models, prices and retirement dates). Which model to run is an evaluation on real Romanian handwriting, not a design decision, and needs no code change. `SPINE_LLM_MODELS` lists further models for a person to pick when they ask for a reading ("Read page with AI", "Read whole document", extracting a document's details again): `getChatLlm(model)` builds a client for an offered id on the same provider, endpoint, region and project, once, and refuses any other, and the routes check the id against the list before using it. Uploads always use `SPINE_LLM_MODEL`.

**Vertex is a platform, not a model**, and what matters is which API serves the model:

| API | Models | Auth | EU residency |
|---|---|---|---|
| **Vertex AI**, standard endpoints | Gemini **and** Claude | service account (ADC); API keys are blocked | yes, via the `eu` endpoint |
| **Vertex AI Express** / **Gemini API** | Gemini only | API key | not the residency-bearing surface |
| **Anthropic API** | Claude only | API key | no EU-only processing commitment |

So a deployment that needs EU residency must use a service account on standard Vertex endpoints. Claude on Vertex cannot use an API key at all (`rawPredict` does not support one), and an API key present in the environment silently reroutes Google clients to a global host (**M-8** has the mechanism). **This deployment requires EU residency**; the interface still spans the other routes because another operator's instance may not.

### How the model is used

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

### What is extracted for each type

The model decides the document's type, then follows that type's guide (`llm/doc-types.ts`, the one definition used by the prompt and the review form): labs get a measurement per analyte with unit and reference range; prescriptions get repeating groups of drug, dose, frequency and duration; vaccinations a group per vaccine; imaging its modality, findings and impression; discharge notes and consultations their diagnoses, plan and follow-up, with vitals as measurements; and every type names its doctors. A clinic's "raport medical" is a consultation whose sections are free text: services performed (one `service` field each, with its result as an `investigations` field), history split into family, personal, habits and current treatment, the reason for the visit (`reason_for_visit`, which is not a symptom: a pre-travel visit has one and no complaint), symptoms and examination, the diagnosis with its ICD code (`diagnosis`, `diagnosis_code`, and `diagnosis_uncoded` for what the report left uncoded), and recommendations split into tests, vaccines, prevention such as malaria prophylaxis, lifestyle advice and medication. A medicine is a `drug` group only when prescribed or taken now; one merely advised for a travel kit or "in caz de" goes in a single `recommended_medication` field. Lab values and hormone levels quoted in that text become measurements, each with the date it was taken, which is often earlier than the visit; a date printed as a month ("03.2026") is kept as the month (`YYYY-MM`) and charted at its start, shown as "month only". The patient's national ID number, patient code and age are never extracted.

A lab bulletin is dated by when the sample was collected, not issued or released, since that is the date a trend should use. Its reference range is the one beside the result; the ranges listed for other groups (by sex, age, pregnancy) are ignored, and a bound printed as `<0.5` or `≤ 5.8` is the upper bound alone. A page numbered "1 / 1" after one numbered "3 / 3" starts a new document, which is how one PDF holding two bulletins splits.

Signing doctors and their professional codes are usually printed in a **stamp**, which is a small picture embedded in the PDF and has no text, so they are absent from a reading of the page text. `ingestion/signatures.ts` finds them without rendering a page: PDF.js lists the pictures embedded in the file on the device (poppler's `pdfimages -list` does the same in the Node tests), and the candidates are those on a document's last page that are

- not a mask, and at least 100 x 40 px;
- wider than tall but not a strip (aspect 1.2 to 4.0), which leaves out QR codes and round seals (square) and letterhead logos (long strips);
- not repeated on another page of the file, which is what a letterhead is;
- at most four, the largest first. There is no size ceiling: one real stamp was a 1580 x 878 scan.

Only those are extracted, reduced to 1000 px on their longer side, and shown to the model, which returns a name, specialty and code for each that is a doctor's stamp, and a code only if every character is legible (a wrong code is worse than none). They are filed as the document's authors, marked as coming from a stamp, so reading the text again replaces the doctors the text named and leaves these. The thresholds are first guesses to tune from what is sent (the log says how many images go per page). With image reading off, for a photo, or if anything fails, nothing is added and the upload is unaffected. Doctors are entered by hand when a stamp is not an embedded image (a scanned page, a stamp too faint to read) or is absent.

A PDF may instead carry a **digital signature**, whose certificate names the signer. `readDigitalSigners` checks it locally, so it does not depend on the image switch and sends nothing: on the device with `ingestion/signatures-cms.ts` (WebCrypto reads the CMS in the file, checks the digest of the bytes the signature covers and the signature itself, RSA and ECDSA; poppler's `pdfsig` is the Node tests' reference, run with `TZ=UTC`). The bytes must still match the signature. With the operator's trust anchors the certificates in the file are also followed to one of them; without, a name is a label from the file (SECURITY.md **S-23**). A signer counts only with both a given name and a surname in the certificate (a personal signature; a company seal has neither); the certificate's serial number is not kept. The signature covers the whole file, so the signer is filed as an author of every document in it, marked `signature` (`verified_signature` when the certificates chain to a trust anchor) so a re-read of the text leaves it. Verified against one real signed PDF (not a clinic's), where the device and `pdfsig` give the same name.

The answer is validated leniently (a missing list means none; a reference range read as `"12"` is fine) and normalised on our side: decimal commas, a flag worked out from the value and range, the document's date where a row has none. A reading with no doctors or measurements is still a reading.

### Limits and concurrency

The only cap on the text in a request is the model's context window, `SPINE_LLM_CONTEXT_CHARS` (default 300,000 characters): nothing is shortened to save money or to send less. A document over it is split into chunks at page boundaries (details from the first chunk, tags and fields gathered from all; if any chunk fails the document counts as failed). Pages are labelled with their real numbers so a field lands on the right page, including for documents that start after page 1. Because the whole text now goes to the provider, more document text leaves the host than before (see the egress table).

Reading pages, checking page pairs and extracting documents are independent, so they run in parallel, at most `SPINE_LLM_CONCURRENCY` at once (default 4). Only the waiting is parallel: every database write stays sequential, and nothing is written until the model calls for that step have succeeded.

### How it is built

LangChain.js supplies the provider implementations (`@langchain/anthropic`, `@langchain/google-vertexai`) and the shared `Runnable` type; zod validates. An adapter is given the task definitions (`llm/tasks.ts`: output budget and schema, both fixed at startup) and returns one bound client per task. Anthropic takes `maxTokens`, Google `maxOutputTokens`, both at construction; the adapters also hold each provider's credentials, endpoint and residency checks.

- **`withStructuredOutput` is an optimisation, not the validation.** Adapters bind the schema to each client; the interface validates every response with zod, so a provider that ignores the schema cannot write an unchecked shape. A validation failure logs and degrades to a reviewable fallback rather than failing the upload.
- **Residency is configuration, not code inspection.** The Vertex adapter requires endpoint, region and project to be stated (nothing defaults to a global host) and refuses to construct if a Google API key is in the environment. It does not assert the shape of the outgoing URL: that would encode Google's URL scheme and say nothing about Azure or Bedrock. Verify residency against the provider's request logs on first deployment, which works for any provider.

## Parser interface

`parse({ sourceFileId, filePath, pages }) → pages with text and boxes`. `SPINE_PARSER` picks the adapter:

- **`text`** (default; `sidecar` is the old name) — the PDF's own text layer with exact boxes, read by PDF.js on the device (`ingestion/pdf-text.ts`; the retired Unstructured sidecar is described in [docs/sidecar.md](../sidecar.md)). A page with no text layer comes back with no elements. Nothing leaves the host.
- **`ocr`** — the text layer where a page has one, local OCR (Tesseract) for the others, kept whatever its confidence. Nothing leaves the host, and handwriting is what it does poorly on.
- **`multimodal`** — every page image goes to the configured LLM provider, which returns the text in blocks, with no positions. A page the model cannot read fails the upload and names the page; there is nothing to fall back to.
- **`hybrid`** — text layer first, then local OCR (unless `SPINE_OCR=off`), then the model, per page. See [Hybrid routing](ingestion.md#hybrid-routing).

The contract every adapter keeps, so nothing downstream has to guess:

- **One entry per page image, in order.** A blank page is an entry with no elements, not an absence, so the pipeline can pair text with images by page number.
- **`image_width`/`image_height` are the image's pixel size and every box is in that space.** The text layer's boxes are in PDF points (72 per inch) while the page PNG is 200 DPI, so the text-layer adapter scales them into the image's pixels.

## Mailer interface

**Implemented.** `send({ to, subject, text })`, plus `enabled`. It exists for account messages only: verifying an address, a reset link, a notice of a sign-in from a new browser or of a changed security setting, and a share request waiting for approval; nothing else in the application sends mail. There is no attachment field and no way to add one, which is the control: a document cannot leave by this route because the route has no place to put it.

Adapters, chosen by `SPINE_MAILER`:

- **`none`** — the default. Sends nothing and reports itself disabled. The server starts with it only when registration is `operator`; `open` with `none` refuses to start.
- **`brevo`** — Brevo's transactional API over `fetch`: one request, a 10-second timeout, no retry (sending is user-triggered and a silent retry could mail a link twice). An error names the status and never the message, which holds a live link. Needs `BREVO_API_KEY`, `SPINE_MAIL_SENDER` and `SPINE_DOMAIN`.

Mail is sent **after the response**, so how long the provider takes does not depend on whether an address has an account. A failure is logged, and the page tells the user to request another link.

### Residency of the mail path

Brevo is French (formerly Sendinblue), runs EU data centres and holds ISO 27001, which fits this deployment. **Confirm it in their DPA before relying on it** — what is available publicly is third-party summary, not contractual terms.

It is a lower bar than inference regardless: under **P8** email carries a recipient address, a link and when an account event happened, never document text, a summary, a field or an attachment. So a mail provider processes personal data, never health data.

Metadata still leaks: a sender, subject or domain naming a service tells the provider, and anyone seeing the inbox, that the recipient uses it. That is the operator's call, as it is for any clinic or pharmacy that mails its patients under its own name, and it is not a legal requirement either way. The subjects are plain account wording ("Confirm your email address", "Reset your password", "New sign-in to your account", "A security setting on your account changed", "Someone is waiting for your approval"), a test fails if the text mentions anything clinical, and the sender is **required configuration with no default** (`SPINE_MAIL_SENDER`) so the operator chooses the name on purpose. The links point at `SPINE_DOMAIN`, so the domain is visible too.
