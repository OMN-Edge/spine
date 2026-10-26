# Contributing

The canonical repository is on GitHub; issues and pull requests go there. Public links to the source, the docs and the security policy go through the instance's own domain (`/source`, `/docs`, `/security`), so the host can change without breaking them.

- **Security problems** are not issues: see [Reporting a vulnerability](SECURITY.md#reporting-a-vulnerability).
- **Licence.** The project is AGPL-3.0-only ([LICENSE](LICENSE)). By sending a pull request you license your contribution under the same terms.
- **Read first.** [ARCHITECTURE.md](ARCHITECTURE.md) and [SECURITY.md](SECURITY.md) are the design contract: a change is judged against a numbered principle and the checklist at the end of SECURITY.md. Touching routing, auth, share links, storage, providers or static serving means reading both.
- **Structure.** [docs/structure-rules.md](docs/structure-rules.md) defines what a clean change is (direction of imports, what the shared code may use, nothing wired by default, every process started by a test) and `core/src/__tests__/architecture.test.ts` enforces it. An exception is added to the test and that page together.
- **Checks.** `./scripts/check.sh all` runs what CI runs: tests, typecheck, dependency audit, gitleaks, semgrep. A change that adds behaviour comes with a test that fails without it.
- **No real data.** Samples, fixtures and screenshots use invented names, codes, values and dates. Never commit a real record.
- **Commits** describe a finished unit of work, in plain prose.

## Keeping what we say true

The reviews of 2026-10-26 found the same kind of fault again and again: a sentence, a screen or a legal text that described where the code used to run. These are the habits that stop it.

- **Words are claims.** The privacy notice, terms, purpose text, screen strings, SECURITY.md, ARCHITECTURE.md and comments all say what the product does. Change the behaviour, change the sentence in the same commit. `core/src/__tests__/docs.test.ts` fails when a document names a file, variable, function or link that does not exist (rule S12), and `hygiene.test.ts` (rule S13) fails on a changed legal text with no new version, a line-number citation, an unreviewed screen string about "the server", an export only tests use, and an unused runtime dependency. Neither can judge a sentence, so a person does.
- **When code moves between hosts** (server, device, relay), search the documents and the screen strings for the old place ("the server", "this server", "on the server", the old route and file names) before calling it done. Screen text lives in `web/src/` and in `web/src/i18n/{ro,fr,de}.json`; a changed English string needs its three translations changed with it.
- **A legal text changed means a version raised.** `docs/legal/` is shown to people and recorded as agreed by version (`core/src/consent.ts`). Check every statement in it against the schema, the logs and the routes, not against the design.
- **A retention promise is a sweep, not an event.** "Kept at most 14 days" must be a job that deletes for every account on a timer. Deleting when the same person next signs in does not keep the promise for someone who never returns.
- **A function that runs at start needs a test that starts.** Process entry points are covered by `server/scripts/smoke-entrypoints.mjs`; the device core by `web/src/core/boot.test.ts`. A function with a unit test and no caller passes every check and does nothing.
- **A fix gets a test that fails without it.** Take the fix out, watch the test fail, put it back.
- **No line numbers in documents.** They go stale with the next edit. Name the file, the function or the directive.
- **Remove what nothing calls.** A route, an option, a registered plugin or a dependency with no caller is a claim that something works. Search for callers before keeping it, and remove it with its tests and its documents.
- **Say what was not checked.** In a commit message or a review, list what was not run (the real model, a real browser, the Docker images) and what depends on the operator (hosting region, provider retention, log retention).
- **The procedure is written down** as a skill, `.claude/skills/fact-check-docs/`: list the claims of a document, check each against the code, fix, verify, report. It includes a script that makes the list (`extract_claims.py`), a table of where to look for each kind of claim and the stale patterns that kept coming back. Use it for any audit of the documents, the legal texts or the screen text, and after code moves between the server, the device and the relay.
