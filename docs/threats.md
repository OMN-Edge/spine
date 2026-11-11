# What Spine protects against, and how it is checked

Spine keeps medical records, so the question to ask before trusting it is not "is it secure?" but "secure against what, and checked how?". This page answers both: the threats and the attacks Spine is built to resist, each with what stops it and where that is checked, and how that is kept true as the code changes. The engineering detail behind every line is in [SECURITY.md](../SECURITY.md), under the IDs given here.

## How it is checked

Security is part of how Spine is built and released, what the industry calls a secure software development lifecycle: automated checks on every change, a security review before every release, and a release that anyone can verify.

| Stage | What happens | Where |
| --- | --- | --- |
| On every change | The test suites, including the security tests named on this page; the dependency audit (a high or critical advisory fails it); secret scanning of the whole history (gitleaks); static analysis (semgrep); the device's code and the whole app in real Chrome against a real server and relay, with a search of the server's files for readable record text; the web app built twice and compared | `.github/workflows/ci.yml`, `scripts/check.sh` |
| Before every release | A security review of what changed since the last release: the threat model updated (what is protected, who might attack it, where data crosses from one party to another; 14 trust boundaries today), each area the change touches checked against the enforcement checklist of SECURITY.md and the matching OWASP ASVS chapter with a verdict for each, what it finds fixed with a test that fails without the fix, the documents the change touches read against the code, and the running service checked after the deploy (`scripts/host-report.sh`) | [releasing.md](releasing.md) |
| At release | Built by GitHub from a tagged commit of `main`, after every check runs again; its files and their hashes carry a signed attestation of that commit; a deployed site can be compared with it file by file | `.github/workflows/release.yml`, [verify-build.md](verify-build.md) |

The first full review, of the whole code and the live instance, was made in November 2026 with the method each release review now follows.

The standards it is measured against:

- **OWASP Application Security Verification Standard (ASVS) 5.0.0** (May 2025): the industry's checklist of security requirements for web applications, in 17 chapters and three levels. A release review goes through its chapters for the areas a change touches. Its requirements are not all checked one by one, so **no ASVS level is claimed**.
- **OWASP Top 10:2025**: the ten most common kinds of web application risk. Each threat below names the category it falls under.
- **OWASP Top 10 for LLM Applications 2025**: the same for software that uses AI models (prompt injection, excessive agency, unbounded consumption).
- **OWASP Web Security Testing Guide (WSTG) 4.2**: how to test each area; the attacks written as tests follow it.

## The threats, and what stops each one

Each row is something an attacker or an accident could do, what in Spine stops it, how that is checked, and what is left. A test named in a row runs on every change.

### Someone gets hold of the server, its database or its backups

| | |
| --- | --- |
| **The threat** | A stolen backup, a lost disk, a break-in at the host, or the operator themselves reading what is stored (OWASP A04 Cryptographic Failures; ASVS V11 Cryptography, V14 Data Protection) |
| **What stops it** | Records are read and kept on the owner's device, and reach the server only sealed (XChaCha20-Poly1305) under keys made on the device from the master password, the recovery kit or a passkey. The server never receives the password; it holds a value derived from it, hashed again with argon2id. The database holds no record at all, only accounts and sealed keys (SECURITY.md **M-34** to **M-38**) |
| **How it is checked** | `boundary.test.ts` fails if the server's code reaches a store of records; `npm run check:app` searches the real server's files for readable record text after a session in a real browser and finds none |
| **What is left** | A weak master password can be guessed offline against a stolen copy of the wrapped keys: the strength of the password is the protection |

### A server that lies, or a hostile operator, tries to get the keys

| | |
| --- | --- |
| **The threat** | A compromised or dishonest server tells the device something false so that it gives away a key: that an account has no vault, that a weak key setting is fine, that a public key is someone's when it is the server's own, or an older state of the records (A04, A08 Software or Data Integrity Failures; ASVS V11) |
| **What stops it** | The device judges the server's answers instead of obeying them: it refuses key-derivation settings below a floor and notices a change from what it saw before (**S-37**); keys between two people travel through a one-time code, not the server's list (**S-39**, **S-41**); the owner compares an eight-character code with a visitor before approving them (**S-40**); a device notices when the vault shows an older state than it last saw (**S-43**) |
| **How it is checked** | `kdf-trust.test.ts`, `delegation-binding.test.ts`, `share-code.test.ts`, `persist.test.ts` |
| **What is left** | An operator can serve a different web app that takes keys as they are typed. Spine's build is reproducible and every file's hash is published, so anyone can check that the app they are served is the one built from the open code ([verify-build.md](verify-build.md)), but someone has to run that check |

### Someone takes over an account

| | |
| --- | --- |
| **The threat** | Guessing passwords, stealing a session cookie, abusing a password-reset link, guessing two-factor codes, a forged request from another site, or faking the source address to dodge rate limits (A07 Authentication Failures; ASVS V6 Authentication, V7 Session Management) |
| **What stops it** | argon2id; common and patterned passwords refused; limits per source, per account and for the whole instance; optional two-factor and passkeys; sessions the owner can see and end, that expire after a day unused; the password asked again before sensitive changes; mail on a new browser. A reset link alone cannot replace an account's keys: it needs the second factor and a signature only the recovery kit can make, the owner is mailed, and recovery by email can be turned off (**S-38**). Requests that change something must come from the app's own origin (**S-50**); the client's address cannot be forged (**S-31**) |
| **How it is checked** | `auth.test.ts`, `second-factor.test.ts`, `sessions.test.ts`, `password-policy.test.ts`, `totp.test.ts`, `reset-proof.test.ts`, `reset-second-factor.test.ts`, `email-recovery.test.ts`, `same-origin.test.ts` |
| **What is left** | Two-factor is optional. Malware on the person's own computer can use a session while it lasts |

### Another user of the same instance reads your records

| | |
| --- | --- |
| **The threat** | A missing check lets one account see or change another's data (A01 Broken Access Control; ASVS V8 Authorization) |
| **What stops it** | Isolation is built into the structure, not remembered route by route: every store method takes the acting user, a route cannot write a query, and a request for something that is not yours gets the same answer as one for something that does not exist (**P12**, **M-1**). The server holds no records to mix up in the first place |
| **How it is checked** | `isolation.test.ts` signs in as a second user against the first user's data across every route, and fails on any route that answers without a session and is not on a short allow-list; `response-shape.test.ts` scans whole responses for fields that must not be there |
| **What is left** | Nothing known |

### A share link leaks, or a recipient sees more than was shared

| | |
| --- | --- |
| **The threat** | A link forwarded to the wrong person, found in a browser history, or a recipient reaching documents outside what the link covers (A01; ASVS V8, V4 API and Web Service) |
| **What stops it** | A share is a sealed copy holding only what the link covers, under a key that lives after the `#` in the address and never reaches the server. A link can require the owner's approval of each browser, after comparing a code. Links expire (at most 30 days) and can be revoked at once. A scope that cannot be worked out shares nothing. A page set aside stays out of the copy (**S-45**); allowing questions asks for the password again and says what it adds (**S-47**); a link's id alone cannot get a pass for model calls or write to the owner's record of who opened it (**S-48**, **S-54**) |
| **How it is checked** | `shared.test.ts`, `slice.test.ts`, `public-share-detail.test.ts`, `share-pass.test.ts`, `audit.test.ts` |
| **What is left** | Whoever holds a whole link reads what it shares, and what a recipient has already seen can be copied |

### A document carries hidden instructions for the AI

| | |
| --- | --- |
| **The threat** | A forwarded PDF contains text that tries to steer the assistant into leaking or changing records (LLM01 Prompt Injection, LLM06 Excessive Agency) |
| **What stops it** | The assistant can only read, and only the signed-in person's own records; it never handles an id or a user, only labels the request gave it. Anything it suggests is a proposal the person confirms, with the words on the card written by the app, not the model. A recipient's assistant is held to the shared documents in code. The page shows no image or link the model makes up, and the content security policy lets the page talk only to Spine and its relay, so there is no way out for stolen text (**M-18**, **M-20**, **M-21**) |
| **How it is checked** | `chat-actions.test.ts` (no proposal writes anything until it is confirmed), `share-chat.test.ts` (a recipient's assistant mentions nothing outside the link however it is asked); a live test gives the real model a document that tells it to do something, and it does not |
| **What is left** | A hostile document can still steer an answer about itself, which is why answers cite their sources and the original page is always one tap away (**S-27**) |

### A crafted file, or a flood of requests, exhausts the device or the host

| | |
| --- | --- |
| **The threat** | A small PDF that unpacks into gigabytes, a zip that writes outside its folder, endless sign-ups that fill the disk or send mail to strangers, repeated downloads of a share, requests built to make a rate limiter slow, model calls run up at the operator's cost (A10 Mishandling of Exceptional Conditions; LLM10 Unbounded Consumption; ASVS V5 File Handling) |
| **What stops it** | Files are recognised by their content, never by their name; zip entries are read by name and never written to a path the zip chooses; a PDF of more than 500 pages is refused and an oversized page is drawn smaller (**S-55**); sealed objects are streamed, never held whole, and capped in number (**S-58**); limits on share downloads in bytes (**S-57**), on sign-ups and mail for the whole instance (**S-51**), the waitlist (**S-52**) and free disk space (**S-56**); a limiter that stays fast whatever the number of addresses (**S-53**); a daily allowance of model calls per account and per share, and a share's pass can only run what a recipient does (**S-35**, **S-49**) |
| **How it is checked** | `rasterize-limits.test.ts`, `object-reads.test.ts`, `share-reads.test.ts`, `signup-caps.test.ts`, `disk-space.test.ts`, `window-limiter.test.ts`, `relay.test.ts` |
| **What is left** | Nothing bounds all the instance's model calls together except the provider's own budget alert |

### The software supply chain is poisoned

| | |
| --- | --- |
| **The threat** | A compromised dependency, a leaked secret in the code, or a release built from something other than the code (A03 Software Supply Chain Failures, A08) |
| **What stops it** | One lockfile installed exactly; the build stops on a high or critical advisory; secret scanning and static analysis on every change; the release is built and signed by a job that installs nothing and runs no action that can move under it (**S-59**); every file of the web app is hashed and the build can be repeated and compared (**M-40**) |
| **How it is checked** | `workflows.test.ts` reads the pipelines; `./scripts/check.sh` runs what CI runs; on 2026-11-10 three moderate advisories in indirect dependencies were found and updated away |
| **What is left** | An advisory published after a build is found at the next build |

### The host is set up unsafely

| | |
| --- | --- |
| **The threat** | A default secret, a service reachable that should not be, files other users of the machine can read, a secret held by a process that does not need it (A02 Security Misconfiguration; ASVS V12 Secure Communication, V13 Configuration) |
| **What stops it** | The server refuses to start with a missing, short or published secret or an unsafe combination of settings (**P3**); it listens only behind the proxy; strict transport security and a strict content security policy on every page, and on the live instance TLS 1.2 and 1.3 only, with modern ciphers; every service writes files only its own user can read (**S-61**); the relay holds none of the server's secrets (**S-62**) |
| **How it is checked** | `permissions.test.ts` reads all three service units; `relay-environment.test.ts`; `scripts/host-report.sh` on the live host; the TLS versions, ciphers and headers were checked from outside |
| **What is left** | The operator's own machine, firewall and other software are the operator's to keep |

### Records are lost by mistake

| | |
| --- | --- |
| **The threat** | A deletion, a bug or a reset that starts over removes records that cannot be got back (ASVS V14) |
| **What stops it** | A daily snapshot of the accounts database and a copy of the sealed vault; anything the vault removes stays in the backup for a week before it goes (**S-60**); the whole archive can be exported at any time |
| **How it is checked** | `backup.test.ts`; the host report restores the newest snapshot onto a copy and checks it |
| **What is left** | Losing both the master password and the recovery kit means the records cannot be opened by anyone, by design |

### Personal data leaves for third parties

| | |
| --- | --- |
| **The threat** | Records sent to a model provider, a mail provider or a payment provider beyond what is needed (LLM02 Sensitive Information Disclosure; ASVS V14) |
| **What stops it** | Every path that leaves the host is listed in [ARCHITECTURE.md](../ARCHITECTURE.md#egress-what-leaves-the-host) and can be switched off; page images need two separate switches; mail never carries medical content; the payment provider never sees a record; a Vertex endpoint, region and project must be stated, and the settings that would quietly send to a global endpoint stop the relay at start (**P8**, **M-7**, **M-8**) |
| **How it is checked** | A test fails if mail contains clinical words (`mail.test.ts`); a test fails if the relay keeps or logs a request's body (`relay.test.ts`); the relay says at start where its calls go |
| **What is left** | The model provider sees the text of the calls a person chooses to make, and its retention is a matter of contract, not code |

### Logs leak, or an attack goes unnoticed

| | |
| --- | --- |
| **The threat** | Passwords or records written to logs, or a takeover nobody sees (A09 Security Logging and Alerting Failures; ASVS V16) |
| **What stops it** | Logs carry no record content and no password; sign-ins, failures and security changes are logged with their source, and the owner is mailed on a new browser, a password or two-factor change, and a passkey added or removed |
| **How it is checked** | `relay.test.ts` fails if the relay keeps or logs a request's body; `sessions.test.ts` checks the mail on a password or two-factor change |
| **What is left** | Alerting on unusual activity across accounts is the operator's |

## The attacks Spine is built to resist

The same ground as the threats above, named the way an assessment report names it: by the attack, with its [CWE](https://cwe.mitre.org/) entry or its OWASP category, and the control that stops it. The **S-** and **M-** IDs are SECURITY.md's.

| Attack | Reference | What stops it |
| --- | --- | --- |
| Man-in-the-middle and TLS stripping | CWE-319 | HTTPS only, TLS 1.2 and 1.3, strict transport security (`nginx/spine.conf`; the live instance checked from outside) |
| Cross-site scripting (XSS) | CWE-79 | A content security policy that runs only the app's own scripts; text from documents and the model is rendered as text, the only HTML set from data is three QR codes made in the browser |
| Clickjacking | CWE-1021 | `X-Frame-Options: DENY` and `frame-ancestors 'none'` |
| Cross-site request forgery (CSRF) | CWE-352 | `SameSite=Strict` session cookie and a same-origin check on every request that changes something (**S-50**, `same-origin.test.ts`) |
| Tampered app code | CWE-494 | Subresource integrity on the page's scripts and styles, and a published hash of every file of a reproducible build (**M-40**) |
| Credential stuffing and password spraying | CWE-307 | argon2id, limits per source and for the whole instance, common and patterned passwords refused (`auth.test.ts`, `password-policy.test.ts`) |
| Account enumeration | CWE-204 | Identical answers and timing for known and unknown addresses at sign-in, sign-up and reset (**M-3**, **M-6**) |
| Two-factor brute force and code replay | CWE-307, CWE-294 | Five attempts per account in ten minutes, the pending sign-in dropped after five, the last accepted step stored (`second-factor.test.ts`, `totp.test.ts`) |
| Session hijacking and session fixation | CWE-613, CWE-384 | `HttpOnly`, `Secure` cookies, a new session id at sign-in, 24 hours idle and 14 days in all, sign-ins listed and ended by the owner (`sessions.test.ts`) |
| Password-reset takeover and reset poisoning | CWE-640 | Single-use links in the fragment, built from `SPINE_DOMAIN`, and a reset that replaces keys needs the second factor and a signature only the recovery kit makes (**S-38**, `reset-proof.test.ts`, `reset-second-factor.test.ts`) |
| Rate-limit evasion by IP spoofing | CWE-348 | Only the local proxy's forwarded address is believed, and nginx overwrites the header (**S-31**, `auth.test.ts`) |
| Insecure direct object reference (IDOR) | CWE-639 | Every store method takes the acting user; a second user tries every route (**P12**, `isolation.test.ts`) |
| Share-link overreach | CWE-285 | A share is a sealed copy of only what its scope resolves to, and a scope that cannot be resolved shares nothing (**P2**, `slice.test.ts`, `public-share-detail.test.ts`) |
| Approval spoofing | CWE-290 | A code made from the visitor's key is compared before approval, for a share and for a person let in (**S-40**, `share-code.test.ts`, `delegation-binding.test.ts`) |
| Offline cracking of a stolen database | CWE-916 | Records sealed under keys the server never has; the server's credential hash is argon2id and recovery codes scrypt (**M-34**, **S-42**) |
| Key substitution by a dishonest server | CWE-322 | Keys between accounts are bound through a one-time code, not the server's list of public keys (**S-39**, **S-41**) |
| Downgrade attack | CWE-757 | The device holds the key-derivation settings to a floor and to what it saw before (**S-37**, `kdf-trust.test.ts`) |
| Ciphertext swapping | CWE-345 | Authenticated encryption with each object's id and kind bound in as associated data (**M-34**) |
| Rollback to an older state | noticed, not prevented | The device keeps the highest vault sequence it has seen and says when it is shown less (**S-43**, `persist.test.ts`) |
| SQL injection and command injection | CWE-89, CWE-78 | Every statement is prepared with parameters, search text is quoted, column names come from a fixed list; the server runs no program on an uploaded file |
| Path traversal and Zip Slip | CWE-22 | Zip entries read by name and never extracted to a path the archive gives (**M-14**) |
| Decompression bombs and image bombs | CWE-409 | Caps on entry and total size, 500 pages a PDF, 25 million pixels a page and 120 million a photo (**S-55**, `rasterize-limits.test.ts`) |
| Server-side request forgery (SSRF) | CWE-918 | The server fetches no address a user supplies |
| Prompt injection | OWASP LLM01 | Read-only tools, proposals the person confirms, a recipient's agent held to the link in code (**M-18**, **M-20**, **M-21**, `chat-actions.test.ts`, `share-chat.test.ts`) |
| Data exfiltration through AI output | OWASP LLM05 | No image or arbitrary link rendered from model output; the content security policy allows only Spine and its relay (**M-18**) |
| Denial of service and denial of wallet | CWE-400, OWASP LLM10 | Caps on uploads, reads, shares, sign-ups, disk and model calls (**S-49**, **S-51**, **S-56** to **S-58**, `relay.test.ts`, `object-reads.test.ts`) |
| Email bombing | CWE-770 | Mail limited per address and for the instance (**S-51**, `signup-caps.test.ts`) |
| Algorithmic complexity attack | CWE-407 | A per-key limiter that stays fast however many keys it holds (**S-53**, `window-limiter.test.ts`) |
| Compromised dependency | CWE-1395 | One lockfile, `npm ci`, a build that stops on high and critical advisories (**S-32**) |
| Poisoned build pipeline | CWE-829 | Actions pinned by commit, a signing job that installs nothing (**S-59**, `workflows.test.ts`) |
| Hard-coded and default secrets | CWE-798 | gitleaks on every change; startup refuses a missing, short or published secret (**P3**) |
| Sensitive data in logs | CWE-532 | No record content or password in any log line; the relay keeps no body (`relay.test.ts`) |
| Loose file permissions | CWE-732 | `UMask=0077` in every unit and owner-only modes in code (**S-61**, `permissions.test.ts`) |

## What Spine does not protect against

Stated plainly, because a security claim is only as honest as its limits:

- **The person's own device.** Malware on the computer or phone that opens the records can read them while they are open.
- **A weak or reused master password.** It is the key to everything.
- **The operator's web app.** An operator can serve a different app; checking the build is the defence, and someone has to run it.
- **What a recipient has seen.** Revoking a link stops new reads, not copies already made.
- **The model provider.** It sees the plaintext of each AI call while it runs it; the relay does not store or log it, but it does see it.
- **The operator with full control of the host.** Spine is self-hosted, so whoever runs the machine can stop it, delete it or replace it; they cannot read the records on the disk.

## Reporting a flaw

To report a vulnerability, see [SECURITY.md](../SECURITY.md#reporting-a-vulnerability).
