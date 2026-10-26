# Contributing

The canonical repository is on GitHub; issues and pull requests go there. Public links to the source, the docs and the security policy go through the instance's own domain (`/source`, `/docs`, `/security`), so the host can change without breaking them.

- **Security problems** are not issues: see [Reporting a vulnerability](SECURITY.md#reporting-a-vulnerability).
- **Licence.** The project is AGPL-3.0-only ([LICENSE](LICENSE)). By sending a pull request you license your contribution under the same terms.
- **Read first.** [ARCHITECTURE.md](ARCHITECTURE.md) and [SECURITY.md](SECURITY.md) are the design contract: a change is judged against a numbered principle and the checklist at the end of SECURITY.md. Touching routing, auth, share links, storage, providers or static serving means reading both.
- **Structure.** [docs/structure-rules.md](docs/structure-rules.md) defines what a clean change is (direction of imports, what the shared code may use, nothing wired by default, every process started by a test) and `core/src/__tests__/architecture.test.ts` enforces it. An exception is added to the test and that page together.
- **Checks.** `./scripts/check.sh all` runs what CI runs: tests, typecheck, dependency audit, gitleaks, semgrep. A change that adds behaviour comes with a test that fails without it.
- **No real data.** Samples, fixtures and screenshots use invented names, codes, values and dates. Never commit a real record.
- **Commits** describe a finished unit of work, in plain prose.
