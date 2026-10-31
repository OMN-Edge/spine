# Spine: requirements

What Spine must do and the technical rules it is built to. The IDs (`FR-…`, `TR-…`, `CR-…`) are the ones other documents cite: [ARCHITECTURE.md](../ARCHITECTURE.md) for how it is built, [SECURITY.md](../SECURITY.md) for the controls and known gaps, [crypto-design.md](crypto-design.md) and [key-hierarchy.md](key-hierarchy.md) for the keys, [relay.md](relay.md) for the model relay, [scenarios.md](scenarios.md) for the flows. Priority says how much a requirement matters (Must, Should, Could). Release says when it ships: Launch is the first public release, built around one loop (upload, organize, share with a doctor in their language), Soon follows it, Later waits for use.

## Purpose and scope

Spine is a personal medical history vault. People upload their records, Spine organizes them into a timeline, and they share them with any doctor, in any country and language, without the operator being able to read them.

In scope: individual use, manual and assisted upload, AI-assisted organization and extraction, time-limited sharing with doctors, live translation. Out of scope for the first release: integration with clinic or national EHR systems, clinical interpretation of results, any feature with a medical purpose under MDR.

Product principles:

- **The operator cannot read patient data.** Servers store ciphertext only; keys never leave user devices unwrapped.
- **Every AI call is visible and opt-in.** The user knows which content goes to which provider, and why.
- **Organize, never interpret.** Spine retrieves, summarizes and translates what the documents say. It never says whether a result is good or bad or suggests diagnoses; the only mark it makes is high or low, by comparing a value with the range printed beside it on the document.
- **The original is always one tap away.** Extracted fields and translations are aids; the source page stays the record of truth.
- **Data is portable.** Full export in open formats at any time, and the stack is self-hostable.

## Privacy model

Spine is zero-knowledge toward its own servers: they store ciphertext only, and decryption happens on the owner's or the doctor's device. "Zero trust" is a different term (a network security model); use "zero-knowledge" and "end-to-end encrypted" in product claims.

Calling an EU model endpoint from the client keeps Spine zero-knowledge, but the model provider does see the plaintext of each call. The honest claim is: *Spine can never read your records; AI features send the content you choose, through a relay that does not store or log content, to an EU-hosted model that keeps nothing.* Say "does not store or log", never "cannot see".

| Party | Sees plaintext | What it can see |
| --- | --- | --- |
| Owner's device | Yes | Everything in the vault |
| Doctor's browser | Yes, scoped | Only the shared documents, until the link expires or is revoked |
| Model endpoint | Yes, transient | The content of each AI call; retention set by contract |
| Spine servers | No | Account email, ciphertext sizes, timestamps, share metadata |
| Email provider | No | Notification that a share was requested; never medical content |

One constraint shapes the AI path: the client cannot hold Spine's model API key, so calls pass through a relay that holds it. A plain relay terminates TLS and sees plaintext, so the claim above is about what it stores and logs. A relay in an attested confidential-computing enclave, which the client verifies before sending anything, is the later step that would let the claim be stronger.

## Functional requirements

### Ingestion

| ID | Requirement | Priority | Release |
| --- | --- | --- | --- |
| FR-ING-01 | Upload PDFs, images (JPG, PNG, HEIC), text documents and ZIP archives, including multi-page scans | Must | Launch |
| FR-ING-02 | Detect when a multi-page upload contains several documents and propose a split; the user confirms | Must | Launch |
| FR-ING-03 | Drag and drop pages to reorder, split, merge, rotate or delete | Must | Launch |
| FR-ING-04 | Paste or drop files into the chat to upload; the chat reports back when processing finishes | Must | Launch |
| FR-ING-05 | Run page operations by chat ("do pages 3 to 5 belong together?", "move page 7 into the 2004 referral") | Must | Launch |
| FR-ING-06 | Camera scanning: live edge detection, automatic corner finding with manual adjustment, perspective correction and crop | Must | Launch |
| FR-ING-07 | Flag duplicate uploads using a content hash | Should | Soon |
| FR-ING-08 | Multi-page scan session: capture pages one after another with the phone's camera, set the corners after each, then review and reorder before saving | Must | Launch |
| FR-ING-09 | Scan enhancement for faded and handwritten pages: deskew, shadow removal, contrast boost; the unprocessed photo is kept as the original | Should | Launch |
| FR-ING-10 | All scan processing runs on the device; raw photos never leave it unencrypted | Must | Launch |

### Extraction and review

| ID | Requirement | Priority | Release |
| --- | --- | --- | --- |
| FR-EXT-01 | Extract date, document type, facility, doctor, specialty, stated diagnoses, medications and lab values | Must | Launch |
| FR-EXT-02 | Link every extracted field to the page and region it came from | Must | Launch |
| FR-EXT-03 | Review queue: extractions stay marked as unreviewed until the user confirms or edits them | Must | Launch |
| FR-EXT-04 | Flag low-confidence fields, especially from handwriting, for manual check | Must | Launch |

### Organization and timeline

| ID | Requirement | Priority | Release |
| --- | --- | --- | --- |
| FR-ORG-01 | Group documents into medical episodes; the app proposes, the user confirms | Must | Launch |
| FR-ORG-02 | Build a doctors directory from extractions, deduplicated and editable | Must | Later |
| FR-ORG-03 | Tags, facilities and specialties as filters | Must | Launch |
| FR-ORG-04 | Full-text search across documents and extracted fields, indexed on the device | Must | Launch |
| FR-ORG-05 | Connected documents: the app suggests links; a link counts only once the user confirms it | Must | Soon |
| FR-ORG-06 | Similar documents through hybrid search (full text, semantic, tags, entities), shown as suggestions | Must | Soon |
| FR-ORG-07 | Every suggested link and similar document shows its match reason, built from structured signals: shared terms, doctor, facility, dates, tags, similarity score | Must | Soon |
| FR-ORG-08 | Match reasons and episode titles never state a clinical inference ("follow-up of", "caused by", "may indicate"); the model does not write free-text explanations of links | Must | Launch |
| FR-TL-01 | Spine timeline: one vertebra per entry, a disc between entries, zoom by year or episode | Must | Launch |
| FR-TL-02 | Tapping a vertebra opens the document with its extraction and the original side by side | Must | Launch |

### Chat

| ID | Requirement | Priority | Release |
| --- | --- | --- | --- |
| FR-CHAT-01 | Answer questions only from the user's own documents, citing the source page for every claim | Must | Soon |
| FR-CHAT-02 | Decline clinical interpretation ("is this result bad?") and point the user to a doctor; applies to the ingestion chat too | Must | Launch |
| FR-CHAT-03 | Find related documents and episodes on request | Should | Soon |

### Follow-up reminders

| ID | Requirement | Priority | Release |
| --- | --- | --- | --- |
| FR-REM-01 | Detect follow-up instructions written explicitly in a document ("control peste 3 luni") and propose a reminder; nothing is inferred from guidelines or results | Should | Later |
| FR-REM-02 | The user confirms date and wording before the reminder exists; it links to the source page | Should | Later |
| FR-REM-03 | Wording reports the document, not advice: "Your report from Dr. Example, 12 May, says: control in 3 months" | Should | Later |
| FR-REM-04 | Delivered as local notifications on the device, with no medical content on the lock screen | Should | Later |

### Sharing with doctors

| ID | Requirement | Priority | Release |
| --- | --- | --- | --- |
| FR-SHR-01 | Create a link scoped to selected documents, selected episodes or the whole history | Must | Launch |
| FR-SHR-02 | Every link expires; default 7 days, options from 1 hour to 30 days | Must | Launch |
| FR-SHR-03 | Approval mode: the doctor requests access, the owner gets an email and approves in the app | Must | Later |
| FR-SHR-04 | Revoke any link instantly; the access log shows when, from which country and which documents were opened | Must | Launch |
| FR-SHR-05 | Doctors need no account | Must | Launch |
| FR-SHR-06 | The owner chooses per link whether the doctor can download or print | Should | Soon |
| FR-SHR-07 | The shared view carries a discreet "Shared securely via Spine" footer linking to the landing page | Must | Launch |

### Translation

| ID | Requirement | Priority | Release |
| --- | --- | --- | --- |
| FR-TR-01 | The viewer picks a language; documents and extracted content translate section by section | Must | Launch |
| FR-TR-02 | Original text shown next to the translation, labelled as machine translation | Must | Launch |
| FR-TR-03 | Allergies, medications and doses highlighted for checking against the original | Must | Launch |
| FR-TR-04 | Translations cached, encrypted, per share, to avoid repeat model calls | Should | Soon |

### Account and export

| ID | Requirement | Priority | Release |
| --- | --- | --- | --- |
| FR-PRF-01 | Several profiles per account (children, elderly parents), each with its own keys | Must | Launch |
| FR-ACC-01 | Sign-up with email and master password; recovery kit generated at sign-up | Must | Launch |
| FR-ACC-02 | The same vault on several devices; passkeys and 2FA supported | Must | Launch |
| FR-ACC-03 | Sample records, explorable before uploading anything real | Must | Launch |
| FR-EXP-01 | Full export: originals plus extracted data as JSON; the export can be imported again | Must | Launch |
| FR-EXP-02 | Account deletion destroys keys, making stored ciphertext unrecoverable | Must | Launch |
| FR-BIL-01 | Plans where the operator offers them: a six-month trial with everything and 150 pages of AI reading, a free plan, and Premium by subscription; nothing is deleted when a plan ends | Must | Launch |
| FR-BIL-02 | Price, renewal and cancellation shown before a purchase, one-step cancellation, the card never seen by Spine, and an account with a running subscription not deleted until it is cancelled | Must | Launch |
| FR-BIL-03 | The first 500 paying accounts keep the yearly founding price for as long as the subscription runs | Should | Launch |
| FR-BIL-04 | A self-hosted or private instance has no plans and no limits but its own | Must | Launch |
| FR-BIL-05 | A family plan for up to six people, sold only where the operator has named its prices; Premium and the family plan are told apart by the prices of the subscription | Should | Launch |
| FR-GRW-01 | The loops in the marketing plan can be counted without identifying anyone: sign-ups from a shared page or a doctor's page, shared pages opened, checkouts started; a waitlist holds an address and a day | Should | Launch |

### Reintroduced after the first scope was cut

The cuts of 2026-10-23 are being undone in this order, each with its documents (the marketing plan needs them): the emergency card, several profiles per account, delegating a profile, child profiles and guardians, promotion at 18 (all built), and the Family plan (built, sold where its prices are named). FR-PRF-01 (several profiles per account) is built (**M-48**); delegation, child profiles and guardians, promotion at 18 and the Family plan follow. Installable mobile apps (TR-MOB) stay out.

| ID | Requirement | Priority | Release | Status |
| --- | --- | --- | --- | --- |
| FR-FAM-01 | A child's profile is kept by a guardian under their account, with the child's birth date sealed in its record; other guardians can be let in | Must | Launch | Built (**M-50**) |
| FR-FAM-02 | A child has an account of their own only from sixteen, when their guardian invites them; below sixteen the page does not offer it | Must | Launch | Built (**M-50**) |
| FR-FAM-03 | At eighteen the person can take the profile into their own account in one step, under a new key; the guardians' access is paused, not ended, until the person chooses | Must | Launch | Built (**M-51**) |
| FR-EMG-01 | A card the owner writes of what someone helping them must know at once (allergies, conditions, medications, contacts, blood type, notes); only what is written is on it | Must | Launch | Built (**M-47**) |
| FR-EMG-02 | The card opens from a QR code with no account and no approval, in the reader's language for everything but the owner's own words, and says what Spine is | Must | Launch | Built |
| FR-EMG-03 | Every opening is logged (time and country, never an address) and the owner is mailed, at most once in fifteen minutes | Must | Launch | Built |
| FR-EMG-04 | An optional code that holds the card as plain text, readable with no signal, said plainly to be readable by anyone who sees it and to hold only what fits | Should | Launch | Built |
| FR-PRF-02 | Another account can be let into one profile, as a guardian (reads and writes) or a viewer (reads), by an invitation code that works for someone with no account yet; the owner can pause, resume and end it, and ending it replaces the profile's key | Must | Launch | Built (**M-49**) |
| FR-PRF-03 | The account's people are listed and chosen on a page of their own; opening one saves the first and starts the screens over on the other's records, with no second password; the choice is remembered on the device | Must | Launch | Built |
| FR-PRF-04 | How many people an account can keep follows its plan (trial six, free one, Premium one; the family plan more); a record is never removed because a plan ended | Must | Launch | Built |
| FR-EMG-05 | The owner turns the card off and its address stops opening; the interface says a card already seen may have been copied | Must | Launch | Built |

## Technical requirements

The hard parts are the key hierarchy, the approval-mode share handshake and the model credential path; everything else is conventional. Use an audited library (libsodium or equivalent) and never custom primitives.

### Encryption and keys

| ID | Requirement |
| --- | --- |
| TR-CRY-01 | Derive the master key on the client from the master password with Argon2id; authenticate with a separately derived value, so the password never reaches the server |
| TR-CRY-02 | Key hierarchy: account key, then one key per profile, then one data key per document; content encrypted with AES-256-GCM or XChaCha20-Poly1305 |
| TR-CRY-03 | Encrypt metadata too: titles, dates, tags, doctors, episodes, extracted fields, summaries and embeddings. Only opaque IDs, sizes and timestamps stay in plaintext |
| TR-CRY-04 | Recovery only through a user-held recovery key (printable kit). The operator has no recovery path, and the UI says so plainly at sign-up |
| TR-CRY-05 | New devices are enrolled from an existing device or with the master password; devices converge on the same records without the server reading them (SECURITY.md **M-38**) |
| TR-CRY-06 | Each account has an X25519 key pair, used to wrap profile keys for delegated access |
| TR-CRY-07 | Any access revocation rotates the profile key: data keys are re-wrapped with a new key that removed parties never held. Content someone already viewed cannot be recalled |

### Sharing

| ID | Requirement |
| --- | --- |
| TR-SHC-01 | Each share gets a random share key; the shared documents are sealed under it |
| TR-SHC-02 | Direct mode: the share key travels in the URL fragment (after #), which browsers never send to the server |
| TR-SHC-03 | Approval mode: the doctor's browser generates an ephemeral key pair and sends the public key with the request. On approval, the owner's app wraps the share key to that public key. A leaked link alone then opens nothing |
| TR-SHC-04 | Expiry and revocation delete the wrapped keys and the share bundle server-side. The UI states that content already viewed may have been copied |

### AI pipeline

| ID | Requirement |
| --- | --- |
| TR-AI-01 | All model calls start on the client: content is decrypted locally and sent over TLS to the relay, which forwards it to the model endpoint |
| TR-AI-02 | The provider is one of the implemented adapters (`vertex` and `anthropic` in `server/src/llm/adapters/`, run by the relay service; the device uses `relay`, in `core/src/llm/adapters/`), chosen by `SPINE_LLM_PROVIDER`; embeddings likewise (`none`, `vertex`, `relay`). `vertex` needs an explicit endpoint, region and project, never a global endpoint (residency is a property of the endpoint). A provider outside the EU is a transfer that needs its own legal basis (CR-GDPR-05). Zero data retention configured as listed below |
| TR-AI-03 | No model API key on the client. Model calls pass through a relay that holds the credentials, enforces per-user quotas, and does not store or log content |
| TR-AI-04 | Minimize each call: send only the pages needed, and mask identifiers such as a national ID number where extraction does not need them |
| TR-AI-05 | One embedding per document summary, computed once at ingestion and stored encrypted like the content; the client decrypts them into a local index. Only the query embedding is computed per search. Retrieval for chat runs on the device |
| TR-AI-06 | Doctor-side translation goes through the same relay, authorized by the share and limited to its expiry |
| TR-AI-07 | Self-hosted installs choose among the implemented adapters and set their own endpoint, region, project and key, and the person who runs the install is responsible for that choice and for the legal basis it needs (see Who is responsible). Another provider is one new file in `llm/adapters/` and one map entry; none is configurable without that (an OpenAI-compatible adapter is not built) |
| TR-AI-08 | The relay only passes requests through: it writes no records and no files (it keeps a count of calls a day, in the store's `usage` repository). The client encrypts every result (extraction, summary, embedding, translation) before upload |
| TR-AI-09 | Send the minimum per call: one document or page for extraction, the top few retrieved snippets for chat, never the whole vault |
| TR-AI-10 | No cloud storage staging for model input; documents are split on the client and sent inline within the provider's request limits |
| TR-AI-11 | Imports run as a resumable client-side job queue that survives reloads, with visible progress |
| TR-AI-12 | Vector search runs on the device: encrypted embeddings are downloaded, decrypted into memory and searched by brute-force cosine similarity. No server-side vector database |
| TR-AI-13 | Hybrid search combines the local full-text index and vector results with reciprocal rank fusion |
| TR-AI-14 | Embeddings at reduced dimension (768) and quantized for storage |
| TR-AI-15 | Query text sent to the relay for embedding is treated like content: no logging, no retention |

**Where the code differs from these rows (checked against the code on 2026-10-26).** The rows say what must hold; these do not yet, or hold differently:

- **TR-CRY-02:** the data key is one per sealed object (a segment of changes, a part of a snapshot, a file), not one per document, and there is one profile per account ([key-hierarchy.md](key-hierarchy.md)).
- **TR-CRY-05:** built (SECURITY.md **M-41**): a new device signs in with the master password, a passkey set up to open the vault, or a one-time code from a device that is signed in. The new device holds the keys in memory only, as after any sign-in, so a reload asks again; there is no list of enrolled devices apart from the sign-ins the account page shows, and a device cannot be revoked in the cryptographic sense (the account key does not change), only signed out.
- **TR-CRY-06 and TR-CRY-07:** built (SECURITY.md **M-49**): the key pair seals a profile key to another account, and ending access replaces the profile key, re-sealing every data key, the profile record and each remaining grant in one step.
- **TR-AI-04:** masking identifiers such as a national ID number before a call is not built; the extraction prompt tells the model not to extract them.
- **TR-AI-11:** reading an upload resumes (confirming again reads what is still marked), and an upload the page was closed on is read again when the core next starts (`resumeStalledJobs`). A restore interrupted that way, and an upload whose file had not reached the vault, is marked failed. The queue is the app's own two-at-a-time limit and is not a persisted list: what resumes is what the rows say is unfinished.
- **TR-INF-03:** account mail carries a link and, for a sign-in, a changed setting or a waiting request, the time of the event (SECURITY.md **P8**); it never carries medical content.
- **TR-CLI-01:** the web app can be put on a home screen (a manifest and icons), but has no service worker on purpose: one would put a cache that can serve an old core in front of every route, share links included, so there is no offline use and the local index is not a cache the page keeps.
- **TR-CLI-02:** the strict content security policy is in place; the page's scripts and styles carry subresource integrity (not the worker, the WebAssembly files or lazily loaded chunks, which the attribute cannot cover); the build is the same files for the same commit and lists their hashes in `hashes.txt`, which the site serves and [verify-build.md](verify-build.md) compares with a build of your own. What is not built: the hashes are not signed or published anywhere but the site and the CI run, and nothing in the page checks them for you.

Model provider zero-retention setup, required before the first real user (the operator's part):

- [ ] Disable data caching on the cloud project
- [ ] Request the abuse-monitoring exception (prompt logging)
- [ ] Request-response logging left disabled
- [ ] No search grounding
- [ ] The relay calls only regional EU endpoints
- [ ] The relay runs in an EU region, with request logging limited to metadata (no bodies)
- [ ] The model tested on handwritten pages, with a stronger model as fallback for low-confidence pages

### Platform

| ID | Requirement |
| --- | --- |
| TR-INF-01 | Hosting in the EU; ciphertext blobs in object storage or files, metadata in the store behind the store interface |
| TR-INF-02 | Logs carry no content; IP addresses kept only as long as abuse prevention needs |
| TR-INF-03 | Transactional email never contains medical content, only a prompt to open the app |
| TR-INF-04 | Backups hold ciphertext only |
| TR-CLI-01 | One web codebase, shipped as an installable PWA. Local search index and caches encrypted at rest |
| TR-CLI-02 | A web client served by the operator could in principle be swapped for a malicious one. Mitigate with strict CSP, subresource integrity and reproducible builds with published hashes |
| TR-OSS-01 | Server and clients under AGPL-3.0, with a one-command self-host (Docker Compose) |
| TR-OSS-03 | Public security policy, vulnerability disclosure contact, and a public write-up of the key hierarchy and trust boundaries, all available at launch |
| TR-OSS-04 | Source code hosted on GitHub as the canonical repository, with issues and pull requests there; optional read-only mirror elsewhere |
| TR-OSS-05 | Public links to source, docs and security policy go through Spine's own domain, so the repository host can change later without breaking links |

## Compliance requirements

### Who is responsible

Whoever runs an instance is its controller and answers for it. For the hosted service that is its operator. For a self-hosted install it is the person or organisation that runs it, not the Spine project: the software offers choices, and the choice and its consequences are theirs. That covers the model provider and endpoint (for example `anthropic`, which sends content outside the EU or EEA, against `vertex` on an EU endpoint), the relay and where it runs, the mailer, hosting and backups, the trust anchors for signatures, the legal texts and operator contact, and the contracts and notices their own users are owed. The software does not stop a choice that needs a legal basis the operator has not got; it states what each setting sends where (`.env.example`, `docs/relay.md`, SECURITY.md), and the privacy notice and the record of processing must describe what the operator actually configured. Requirements below marked Operator are theirs in every case; the others describe what the software does so that they can be met.

What each feature, current and planned, must satisfy in law, with the source. GDPR binds from day one; MDR is avoided by design; the rest applies as the features arrive. **Each citation was looked up on the web on 2026-10-24 (see [References](#references) for what was read at the source and what only in secondary sources); a lawyer confirms them before launch** (the drafts are in [compliance/](compliance/) and [legal/](legal/); see its README for what is built, drafted or a contract still to sign). Status: **Built** is in the software, **Draft** is a text a lawyer reviews, **Operator** is the controller's own act (a contract, a setting), **Future** is for a feature not in the first release.

### Data protection (GDPR and Romanian law)

| ID | Requirement | Basis | Applies to | Status |
| --- | --- | --- | --- | --- |
| CR-GDPR-01 | Explicit consent for health data at sign-up, separate from accepting the terms, recorded with the version shown and asked again when a text changes | GDPR Art. 7, 9(2)(a) | Sign-up, `legal.ts` | Built |
| CR-GDPR-02 | Privacy notice: controller, purposes, recipients (including the model provider and the relay), transfers, retention, rights | GDPR Art. 12 to 14 | `docs/legal/privacy.md` | Draft |
| CR-GDPR-03 | Data protection impact assessment before launch; health data and new technology make it mandatory | GDPR Art. 35 | `compliance/dpia.md` | Draft |
| CR-GDPR-04 | Record of processing activities | GDPR Art. 30 | `compliance/ropa.md` | Draft |
| CR-GDPR-05 | Processing agreements with hosting, model, relay-hosting and email providers. Which provider is used is the operator's choice. One outside the EU or EEA (for example the `anthropic` adapter) is a transfer: the operator needs a basis under Chapter V before using it, and their privacy notice names it. The hosted service's operator and every self-hosting operator decide this for their own instance | GDPR Art. 28, 44 to 49 | Each provider | Operator |
| CR-GDPR-06 | Access, rectification, erasure and portability served in the app, since the operator cannot decrypt: full export, editing, account deletion that destroys keys | GDPR Art. 15 to 17, 20 | Export, edit, `POST /api/account/delete` | Built |
| CR-GDPR-07 | Security of processing and data protection by design: client-side encryption, ciphertext-only backups, no content in logs, minimal model calls | GDPR Art. 25, 32 | The vault, the relay, `SECURITY.md` | Built, maintained |
| CR-GDPR-08 | Breach procedure: notify the supervisory authority within 72 hours; users need not be told when the data was unintelligible to others | GDPR Art. 33, 34(3)(a) | `compliance/breach-procedure.md` | Draft |
| CR-GDPR-09 | Storage limitation: shares expire, revoked shares and expired bundles are deleted, deleting an account removes its vault | GDPR Art. 5(1)(e) | Share sweep, account deletion | Built |
| CR-GDPR-10 | No decision with legal or similar effect made by automated means; health-data profiling needs explicit consent or a legal basis. Links, episodes and extractions are proposals the owner confirms | GDPR Art. 22; Law 190/2018 Art. 3(1) (health data: automated decisions and profiling need explicit consent or an express legal provision) | Linking, episodes, extraction | Built |
| CR-GDPR-11 | What a share records about its recipient (the country worked out from their address, the note and public key they send when they ask to open a link, and which document they opened) is personal data of that visitor: the address itself is not kept, the shared page says what is recorded, only what the owner's log needs is kept, and the owner can see it | GDPR Art. 6(1)(f), 13, 14 | Share access log | Draft |
| CR-GDPR-12 | A doctor who receives a share becomes a controller of what they download or copy; the terms say that revocation cannot recall what was viewed | GDPR Art. 4(7); terms | Sharing | Draft |
| CR-GDPR-13 | Assess whether a data protection officer is required once processing is at scale | GDPR Art. 37 | Operator | Future |
| CR-GDPR-14 | No registration or authorisation with the Romanian authority is needed; the record and the DPIA are shown on request | Law 129/2018 (repeals Law 677/2001); ANSPDCP FAQ and decision (see References) | Operator | n/a |
| CR-EPR-01 | Storing information on a person's device: Art. 5(3) applies to any storage on the terminal, not only cookies, with no minimum duration or size (EDPB Guidelines 2/2023, points 35-38). Only what is strictly necessary for a service the person explicitly asked for is exempt, so no consent banner is needed for: the owner's sign-in cookie, a one-year browser cookie (`HttpOnly`, a random value the server keeps only hashed) that lets the service mail the owner about a sign-in from a browser it has not seen (whether that counts as strictly necessary is for the lawyer to confirm; the privacy notice names it), and what a recipient's browser keeps for the tab (the key from the link, and the key pair made to ask to open a link, in `sessionStorage`). Information the page keeps and reads only inside the device is not a "gaining of access" (point 44). There is no other cookie or tracker; any non-essential one needs the person's consent first | ePrivacy Directive 2002/58/EC Art. 5(3); Law 506/2004 Art. 4(5) (information, and the choice to refuse) and 4(6)(b) (exempt when strictly necessary for a service the user expressly requested). A bill to change the consent rules was before Parliament in 2026: check its status | Web app | Built (none non-essential) |

### Medical device, AI and health data

| ID | Requirement | Basis | Applies to | Status |
| --- | --- | --- | --- | --- |
| CR-MDR-01 | Written intended purpose: storage, organization, translation and sharing, with no medical purpose | MDR Art. 2(1); MDCG 2019-11 Rev.1 (June 2025) | `docs/legal/purpose.md` | Draft |
| CR-MDR-02 | Marketing copy, store text and chat guardrails reviewed against that purpose; the chat declines interpretation | MDR Art. 7; FR-CHAT-02 | Chat, site | Built (chat), Operator (copy) |
| CR-MDR-03 | Match reasons, episode titles and reminders only restate what documents say | MDCG 2019-11; FR-ORG-08 | Linking, episodes | Built |
| CR-AI-01 | Model-written text is labelled as such (`AiLabel`, the chat says so) | AI Act Art. 50 (applies since 2 August 2026; the AI Omnibus, Regulation (EU) 2026/1744, left the transparency duties as they were) | Summaries, chat, shared page | Built |
| CR-AI-02 | Staff and operators know what the AI features do and cannot do (AI literacy). Keeping Spine out of the medical-device class also keeps it out of the AI Act's high-risk class for medical devices | AI Act Art. 4; Art. 6(1) and Annex I (high-risk obligations for products under Annex I moved by the AI Omnibus to 2 August 2028) | Operator | Operator |
| CR-EHDS-01 | No claim of interoperability with clinic or national EHR systems; if one is made, the wellness-app label and registration apply | Regulation (EU) 2025/327 Art. 47 (label, only for wellness apps that claim interoperability with EHR systems), Art. 48 (sharing into an EHR needs the user's consent), Art. 49 (EU registration database); application dates in its Art. 105 | Marketing | Operator |
| CR-SIG-01 | A digital signature is shown as "verified" only when its certificates chain to an authority the operator named (EU trusted list for qualified providers) and the file's bytes match. It says nothing about legal effect or the signing time beyond what the file states; revocation is checked only against lists inside the signature (a certificate revoked before the signing is not verified), and is unknown otherwise | eIDAS Regulation (EU) 910/2014 as amended by 2024/1183, Art. 22 (trusted lists); Implementing Decision (EU) 2025/2164 (trusted list template, applies from 29 April 2026) | Signature check, `SPINE_TRUST_ANCHORS_DIR` | Built, operator supplies anchors |
| CR-TR-01 | Terms state that translations and extractions are aids and the original document prevails | Liability; terms | Terms | Draft |

### Operating the service

| ID | Requirement | Basis | Applies to | Status |
| --- | --- | --- | --- | --- |
| CR-CRA-01 | Vulnerability handling and reporting process, a public contact, advisories; full obligations later | Cyber Resilience Act (EU) 2024/2847: Art. 14 reporting of exploited vulnerabilities and severe incidents applies since 11 September 2026 (early warning in 24 hours, notification in 72); most other obligations from 11 December 2027; the Commission's guidance of 27 July 2026. Whether it binds depends on whether the product is made available in the course of a commercial activity | `SECURITY.md` | Draft |
| CR-CON-01 | Operator identity and contact on the service, and terms in plain language | E-commerce Directive 2000/31 Art. 5; Law 365/2002 Art. 5 (name, seat, contact, fiscal code and tariffs made permanently and freely accessible; read in unofficial copies) | Site, `SPINE_OPERATOR_*` | Operator |
| CR-ACC-01 | Check whether accessibility requirements apply to the service (micro-enterprise service providers are exempt) | Directive (EU) 2019/882, applies since 28 June 2025; microenterprises (fewer than 10 people and turnover or balance sheet up to EUR 2 million) providing services are exempt; Romanian transposition to be confirmed | Web app | Operator |
| CR-NIS-01 | Check whether the operator is in scope as an essential or important entity | Directive (EU) 2022/2555; Romania: Emergency Ordinance 155/2024 approved by Law 124/2025, with registration with DNSC (Orders 1/2025 and 2/2025) | Operator | Operator |

### Features not in the first release

| ID | Requirement | Basis | Applies to | Status |
| --- | --- | --- | --- | --- |
| CR-FAM-01 | A child's profile is managed by a guardian; no own account under 16 without guardian consent | GDPR Art. 8(1) (16 is the age unless a state lowers it; Romania has not, and Law 190/2018 has no such article); a 2025 bill on online services for under-16s passed the Senate and is not confirmed as law | Family profiles | Built (the guardian's invitation is the consent, **M-50**; the lawyer confirms) |
| CR-FAM-02 | At 18, guardian access continues only with the new adult's consent; access is paused until they choose, and the profile key is rotated | GDPR Art. 6, 9; TR-CRY-07 | Promotion at 18 | Built (**M-51**; the person takes the step themselves) |
| CR-FAM-03 | Lawyer review of a minor's rights over their own medical data, including whether some records may be hidden from guardians before 18 | Law 46/2003 (patient rights: the legal representative's consent, and the patient's involvement as far as they can understand); Order 386/2004; Civil Code | Teen access | Future |
| CR-DEL-01 | Delegating a profile to another account is a disclosure the owner chooses; the delegate's rights and the owner's right to revoke are stated, and each grant is logged | GDPR Art. 6, 9(2)(a), 26 if roles are joint | Delegation | Future |
| CR-EMG-01 | The emergency card is data the owner chooses to expose without approval: consent for that exposure is explicit, a scan is logged and notified, and the offline QR (data in the code) warns that anyone who sees the code reads the card | GDPR Art. 9(2)(a), 25, 32 | Emergency card | Built (the owner turns it on after being told who can read it; the lawyer confirms the consent wording) |
| CR-REM-01 | Reminders restate the document, hold no medical text on the lock screen and are the owner's to switch off | GDPR Art. 5(1)(c); MDCG 2019-11 | Reminders | Future |
| CR-PAY-01 | A paid tier: price, renewal and cancellation shown before purchase, 14-day withdrawal right and digital-content rules, a processor agreement with the payment provider | Consumer Rights Directive 2011/83; Digital Content Directive (EU) 2019/770; GDPR Art. 28 | Subscription | Draft (pricing page, terms and privacy notice say it; the agreement with Paddle is the operator's to sign) |
| CR-MOB-01 | Store listings and privacy forms match the privacy notice and the intended purpose | Store policies; GDPR Art. 13; MDR Art. 7 | Mobile apps | Future |
| CR-ENC-01 | An attested confidential-computing relay (so the relay could be said not to see content) is a security measure to be described in the notice and the DPIA when it replaces the current relay | GDPR Art. 25, 32, 35 | Relay | Future |

### References

How these were checked: Law 190/2018 was opened on the legislation portal; Law 365/2002 Art. 5, Law 506/2004 Art. 4(5) and Law 46/2003 come from unofficial copies and press, with the portal link given where a search returned it; the dates and scope of the AI Act, the Cyber Resilience Act, the EHDS, eIDAS, NIS2 and the accessibility directive come from law-firm analyses and the Irish national cybersecurity centre, because the EUR-Lex pages would not load for the tool that did the checking. Article numbers of the EU instruments that no source confirmed are left out rather than guessed; open the EUR-Lex text before relying on one.

EU instruments (official text):

- GDPR, Regulation (EU) 2016/679: https://eur-lex.europa.eu/eli/reg/2016/679/oj (Art. 8: https://gdpr-text.com/ro/read/article-8)
- Medical Devices Regulation (EU) 2017/745: https://eur-lex.europa.eu/eli/reg/2017/745/oj
- AI Act, Regulation (EU) 2024/1689: https://eur-lex.europa.eu/eli/reg/2024/1689/oj
- European Health Data Space, Regulation (EU) 2025/327, published in the Official Journal on 5 March 2025: https://eur-lex.europa.eu/eli/reg/2025/327/oj
- eIDAS, Regulation (EU) 910/2014: https://eur-lex.europa.eu/eli/reg/2014/910/oj; amended by Regulation (EU) 2024/1183; trusted list template, Implementing Decision (EU) 2025/2164: https://eur-lex.europa.eu/eli/dec_impl/2025/2164/oj
- Cyber Resilience Act, Regulation (EU) 2024/2847: https://eur-lex.europa.eu/eli/reg/2024/2847/oj
- NIS2, Directive (EU) 2022/2555: https://eur-lex.europa.eu/eli/dir/2022/2555/oj
- ePrivacy Directive 2002/58: https://eur-lex.europa.eu/eli/dir/2002/58/oj
- Consumer Rights Directive 2011/83: https://eur-lex.europa.eu/eli/dir/2011/83/oj
- Digital Content Directive (EU) 2019/770: https://eur-lex.europa.eu/eli/dir/2019/770/oj
- E-commerce Directive 2000/31: https://eur-lex.europa.eu/eli/dir/2000/31/oj
- European Accessibility Act, Directive (EU) 2019/882: https://eur-lex.europa.eu/eli/dir/2019/882/oj

Romanian law (legislation portal):

- Law 190/2018 of 18 July 2018, implementing the GDPR (Official Gazette 651 of 26 July 2018); Art. 3(1) health data in automated decisions and profiling, Art. 3(2) public health: https://legislatie.just.ro/Public/DetaliiDocumentAfis/220052
- Law 365/2002 on electronic commerce (republished), Art. 5: https://legislatie.just.ro/Public/DetaliiDocumentAfis/77218
- Law 506/2004 on privacy in electronic communications, Art. 4(5): consolidated text on https://legislatie.just.ro (search "Legea 506/2004"); enforcement examples: https://startupcafe.ro/agentie-online-de-turism-amendata-pentru-cookie-urile-de-pe-site-ce-lege-a-incalcat-88031
- Law 46/2003 on patients' rights (consolidated copy of 20.11.2023; the current form is on the portal): https://audit.ms.ro/media/documents/LEGE_Nr._46_2003_forma_la_data_de_20.11.2023.pdf
- Law 129/2018 (repeals Law 677/2001) and the ANSPDCP decision repealing its acts: https://dataprotection.ro/servlet/ViewDocument?id=1479; ANSPDCP FAQ: https://www.dataprotection.ro/servlet/ViewDocument?id=1650
- Emergency Ordinance 155/2024 approved by Law 124/2025 (NIS2): analysis at https://cms.law/en/rou/legal-updates/romania-expands-scope-of-nis2-implementation and https://www.cliffordchance.com/briefings/2025/12/navigating-nis2-cybersecurity-compliance-obligations-for-romanian-companies.html

Analyses used for dates and scope:

- AI Act Art. 50 in force since 2 August 2026, AI Omnibus Regulation (EU) 2026/1744: https://www.goodwinlaw.com/en/insights/publications/2026/08/alerts-technology-dpc-eu-ai-act-transparency-obligations-now-in-force
- CRA reporting from 11 September 2026: https://www.mccannfitzgerald.com/knowledge/data-privacy-and-cyber-risk/cyber-resilience-act-reporting-obligations-apply-from-11-september-2026 and https://ncsc.gov.ie/cra/
- EHDS wellness applications, Art. 47 to 49: https://www.insideprivacy.com/digital-health/ehds-series-4-the-european-health-data-spaces-implications-for-wellness-applications-and-medical-devices/
- MDCG 2019-11 Rev.1: https://openregulatory.com/mdcg/mdcg-2019-11 (the guidance itself is on the European Commission's health site)
- Age of digital consent in Romania (16): https://childreninthedigitalworld.twobirds.com/home/romania and https://www.linklaters.com/en/insights/data-protected/data-protected---romania
- European Accessibility Act exemptions: https://www.taylorwessing.com/en/interface/2025/accessibility/key-eu-accessibility-act-exemptions-and-the-challenges-they-pose
- ANSPDCP, the Romanian supervisory authority: https://www.dataprotection.ro

## Open decisions

- [x] Model credential path: a relay holds the credentials (provider tokens cannot be scoped per user)
- [x] Model provider: one of the implemented adapters, chosen by configuration, with regional endpoints and the zero-retention setup above
- [x] Licence: AGPL-3.0-only for everything (`LICENSE`); a mobile app is not in the first release
- [ ] Whether the relay moves into an attested confidential-computing enclave, and when
