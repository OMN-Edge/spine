# Changelog

Spine is versioned `0.x` until its first production release: anything may change between minor versions, and a schema change still needs an empty database (CLAUDE.md, "Schema changes"). Releases are tags `vX.Y.Z` that match `web/package.json` ([docs/releasing.md](docs/releasing.md)). One line per change a person running or using Spine would notice; the commits say the rest.

## Unreleased

- The server's store can be Postgres (`SPINE_STORE=postgres`, `SPINE_DATABASE_URL`), so more than one instance, or a host with no disk, can share accounts, sign-ins, the vault's index and sealed shares and the relay's counts. `npm run test:postgres` runs the accounts' tests on it.
- Plans and payment, off unless `SPINE_BILLING=on` (M-45, `docs/billing.md`): a six-month trial, a free plan and Premium, sold by Paddle; AI reading is measured at the relay, and translation, questions, connections, any number of share links and visitor approval are Premium's. The privacy notice and terms say so, and every account is asked to agree to them again.
- A pricing page, a plan card on the account page, a waitlist, and a page for doctors reached from a shared page's footer; `grant-plan`, `waitlist` and `metrics` for the operator.

## 0.1.0

The first tagged version: usable for self-hosting, not yet audited (SECURITY.md).

- Records are read, searched and kept on the device; the server holds sealed pieces it cannot open (M-34 to M-38). Several devices, a recovery kit, passkeys, and a signed-in device letting a new one in.
- Scanning with the camera and uploading are one flow; a one-page upload is read at once; a failed upload says what happened.
- A new person is shown where to start, and Spine can explain itself.
- Faster reopening: a sealed copy of the vault kept in the browser (M-43), small saved parts, long-lived caching of built files.
- Sign-ins survive a restart or a deploy of the server.
- Anyone can check a site against the published code: the app says its version and commit, a `v*` tag builds and attests the web app, and `/trust` explains it in plain words (M-40).
- `SPINE_REGISTRATION=approval`: people ask for an account and the administrator approves it, with the CLI or from the app (`SPINE_ADMIN_EMAILS`). `SPINE_INSTANCE=private` labels a private deployment and refuses open signup.
