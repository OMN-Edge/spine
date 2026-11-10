# What Spine protects against, and how it was checked

Spine keeps medical records, so the question a person should ask before trusting it is not "is it secure?" but "secure against what, checked how, and by whom?". This page answers the three in that order, in the form an independent security assessment report takes: the method and the standards first, then each threat with what stops it and the test that shows it, then what the review found and fixed, then what Spine does not protect against. The engineering detail behind every line is in [SECURITY.md](../SECURITY.md), under the IDs given here.

> **Who checked it.** The November 2026 review was done by the project itself, following the method below. **It is not an independent audit**: no outside firm has tested Spine, and no certificate is claimed. An independent assessment is the next step (see the end of this page); until then, treat every statement here as the project's own, checkable in the open code and its tests.

## How the review was done

A professional application security assessment follows the same steps whoever runs it: agree the scope, model the threats, verify the controls against a published standard, test what is found, rate it, fix it, test again and report. This review followed them.

| Step | What a professional assessment does | What was done here |
| --- | --- | --- |
| 1. Scope | Agree what is in and out | The whole repository (server, the device's core, the relay, the web app, install and deployment files) and the live instance; out of scope: the model providers' and the mail provider's own systems |
| 2. Threat model | List what is protected, who might attack it, and where data crosses from one party to another | 6 assets, 5 adversaries, 14 trust boundaries (for example "account A to account B", "owner to share recipient", "device to relay", "operator to vault"), each with what must hold there |
| 3. Verification against a standard | Go area by area through a checklist so no area is skipped | Thirteen passes over the code, one area at a time (cryptography and the vault, share scope, the assistant and the relay, sign-in and sessions, authorisation, uploads and the file readers, the web page, secrets and logging, abuse and availability, the supply chain, the host's setup), each finding mapped to its [OWASP ASVS 5.0](https://github.com/OWASP/ASVS) chapter and its CWE, and the model and agent features read against the [OWASP Top 10 for LLM Applications 2025](https://genai.owasp.org/llm-top-10/) |
| 4. Manual review and testing | Read the code that enforces each control, try to break it, run automated scanners | Every route, key, crossing and documented claim (about 180 units) was given a verdict of its own; seven findings were reproduced by an attack written as a test; dependency audit, secret scanning (gitleaks) and static analysis (semgrep) ran in CI |
| 5. The live system | Look at what is actually deployed, not only the code | The running instance: TLS versions and ciphers from outside, open ports, file permissions, how the services run, free space, and a restore of the newest backup onto a copy (`scripts/host-report.sh`) |
| 6. Rating | Rate each finding by impact and how hard it is to reach | High, Medium or Low, with a confidence score; a candidate with no complete attack path was not counted as a finding |
| 7. Fix and retest | Fix, then show the fix works | Every fix came with a test that fails without it, written before the fix |
| 8. Report | Say what was found, fixed and left, and check that the documents tell the truth | This page and SECURITY.md; SECURITY.md (sentence by sentence) and the documents beside it were then checked against the code, and about seventy statements that no longer matched it were corrected |

The standards it was measured against, and what each is:

- **OWASP Application Security Verification Standard (ASVS) 5.0.0** (May 2025): the industry's checklist of security requirements for web applications, in 17 chapters and three levels. Its chapters set the areas of the review. The review did not go through all of its requirements one by one, so **no ASVS level is claimed**.
- **OWASP Top 10:2025**: the ten most common kinds of web application risk. Each threat below names the category it falls under.
- **OWASP Top 10 for LLM Applications 2025**: the same for software that uses AI models (prompt injection, excessive agency, unbounded consumption).
- **OWASP Web Security Testing Guide (WSTG) 4.2**: how to test each area; the attacks written as tests follow it.

## The threats, and what stops each one

Each row is something an attacker or an accident could do, what in Spine stops it, how that is checked, and what is left. A test named in a row runs on every change; "reproduced" means the attack was first shown to work and the fix then shown to stop it.

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
| **How it is checked** | `kdf-trust.test.ts`, `delegation-binding.test.ts`, `share-code.test.ts`, `persist.test.ts`; S-37 was reproduced before it was fixed |
| **What is left** | An operator can serve a different web app that takes keys as they are typed. Spine's build is reproducible and every file's hash is published, so anyone can check that the app they are served is the one built from the open code ([verify-build.md](verify-build.md)), but someone has to run that check |

### Someone takes over an account

| | |
| --- | --- |
| **The threat** | Guessing passwords, stealing a session cookie, abusing a password-reset link, guessing two-factor codes, a forged request from another site, or faking the source address to dodge rate limits (A07 Authentication Failures; ASVS V6 Authentication, V7 Session Management) |
| **What stops it** | argon2id; common and patterned passwords refused; limits per source, per account and for the whole instance; optional two-factor and passkeys; sessions the owner can see and end, that expire after a day unused; the password asked again before sensitive changes; mail on a new browser. A reset link alone cannot replace an account's keys: it needs the second factor and a signature only the recovery kit can make, the owner is mailed, and recovery by email can be turned off (**S-38**). Requests that change something must come from the app's own origin (**S-50**); the client's address cannot be forged (**S-31**) |
| **How it is checked** | `auth.test.ts`, `second-factor.test.ts`, `sessions.test.ts`, `password-policy.test.ts`, `totp.test.ts`, `reset-proof.test.ts`, `reset-second-factor.test.ts`, `email-recovery.test.ts`, `same-origin.test.ts`; S-38 and S-31 were reproduced before they were fixed |
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
| **How it is checked** | `shared.test.ts`, `slice.test.ts`, `public-share-detail.test.ts`, `share-pass.test.ts`, `audit.test.ts`; S-45, S-48 and S-54 were reproduced before they were fixed |
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
| **How it is checked** | `rasterize-limits.test.ts`, `object-reads.test.ts`, `share-reads.test.ts`, `signup-caps.test.ts`, `disk-space.test.ts`, `window-limiter.test.ts`, `relay.test.ts`; S-55 and S-58 were reproduced before they were fixed |
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

## What the review found and fixed

The review recorded **27 findings: 2 High, 12 Medium, 13 Low** (SECURITY.md **S-37** to **S-63**). All are fixed, each with a test that fails without the fix. The two High ones:

- **S-37.** A server that answered "this account has no vault" could make the device send the password instead of the derived value. The device now judges such answers itself.
- **S-38.** A password-reset link alone could replace an account's keys. A reset now needs the second factor and a signature only the recovery kit can make, and the owner is told.

The look at the live instance added two more, both in file permissions: one was fixed on the host the same day, the other in the code, which reaches the host with its next update. Checking the documents against the code afterwards corrected about seventy statements that no longer described what the code does; none of them was a control that did not work.

## What Spine does not protect against

Stated plainly, because a security claim is only as honest as its limits:

- **The person's own device.** Malware on the computer or phone that opens the records can read them while they are open.
- **A weak or reused master password.** It is the key to everything.
- **The operator's web app.** An operator can serve a different app; checking the build is the defence, and someone has to run it.
- **What a recipient has seen.** Revoking a link stops new reads, not copies already made.
- **The model provider.** It sees the plaintext of each AI call while it runs it; the relay does not store or log it, but it does see it.
- **The operator with full control of the host.** Spine is self-hosted, so whoever runs the machine can stop it, delete it or replace it; they cannot read the records on the disk.

## What an independent assessment would add

An outside firm brings what a project cannot give itself: people with no stake in the result and a fresh view of the design. For Spine that means a penetration test of a running instance against the OWASP Web Security Testing Guide, a review of the cryptographic design by a specialist, and a retest of the findings, ending in a letter that says what was tested and what remained. When that is done its report will be published here. Until then, everything on this page can be checked by anyone: the code, the tests and [SECURITY.md](../SECURITY.md) are open.

To report a vulnerability, see [SECURITY.md](../SECURITY.md#reporting-a-vulnerability).
