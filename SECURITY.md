# Security

Spine holds complete medical histories and exposes part of them to the public internet
through share links. It is self-hosted, multi-user, and runs on hardware as small as a
Raspberry Pi.

This document states the posture it is **supposed** to hold, records which controls
actually exist, and lists the gaps between the two.

It is written to be enforced: every principle is phrased so a change can be judged
against it, and every gap names the principle it violates. See
[ARCHITECTURE.md](ARCHITECTURE.md) for the component and trust-boundary model.

> **Status.** Multi-user works: accounts, argon2id passwords, open signup with email
> verification, recovery links, and every query scoped by owner, with isolation tests that
> fail when a filter is removed, and hybrid parsing with image egress behind two switches.
> All defects found so far are fixed or accepted (see [Known gaps](#known-gaps)). Not yet
> exercised against a real provider or sidecar: reading a page image, and the sidecar's box
> scaling. See [Multi-user](#multi-user). Nothing here claims current compliance.

## Distribution and who owns the risk

The primary deployment is the author's family. Others may self-deploy, or pay the author
to set up an instance. In every case **the operator of an instance is the data
controller for its contents and owns the risk.** The author is not a processor for other
people's medical data.

Operators will not be security experts, so:

- Insecure configurations must be **unreachable by default**, not merely documented
  against. A default that works but is unsafe is a defect (**P3**).
- Anything that sends data off-host must be an explicit, reversible choice (**P8**).
- The software should refuse to start rather than run in a state the operator would not
  have chosen knowingly.

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

1. **Untargeted internet traffic** — scanners, credential stuffers, crawlers. Constant
   and automated. Reaches login, registration, and share URLs.
2. **Another user of the same instance.** New with multi-user and the boundary most
   easily broken by a careless change. A family member is not an attacker, but the
   control must hold regardless of intent — a query missing an owner filter leaks
   silently and nobody notices.
3. **A share-link recipient exceeding their scope** — a doctor, or whoever the link was
   forwarded to, reaching data outside what was shared.
4. **A leaked share link.** Forwarded email, shared screen, clinic browser history.
   Assume tokens leak eventually.
5. **An attacker who obtains `spine.db`** — stolen backup, misconfigured static mount,
   lost SD card.

### Explicitly out of scope

- **An operator with shell access to their own instance.** They can read the database.
  This is inherent to self-hosting and is stated plainly rather than designed around.
  It is also why there is no in-app admin role: no *application* path reads another
  user's records.
- An attacker with physical possession of the host, or root on it. Disk encryption is the
  host's job.
- Targeted attack on the chosen inference provider or on Let's Encrypt.

## Principles

A change that breaks one of these is a defect, whether or not a test catches it.

**P1 — Deny by default.** A route is private unless deliberately and visibly public.
Today "public" means living in a route file with no `requireAuth` preHandler, so
**adding a route to the wrong file silently publishes it**. Every public route must be
justified in this document.

**P2 — Scoping fails closed.** If a share link's scope cannot be fully resolved, return
nothing. A missing, malformed or unrecognised scope is an error, never "return
everything".

**P3 — No fallback secrets, no unsafe defaults.** The service must refuse to start
rather than run with an absent, default or weak secret — one committed to the repo as a
fallback is a published secret. Extended for self-hosting: any default an unaware
operator would not have chosen is treated the same way.

**P4 — Medical content is served only by authenticated, auditable handlers.** Never a
static file mount: `DATA_DIR` holds `spine.db` and the original scans, so a mount rooted
there is one flag from publishing the archive.

**P5 — Every unauthenticated endpoint is rate limited.** Login, registration,
share-token reads.

**P6 — Capability tokens and secrets are hashed at rest.** Possession of the database
must not confer the ability to use the share links described in it.

**P7 — Every non-owner data access is logged.** Token, timestamp, source address, and
the scope served. Append-only, and part of the backup set.

**P8 — Egress is minimal, enumerated, explicit and disableable.** The only third parties
are configured inference providers. Three rules:

- Every egress path is listed in [ARCHITECTURE.md](ARCHITECTURE.md). A new one is a
  change to that document first.
- **Page images leaving the host requires an explicit opt-in**, and the deployment must
  be able to disable that path entirely and accept weaker OCR.
- **Residency is a property of the endpoint, not the model.** An adapter that can fall
  back to a global endpoint, or authenticate in a way known to ignore the configured
  location, is a defect.
- **Email carries no medical content — ever.** The mail path exists only for account
  recovery and verification: a recipient address and a single-use link. No document text,
  no summary, no extracted field, no attachment. This is what keeps a mail provider from
  becoming a processor of health data, and the mailer interface has no attachment
  parameter precisely so the capability cannot be reached. **Subject and sender must also
  be neutral** — naming a medical system in either reveals that the recipient holds
  medical records, to the provider and to anyone seeing the inbox.

**P9 — Least privilege at the OS layer.** Services run unprivileged with
`ProtectSystem=strict`, `NoNewPrivileges`, write access narrowed to `data/`. The parser
sidecar binds loopback only; it has no auth and accepts a filesystem path, so it must
never be reachable off-host.

**P10 — Tests exercise the real path.** A control is untested unless the test drives it
the way production does. A fixture that builds state directly, bypassing the handler
that encodes it, proves nothing.

**P11 — Recoverable by design.** `data/spine.db` and `data/originals/` must be
restorable. `data/pages/` is regenerable.

**P12 — Isolation is structural, not remembered.** Every read and write is scoped by
owner **in the store layer**. A repository method that does not take an acting user id,
or that can return a row the acting user does not own, is a defect. Route handlers must
not be able to write queries, so isolation cannot be forgotten in one. The only
exception is a share-token read, scoped by the link's owner resolved from the token —
never from a session.

**P13 — Credentials are stored with a memory-hard KDF and are never recoverable.**
argon2id, per-user salt, parameters tuned to the host. No reversible storage, no
password in a log or error, and no reset path that reveals the old value. Changing a
password invalidates that user's existing sessions.

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
| Upload cap 200 MB (nginx and Fastify) | `spine.conf:35`, `index.ts:53` |
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
| Originals stored under `data/originals/<user>/<year>/` | `routes/source-files.ts` |
| Responses list explicit columns: no `user_id`, server path, checksum or token; tested by scanning whole responses | `store/sqlite/`, `__tests__/response-shape.test.ts` |
| Signup, verification, forgot and reset limited per source and per address; identical answers for known and unknown addresses | `routes/accounts.ts`, `rate-limit.ts` |
| Verification and reset tokens: hashed at rest, single-use by one atomic update, in the URL fragment, spent by POST | `accounts.ts`, `store/sqlite/users.ts`, `web/src/auth.ts` |
| An unverified account never gets a session | `routes/auth.ts`, `routes/middleware.ts` |
| Mail has no attachment field, neutral wording, and a required sender; failures never log the message | `mail/`, `accounts.ts` |
| Open signup without a mailer refuses to start | `config.ts` |
| Page images leave only through `readPage`, which only the `multimodal` and `hybrid` parsers call, and those need `SPINE_MULTIMODAL_ENABLED` as well; `hybrid` never sends a native-text page | `parser/`, `config.ts` |
| Startup logs whether images can leave, and each one sent | `index.ts`, `parser/adapters/` |
| Page images served only by an authenticated route, streamed, `Cache-Control: private` | `routes/documents.ts` |
| No static mount over `DATA_DIR` | `index.ts` |
| Share tokens 256-bit, stored as `sha256` — never in plaintext | `share-token.ts`, `routes/share.ts` |
| Legacy plaintext tokens rewritten to digests at boot, idempotently | `hash-legacy-tokens.ts` |
| Share entry route serves the app shell, never JSON | `routes/public-share.ts` |
| Share expiry bounded 1–30 days, default 7; revocation checked on every read | `routes/share.ts`, `routes/public-share.ts` |
| A scope that cannot be fully resolved is rejected at creation, and serves nothing if found stored | `share-scope.ts`, `routes/public-share.ts` |
| Access logged before data is returned; `view_count` counts document reads | `routes/public-share.ts` |
| Share view is text-only — no image URL reaches a recipient | `web/src/pages/PublicShareView.tsx` |
| No SQL or driver import outside the store adapter | `store/sqlite/` |
| PATCH takes a patch object, so no request key reaches a column name | `routes/documents.ts`, `store/sqlite/documents.ts` |
| Every LLM response validated against a schema before it reaches the database | `llm/types.ts`, `llm/chat-llm.ts` |
| Startup refuses an unknown LLM provider, an unstated Vertex endpoint/region, or a stray Google API key | `llm/index.ts`, `llm/adapters/vertex.ts` |
| Startup refuses a database from before multi-user, saying whether it is safe to delete | `store/sqlite/connection.ts` |
| Daily `VACUUM INTO` snapshot + forward-only originals mirror, retention 7 | `backup.ts`, `systemd/spine-backup.timer` |
| Restart reconciliation of stranded jobs | `ingestion/pipeline.ts` |

### Host

| Control | Where |
|---|---|
| `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `ReadWritePaths=data/` | both units |
| Sidecar bound `127.0.0.1:8000` | `spine-ingestion.service:10` |
| Services run as the invoking user, not root | both units |

## Known gaps

Defects in the code as it stands. Severity: **High** = unauthorised access to medical
data or account takeover. **Medium** = weakens a control or widens blast radius given a
precondition. **Low** = hygiene and defence in depth.

**Nothing is currently open.** That is a statement about this list, not a claim of
security: it means every defect found so far has been fixed or explicitly accepted, and
the next review should expect to add to it. The work multi-user needs before it can ship
is tracked separately in [Multi-user](#multi-user).

The original five findings were confirmed against a running instance, not inferred.
[Closed](#closed) records what has been fixed and keeps those ids resolvable, since they
are referenced from [ARCHITECTURE.md](ARCHITECTURE.md).

### Accepted

**S-16 — Sessions live in memory.** Restarting the server signs everyone out, and
sessions are not shared between processes. Fine for one process; a second would need a
shared store.

**S-17 — The instance-wide login cap can lock everyone out.** 50 failed logins in ten
minutes from anywhere stops all logins for the rest of the window, including the real
owner's. That is the trade for throttling a distributed guess; the per-source limit runs
first so one noisy host does not spend it alone. An attacker who can send 50 requests can
deny sign-in for ten minutes at a time. Existing sessions are unaffected.

**S-19 — nginx's access log holds raw share tokens.** `/share/<token>` and
`/api/share/<token>/documents` are in the path, so `spine.access.log` records every live
token. Hashing them in the database (S-4) does not help against someone who can read the
log, which is the operator and anyone the log is shipped to. Verification and reset links
avoid this by using a fragment; share links cannot without changing how recipients open
them. Rotate the log, keep it readable by the operator only, and revoke links that matter.

**S-9 — The audit log trusts `X-Real-IP`.** `public-share.ts` reads the header before
the socket address. Correct behind nginx, forgeable if Fastify is reachable directly,
which would poison the only record of who read what. Acceptable while **P9** holds —
and since S-13, it does: Fastify binds loopback, so only the proxy can set that header.
Revisit if anything ever makes Fastify reachable without the proxy in front.

### Closed

Fixed; the control is in [Controls in place](#controls-in-place). Kept because the ids are
cited elsewhere here and in [ARCHITECTURE.md](ARCHITECTURE.md).

**S-1 — Share scoping failed open** (**High**, **P2**). A `tag` scope with no
`scope_value` was accepted, and on read every branch of the scope chain was skipped so
the query ran unfiltered — confirmed at 215 documents on a running instance.
`share-scope.ts` is now the one place a scope is resolved: creation rejects what it
cannot resolve, and the read path re-resolves the stored row, so rows written before the
fix also fail closed.

**S-2 — No rate limit on `/api/auth/login`** (**High**, **P5**). `@fastify/rate-limit`
was registered `global: false` and applied to no route. Now a per-source limit (the
plugin) plus an instance-wide cap (ours — the plugin applies only its first hook per
request, so two of its limiters cannot both run). Per-source runs first, so an address
that has spent its budget stops consuming the instance-wide one.

**S-3 — `SESSION_SECRET` fell back to a repo-published value** (**High**, **P3**).
`config.ts` validates both secrets before anything binds an interface or opens the database,
reporting every problem at once; `install.sh -s` runs the same check so a bad `.env`
fails at deploy, not in a restart loop.

**S-4 — Share tokens stored in plaintext** (**Medium**, **P6**). The column holds
`sha256(token)` now, hashed in one place (`findLiveLink`) so both public routes go
through it. Plain SHA-256 is right here: the input is 256 bits of CSPRNG output, so
there is nothing to brute-force.

No link broke and no migration runner was needed — the plaintext was in the row, so each
digest was computable in place, and the shapes are unambiguous (43 base64url issued, 64
hex stored), which makes the rewrite idempotent at boot. A row matching neither shape is
left alone and logged.

**S-5 — No CSP, `Referrer-Policy` or `Permissions-Policy`** (**Medium**). All three set,
plus `object-src`, `frame-ancestors`, `base-uri`, `form-action`. `script-src 'self'`
needs no exception: the build has one external module script, one stylesheet, no inline
`<script>`, no `data:` URI. `style-src` carries `'unsafe-inline'` because React writes
inline style attributes; `style-src-attr` would be tighter but blocks them where
unsupported, and inline styles cannot execute script.

**S-6 — `tag` scopes broken by double JSON encoding** (**Medium**, **P2**). Creation
stored `JSON.stringify(value)`, the read path compared it to `tags.name` unparsed — 0 of
8 documents returned. One module now serialises and parses; existing rows are unaffected
because the encoding did not change.

**S-7 — The scope test could not fail** (**Medium**, **P10**). `|| true` in the
assertion, over an array that S-6 left empty anyway. Links are now created through
`POST /api/share-links` and returned id sets compared exactly, which is what catches a
scope returning *more* than it should. Confirmed by reintroducing both defects and
watching the tests fail.

**S-8 — Responses carried internal columns, server paths and live tokens** (**Low**).
`SELECT *` sent each page's absolute `image_path` and the share-link list sent every
token. Multi-user made it worse before it was caught: the new `user_id` column went to
**share recipients** in `GET /api/share/:token/documents`, and `GET /api/source-files`
returned absolute `file_path`s, checksums and `user_id`. Every query now lists explicit
columns, and `response-shape.test.ts` scans whole responses for forbidden keys and for
any absolute path in a value, so a column added to a table does not leak by default.
Confirmed by reverting one query to `d.*` and watching it fail.

**S-10 — Failed logins unrecorded** (**Low**). Failures and successes are logged with the
source address; the password never is.

**S-11 — No automated backup** (**Low**, **P11**). `spine-backup.timer` daily,
`Persistent=true` so a Pi that was off catches up. `VACUUM INTO` for the database,
because copying the file under load is unsafe in WAL mode — the `-wal` sidecar holds
committed pages the main file does not. Originals are immutable after upload, so they get
a forward-only mirror. `data/pages/` is not copied; it regenerates. Retention
`SPINE_BACKUP_KEEP`, default 7, never below one.

**This protects against corruption and mistakes, not against losing the disk** — it
writes beside `data/` by default. `SPINE_BACKUP_DIR` pointed at removable or network
storage makes it offsite, which also needs that path in `ReadWritePaths`.

**S-18 — No way to delete a user** (**Low**). `npm run cli -- delete-user <email> --yes`
removes the account, every row it owns, its originals, its page images and its copy in
the backup mirror, and says what it removed. Without `--yes` it only reports what it
would. Database snapshots already taken still hold the rows until retention prunes them
(7 days by default). A deleted user's sessions end on their next request. Tested against
another user's data, files and search results being untouched.

**S-12 — Request-body keys interpolated into SQL** (**High**). `PATCH
/api/documents/:id` built its `SET` clause from `Object.keys(req.body)`, and `Body` is a
compile-time type only, so a key like `user_notes = (SELECT token FROM share_links LIMIT
1), provider` appended SQL while keeping the parameter count valid. Handlers now pass a
patch object and the store maps it to columns, so no request key reaches the SQL.

**S-13 — Fastify bound `0.0.0.0` while trusting `X-Forwarded-*`** (**Medium**, **P9**).
This document listed "Fastify bound to localhost" as a control; it was not one. On a home
LAN port 3000 was directly reachable, bypassing nginx's rate limit and making `X-Real-IP`
attacker-controlled — trust boundary 2, and S-9's precondition. It binds `127.0.0.1`
unless `SPINE_HOST` says otherwise; verified the LAN address refuses.

**S-14 — `/share/` received none of the security headers** (**Medium**). nginx inherits
`add_header` from an outer level only if the inner level declares none of its own. The
`/share/` location sets two, so it was dropping HSTS, nosniff and `X-Frame-Options` — on
the one surface an unauthenticated reader reaches. The block is repeated inside the
location, with a comment that both copies change together.

**S-15 — `GET /share/:token` returned JSON** (found while reviewing the share path). The
SPA fallback excludes `/share/`, so this route is the only thing answering a recipient's
URL, and it returned `{"ok":true,...}` — a doctor following a link saw that, not the
documents. It serves the app shell as `text/html` now, and a plain page for a dead link.
The route had no test; it has five. `view_count` moved to the data route, since it means
documents were read, while both routes still append to the access log (**P7**).

## Multi-user

The requirements multi-user put on the design, and where each stands. All are
implemented.

**M-1 — Owner-scoped store layer.** **P12. Implemented.** Every user-owned table has a
`user_id`, and every statement in `store/sqlite/` filters by it. Handlers cannot write
queries: zero `.prepare()` calls exist outside the adapter. There is no `find(id)`
without a user, and a repository method called with no acting user throws rather than
matching nothing quietly.

What a method does with a record the caller does not own: a read returns nothing, an
update or delete changes nothing, and a create that names such a record throws and
inserts nothing. Routes check first and answer 404, never 403, so a record cannot be
probed for.

Four exceptions, enumerated in `store/types.ts` so a fifth has to be argued for:
share-token resolution and `listForShare` (scoped by the link's owner, never by a
session); `logAccess` (the reader is unauthenticated); `maintenance.*` (boot-time work);
and `users.*` (the identity layer — login must find a user before there is an acting
user).

`__tests__/isolation.test.ts` runs as a second user against the first user's data across
every route and every repository method. It was written before the filtering existed and
failed 25 of 28 for the right reasons; removing the search filter or the share ownership
check afterwards fails it again. Removing only the inner tag-owner check in the tag-scoped
share query does *not* fail it, because the outer `d.user_id` already excludes other
users' documents — that one is defence in depth.

**M-2 — Owner-aware full-text search.** **Implemented.** The FTS index stays shared;
results are filtered by joining back to `documents.user_id`. Tested.

**M-3 — Credential storage.** **P13. Implemented.** argon2id, 19 MiB / 2 passes / 1 lane
(the OWASP minimum), per-hash salt, 12–256 characters. About 30 ms on a laptop; not yet
measured on the Pi. Login is by email; an unknown email runs a dummy verification so it
is neither faster nor different in answer.

**M-4 — Session invalidation on password change.** **P13. Implemented.** `users.auth_version`
is bumped on a change; a session carries the value it was issued under and is refused
once it no longer matches. Every request re-resolves its session against the database,
so this takes effect on the next request. Login also issues a new session id.

**M-5 — Share creation verifies ownership of the scope.** **Implemented.** A
`document_ids` link naming a document the creator does not own is rejected at creation,
with one message for "not yours" and "does not exist".

**M-6 — Login and registration throttling.** **P5. Implemented.** Login: per source
and instance-wide (S-2). Signup, resend, forgot and reset: per source **and per email
address**, so they cannot be used to flood an inbox. The address limit is
`rate-limit.ts`, because the Fastify plugin cannot stack two limiters on one route.

Signup is `SPINE_REGISTRATION=open`, default `operator`. `open` with no mailer fails at
startup (**P3**), so a fresh install boots without one. Verification is mandatory: an
unverified account gets no session, and the right password before confirming answers 403
with a code the page uses to offer a new link. A taken address is answered exactly like a
new one — same body, same status, no mail — and its password is not touched.

**Residual:** a new address does a few more database writes than a taken one, so the
timing is close but not identical. The mail itself is sent after the response, which is
the large part.

**M-7 — Explicit opt-in for image egress.** **P8. Implemented.** `SPINE_PARSER` defaults to
`sidecar`, which sends nothing. The parsers that send page images, `multimodal` and
`hybrid`, need **a second, separate switch**, `SPINE_MULTIMODAL_ENABLED=true`, and are
refused at startup without it — in `config.ts`, and again in `createParser`, which is the
function that decides whether an image can leave and does not rely on its caller. The
second switch alone does nothing. Picking a parser therefore never turns egress on by
implication.

The startup log states the result: `imageEgress: true`, plus a warning naming the provider
and endpoint; each image sent is logged with its page. In `hybrid`, only pages the sidecar
had to OCR or found nothing on are sent — never a `native_text` or `mixed` page, which a
test asserts.

**Which provider matters.** Images go to `SPINE_LLM_PROVIDER`. The Anthropic adapter has
no EU-only processing commitment, so a deployment with a residency requirement should
enable this only on Vertex at an `eu` endpoint (M-8). Nothing in the software knows that
your deployment has such a requirement, so it does not stop you.

**What has not been exercised:** no real page has been sent to a real provider. The message
that carries the image was checked against both providers' request builders only.

**M-8 — Residency enforcement in the provider adapter.** **P8. Implemented at the
configuration level.** The Vertex adapter requires `SPINE_LLM_ENDPOINT`,
`SPINE_LLM_REGION` and `SPINE_LLM_PROJECT` to be stated — nothing defaults, so an
instance cannot reach a global endpoint by omission — and the resolved provider, model
and endpoint are logged once at startup.

The control that does the work: **construction fails if `GOOGLE_API_KEY`,
`GEMINI_API_KEY` or `GOOGLE_GENAI_API_KEY` is present at all.** Reproduced against the
installed `@langchain/google-vertexai`: with one set and an EU endpoint and region
configured, the request goes to

```
https://aiplatform.googleapis.com/v1/publishers/google/models/<model>:generateContent
```

Global host, configured endpoint dropped, no region in the path. In
`@langchain/google-common`, `chat_models.js` reads `GOOGLE_API_KEY` from the environment
when no `apiKey` was passed, then `connection.js` has `isApiKey` force
`computedPlatformType` to `"gai"` and `buildUrlVertex()` branch to
`buildUrlVertexExpress()`, which hardcodes the global host. Same behaviour as reported
for `@google/genai` ([gemini-cli#27984](https://github.com/google-gemini/gemini-cli/issues/27984),
closed "not planned" 1 Sep 2026), so it is a class of bug across Google's client
libraries. API keys are also blocked on standard Vertex endpoints and unsupported for
Claude's `rawPredict`, so there is no legitimate reason for one to be set here.

**Not done, deliberately:** asserting the shape of the outgoing URL. An earlier version
wrapped the library's HTTP client and checked host and `/locations/<region>/` per
request. That encodes Google's URL scheme — meaningless for an Azure or Bedrock endpoint
— and the API-key path bypasses it, which is why the refusal above is the real control.
Verify residency against the provider's request logs on first deployment; that check
works for any provider.

**M-9 — Per-user paths for originals.** **Implemented.** `data/originals/<user>/<year>/`,
so a filesystem mistake cannot cross users as easily as a query mistake. Asserted in the
upload test.

**M-10 — A migration runner: not needed yet, and the last free schema change was
spent.** `CREATE TABLE IF NOT EXISTS` cannot add a column to an existing table. The
archive held no records, so multi-user and then verification (`email_verified_at`,
`user_tokens`) changed `schema.sql` directly. A database from either earlier shape is
**refused at startup**, with a message saying how many uploads and documents it holds and
whether it is safe to delete.

**The next schema change needs a runner first**, or an empty database. Load real records
only after deciding that.

**M-11 — Account recovery and verification.** **Implemented.**

- The token is a capability: 256 bits of CSPRNG output, only its **sha256 stored**
  (**P6**), spent by one atomic `UPDATE` so two simultaneous requests cannot both succeed.
  A newer one replaces an older one. Verification lasts 24 hours, reset one hour.
- It travels in the URL **fragment**, never sent to the server, so it stays out of nginx's
  access log and the Referer header; the page removes it from the address bar. It is spent
  by a `POST`, so a mail scanner following links cannot spend it.
- Using a reset link ends **all** the user's sessions (**P13**, as M-4) and confirms the
  address.
- Requests answer identically whether or not the address has an account, and are rate
  limited (**P5**).
- A send failure is logged and the page says to request another link. It is not shown as
  an error, because an error only for addresses that exist would be a way to find them.
- The mail carries no medical content (**P8**): an address and a link, no attachment
  field to put anything in, neutral subjects, and a test that fails on clinical wording.
- Without a mailer, `npm run cli -- reset-link <email>` prints the same single-use link.

## Enforcement checklist

For any change touching routing, auth, share links, storage, providers or static
serving:

- [ ] Does a new route land in a file with `requireAuth`? If public, is it justified
      here? (**P1**)
- [ ] Does a new table carry `user_id`, and does every statement on it filter by it?
      Does a new repository method take the acting user's id first? (**P12**) Is it
      inside `store/sqlite/` — the only place SQL or a driver import belongs?
- [ ] Does a new query list explicit columns? `SELECT *` on a table with `user_id` sends
      it to the client. (**S-8**)
- [ ] Does a new route sit behind `requireAuth`? `isolation.test.ts` fails if a public
      route is not on its allow-list. (**P1**)
- [ ] Is a new method exempt from taking a user id? Then it must be one of the four
      exceptions in `store/types.ts`, argued for there, not a fifth added quietly.
- [ ] Can any share-link path return documents without a fully resolved scope? (**P2**)
      Does scope creation verify the creator owns everything it names? (**M-5**)
- [ ] Does any config read a secret with a `??` fallback, or ship a default an operator
      would not knowingly choose? (**P3**)
- [ ] Is medical content served by anything other than an authenticated handler — static
      mount, redirect, signed URL? (**P4**)
- [ ] Does a new nginx `location` set any `add_header`? If so it inherits none from the
      server level and must repeat the security headers. (**S-14**)
- [ ] Is every new unauthenticated endpoint rate limited at nginx or Fastify? (**P5**)
      Note `@fastify/rate-limit` applies only its first hook per request, so a second
      limit on one route has to be enforced separately (see S-2).
- [ ] Does anything new leave the host? Is it listed in
      [ARCHITECTURE.md](ARCHITECTURE.md), opt-in, and disableable? Do page images leave
      only through `readPage`, on a path that needs both switches? (**P8**, **M-7**)
- [ ] Does a provider adapter require its endpoint to be stated, and can it fall back to
      a global one? (**P8**, **M-8**) Is residency being asserted from a URL's shape —
      which only holds for one provider — rather than verified against request logs?
- [ ] Does anything above `src/llm/adapters/` import a vendor package? That is a review
      failure: the interface exists so the library can be swapped without touching ingestion.
- [ ] Does anything widen the listening surface — a new bind address, an interface opened on a
      unit, a proxy header trusted from somewhere other than nginx? (**P9**, S-13)
- [ ] Does anything put document text, a summary, a field or an attachment into an
      email? Does any subject line or sender name reveal that this is a medical system?
      (**P8**)
- [ ] Do tests drive the control through the real handler, with assertions that can
      actually fail? (**P10**)
- [ ] Does `SELECT *` cross a trust boundary and carry fields the client should not see?
      (**S-8**)

## Operational response

**A share link is leaked or sent to the wrong person.** Revoke it from the Share Links
page; `revoked` is checked on every read, so it takes effect immediately. Check
`share_link_access_log` for that link's id to see whether and from where it was read.

**A user's account may be compromised.** Set a new password from the server:
`cd server && npm run cli -- set-password <email>` prints a new one once and ends all of
that user's sessions (**M-4**). Revoke the share links they created — those are
independent of the password and survive a reset.

**The instance-wide secret may be compromised.** Rotate `SESSION_SECRET` in `.env` and
`sudo systemctl restart spine-web`. This invalidates every session on the instance,
which is the point.

**`spine.db` may have been exposed.** Share tokens are digests since **S-4**, so the
links in it are not usable as-is; revoking them is still the cautious move if you cannot
rule out that the raw tokens leaked by another route (an email, a screenshot, a browser
history). Credential hashes (argon2id) are exposed — set a new password for every user with the
CLI.
Document contents are disclosed. Backup snapshots are copies of the same database and
carry the same exposure.

**Restoring.** Stop `spine-web`, copy a snapshot from the backup directory to
`data/spine.db` (and `data/originals/` back from the mirror), then start it again.
`data/pages/` regenerates on re-ingestion. Delete any stale `spine.db-wal` and
`spine.db-shm` beside the restored file — a snapshot is already consistent, and an old
sidecar would be applied on top of it.

## Reviewing this document

Re-read it when adding a route, changing share-link scoping or auth, touching the store
or a provider adapter, adding a third-party call, or changing what nginx serves.

Move items out of [Known gaps](#known-gaps) and
[Multi-user](#multi-user) as they are fixed, and add the
control to [Controls in place](#controls-in-place) with its file reference. The lists are
only useful while they stay true.
