# Testing

Two suites, for two different questions.

| | Unit and route tests | Integration tests |
|---|---|---|
| Question | Does our code do what it says, given any answer a model might give? | Does the whole thing work with the real model, the real sidecar and real PDFs? |
| Command | `npm test` | `npm run test:integration` |
| Where | `server/src/__tests__/` | `server/src/__integration__/` |
| Model | Never. Scripted stand-ins; `vitest.config.ts` blanks the provider key so a test cannot call one by accident | The one named in `.env` |
| Speed, cost | Seconds, free | Minutes, a few hundred model calls (the configured model's price) |
| Run it | On every change | Before a release, after changing a prompt, a tool or the pipeline, and when a provider or model changes |

The unit suite is the net under every change. The integration suite is what tells you that a prompt still gets a real model to do the right thing, which nothing else can.

## Running the integration suite

```bash
cd server
npm run test:integration                                  # every flow
npm run test:integration -- src/__integration__/journey.it.ts   # one file
```

It needs:

- **A model.** It loads the repository's `.env` (`SPINE_LLM_PROVIDER`, `SPINE_LLM_MODEL`, and the provider's endpoint, region, project and credentials). If the configuration is unusable, every flow is skipped and the run says why. Embeddings are used if `.env` turns them on.
- **The sidecar and poppler** for the flows that read a PDF. If a sidecar answers at `INGESTION_URL` (default `http://127.0.0.1:8000`) it is used; otherwise one is started from `ingestion-service/.venv` on port 8765 and stopped afterwards. Without either, the PDF flows are skipped, and the run says so. `pdftoppm` must be installed.

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
2. Use `describeLive` (needs a model) or `describePipeline` (also needs the sidecar and poppler) from `support/live.js`, so it skips cleanly where it cannot run.
3. Drive the app with `startWorld`, `ask`, `attach`, `proposalOf`, `confirm`, `until`.
4. Assert the invariants above. Run it a few times; if it is flaky, make the assertion say what actually must hold.
5. Add it to the list below and to the scenario it checks in [scenarios.md](scenarios.md) (status `live`).

## The flows

| File | Needs | What it goes through |
|---|---|---|
| `journey.it.ts` | model, sidecar, poppler | A physician's export of six mixed pages is attached in the chat. The app reads it and reports in that conversation (documents, doctors, tests, "looks mixed"). The pages are checked with the model, the plan finds both mixed documents and is sure of them, the assistant proposes the groups, Confirm regroups and reads them again (values, date and provider come out right), the grouping is confirmed through the assistant, and a question about the result is answered with the right value and its source |
| `chat-qa.it.ts` | model | Questions about a value and its change, about the tests a consultation asked for, about "this" on a document page, about something that is not in the records (no invention), about treatment (no advice), and a follow-up in the same conversation; the archive is unchanged afterwards |
| `chat-actions.it.ts` | model | Sharing (finds the visit and the tests it asked for; reasons about dates to pick both visits and only the March tests; scans and questions are not the model's to set; the recipient then sees exactly those), a note, a correction of one result, tags, changing and revoking an existing link, asking which link when two fit, and a document that tries to give the assistant instructions |
| `tidy.it.ts` | model | The same doctor written three ways becomes one final form (name, code, specialty), a neurologist with the same surname and another code is left alone; a test named two ways; a clinic and a tag written two ways; nothing merged before Confirm |
| `recipient-chat.it.ts` | model | A doctor with a link asks about what was shared: answered from it and cited, in the third person, the owner's purpose as context; nothing from the rest of the archive however it is asked; it cannot change anything; the stream ends in the answer |
| `model-seams.it.ts` | model | The calls the pipeline makes, one at a time: page continuation, extraction of a laboratory report, a consultation and a discharge note (type, date, provider, doctors with codes, each result with unit and range, canonical names reused), the link between a consultation and the tests it asked for (right direction, a proposal), and a translation that keeps the numbers |

## When one fails

1. Read the first assertion that failed: it says what it expected and, for the assistant, what it said instead.
2. Run that file alone, twice. Both failing: a real regression, or a prompt that no longer works with this model. One failing: tighten the assertion or the prompt.
3. A failure in `journey.it.ts` at the report step usually means the pipeline or the sidecar; later, the assistant or the regrouping. The log lines show how far it got.
4. When a flow fails here and the unit tests pass, the unit tests' world is too tidy: add a unit test that reproduces the real state, then fix. The first live runs found three such bugs, each now fixed with a unit test:
   - the finished-upload report and the match questions were blind to a new upload's own tests, because the archive-wide test list holds back an upload whose grouping is not confirmed, which is the state the report is written in;
   - the link judge's correct answer was thrown away because the model wrote the label as `[1]` (with the brackets the prompt showed it in) and the app compared it with `1`;
   - the assistant ran out of tool rounds on a request that needed several steps (find both visits, follow them to their tests, propose), so the cap went from 5 to 8 for the owner's assistant.
5. A leak check must look for details the model could not have guessed, not for words: an assistant that says "I searched for pneumonia and found nothing" has leaked nothing. `recipient-chat.it.ts` checks for the dates, durations, clinic names and titles that only the unshared documents hold.
