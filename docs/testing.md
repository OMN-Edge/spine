# Testing

Two suites, for two different questions.

| | Unit and route tests | Integration tests |
|---|---|---|
| Question | Does our code do what it says, given any answer a model might give? | Does the whole thing work with the real model and real PDFs? |
| Command | `npm test` | `npm run test:integration` |
| Where | `core/src/__tests__/` (the units) and `server/src/__tests__/` (the whole composed app) | `server/src/__integration__/` |
| Model | Never. Scripted stand-ins; `vitest.config.ts` blanks the provider key so a test cannot call one by accident | The one named in `.env` |
| Speed, cost | Seconds, free | Minutes, a few hundred model calls (the configured model's price) |
| Run it | On every change | Before a release, after changing a prompt, a tool or the pipeline, and when a provider or model changes |

The unit suite is the net under every change. The integration suite is what tells you that a prompt still gets a real model to do the right thing, which nothing else can.

A test that is skipped is reported as a pass, so none is allowed to skip where its tool is expected. The PDF tests need poppler (`core/src/testing/tools.ts`): on a laptop they skip with a note, and where `CI` is set a missing tool fails the run, which is why both pipelines install `poppler-utils`. `native-tools.test.ts` in core, server and web checks that every host brings every tool the shared code asks for, and that the thin files in core pass the call on or say there is nobody to ask. `check:browser` draws a PDF with an embedded font in a worker of its own and compares the ink of two different letters, because a page can load a font that the core's worker cannot (the page images of such a file were once empty boxes). The browser checks (`check:browser`, `check:app`) stop at the first page error and print it with the server's log, instead of waiting out a timeout.

Guards that keep the fixes of the pre-release review from coming back, and where each runs. In CI (`npm test`, `npm run build`): `core/src/__tests__/ports.test.ts` (a process with no way of knowing who a request is from refuses everything; consent holds an account; the mail default follows the device's share host), `pinned-images.test.ts` (every container image is named by digest), `boundary.test.ts` (core imports neither server nor web; the server asks only for the accounts store), `core/src/__tests__/architecture.test.ts` (the structural rules, [structure-rules.md](structure-rules.md)), `web/src/core/client.test.ts` (the page keeps the core open and says so when it holds unsaved changes), `persist.test.ts` and `boot.test.ts` (a failed save keeps its changes and is retried), and the build itself, which ends with `web/scripts/check-bundle.mjs` and fails if the core's worker is split into chunks. Only on a machine with Chrome (`./scripts/check.sh browser`): `check:browser` and `check:app`, which also cover the banner while a save fails, the sign-out question, and where the next sign-in lands.

The structural rules (layering, what the shared code may import, what ships in an image, that every process starts) are in [structure-rules.md](structure-rules.md); `architecture.test.ts` and `npm run smoke -w spine-server` check them.

## Every check, and what each one answers

| Command | Question | Needs |
|---|---|---|
| `npm run build` (at the root), `npm run typecheck -w spine-core -w spine-server` | Does it compile, for core, the server, the web app and the device core (`web/tsconfig.core.json`)? Core is built first because the server uses its output | nothing |
| `npm test -w spine-core`, `npm test -w spine-server` | Does the code do what it says? Core holds the unit tests (the store contract, sync rules, the share allow-list, the parser and the model interface); the server holds the tests that drive the whole composed app, with a login. Includes `requirements.test.ts`: every `FR-`, `TR-` and `CR-` ID cited anywhere in the repository is defined once in [requirements.md](requirements.md) | nothing |
| `npm run test:accounts -w spine-server` (and `-w spine-core`) | Does it still hold on the accounts-only database the server runs (SECURITY.md **M-37**)? | nothing |
| `npm run test:shim -w spine-server` (and `-w spine-core`) | Does the same suite hold on the WebAssembly SQLite the browser runs? | nothing |
| `npm test -w spine-web` | The device: keys and vault, the core's saving and syncing (`persist`, `boot`), shares, scanning algorithms, the relay client | nothing |
| `npm run test:coverage -w spine-core` (or `-w spine-server`) | What is not run by any test (above 90% for statements and branches; the entry points and the provider calls are listed as intentionally uncovered in CLAUDE.md) | nothing |
| `npm run check:browser -w spine-web` | Does each native piece of the core work in real Chrome (text, rendering, OCR, photos, zip, stamps, signature chain)? | Chrome, a build |
| `cd web && npm run check:app` | The whole app in real browsers, against a real server and relay: sign-up, vault, upload, search, two devices on one account, shares that follow the records, signatures, passkeys, export and import | Chrome, a build |
| `npm run test:integration -w spine-server` | Does a real model do the right thing with the prompts? | a model in `.env` |

`./scripts/check.sh all` runs what CI runs: the build and typecheck, the core and server tests with `test:accounts`, the web tests, the smoke test, the dependency audit and the secret and code scans (`./scripts/check.sh browser` adds the two browser checks, which CI runs too). It does not run `test:shim` or the coverage report, and no pipeline does: run those yourself. A change that touches the store, the change log or the vault is not done until `test:accounts`, `test:shim` and `check:app` have run: each has caught a bug the others could not.

## What belongs to every store, and what to SQLite

The rules that do not depend on an engine are written once, above the adapters, and tested without a database where they can be:

| Rule | Where | Held by |
|---|---|---|
| Syncing devices: the clock, the newest change wins, a tag or doctor made twice becomes one, the newer change keeps a place | `store/sync.ts` (SQLite supplies `Rows` in `store/sqlite/changes.ts`) | `sync-engine.test.ts` on `core/src/testing/memory-rows.ts`, a store made of maps, with a random run that exchanges changes in different orders; `changes.test.ts` through the SQLite repositories |
| What a share copy holds | `store/slice-policy.ts` (SQLite chooses the rows in `store/sqlite/slice.ts`) | `slice-policy.test.ts` (every table and column of the records is named, copied, left or never shared); `slice.test.ts` (a real copy, every table looked at) |
| Which documents are shown | `store/visibility.ts` (SQLite's SQL rendering in `store/sqlite/visibility.ts`) | the contract below |
| Keys that are not the engine's counter | `store/ids.ts` | `ids.test.ts` |
| What the interface means: who sees what, order and paging, search, tags, transactions, quotas, two stores syncing | `store/types.ts` | `core/src/testing/store-contract.ts`, run for each adapter by `store-contract.test.ts` |

The contract is written as a function that takes a way to make a store. Today it runs for SQLite (native here, and on the WebAssembly driver under `npm run test:shim`). **A second adapter is finished when `describeStoreContract` passes for it**; until one exists the contract has only ever been run against the one implementation, so it may still assume something SQLite does that the interface does not say.

## Running the integration suite

```bash
npm run test:integration -w spine-server                                  # every flow
npm run test:integration -w spine-server -- src/__integration__/journey.it.ts   # one file
```

It needs:

- **A model.** It loads the repository's `.env` (`SPINE_LLM_PROVIDER`, `SPINE_LLM_MODEL`, and the provider's endpoint, region, project and credentials). If the configuration is unusable, every flow is skipped and the run says why. Embeddings are used if `.env` turns them on.
- **poppler** for the flows that read a PDF (the text layer is read in-process by PDF.js). Without it, the PDF flows are skipped, and the run says so.

It does **not** need the web server running. Each file builds the same Fastify app the server runs (`__tests__/helpers/app.ts`) and drives it with `app.inject`, through the HTTP routes and a signed-in session, as the browser does. There is no browser, so the screens are not exercised here; what they send and show is.

### What it never touches

`env.ts` forces, whatever `.env` says: an in-memory database, a temporary data and backup directory, **no mailer** (a real one in `.env` is switched off: nothing sends mail), and a session secret of its own. Your `data/`, your accounts and your mailbox are not involved. The only thing that leaves the machine is the invented text of the fixtures, to the configured model. The suite refuses to start unless it is run with `SPINE_INTEGRATION=1`, which the npm script sets.

Fixtures are invented (`support/fixtures.ts`, `support/archive.ts`): no real person, clinic or number.

## How a flow is written

- A flow is a TypeScript test that does what a person does: attach a file, wait for the report, press a button, ask the assistant, press Confirm. Pressing Confirm is sending the requests a card carries to the real routes (`confirm()` in `support/world.ts`); the card's words are the page's, so they are not tested here.
- **The model's words are not scripted.** Assertions are about what must hold whatever it says: the facts in the input (a value, a date, a code), the structure of what comes back (a proposal of the right kind naming the right documents), the safety properties (nothing changes before Confirm; a recipient learns nothing outside the link; a document's instructions are not followed; a code that differs is not merged) and the absence of invention (no number for a test that was never done).
- A model is not deterministic, so the config allows **one retry** per test. A test that needs the retry every time is a test (or a prompt) to fix, not to retry. Because a retry reruns the test, a flow that changes the world builds its own (`startWorld()` inside the test, as `journey.it.ts` does).
- Waiting for the background (reading, the analysis) is `until(what, check)`, which names what it waited for when it gives up.
- Progress is logged with a timestamp (`[journey ...]`), so a slow or stuck run shows where.

### Adding a flow

1. Put the text it needs in `support/fixtures.ts` (a PDF page is a list of lines; `makeTextPdf` makes the file) or seed records with `support/archive.ts`.
2. Use `describeLive` (needs a model) or `describePipeline` (also needs poppler) from `support/live.js`, so it skips cleanly where it cannot run.
3. Drive the app with `startWorld`, `ask`, `attach`, `proposalOf`, `confirm`, `until`.
4. Assert the invariants above. Run it a few times; if it is flaky, make the assertion say what actually must hold.
5. Add it to the list below and to the scenario it checks in [scenarios.md](scenarios.md) (status `live`).

## The flows

| File | Needs | What it goes through |
|---|---|---|
| `journey.it.ts` | model, poppler | A physician's export of six mixed pages is attached in the chat. The app reads it and reports in that conversation (documents, doctors, tests, "looks mixed"). The pages are checked with the model, the plan finds both mixed documents and is sure of them, the assistant proposes the groups, Confirm regroups and reads them again (values, date and provider come out right), the grouping is confirmed through the assistant, and a question about the result is answered with the right value and its source |
| `chat-qa.it.ts` | model | Questions about a value and its change, about the tests a consultation asked for, about "this" on a document page, about something that is not in the records (no invention), about treatment (no advice), and a follow-up in the same conversation; the archive is unchanged afterwards |
| `chat-actions.it.ts` | model | Sharing (finds the visit and the tests it asked for; reasons about dates to pick both visits and only the March tests; scans and questions are not the model's to set; the recipient then sees exactly those), a note, a correction of one result, tags, changing and revoking an existing link, asking which link when two fit, and a document that tries to give the assistant instructions |
| `tidy.it.ts` | model | The same doctor written three ways becomes one final form (name, code, specialty), a neurologist with the same surname and another code is left alone; a test named two ways; a clinic and a tag written two ways; nothing merged before Confirm |
| `recipient-chat.it.ts` | model | A doctor with a link asks about what was shared: answered from it and cited, in the third person, the owner's purpose as context; nothing from the rest of the archive however it is asked; it cannot change anything; the stream ends in the answer |
| `model-seams.it.ts` | model | The calls the pipeline makes, one at a time: page continuation, extraction of a laboratory report, a consultation and a discharge note (type, date, provider, doctors with codes, each result with unit and range, canonical names reused), the link between a consultation and the tests it asked for (right direction, a proposal), and a translation that keeps the numbers |

## The app in a real browser

The integration suite drives the server's routes with `app.inject`. Since the records live on the device (the core in a Web Worker), the whole app is also checked in real Chrome, against a real server, a relay and a model:

```bash
npm run build                 # at the root: core, server and web. The checks run the built server and web, not the sources
npm run check:browser       # each native piece of the core: text, rendering, OCR, trimming, photos, zip, stamps
npm run check:app           # the demo (with files of one's own, kept into an account), sign-up, vault, sample records, reload and unlock, search, upload, shares, export and import
```

`check:app` uses a stand-in for the model behind the real relay code. Two switches change that, and nothing else:

| | |
|---|---|
| `SPINE_CHECK_REAL=1` | Starts the relay as a process with the model, region, project and service account in `.env`, so the upload is read, the documents are embedded and a recipient's question is answered by the real provider (invented records only; the same cost and residency as the integration suite). |
| `SPINE_CHECK_RESTORE=/path/to/export.zip` | Restores a Spine export through the Upload page and checks that every document of its manifest is on the timeline after a reload and an unlock, and that no model was asked to read or write one. Only counts are printed. |

Every run also exports everything from the first account and imports it into a second one, then exports again and compares the two manifests (apart from ids, times and the numbering of the zip's entries), before and after a reload: what comes out of one device is what another puts back.

## When one fails

1. Read the first assertion that failed: it says what it expected and, for the assistant, what it said instead.
2. Run that file alone, twice. Both failing: a real regression, or a prompt that no longer works with this model. One failing: tighten the assertion or the prompt.
3. A failure in `journey.it.ts` at the report step usually means the pipeline or the text reader; later, the assistant or the regrouping. The log lines show how far it got.
4. When a flow fails here and the unit tests pass, the unit tests' world is too tidy: add a unit test that reproduces the real state, then fix. The first live runs found three such bugs, each now fixed with a unit test:
   - the finished-upload report and the match questions were blind to a new upload's own tests, because the archive-wide test list holds back an upload whose grouping is not confirmed, which is the state the report is written in;
   - the link judge's correct answer was thrown away because the model wrote the label as `[1]` (with the brackets the prompt showed it in) and the app compared it with `1`;
   - the assistant ran out of tool rounds on a request that needed several steps (find both visits, follow them to their tests, propose), so the cap went from 5 to 8 for the owner's assistant.
5. A leak check must look for details the model could not have guessed, not for words: an assistant that says "I searched for pneumonia and found nothing" has leaked nothing. `recipient-chat.it.ts` checks for the dates, durations, clinic names and titles that only the unshared documents hold.
