# Security

Spine holds complete medical histories and exposes part of them to the public internet through share links. It is self-hosted, multi-user, and runs on hardware as small as a Raspberry Pi.

This document states the posture it is **supposed** to hold, records which controls actually exist, and lists the gaps between the two.

It is written to be enforced: every principle is phrased so a change can be judged against it, and every gap names the principle it violates. See [ARCHITECTURE.md](ARCHITECTURE.md) for the component and trust-boundary model.

> **Status.** Built and tested: multi-user accounts with every query scoped by owner,
> argon2id passwords, open signup with email verification, recovery links, optional TOTP
> two-factor, and hybrid parsing with image egress behind two switches. Every defect found
> so far is fixed or accepted ([Known gaps](#known-gaps)). Not yet exercised against a real
> provider or sidecar: reading a page image, and the sidecar's box scaling. Nothing here
> claims compliance with any regulation.

## Distribution and who owns the risk

The primary deployment is the author's family. Others may self-deploy, or pay the author to set up an instance. In every case **the operator of an instance is the data controller for its contents and owns the risk.** The author is not a processor for other people's medical data.

Operators will not be security experts, so:

- Insecure configurations must be **unreachable by default**, not merely documented against. A default that works but is unsafe is a defect (**P3**).
- Anything that sends data off-host must be an explicit, reversible choice (**P8**).
- The software should refuse to start rather than run in a state the operator would not have chosen knowingly.

## What we are protecting

| Asset | Why it matters |
|---|---|
| Document text, summaries, extracted fields | Medical history. |
| Original scans (`data/originals/`) | Same, plus signatures, ID numbers, letterheads. |
| Page images | The full document rather than an extract — the most sensitive egress. |
| `data/spine.db` | All of the above, every user's credential hash, every live share token. |
| User credentials | Account takeover. Reused passwords make this worse than local. |
| Share tokens | Read access to a subset, with no account and no second factor. |

### Adversaries we design against

1. **Untargeted internet traffic** — scanners, credential stuffers, crawlers. Constant and automated. Reaches login, registration, and share URLs.
2. **Another user of the same instance.** New with multi-user and the boundary most easily broken by a careless change. A family member is not an attacker, but the control must hold regardless of intent — a query missing an owner filter leaks silently and nobody notices.
3. **A share-link recipient exceeding their scope** — a doctor, or whoever the link was forwarded to, reaching data outside what was shared.
4. **A leaked share link.** Forwarded email, shared screen, clinic browser history. Assume tokens leak eventually.
5. **An attacker who obtains `spine.db`** — stolen backup, misconfigured static mount, lost SD card.

### Explicitly out of scope

- **An operator with shell access to their own instance.** They can read the database. This is inherent to self-hosting and is stated plainly rather than designed around. It is also why there is no in-app admin role: no *application* path reads another user's records.
- An attacker with physical possession of the host, or root on it. Disk encryption is the host's job.
- Targeted attack on the chosen inference provider or on Let's Encrypt.

## Principles

A change that breaks one of these is a defect, whether or not a test catches it.

**P1 — Deny by default.** A route is private unless deliberately and visibly public. "Public" means living in a route file with no `requireAuth` preHandler, so **adding a route to the wrong file silently publishes it**. `isolation.test.ts` fails on any route that answers without a session and is not on its allow-list; every public route must be justified in this document.

**P2 — Scoping fails closed.** If a share link's scope cannot be fully resolved, return nothing. A missing, malformed or unrecognised scope is an error, never "return everything".

**P3 — No fallback secrets, no unsafe defaults.** The service must refuse to start rather than run with an absent, default or weak secret — one committed to the repo as a fallback is a published secret. Extended for self-hosting: any default an unaware operator would not have chosen is treated the same way.

**P4 — Medical content is served only by authenticated, auditable handlers.** Never a static file mount: `DATA_DIR` holds `spine.db` and the original scans, so a mount rooted there is one flag from publishing the archive.

**P5 — Every unauthenticated endpoint is rate limited.** Login, registration, share-token reads.

**P6 — Capability tokens and secrets are hashed at rest.** Possession of the database must not confer the ability to use the share links described in it.

**P7 — Every non-owner data access is logged.** Token, timestamp, source address, and the scope served. Append-only, and part of the backup set.

**P8 — Egress is minimal, enumerated, explicit and disableable.** The only third parties are the configured inference provider and, for account links, the mail provider. Four rules:

- Every egress path is listed in [ARCHITECTURE.md](ARCHITECTURE.md). A new one is a change to that document first.
- **Page images leaving the host requires an explicit opt-in**, and the deployment must be able to disable that path entirely and accept weaker OCR.
- **Residency is a property of the endpoint, not the model.** An adapter that can fall back to a global endpoint, or authenticate in a way known to ignore the configured location, is a defect.
- **Email carries no medical content — ever.** The mail path exists only for account recovery and verification: a recipient address and a single-use link. No document text, no summary, no extracted field, no attachment. This is what keeps a mail provider from becoming a processor of health data, and the mailer interface has no attachment parameter precisely so the capability cannot be reached. The subject and body say nothing clinical either. The sender name is the operator's choice: it can be the company or the product, which tells the provider and anyone seeing the inbox that the recipient uses that service, and no more. An operator who wants less visible than that picks a more neutral name.

**P9 — Least privilege at the OS layer.** Services run unprivileged with `ProtectSystem=strict`, `NoNewPrivileges`, write access narrowed to `data/`. The parser sidecar binds loopback only; it has no auth and accepts a filesystem path, so it must never be reachable off-host.

**P10 — Tests exercise the real path.** A control is untested unless the test drives it the way production does. A fixture that builds state directly, bypassing the handler that encodes it, proves nothing.

**P11 — Recoverable by design.** `data/spine.db` and `data/originals/` must be restorable. `data/pages/` is regenerable.

**P12 — Isolation is structural, not remembered.** Every read and write is scoped by owner **in the store layer**. A repository method that does not take an acting user id, or that can return a row the acting user does not own, is a defect. Route handlers must not be able to write queries, so isolation cannot be forgotten in one. The four exceptions are listed in **M-1**; the main one is a share-token read, scoped by the link's owner resolved from the token, never from a session.

**P13 — Credentials are stored with a memory-hard KDF and are never recoverable.** argon2id, per-user salt, parameters tuned to the host. No password in a log or error, and no reset path that reveals the old value. Changing a password invalidates that user's existing sessions. The one reversible secret is a TOTP seed, which has to be read back to check a code; it is encrypted at rest and is a recorded exception (**S-21**), and recovery codes and tokens are hashed. A second factor, where enabled, applies to every way of obtaining a session (**M-12**).

## Controls in place

Verified present.

### Network and transport

| Control | Where |
|---|---|
| TLS, HTTP→HTTPS 301 | `nginx/spine.conf:18,24` |
| HSTS, `max-age=31536000; includeSubDomains` | `spine.conf:43` |
| `X-Content-Type-Options: nosniff` | `spine.conf:44` |
| `X-Frame-Options: DENY` | `spine.conf:45` |
| `Referrer-Policy: no-referrer`, restrictive `Permissions-Policy` | `spine.conf:46-47` |
| CSP: `default-src 'self'`, no `unsafe-inline` for scripts, `frame-ancestors 'none'` | `spine.conf:54` |
| All of the above repeated inside `location /share/`, which would otherwise inherit none | `spine.conf:62-71` |
| Share links `noindex, nofollow` + `Cache-Control: no-store` | `spine.conf:59-60` |
| Rate limit on `/share/` — 20 r/m, burst 5 | `spine.conf:2,58` |
| Dotfile requests denied | `spine.conf:102` |
| Upload cap 200 MB (nginx and Fastify) | `spine.conf:35`, `index.ts` (multipart limit) |
| Responses select explicit columns — no server paths, no raw share tokens | `routes/documents.ts`, `routes/share.ts` |
| Fastify binds `127.0.0.1` by default, so nginx is the only public listener | `config.ts`, `index.ts` |

### Application

| Control | Where |
|---|---|
| Startup refuses a missing, short or placeholder `SESSION_SECRET`; same check at deploy | `config.ts`, `install.sh` (`check_secrets`) |
| Session cookie `httpOnly`, `sameSite: strict`, `secure` in production | `index.ts` |
| Passwords hashed with argon2id (19 MiB, 2 passes), 12–256 characters | `passwords.ts` |
| Login by email; an unknown email and a wrong password give the same answer and take the same time | `routes/auth.ts` |
| New session id on login, so a fixed one is not kept | `routes/auth.ts` |
| Every request re-resolves its session to a live user; a changed password ends other sessions | `routes/middleware.ts` |
| Login rate limited per source (10 / 10 min) and instance-wide (50 / 10 min) | `routes/auth.ts` |
| Failed and successful logins logged with source address, never the password or the email tried | `routes/auth.ts` |
| Every route refuses an unauthenticated request unless on a short allow-list; a test fails otherwise | `__tests__/isolation.test.ts` |
| Every statement on a user-owned table filters by `user_id`; none runs without an acting user | `store/sqlite/` |
| A record that is not the caller's answers 404, the same as one that does not exist | `routes/` |
| A create naming another user's record throws and inserts nothing | `store/sqlite/` |
| Search is filtered by owner by joining back to `documents.user_id` | `store/sqlite/documents.ts` |
| A share link may name only its creator's documents, checked at creation | `routes/share.ts` |
| Tags are per user | `store/sqlite/tags.ts` |
| Measurements and the doctors directory are per user: a value cannot sit on another user's page, a doctor cannot be linked, merged or edited across users, and a doctor's match key is unique per user, not global | `store/sqlite/measurements.ts`, `doctors.ts`; `__tests__/structured.test.ts`, `trends-doctors.test.ts` |
| Originals stored under `data/originals/<user>/<year>/` | `routes/source-files.ts` |
| An owner can delete one upload (`DELETE /api/source-files/:id`): its rows, page images, original and mirror copy go, not while it is being read, and a stored path outside the user's originals is never removed. Database snapshots already taken keep the rows until retention prunes them | `routes/source-files.ts`, `ingestion/remove-upload.ts`, `__tests__/delete-upload.test.ts` |
| Responses list explicit columns: no `user_id`, server path, checksum or token; tested by scanning whole responses | `store/sqlite/`, `__tests__/response-shape.test.ts` |
| Signup, verification, forgot and reset limited per source and per address; identical answers for known and unknown addresses | `routes/accounts.ts`, `rate-limit.ts` |
| Verification and reset tokens: hashed at rest, single-use by one atomic update, in the URL fragment, spent by POST | `accounts.ts`, `store/sqlite/users.ts`, `web/src/auth.ts` |
| An unverified account never gets a session | `routes/auth.ts`, `routes/middleware.ts` |
| With two-factor on, the right password starts only a pending login; `login/second-factor` is the only other place a session is issued, and a test fails if another route assigns one | `routes/auth.ts`, `__tests__/second-factor.test.ts` |
| TOTP: a used code cannot be replayed (one atomic `UPDATE`), wrong guesses are limited per source and per user, the seed is encrypted with the user id bound in, recovery codes are hashed and single-use | `totp.ts`, `second-factor.ts`, `store/sqlite/users.ts` |
| Turning two-factor off or regenerating codes needs the password and a current code; enabling or disabling ends the user's other sessions | `routes/totp.ts` |
| Mail has no attachment field, no clinical wording, and a required sender; failures never log the message | `mail/`, `accounts.ts` |
| Open signup without a mailer refuses to start | `config.ts` |
| Page images leave only through `readPage`, which only the `multimodal` and `hybrid` parsers call, and those need `SPINE_MULTIMODAL_ENABLED` as well; `hybrid` never sends a native-text page | `parser/`, `config.ts` |
| Startup logs whether images can leave, and each one sent; every page logs its route | `index.ts`, `parser/adapters/` |
| "Read page with AI" needs the operator switch and the caller's own upload or page, takes at most 200 pages, runs one reading per upload at a time, and names the count and provider before sending | `routes/source-files.ts`, `ingestion/ai-reading.ts`, `web/src/components/AiReading.tsx` |
| `hybrid` refuses to start without Tesseract and its language packs, which would otherwise quietly send more pages away | `parser/ocr.ts`, `index.ts` |
| Page images served only by an authenticated route, streamed, `Cache-Control: private` | `routes/documents.ts` |
| An edit is validated before anything is written and saved in one transaction; a field or page that is not on the user's own document is refused, and the store's SQL checks owner and document again | `routes/documents.ts`, `store/sqlite/fields.ts`, `__tests__/document-edit.test.ts` |
| No static mount over `DATA_DIR` | `index.ts` |
| Share tokens 256-bit, stored as `sha256` — never in plaintext | `share-token.ts`, `routes/share.ts` |
| Legacy plaintext tokens rewritten to digests at boot, idempotently | `hash-legacy-tokens.ts` |
| Share entry route serves the app shell, never JSON | `routes/public-share.ts` |
| Share expiry bounded 1–30 days, default 7; revocation checked on every read | `routes/share.ts`, `routes/public-share.ts` |
| A scope that cannot be fully resolved is rejected at creation, and serves nothing if found stored | `share-scope.ts`, `routes/public-share.ts` |
| Access logged before data is returned; `view_count` counts document reads | `routes/public-share.ts` |
| A share link shows page images only if the owner ticked `include_scans` for it (default off); a recipient can open only a document the link's scope resolves to, and see only a page of such a document that is not hidden, with one 404 for everything else; responses are `no-store` and rate limited | `routes/public-share.ts`, `__tests__/public-share-detail.test.ts` |
| No SQL or driver import outside the store adapter | `store/sqlite/` |
| PATCH takes a patch object, so no request key reaches a column name | `routes/documents.ts`, `store/sqlite/documents.ts` |
| A file's kind is read from its content, never its name or declared type; poppler calls have a time limit; image decoding has a pixel limit; doctor fields have a length limit | `file-kind.ts`, `ingestion/signatures.ts`, `photo.ts`, `rasterize.ts`, `store/sqlite/doctors.ts` |
| Digital signatures are read locally by `pdfsig`, and only a valid personal signature counts; the certificate's serial number is not kept | `ingestion/signatures.ts` |
| Search text is quoted into a full-text query and a result's excerpt is drawn as text with highlight marks, never as HTML | `search-query.ts`, `web/src/pages/Search.tsx` |
| Every LLM response validated against a schema before it reaches the database | `llm/types.ts`, `llm/chat-llm.ts` |
| Startup refuses an unknown LLM provider, an unstated Vertex endpoint/region, or a stray Google API key | `llm/index.ts`, `llm/adapters/vertex.ts` |
| Startup refuses a database of an older shape, saying whether it is safe to delete | `store/sqlite/connection.ts` |
| Daily `VACUUM INTO` snapshot + forward-only originals mirror, retention 7 | `backup.ts`, `systemd/spine-backup.timer` |
| Restart reconciliation of stranded jobs | `ingestion/pipeline.ts` |

### Host

| Control | Where |
|---|---|
| `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `ReadWritePaths=data/` | both units |
| `PrivateTmp`: stamp crops and other temporary files are not in a shared `/tmp` | `spine-web.service` |
| Sidecar bound `127.0.0.1:8000` | `spine-ingestion.service:10` |
| Services run as the invoking user, not root | both units |

## Known gaps

Defects in the code as it stands. Severity: **High** = unauthorised access to medical data or account takeover. **Medium** = weakens a control or widens blast radius given a precondition. **Low** = hygiene and defence in depth.

Nothing is open: every defect found so far is fixed or explicitly accepted, and the next review should expect to add to the list. The original findings were confirmed against a running instance, not inferred. [Closed](#closed) keeps the ids resolvable, since they are cited from [ARCHITECTURE.md](ARCHITECTURE.md).

### Accepted

**S-9 — The audit log trusts `X-Real-IP`.** `public-share.ts` reads the header before the socket address. Correct behind nginx, forgeable if Fastify were reachable directly, which would poison the only record of who read what. Acceptable while **P9** holds, and since S-13 it does: Fastify binds loopback, so only the proxy can set the header.

**S-16 — Sessions live in memory.** Restarting the server signs everyone out, and sessions are not shared between processes. Fine for one process; a second would need a shared store.

**S-17 — The instance-wide login cap can lock everyone out.** 50 failed logins in ten minutes from anywhere stops all logins for the rest of the window, including the owner's. That is the trade for throttling a distributed guess; the per-source limit runs first so one noisy host does not spend it alone. Existing sessions are unaffected.

**S-19 — nginx's access log holds raw share tokens.** `/share/<token>` and `/api/share/<token>/documents` are in the path, so `spine.access.log` records every live token, and hashing them in the database (S-4) does not help against someone who can read the log. Verification and reset links avoid this with a URL fragment; share links cannot without changing how recipients open them. Rotate the log, keep it readable by the operator only, and revoke links that matter. A link with scans now makes many more requests that carry the token (one per page image), so the exposure in the log is larger. A scan also shows what extraction drops on purpose, the patient's ID number and phone, so "include scans" is a decision to make per link, and it is off by default.

**S-20 — Two-factor is optional.** Each user turns TOTP on for their own account (M-12); an instance cannot require it, so on an `open` instance a user who never enables it is protected by their password alone. A `SPINE_REQUIRE_2FA` switch is the obvious next step; it is not built.

**S-21 — The TOTP key derives from `SESSION_SECRET`.** A TOTP seed has to be read back to check a code, so unlike a password it cannot be hashed; it is encrypted at rest under a key derived from `SESSION_SECRET`. Someone holding both `.env` and the database could generate valid codes (they could also forge sessions, so this adds nothing new). **Changing `SESSION_SECRET` makes every enrolled seed unreadable**, so authenticator codes stop working. Recovery codes still do (they are hashed, not encrypted), so each user can sign in, turn it off and enrol again; failing that, the operator runs `disable-2fa`.

**S-22 — Whoever has the password can enrol their own authenticator.** Enrolment needs the password and a session, nothing else. An attacker who has both can switch two-factor on with their own app and lock the owner out: a reset link and `set-password` do not remove it. That is denial rather than disclosure (holding the password already exposed the archive), and the operator's `disable-2fa` undoes it. Not built, and the obvious fix: email the account when two-factor is turned on or off, so a lock-out is noticed.

**S-23 — A doctor read from a document is a label, not a proof.** Text, a stamp and a digital signature all name a doctor, and anyone who can get a file into the archive (a forwarded PDF, a clinic's mail) can make one say anything. A signature is checked only for being intact: `pdfsig`'s certificate trust is not consulted, so a self-signed certificate naming a real doctor is filed as that doctor. Nothing is decided from it (no scope, no access, no share); it puts a name in the owner's own directory, where Review can remove it and Duplicates can show it. A stamp or signature is not evidence of who wrote a document and the interface never says so.

**S-24 — Uploaded files are parsed by poppler and sharp in the web service's own process owner.** A memory-safety flaw in either would run as the `spine` user, with that user's access to `data/` and `.env`. The units drop privileges and make the system read-only, and every call has a time limit and a pixel limit (S-25), but there is no memory cap, no seccomp filter and no separate user for the readers. Keep poppler and the `sharp` package up to date; a stricter unit (`MemoryMax=`, `SystemCallFilter=`, a dedicated user) is the next step and is not built.

**M-17 — Documents are held back until the grouping is confirmed, and what the owner edited is theirs.** **P12.** Every listing of the owner's documents, every share query and the vectors, links, trends and doctors' lists use one fragment (`VISIBLE`: not set aside and the upload's grouping confirmed), so an unconfirmed upload cannot reach a share recipient, the search or a model call (the links search takes its documents from the same listing). The upload and regrouping screens still list them, scoped to the signed-in user, and the confirm route answers 404 for an upload that is not theirs. The records of what the owner edited or removed (`owner_edited`, `removed_readings`) are per user, deleted with the document, the upload and the account, and never returned by a route.

**M-16 — Looking for links is egress of summary text, and a model's word is a proposal.** **P8, P12.** On unless `SPINE_LINKING=off`. When the data finds a candidate (shared test or doctor, closeness in time or, if on, in meaning), one call sends the *summary card* of the document and of up to six candidates (the same cards as **M-15**, with each doctor's role and the owner's notes, trimmed to 600 characters; not pages or scans) to the configured chat provider, which has the residency refusals of any chat call. With no candidate nothing is sent. The cards are copied from scans, so they are untrusted text: the prompt says to ignore instructions in them, the model's answer is validated by schema, a candidate label it did not send is dropped, and nothing it says writes anything but a `proposed` link that the owner must confirm; a request or follow-up whose dates run backwards is refused in code. Candidates and chains come from the signed-in user's own documents (set-aside ones excluded), every statement filters by `user_id`, a link is written only between two documents that are the user's, and any other id answers 404 (`linking.test.ts`). A dismissed pair is never offered to the model again, and a search replaces only the suggestions for pairs it judged again. The owner's notes also go, as context, with the text of a document being read again (**P8**); the extraction prompt tells the model to take no field, result or date from them and to ignore instructions in them. The links route is owner only; no share route returns a link or a chain. Links are deleted with their documents and the account. Links are not in exports.

**M-15 — Embeddings are egress of summary text, and vectors are as private as the text.** **P8, P12.** Off unless `SPINE_EMBEDDINGS=vertex`. On, the *summary card* of each document (title, type, provider, date, summary, doctors, a few key fields, test names; not the pages, notes or scans) and the words of a meaning search go to Vertex at the stated endpoint, region and project, with the same refusals as the chat model (no default endpoint; a Google API key in the environment stops startup); the startup log says so, and a failure's message carries the status, never the text. A vector can be turned back into much of the text it came from, so it is treated as the text is: stored per user and scoped by the store (**P12**), deleted with the document and the account, left out of exports, and returned by no route (asserted in `similarity.test.ts`). Vectors are compared only within the model that made them. Related documents and search results come from the signed-in user's own documents only (set-aside ones excluded); nothing here is offered to a share recipient. A document's card is built from its stored data, so what is embedded is what the owner has already reviewed or edited.

**S-26 — What an imported export says is believed.** An export is not signed, so a restored document's title, summary, fields, results and `reviewed` flag are whatever the file says, as if the owner had edited them. Someone who hands a person a crafted zip can put plausible but false values in their archive, which then appear in trends and share links. They cannot reach another account, run code or read anything, and nothing is decided from the content, but a person should import exports only from themselves or from a source they trust. Not built, and the obvious step: import everything as unreviewed (so it passes through Review) when the export did not come from this instance, which needs the export to be signed or to carry the instance's identity.

**S-27 — A hostile document can steer its own translation and reading.** Text in a PDF (a forwarded report, a clinic's mail) goes to the model in extraction and in translation, and a page can contain instructions. The model has no tools and cannot read or change anything else, so the effect is bounded to that document's own extracted values, title and translation, and to the tags and test names it suggests, which the Library lets the owner tidy. A translation is checked to be about as long as its original, which stops a document turning it into a long output. Not preventable by checking; the owner reviews what is read.

**S-28 — Nothing limits how much one account uploads.** The upload route has a per-file size limit (200 MB, or 2 GB for a zip, decided from the first bytes) but no request rate limit and no per-account quota, so a signed-in user, or someone holding a session, can fill the disk. This was true before zips; a zip makes one request larger. Fine for a household instance; an `open` registration instance should add a quota before it is public.

**S-29 — One request downloads the whole archive.** `GET /api/export` returns every document, note and page text. It needs a session, is rate limited (6 a minute) and cannot be started from another site (the session cookie is `SameSite=Strict`, and it is a download), but a stolen session can take everything in one step where before it would have had to walk the API. Two-factor protects the sign-in (**M-12**), not the session after it. Not built, and the obvious step: ask for the password again before an archive export.

**S-30 — A share link's page costs more queries the more it shares.** The recipient's list, document and trends routes resolve the link's documents on every request, and the trends names read each shared document's results. They are rate limited (120 a minute) and the work is bounded by the owner's own archive; a link covering a very large archive is slower to open, not unsafe.

### Closed

Fixed; the control is in [Controls in place](#controls-in-place).

**S-25 — Readers of uploaded files had no resource limits** (**Low**). `pdfimages`, `pdftoppm` and `sharp` had no time limit, and `pdfimages` writes every image on a page, so a file built with huge declared images could hold an upload forever or fill the temporary directory. Now: `pdfimages` and `pdfsig` stop after 60 s (`pdftoppm` after ten minutes); a page declaring over 120 million image pixels is not unpacked, and `sharp` refuses an image over that for both stamps and photos; the web unit has `PrivateTmp`, so stamp crops are not in a shared `/tmp`; a doctor's name, specialty and clinic are cut at 120 characters and a professional code over 24 is not a code (they come from stamps, signatures and the model, all of which a sender controls). `__tests__/stamps.test.ts`, `trends-doctors.test.ts`.

**S-1 — Share scoping failed open** (**High**, **P2**). A `tag` scope with no `scope_value` skipped every branch of the scope chain and returned everything (215 documents on a running instance). `share-scope.ts` is now the one place a scope is resolved: creation rejects what it cannot resolve, and the read path re-resolves the stored row, so older rows fail closed.

**S-2 — No rate limit on `/api/auth/login`** (**High**, **P5**). Now a per-source limit (the plugin) plus an instance-wide cap (ours, because the plugin applies only its first hook per request). Per-source runs first, so an address that has spent its budget stops consuming the instance-wide one.

**S-3 — `SESSION_SECRET` fell back to a repo-published value** (**High**, **P3**). `config.ts` validates it before anything binds an interface or opens the database, reporting every problem at once; `install.sh -s` runs the same check so a bad `.env` fails at deploy, not in a restart loop.

**S-4 — Share tokens stored in plaintext** (**Medium**, **P6**). The column holds `sha256(token)`, hashed in one place so both public routes use it. Plain SHA-256 is right because the input is 256 bits of CSPRNG output. Existing links kept working: the plaintext was in the row, and the two shapes are unambiguous (43 base64url vs 64 hex), so the boot rewrite is idempotent. A row matching neither is left alone and logged.

**S-5 — No CSP, `Referrer-Policy` or `Permissions-Policy`** (**Medium**). All set, plus `object-src`, `frame-ancestors`, `base-uri`, `form-action`. `script-src 'self'` needs no exception. `style-src` carries `'unsafe-inline'` because React writes inline style attributes; inline styles cannot execute script.

**S-6 — `tag` scopes broken by double JSON encoding** (**Medium**, **P2**). Creation stored `JSON.stringify(value)` and the read path compared it unparsed, returning nothing. One module now serialises and parses.

**S-7 — The scope test could not fail** (**Medium**, **P10**). An `|| true` in the assertion. Links are now created through the real route and the returned id sets compared exactly, which also catches a scope returning *more* than it should.

**S-8 — Responses carried internal columns, server paths and live tokens** (**Low**). `SELECT *` sent absolute paths and, once multi-user arrived, `user_id` to share recipients and `file_path`/checksums from `GET /api/source-files`. Every query now lists explicit columns, and `response-shape.test.ts` scans whole responses for forbidden keys and absolute paths.

**S-10 — Failed logins unrecorded** (**Low**). Failures and successes are logged with the source address; the password never is.

**S-11 — No automated backup** (**Low**, **P11**). `spine-backup.timer` daily, `Persistent=true` so a Pi that was off catches up. `VACUUM INTO` for the database, because copying the file under load is unsafe in WAL mode. Originals are immutable, so they get a forward-only mirror. `data/pages/` regenerates and is not copied. Retention `SPINE_BACKUP_KEEP`, default 7, never below one. **This protects against corruption and mistakes, not against losing the disk**: it writes beside `data/` by default. `SPINE_BACKUP_DIR` pointed at removable or network storage makes it offsite, and that path must also be in `ReadWritePaths`.

**S-12 — Request-body keys interpolated into SQL** (**High**). `PATCH /api/documents/:id` built its `SET` clause from `Object.keys(req.body)`, and a key like `user_notes = (SELECT token FROM share_links LIMIT 1), provider` appended SQL while keeping the parameter count valid. Handlers now pass a patch object and the store maps it to columns.

**S-13 — Fastify bound `0.0.0.0` while trusting `X-Forwarded-*`** (**Medium**, **P9**). On a home LAN port 3000 was reachable, bypassing nginx's rate limit and making `X-Real-IP` attacker-controlled. It binds `127.0.0.1` unless `SPINE_HOST` says otherwise.

**S-14 — `/share/` received none of the security headers** (**Medium**). nginx inherits `add_header` from an outer level only if the inner level declares none of its own, and the `/share/` location sets two. The block is repeated inside the location, with a comment that both copies change together.

**S-15 — `GET /share/:token` returned JSON** (**Medium**). The SPA fallback excludes `/share/`, so this route alone answers a recipient's URL, and it returned `{"ok":true}` instead of the documents. It serves the app shell as `text/html` now, and a plain page for a dead link. `view_count` moved to the data route; both routes still append to the access log (**P7**).

**S-18 — No way to delete a user** (**Low**). `npm run cli -- delete-user <email> --yes` removes the account, every row it owns, its originals, page images and its copy in the backup mirror, and says what it removed; without `--yes` it only reports. Database snapshots already taken still hold the rows until retention prunes them. A deleted user's sessions end on their next request.

## Review: translation, export and import, sharing, the library

A review of what was added with translation, zip export and import, the recipient's pages and trends, and the Library, read for what each could be made to do beyond its purpose: authorisation and scoping, input handling, resource use, what changes state, what leaves the host, and injection. Method: each new route, store method and page was read with the question "what does a hostile or careless caller get", and the findings were fixed with a test (`audit.test.ts` and the tests named below) or recorded as accepted gaps above.

**Found and fixed**

- **R-1 (Medium) — A zip could start every file at once.** A request with hundreds of PDFs, or an export with many files, began reading or restoring each immediately: poppler, OCR and model calls, and their cost, all at the same time, on a Pi. Reading and restoring now go through a queue that works on two files at a time and says `queued` meanwhile (`ingestion/jobs.ts`).
- **R-2 (Medium) — Any file could be written up to the zip limit.** Raising the request limit to 2 GB for zips applied to every upload, so 2 GB of something that is then refused as "not a PDF" was written first. The limit is now chosen from the file's first bytes: 200 MB unless it is a zip (`saveStream`).
- **R-3 (Low) — A write after the limit.** The stream writer wrote one more chunk after it had stopped keeping a file, which threw. Writes are now explicit and stop at the limit.
- **R-4 (Low) — A recipient's read changed the owner's record.** The first translation of a document with no recorded language saved the language the model found, from a public route. Public reads now change nothing; the owner's next visit records it, and moves the stored translation to its new digest instead of translating again.
- **R-5 (Low) — The manifest was looser than the data it fills.** Free text could stand in for a date, a document could carry 200 tags, a test name kept its case, and the whole could be 200 MB. Dates must be in the app's form, tags are at most 50 a document, the test name is lower-cased, documents and pages are capped in all, and the manifest is at most 64 MB.
- **R-6 (Low) — Tags could split.** The model's wording and a typed "Cardiology" were different tags. Every source now goes through one cleaning (`cleanTag`), the model is given the person's tags to prefer, and the Library merges what is left.

**Checked and found sound**

- **Another user's data.** Every new store method takes the acting user and filters by it; tags, providers and tests cannot be read, renamed, merged or removed by id or name across accounts (404), exports of another account's document are a 404, and a restore writes only rows for the acting user. `management.test.ts`, `archive.test.ts` and `isolation.test.ts`.
- **The zip as a path.** Entries are read by name and never extracted to a name the zip gives; the stored file's path is made by the server; a manifest that names `../../etc/passwd` finds no such entry; an entry named `manifest.json` used as a file is not a PDF.
- **The zip as a size.** Sizes are counted as they stream, per entry and in all, whatever the zip declares; an encrypted or damaged entry fails that file, not the request.
- **What a manifest can name.** No user, no id, no path; every id is made on import; doctors from a manifest are matched into the directory the way a read doctor is, filling blanks and never overwriting; the restore is one transaction.
- **The recipient's reach.** Trends are built from the shared documents' own results and filtered to their ids (a newer value in an unshared document appears nowhere), set-aside documents are excluded as everywhere, and a tag removed from under a link makes it share nothing, not more (`audit.test.ts`). The recipient's page links only to the same link's pages, never to the owner's directory.
- **Cross-site requests.** The export is a `GET` that returns a download; the session cookie is `SameSite=Strict`, so another site cannot make the browser send it.
- **Headers and markup.** The export filename is built from letters, digits and dashes only; no new page renders HTML from data (React text only; the one existing `dangerouslySetInnerHTML` is the server-made QR code).
- **Egress.** Translation sends text only, is listed in the egress table and can be switched off; export and restore send nothing.

**Left as gaps:** S-26 (an imported export is believed), S-27 (a hostile document steers its own reading), S-28 (no upload quota), S-29 (the archive is one download), S-30 (the cost of a very large share).

## Multi-user

The requirements multi-user put on the design. All are implemented; the controls they produced are in [Controls in place](#controls-in-place).

**M-1 — Owner-scoped store layer.** **P12.** Every user-owned table has a `user_id`, and every statement in `store/sqlite/` filters by it. Handlers cannot write queries. There is no `find(id)` without a user, and a method called with no acting user throws.

What a method does with a record the caller does not own: a read returns nothing, an update or delete changes nothing, and a create that names such a record throws and inserts nothing. Routes check first and answer 404, never 403, so a record cannot be probed for.

Four exceptions, enumerated in `store/types.ts` so a fifth has to be argued for: share-token resolution and `listForShare` (scoped by the link's owner, never by a session); `logAccess` (the reader is unauthenticated); `maintenance.*` (boot-time work); and `users.*` (the identity layer: login must find a user before there is an acting user).

`__tests__/isolation.test.ts` runs as a second user against the first user's data across every route and every repository method, and fails when the search filter or the share ownership check is removed. Removing only the inner tag-owner check in the tag-scoped share query does *not* fail it, because the outer `d.user_id` already excludes other users' documents; that one is defence in depth.

**M-2 — Owner-aware full-text search.** The FTS index stays shared; results are filtered by joining back to `documents.user_id`. The index now also holds page text, values and doctor names (the most sensitive text in the system), so what makes it safe is that each row is built only from the owning user's rows and is only reachable through that join; a test searches for another user's page text, value and doctor name and finds nothing. Typed text is quoted, never passed as query syntax. Tested.

**M-3 — Credential storage.** **P13.** argon2id, 19 MiB / 2 passes / 1 lane (the OWASP minimum), per-hash salt, 12–256 characters. About 30 ms per hash on a laptop-class CPU; not yet measured on a Pi. An unknown email runs a dummy verification so it is neither faster nor different in answer.

**M-4 — Session invalidation on password change.** **P13.** `users.auth_version` is bumped on a change; a session carries the value it was issued under and is refused once it no longer matches. Every request re-resolves its session, so this takes effect on the next request. Login also issues a new session id.

**M-5 — Share creation verifies ownership of the scope.** A `document_ids` link naming a document the creator does not own is rejected at creation, with one message for "not yours" and "does not exist".

**M-6 — Login and registration throttling.** **P5.** Login: per source and instance-wide (S-2). Signup, resend, forgot and reset: per source **and per email address**, so they cannot be used to flood an inbox; the address limit is `rate-limit.ts`, because the Fastify plugin cannot stack two limiters on one route.

Signup is `SPINE_REGISTRATION=open`, default `operator`; `open` with no mailer fails at startup (**P3**). Verification is mandatory: an unverified account gets no session, and the right password before confirming answers 403 with a code the page uses to offer a new link. A taken address is answered exactly like a new one — same body, same status, no mail — and its password is not touched. **Residual:** a new address does a few more database writes than a taken one, so the timing is close but not identical; the mail itself is sent after the response, which is the large part.

**M-7 — Explicit opt-in for image egress.** **P8.** `SPINE_PARSER` defaults to `text`, which sends nothing (as does `ocr`). The parsers that send page images, `multimodal` and `hybrid`, need a **second, separate switch**, `SPINE_MULTIMODAL_ENABLED=true`, and are refused at startup without it: in `config.ts`, and again in `createParser`, which decides whether an image can leave and does not rely on its caller. The second switch alone does nothing, so picking a parser never turns egress on by implication.

Signature stamps (`ingestion/signatures.ts`) are a second, smaller image egress under the same switch: each document's last page contributes at most four small pictures that look like a stamp (a doctor's name, specialty and code; no clinical content), never the page; nothing runs with the switch off, and a test asserts that no image is sent then. Each send is logged with the number of images.

The startup log states the result (`imageEgress: true`, plus a warning naming the provider and endpoint); each image sent is logged, and every page logs its route and the figures behind it. In `hybrid`, an image is sent only for a page with **no text layer** that **local OCR could not read confidently**, never a page that has a text layer (a test asserts it). There is no LLM screening step: looking at an image to decide whether to send it is the same egress as sending it.

**A second route: reading again.** "Read page with AI" (on the document page) sends only that page's image through the same model parser, so the same switch applies and nothing new decides whether an image can leave. It acts only on the caller's own pages (a page of another upload, or another user's, is refused like one that does not exist), takes at most 200 a request, runs one reading per upload at a time, and asks first, naming the number of images and the destination. A page the model cannot read changes nothing. "Read whole document" (the same route with `strategy: "configured"`) reads a document's pages with the parser the operator configured, so it sends an image only when that parser does (`hybrid` for pages still without text, `multimodal` for every page) or when the upload is a photo, and the switch is required exactly then; with `text` or `ocr` it sends only the page text for extraction.

**Which provider matters.** Images go to `SPINE_LLM_PROVIDER`. The Anthropic adapter has no EU-only processing commitment, so a deployment with a residency requirement should enable this only on Vertex at an `eu` endpoint (M-8). The software cannot know your deployment has such a requirement, so it does not stop you.

**Not exercised:** no real page has been sent to a real provider; the image message was checked against both providers' request builders only. The local screening ran on real files with real Tesseract and poppler, though on rendered pages, not real handwriting.

**M-8 — Residency enforcement in the provider adapter.** **P8. Enforced as configuration.** The Vertex adapter requires `SPINE_LLM_ENDPOINT`, `SPINE_LLM_REGION` and `SPINE_LLM_PROJECT` to be stated — nothing defaults, so an instance cannot reach a global endpoint by omission — and the resolved provider, model and endpoint are logged once at startup.

The control that does the work: **construction fails if `GOOGLE_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_GENAI_API_KEY` is present at all.** Reproduced against the installed `@langchain/google-vertexai`: with one set and an EU endpoint and region configured, the request goes to `https://aiplatform.googleapis.com/v1/publishers/google/models/<model>:generateContent` — the global host, with the configured endpoint dropped and no region in the path. In `@langchain/google-common`, an API key makes `connection.js` choose the "Express" platform, which hardcodes the global host. The same behaviour is reported for `@google/genai` ([gemini-cli#27984](https://github.com/google-gemini/gemini-cli/issues/27984)), so it is a class of bug across Google's client libraries. API keys are also blocked on standard Vertex endpoints and unsupported for Claude's `rawPredict`, so there is no legitimate reason for one to be set here.

**Deliberately not done:** asserting the shape of the outgoing URL. That encodes Google's URL scheme, means nothing for an Azure or Bedrock endpoint, and is bypassed by the API-key path, which is why the refusal above is the real control. Verify residency against the provider's request logs on first deployment; that works for any provider.

**M-9 — Per-user paths for originals.** `data/originals/<user>/<year>/`, so a filesystem mistake cannot cross users as easily as a query mistake. Asserted in the upload test.

**M-10 — A migration runner: not needed yet.** `CREATE TABLE IF NOT EXISTS` adds new tables to an existing database but cannot add a column to an existing table. Multi-user and verification changed existing tables while the archive held no records, so they edited `schema.sql` directly; a database of an older shape is **refused at startup**, with a message saying how many uploads and documents it holds and whether it is safe to delete. TOTP (M-12) added new tables only, so it did not need a change. Document titles added a column to `documents`, again while the archive held no records; a database without it is refused the same way. **A change to an existing table that is not purely additive needs a runner first**, or an empty database. A new column with a default is added in place when the database is opened (`addColumnsInPlace`; `pages.hidden` was the first), and tested against a database made without it.

**M-11 — Account recovery and verification.**

- The token is a capability: 256 bits of CSPRNG output, only its **sha256 stored** (**P6**), spent by one atomic `UPDATE` so two simultaneous requests cannot both succeed. A newer one replaces an older one. Verification lasts 24 hours, reset one hour.
- It travels in the URL **fragment**, never sent to the server, so it stays out of nginx's access log and the Referer header; the page removes it from the address bar. It is spent by a `POST`, so a mail scanner following links cannot spend it.
- Using a reset link ends **all** the user's sessions (**P13**, as M-4) and confirms the address. It does not bypass two-factor (M-12).
- Requests answer identically whether or not the address has an account, and are rate limited (**P5**).
- A send failure is logged and the page says to request another link. It is not shown as an error, because an error only for addresses that exist would be a way to find them.
- The mail carries no medical content (**P8**): an address and a link, no attachment field, plain subjects, and a test that fails on clinical wording.
- Without a mailer, `npm run cli -- reset-link <email>` prints the same single-use link.

**M-12 — Second factor (TOTP).** **P13.** Optional per user (S-20).

- **Algorithm:** RFC 6238 — HMAC-SHA1, 6 digits, 30-second steps, written with `node:crypto` and checked against the RFC's test vectors. SHA-1 is what authenticator apps support, and HMAC-SHA1 is not weakened by SHA-1's collision problems. A code is accepted one step either side of now, for clock drift.
- **Seed:** 20 random bytes, stored **encrypted** (AES-256-GCM, key derived from `SESSION_SECRET` with HKDF, the user id as associated data, so a row copied to another account does not decrypt) — see S-21. Shown once, as a QR code and as text.
- **Enrolling** takes the password, then a first valid code, which proves the app works before two-factor is switched on. Until then the seed is inert and login is unchanged. Anyone holding the password can enrol (S-22).
- **Login is two steps.** The right password does **not** create a session for a user with two-factor: it starts a *pending* login in the session (user id, `auth_version`, five-minute expiry). Only a valid code turns that into a session, with a fresh id. As with an unverified address, only someone holding the right password learns the account has two-factor.
- **Guessing is throttled (P5).** Six digits is a million possibilities, so the second step is limited per source, **per user** (5 attempts per ten minutes, whatever the source), and the pending login is dropped after five wrong tries.
- **No replay.** The last accepted time step is stored; a code for that step or earlier is refused, so a code seen over a shoulder or in a log cannot be used again.
- **Recovery codes:** ten, shown once when enabled and when regenerated; 10 characters from a 32-letter alphabet (50 bits), **sha256 stored** (**P6**), each spent by one atomic `UPDATE`. They are accepted at the second step in place of a code, and using one is logged. Regenerating replaces all ten.
- **Changing it needs proof.** Disabling or regenerating codes takes the password *and* a current code. Enabling and disabling both bump `auth_version`, ending the user's other sessions (**P13**).
- **Lost phone and lost codes:** `npm run cli -- disable-2fa <email>`, run by the operator. That makes the operator the recovery path, which is the trust the operator already has.
- Deleting a user (S-18) removes the seed and the codes.


**M-13 — Translation is egress of text, and a public route can trigger it.** **P8.** A document is translated into the reader's language on demand: its title, summary, extracted field values (and labels the app has no name for), measurement names, doctors' specialties and the owner's notes go to the configured inference provider, as text, and the result is kept in `document_translations`, keyed by a digest of exactly what was sent, so an edit, a re-extraction or a page reorder changes the digest and the old translation is never served. Nothing is sent for a document already in the reader's language, and `SPINE_TRANSLATION=off` stops the path: the endpoints answer `off` and the interface shows the original. Two things are new in the threat model. The owner's **notes** leave the host (they never did before; extraction sees only page text), which is why this is listed in [ARCHITECTURE.md](ARCHITECTURE.md) and is on by default only because the text already goes to the same provider. And **a share recipient can cause a model call**: `GET /api/share/:token/documents/:id/translation` is public. It is bounded the same way every public route is: the token must resolve to a live link and the document to its scope (anything else is the same 404, **P2**), the language must be one of four (`ro`, `en`, `fr`, `de`), a document is translated **once per language** whatever the number of requests (concurrent ones share one call), the route is rate limited (60 a minute), and it **writes nothing to the owner's records**: the language the model finds for a document with none is recorded only when the owner opens it (**R-4**). The worst a holder of a link can do is have each document in scope translated into each of four languages, once. Translations are deleted with their document, with an upload's derived data and with the account (`OWNED_TABLES`). Server error messages stay English: only the web interface and the stored details are translated.

**M-14 — Import takes a file the user was given.** **P12.** A zip uploaded to the upload route is untrusted input twice: as an archive and as a Spine export. As an archive: it is opened with `yauzl` and entries are read **by name and never extracted to a path the zip chooses**, so `../../x` is only a name; the size of every entry is counted as it is read and capped (200 MB each, 4 GB in all, 500 entries for a plain zip), whatever the zip declares, so a small zip cannot expand without limit; the zip itself is not kept; and the work a zip brings (restoring or reading each file) is queued two at a time, so a request with hundreds of files cannot start hundreds of poppler, OCR and model jobs at once (**R-1**). As an export: `manifest.json` (at most 64 MB, parsed into memory) is checked with zod, with a length or count limit on every string and list, dates in the app's own form, a cap on documents and pages in all, and a test name lower-cased, before anything is used, and a manifest of an unknown version is refused. **Nothing in it can name an owner, an id or a path**: every id is made on import, rows are written for the acting user through the store (**P12**), and the stored file is written to a path the server makes. The restored pages are made from the *file* with poppler/sharp as for any upload (**S-24**); the manifest supplies text, boxes and details, and a manifest that does not fit its file (a different page count, pages or ranges that do not exist) fails the whole file in one rolled-back transaction. Restoring calls no model and sends nothing off the host (**P8**). Exporting is the owner's own data on an authenticated, rate-limited route (6 archives, 30 documents a minute), built as it is sent; it never includes share links or their tokens, other users' rows, server paths or ids (a test asserts the owner's id and the data directory are absent from the manifest).

## Enforcement checklist

For any change touching routing, auth, share links, storage, providers or static serving:

- [ ] Does a new route land in a file with `requireAuth`? If public, is it justified here and on the allow-list in `isolation.test.ts`? (**P1**)
- [ ] Does a new table carry `user_id`, and does every statement on it filter by it? Does a new repository method take the acting user's id first? Is it inside `store/sqlite/`, the only place SQL or a driver import belongs? (**P12**)
- [ ] Is a new method exempt from taking a user id? Then it must be one of the four exceptions in `store/types.ts`, argued for there, not a fifth added quietly.
- [ ] Does a new query list explicit columns? `SELECT *` on a table with `user_id` sends it to the client, including to share recipients. (**S-8**)
- [ ] Can any share-link path return documents without a fully resolved scope? (**P2**) Does scope creation verify the creator owns everything it names? (**M-5**)
- [ ] Does any config read a secret with a `??` fallback, or ship a default an operator would not knowingly choose? (**P3**)
- [ ] Is medical content served by anything other than an authenticated handler — static mount, redirect, signed URL? (**P4**)
- [ ] Does a new nginx `location` set any `add_header`? If so it inherits none from the server level and must repeat the security headers. (**S-14**)
- [ ] Is every new unauthenticated endpoint rate limited at nginx or Fastify? (**P5**) The Fastify plugin applies only its first hook per request, so a second limit on one route has to be enforced separately (see S-2).
- [ ] Does anything new leave the host? Is it listed in [ARCHITECTURE.md](ARCHITECTURE.md), opt-in, and disableable? Do page images leave only through `readPage`, on a path that needs both switches — including any new button that triggers it? Can a public route cause a model call, and is it bounded (by language, by once-per-document caching and by a rate limit)? (**P8**, **M-7**, **M-13**)
- [ ] Does anything send text to a model that was not sent before (a new card, a new field)? Is it in the egress table and behind a switch? (**M-15**)
- [ ] Does a new query list the owner's documents? Does it use the one visibility fragment, so an unconfirmed upload or a set-aside document cannot leak into it, a share or a model call? (**M-17**)
- [ ] Does anything new write a record because a model said so? Is it only a proposal the owner decides on, and does code refuse what the data contradicts? (**M-16**)
- [ ] Does a request start work per item (files in a zip, documents in a list)? Is it queued and capped? (**R-1**)
- [ ] Does a public route write anything? It must not. (**R-4**)
- [ ] Does anything read a file or manifest a user was given? Is it read by name and never written to a path from it, size-capped as it is read, schema-checked, and does it mint every id itself? (**M-14**)
- [ ] Can a provider adapter fall back to a global endpoint, and is residency being asserted from a URL's shape rather than verified against request logs? (**P8**, **M-8**)
- [ ] Does anything above `src/llm/adapters/` import a vendor package? That is a review failure.
- [ ] Does anything widen the listening surface — a new bind address, an interface opened on a unit, a proxy header trusted from somewhere other than nginx? (**P9**, **S-13**)
- [ ] Does anything put document text, a summary, a field or an attachment into an email, or a subject or body that says anything clinical? (**P8**)
- [ ] Does a new way to obtain a session — login, reset, verification, any future SSO — go through the second factor for a user who has one? A path that issues a session directly is a bypass. (**M-12**)
- [ ] Do tests drive the control through the real handler, with assertions that can actually fail? (**P10**)

## Operational response

**A share link is leaked or sent to the wrong person.** Revoke it from the Share Links page; `revoked` is checked on every read, so it takes effect immediately. Check `share_link_access_log` for that link's id to see whether and from where it was read.

**A user's account may be compromised.** From the server:

1. `cd server && npm run cli -- set-password <email>` prints a new password once and ends all of that user's sessions (**M-4**).
2. `npm run cli -- disable-2fa <email>` if they use two-factor or might have had one added: someone with the old password could have enrolled their own authenticator (**S-22**), and neither a reset nor `set-password` removes it. The user can enrol again.
3. Revoke the share links they created; those are independent of the password and survive a reset.

**The instance-wide secret may be compromised.** Rotate `SESSION_SECRET` in `.env` and `sudo systemctl restart spine-web`. This invalidates every session, which is the point. It also makes every enrolled authenticator seed unreadable (**S-21**): those users sign in with a recovery code and enrol again, or the operator runs `disable-2fa`.

**`spine.db` may have been exposed.** Share tokens are digests since **S-4**, so the links in it are not usable as-is; revoking them is still the cautious move if the raw tokens may have leaked by another route (an email, a screenshot, browser history). Credential hashes (argon2id) are exposed, so set a new password for every user with the CLI. TOTP seeds are encrypted under a key that is in `.env`, not the database, but treat them as exposed too if `.env` was. Document contents are disclosed. Backup snapshots are copies of the same database and carry the same exposure.

**Restoring.** Stop `spine-web`, copy a snapshot from the backup directory to `data/spine.db` (and `data/originals/` back from the mirror), then start it again. `data/pages/` regenerates on re-ingestion. Delete any stale `spine.db-wal` and `spine.db-shm` beside the restored file: a snapshot is already consistent, and an old sidecar would be applied on top of it.

## Reviewing this document

Re-read it when adding a route, changing share-link scoping or auth, touching the store or a provider adapter, adding a third-party call, or changing what nginx serves. Add a new defect to [Known gaps](#known-gaps), and when it is fixed move it to Closed and add the control to [Controls in place](#controls-in-place) with its file reference. The lists are only useful while they stay true.
