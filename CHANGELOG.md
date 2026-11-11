# Changelog

Spine is versioned `0.x` until its first production release: anything may change between minor versions, and a schema change still needs an empty database ([docs/design-decisions.md](docs/design-decisions.md#records-and-the-store), "Schema changes"). Releases are tags `vX.Y.Z` that match `web/package.json` ([docs/releasing.md](docs/releasing.md)). One line per change a person running or using Spine would notice; the commits say the rest.

## Unreleased

- The privacy notice names the accounts that share a plan and what is kept about them, so its version is raised (`HEALTH_CONSENT_VERSION`) and every account is asked to agree to the new text at its next sign-in.
- Accounts can share a plan (M-52): on the family plan the account that pays invites up to five others with a link that works once, each holds a seat with the plan's features, they share its six people (each account's own included) and its 12,000 pages, and either side can end a seat. A seat gives the one who pays no access to what a member keeps, and nothing is deleted when one ends; the account page has a "Shared plan" card for it. A larger plan would be one more entry in `core/src/billing/plans.ts`.
- When the master password was accepted and the records still do not open, the screen says which part failed (the vault could not be reached, or the records could not be loaded on this device) instead of asking for the password again, and offers Try again and a short report to copy for support. Records whose pages had been put in another order could not be opened again on any device since 30 October; fixed, with nothing to repair.
- Review in the Get started list leads to the first upload waiting for its grouping, scrolled into view, while one is waiting.
- A share link is made and opened faster, and a reader is no longer left with pages the server lacks; the first refresh of an existing link sends its pages again, once, as JPEG.
- The device's own daily limit on model calls is gone: the relay's limits (per account, per share link, per demo visitor) are the only ones. `SPINE_RELAY_DAILY_CALLS=0` now means no calls at all (it meant no limit), and `SPINE_LLM_DAILY_CALLS` is no longer read.
- The emergency card prints at home on one A4 or Letter page (the steps, a 5 cm line to check the size, and the card to cut out and fold) or for a print shop (each side on a page of exactly a bank card's size, no lines, to save as a PDF). Its front gives each value a label of its own, with allergies in red, and the mark is on both sides; on a phone the card's phone number stays on one line and the editor's contact and detail fields stack.
- Documents can be translated into about forty-five languages, chosen in the same switcher as the screens; in a language the screens are not written in they stay in English, and a line at the top of the page says so. Short fixed lists (who can do what, how long a link lasts, a filter) are chosen from rather than typed into; long ones and those that take a new entry are still searched.
- The top bar always says whose records are open, with a menu to switch person or add and manage people. An invitation followed from a link waits, with a note in the page, at the top of the page of people, saying who it is from and what it allows, with Accept and Decline. Who else can open each person's records is shown under that person. A young adult who takes over their records at eighteen sees them as simply their own, the parent who kept them is paused like the other guardians and can be let back in, and the parent's device lets go of the records and says why.
- The pages a visitor reads before an account are new: a front page that shows how a document's values are read and how records are sealed before the server keeps them, and pages of detail (how it works, how records are protected, the encryption in detail, Spine for families), in English, Romanian, French and German, light and dark.
- The assistant knows today's date, so "a year ago" or "the latest" mean what you mean; it can find documents by a period, a tag or a clinic without keywords, and sees the documents each one is linked to, so a request such as "the visit and the tests it asked for" takes fewer steps.
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
