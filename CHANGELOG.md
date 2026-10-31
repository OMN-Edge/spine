# Changelog

Spine is versioned `0.x` until its first production release: anything may change between minor versions, and a schema change still needs an empty database (CLAUDE.md, "Schema changes"). Releases are tags `vX.Y.Z` that match `web/package.json` ([docs/releasing.md](docs/releasing.md)). One line per change a person running or using Spine would notice; the commits say the rest.

## Unreleased

- The server's store can be Postgres (`SPINE_STORE=postgres`, `SPINE_DATABASE_URL`), so more than one instance, or a host with no disk, can share accounts, sign-ins, the vault's index and sealed shares and the relay's counts. `npm run test:postgres` runs the accounts' tests on it.
- The family plan (€79 a year or €7.99 a month): Premium for up to six people, with children's records, other accounts let in, teenagers' own accounts and promotion at eighteen.
- At eighteen the person a profile is of can take it into their own account under a new key; the people who looked after them are paused until they choose, and an emergency card published for the profile becomes theirs (M-51).
- A child's records can be kept apart with a birth date (sealed, never seen by the server); other guardians can be let in, and from sixteen the child can have an account of their own at the guardian's invitation (M-50).
- Let someone else into a person's records with a code, as someone who can change them or only read them, from the account's People page; ending it gives the records a new key (M-49). The trial and the family plan include it; Premium alone does not.
- Records for more than one person in an account (M-48): a child's or a parent's records apart from your own, each with a key, search, share links and emergency card of their own; one is open at a time. The trial allows six, the free plan and Premium one.
- The emergency card is flagged for a look after a year and its owner is mailed once a year, and a lost code can be replaced by a new one (the old stops opening at once).
- The emergency card can keep official details (identification and insurance numbers, a card number, organ donor), each on the card only when ticked, and can be printed at the size of a bank card. A person's name and a child's birth date can be corrected.
- The emergency card (M-47): the owner writes a short card, turns it on, and anyone who scans its code reads it with no account; every opening is logged and the owner is mailed. An optional code holds the card as plain text for use with no signal. It is on every plan.
- The sealed bytes can be kept in a Google Cloud Storage bucket instead of files (`SPINE_OBJECTS=gcs`, `SPINE_GCS_BUCKET`), so the server needs no disk of its own; files stay the default.
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
