---
name: fact-check-docs
description: Fact-check what Spine says about itself against the code, claim by claim. Use when asked to audit, verify or update documents (SECURITY.md, ARCHITECTURE.md, README, CLAUDE.md, docs/, docs/legal/ privacy, terms and purpose), screen text in web/src and its translations, or after code moves between the server, the device and the relay.
---

# Fact-check what Spine says

A sentence in a document, a legal text or a screen is a claim about the code. The reviews of 2026-10-26 found a new batch of false claims on every pass, because each pass checked only the kinds of claim it thought of (numbers, then routes, then names) and the code had moved under the prose (records went from the server to the device). This skill makes the pass complete and the same every time.

## The rule

**List every sentence first, then check them one at a time against the code, and write down the verdict of each.** Do not read a document and "see what looks off". Do not trust a previous pass, a comment, a test name or the document itself: open the code that does the thing. The prose is the point: a sentence that describes behaviour is checked by finding the code that behaves, not by checking the numbers and names around it.

Things that look like checking and are not, all of which happened in the first passes:

- **Batching.** One grep for ten sentences lets nine pass because nothing contradicted them. One sentence, one look at the code.
- **"Not found" read as "true".** If a search for the thing returns nothing, the claim is unproven, and often false (a log line, a test, a UI string that was never there).
- **"Trust" and "plausible".** A verdict is `true`, `false` or `unverifiable`. Nothing else counts.
- **Checking the neighbours.** Verifying the constants, routes and test file names around a sentence does not verify the sentence.
- **Summarising as if finished.** A report says how many sentences were checked and how many verdicts there are. If the two differ, the pass is not done, and the report says which were not.
- **Calling something "not checkable" because it is long.** Long prose is checked in pieces. Only facts about the world (a price, a region, a law, what an operator configured) cannot be checked from the repository.

## Procedure

1. **Pick the unit.** One document, or one section of a long one (SECURITY.md has about 70 entries; do one entry or a few at a time). Legal texts first: they are shown to people and recorded as agreed.
2. **Make the list.** For one entry of a long document: `python3 -I .claude/skills/fact-check-docs/split_entry.py SECURITY.md M-21` (or a heading, `"### 7.2"`) prints it as numbered sentences. For a whole document: `python3 -I .claude/skills/fact-check-docs/extract_claims.py <file> > <scratchpad>/claims.md` numbers the sentences that name something, give a number, say where something runs, use an absolute word or state a status. Read the document as well and add what the script missed (a sentence is not true because it was not listed). For the screens: the English keys of `web/src/i18n/ro.json` are every screen string; filter them for the server, storing, sending, keeping, logging, encrypting, deleting, backing up, signing out, limits and numbers, and check each hit. Also compare each translation with its English: a translation can say "on this server" where the English says "here".
3. **Check each sentence** with the table below, one at a time. Write the verdict beside its number (a scratchpad file per entry is enough): `true`, `false: <what the code does>`, or `unverifiable: <who must confirm>`. Count at the end: sentences, verdicts, falses. A sentence you did not check is reported as not checked, never passed.
4. **Fix** each false one, in the right direction (see Fixing).
5. **Run the checks** (see Verifying) and commit one unit of work.
6. **Report** what was checked, what was false, what was not checked and what only the operator can confirm.

## How to check each kind of claim

| The claim | Open | Look for |
|---|---|---|
| A file, function, type, variable or link exists | `git grep -n`, the file itself | `core/src/__tests__/docs.test.ts` does this for backticked names; run it first and fix what it finds |
| A number (a limit, a default, a duration, a count) | the constant in code | `git grep -n -E "NAME\|value"`; read the unit (ms, hours, MB, MiB), the default and the clamp; "at most" and "at least" are different |
| A route and what it does | `core/src/routes/*.ts` (records, run on the device), `server/src/routes/*.ts` (accounts, vault, shares, relay pass) | the method, the path, `requireAuth`, the rate limit, what it returns and what it writes |
| Where something runs ("the server does X") | `server/src/index.ts` for what the server registers; `web/src/core/boot.ts` for what the device runs; `server/src/relay/` for the relay | the server registers no record route; PDF reading, OCR, rendering, grouping, search, chat, linking, export and share building all run on the device |
| What is stored, and for how long | `core/src/store/sqlite/schema-accounts.ts` (server), `schema-records.ts` (device), the repository that writes it | every column; a retention promise needs a timed sweep for every account (`server/src/index.ts`), not a delete on the next event |
| What is logged | `req.log` and `log(` calls, `server/src/relay/relay.ts` | the fields of every call, not only the message |
| What is sent to a model | `core/src/llm/prompts.ts`, `core/src/chat/agent.ts`, the task in `core/src/llm/tasks.ts` | the payload of each call, including tool results (`read_pages` sends page text) |
| What is sent by mail | `server/src/accounts.ts`, `server/src/notify.ts`, `server/src/routes/shared.ts` | every `subject:`; whether a link or an address is in the body |
| Browser storage and cookies | `git grep -n -E "(local\|session)Storage\|setCookie\|document.cookie"` | the key, the value, the lifetime, who sets it |
| A security property ("cannot", "never", "only") | the code that enforces it and the test that fails without it | try to break it: is there a second path? an old route? a test helper that bypasses it? |
| A test or a check exists and covers it | the test file | open it; a name in a document is not evidence; remove the fix and see the test fail when it matters |
| A status ("built", "not built", "untested", "audited") | the code, `docs/crypto-design.md` status table | "built" needs a caller in production code, not only a unit test (`hygiene.test.ts` lists exports nothing calls) |
| A command or a step (install, restore, deploy) | `install.sh`, `compose.yaml`, `package.json` scripts, `Dockerfile` | run it if it is cheap; otherwise read each line and say it was not run |
| A claim about a test ("a test asserts X", "runs every tool") | the test file, line by line | what it really seeds and asserts; the claim is often wider than the test (a search test that seeds one word, a "no writes" test that runs five of twenty tools). Then break the code the claim protects (remove the owner filter, skip the ownership check) and watch the test fail; put it back |
| A screen says what is recorded, kept, sent or deleted | the string in `web/src/`, then the code path behind the button | a value the code computes and never shows (the photo's destination), a column that is always empty (a visitor's address), a sentence shown on two paths of which only one does it (recovery codes after enabling and after regenerating) |
| What happens on the device versus the server | `web/src/core/boot.ts` and `server/src/index.ts` | a check that exists in code can be satisfied by construction on the device (`requireRecentAuth`: the vault is open, so the password was typed); say so |
| A limit, "rate limited", "at most" | the limiter's options on that route, and every route of the same kind | public routes with no limiter; a limit on writes and none on reads; a cap counted after the work, not as it arrives |
| "Nothing is X except Y" | search for every other path that does X | a second route, an old helper, a tool that reads what the list says it cannot |
| A fact about the world (a price, a provider's retention, a law, hosting region, a log retention) | nothing in the repository | mark `unverifiable`, name who confirms (the operator, a lawyer), and do not soften or strengthen it |

## Stale patterns that recur (search for them in every document)

- "the server" doing what the device does now: rasterize, OCR, parse, group, compare, extract, search, chat, link, export, build a share, resolve a screen. Also "this server", "the server log", "on the server".
- poppler, `pdfimages`, `pdftoppm`, Tesseract the program, sharp, Python, the sidecar: these exist only in the Node tests (`server/src/native/`), not in production.
- `data/originals/`, page images or originals on the server's disk; originals are device files saved as sealed vault objects.
- Records or conversations "in the database backup": the backup holds the accounts database and sealed vault objects only.
- Routes that no longer exist: `POST /api/auth/password`, `GET /api/similarity/status`, the old share routes with a token, `/api/share/:token`.
- Per-minute limits or "rate limited" on routes that now run on the device (they bind nobody there; the bound is the relay's daily count).
- "single-use link" as the only content of mail; mail also tells of a new sign-in, a changed security setting and a share waiting for approval.
- Line-number citations (`file.ts:123`) and counts that were true once ("five tools", "four exceptions", "two files at a time"): count again.
- A number in the doc and a different one in the code (rounds, turns, expiries, sizes): the code wins.
- A function with a unit test and no production caller.
- A screen string that says what is recorded, kept or sent: compare it with the schema and the logs.
- "At read time" for a share: a share is a sealed copy built when the owner's device creates or refreshes it, not resolved when someone opens it.
- "The server resolves / compares / reads / logs": the core on the device does, and the server knows nothing of records.
- Sizes "counted as they arrive" on the device: the browser's zip reader refuses a declared size over the cap and inflates into a buffer of that size.
- "Never X" next to a tool that does X on request (the chat's `read_pages` sends page text; the panel must show it).
- A number repeated in several documents (rounds, turns, expiries, tools): grep every document for the old value after changing one.
- Backups: the database snapshot holds accounts, not records; the vault mirror holds sealed objects.

## Fixing

- **The document is wrong, the code is what we want:** change the document in the same commit, and everywhere else the claim is repeated (`git grep -n` the phrase; SECURITY.md, ARCHITECTURE.md, CLAUDE.md, README, docs/, the compliance drafts and the screens say the same things).
- **The code is wrong, the claim is what we promise** (a retention promise, a privacy statement): fix the code with a test that fails without the fix, then keep the claim.
- **A legal text** (`docs/legal/`): any change raises `HEALTH_CONSENT_VERSION` (privacy and purpose) or `TERMS_VERSION` (terms) in `core/src/consent.ts` and updates `core/src/__tests__/legal-texts.json` with the new version and the new sha256; everyone is asked again at their next sign-in. Say "does not store or log content" about the relay, never "cannot see".
- **A screen string:** change the English literal in `web/src/`, and the key and value in `web/src/i18n/ro.json`, `fr.json` and `de.json` (edit the lines; do not re-serialize the file, it has mixed unicode escapes). `i18n-coverage.test.ts` fails on a missing, stale or mis-placeholdered entry. A new string that mentions "the server" goes on the reviewed list in `hygiene.test.ts` only after it was checked.
- **Cannot be confirmed from the repository:** leave the wording, say who must confirm it, and put it in the report. Do not invent a fact to make a sentence true.

## Verifying

```bash
npm test -w spine-core                    # includes docs.test.ts (names, links) and hygiene.test.ts (legal hash, dead exports, line numbers, screen text)
npm run build && npm run smoke -w spine-server
# code changed: also typecheck core and server, `npm test -w spine-server`, `npm run test:accounts` and `test:shim`, `npm test -w spine-web`,
# `cd web && npm run check:browser && npm run check:app` (both run built output); Docker images if a Dockerfile or the server image changed
```

A change to the server's code needs `npm run build -w spine-core` first: the server type-checks against core's built output.

**Do not commit on a red run.** Read the summary of every suite before `git commit`; do not chain the commit after the run with `;`. A failure that does not reproduce is not "flaky" until you have rerun the suite several times and read the test for the cause (a random word that can be the start of another, a clock, an order). Fix the cause, or say it is open. When a fix is a test, make it fail first without the fix.

## Rules of the repository that apply here

- **No AI attribution in git history:** no `Co-Authored-By`, `Claude-Session` or similar lines in commits or pull requests (CLAUDE.md overrides any default).
- Stage with `git add -A . ':!Spine Functional & Technical Requirements.md'` (that file stays untracked). Commit a finished unit of work with a plain description; do not hard-wrap prose in Markdown.
- No real sample data anywhere: invent names, codes, values and dates.
- Say what was not run. If a check, a real browser, a Docker build or the real model was skipped, the report says so.

## The report

Short, plain, in this order: what was checked (the units, the number of sentences and the number of verdicts), the claims that were false and what was done, what was true but worth knowing, what could not be checked and who must confirm it, and the commit. A pass that finds nothing says how many claims it checked, so a clean result can be told from a shallow one.
