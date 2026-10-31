# Keys and trust boundaries

This is the public write-up of how Spine is meant to keep records readable only by their owner and the doctors the owner chooses (requirements TR-CRY, TR-SHC, TR-AI, TR-OSS-03). It describes the design and, since it is built, what the code does.

> **Status.** Built, not audited ([crypto-design.md](crypto-design.md) has the stages). Keys are made on the device, records are kept in a database the browser holds and saved to the server as sealed objects, the server registers no route that reads a record, and shares are sealed copies ([SECURITY.md](../SECURITY.md) **M-34** to **M-38**). Gaps are listed there and in the status table: the relay sees model calls in plaintext as they pass, a share is a snapshot that the owner's device refreshes while it is open, and nothing has been audited. A passkey with the WebAuthn PRF extension can open the vault. Each section ends with what stays visible, so the claim can be checked against the design.

## Claim, in one sentence

Spine can never read your records. AI features send the content you choose, through a relay that stores and logs no content, to an EU-hosted model that keeps nothing. "Zero-knowledge" and "end-to-end encrypted" describe this; "zero trust" is a different thing (a network model) and is not used.

## Who sees plaintext

| Party | Sees plaintext | What it can see |
| --- | --- | --- |
| Patient's device | Yes | Everything in the vault |
| Doctor's browser | Yes, scoped | Only the shared documents, until the link expires or is revoked |
| EU model endpoint | Yes, transient | The content of each AI call; retention set by contract |
| Relay | Yes, in transit | The content of each AI call, passing through; it stores and logs none. Today this is a promise about open-source code, not a property: only an attested confidential-computing relay would make it one |
| Spine servers | No | Account email, ciphertext sizes, timestamps, share metadata |
| Email provider | No | That a share was requested; never medical content |

The weakest point is the AI path. A plain relay terminates TLS and can see what passes through, so until the relay runs in an attested enclave (Google Cloud Confidential Space), the honest wording is "does not store or log content", never "cannot see it".

## Key hierarchy

Primitives come from an audited library (libsodium or equivalent); nothing is invented.

1. **Master key.** Derived on the device from the master password with Argon2id. The server never receives the password: sign-in uses a separately derived value.
2. **Account key.** Random, wrapped by the master key. Also wrapped by the **recovery key**, which exists only in the printable recovery kit made at sign-up.
3. **Profile key**, one per profile (a child, a parent), wrapped by the account key. Each profile is a person whose records stand apart: their own database on the device, objects, search, share links and emergency card.
4. **Data key**, one per sealed object (a segment of changes, a part of a snapshot, a file), wrapped by the profile key. Content is encrypted with XChaCha20-Poly1305, the object's id and kind bound in as associated data. (Not one per document: the unit of storage is the object.)
5. **Account key pair** (X25519), made at sign-up. It is used to let another account into one profile: the owner's device seals the profile key to the other account's public key (SECURITY.md **M-49**). An account can keep several profiles (**M-48**); they are opened one at a time, and the account's own devices open them all.

Everything about a document is encrypted, not only its pages: titles, dates, tags, doctors, episodes, extracted fields, summaries and embeddings. In plaintext on the server stay only opaque identifiers, sizes, timestamps and a coarse kind of object.

**Recovery.** Only the recovery kit recovers an account. The operator has no recovery path, and sign-up says so plainly. A lost password and a lost kit together mean the data is gone.

**New devices** sign in with the master password, or with a passkey that was set up to open the vault (WebAuthn PRF). Or **from a device that is already signed in**: that device shows a one-time code (80 bits, never sent to the server), seals the account key under a key the code makes and leaves it at the server for ten minutes; the new device asks, the person approves it on the first device after seeing what asked, and it collects the sealed key and a sign-in (SECURITY.md **M-41**). The server holds an id the code makes and ciphertext, neither of which opens anything without the code.

**Rotation** (SECURITY.md **M-49**): ending a delegate's access replaces the profile's key. A new key is made on the owner's device; every data key of the profile is sealed again under it (the data keys and the bodies are unchanged); the profile record is sealed again; the new key is sealed to each remaining delegate's public key; and the server takes all of it in one step. A key a former delegate holds opens nothing stored from then on. Content someone already viewed cannot be recalled. Promoting a child's profile to an adult account at 18 will use the same step.

**Deleting an account** removes its vault keys, its sealed objects and shares, and the backup's copy of its vault (`deleteAccount`). Database snapshots already taken still hold its rows until retention prunes them; they hold the account's wrapped keys, which open only with its master password or recovery kit, and no record.

Stays visible to the operator: that an account exists, how many blobs it has and how large they are, when they changed.

## Sharing with a doctor

A share is a **sealed copy**: the owner's device builds a copy that holds only what the link shares (an allow-list, `store/slice-policy.ts`), seals it under a random **share key**, and sends the sealed bytes. No data key of the owner's vault is involved.

- **Direct mode.** The share key travels in the URL fragment (after `#`), which browsers never send to a server. Anyone holding the whole link can read; the server holds only sealed bytes it cannot open.
- **Approval mode.** The doctor's browser makes an ephemeral key pair and sends the public key with its request. The patient's app approves and wraps the share key to that public key. A leaked link alone then opens nothing.
- **Expiry and revocation** delete the sealed copy on the server. Content already viewed may have been copied; the interface says so.
- **A share is a snapshot** that the owner's device builds again after the records change (15 seconds later, while it is open) and sends if it would differ, under the same key. A closed device cannot refresh it.
- **Emergency card** (SECURITY.md **M-47**): a card the owner writes, sealed on the device under a key of its own and kept at the server as a bundle that opens with no approval and has no end. The key is in the address and the QR code after the `#`, so anyone who has the whole address reads the card, and the server never has the key. The owner turns it off and the sealed bytes are deleted. A second, optional code holds the card itself as plain text, so it needs no network and no server at all; it cannot be turned off or counted, and the page says so. Stays visible to the operator: that a card exists, its size, and when and from which country it was opened.

Stays visible to the operator: that a share exists, its expiry, when and from which country it was opened. Not which documents it holds: it sees only the id, meaningless to it, of a document a recipient says they opened.

## The AI path

- Every model call starts on the device: content is decrypted locally and sent over TLS to the relay, which forwards it to the provider the relay is configured with (Vertex AI at a regional EU endpoint, never the global one, in the author's deployment; Anthropic's API is the other adapter).
- The device never holds the provider's credential. The relay does, enforces per-account and per-share daily quotas, and only passes requests through: it stores no content and keeps only a count of calls a day. The device encrypts every result (extraction, summary, embedding, translation) before upload.
- Each call carries the minimum: one document or page for extraction, a few summary cards for chat (and the text of a few pages only when the owner asks the assistant to sort an upload), never the vault. (Masking identifiers such as a national ID number where extraction does not need them is **not built**.)
- Search runs on the device: encrypted embeddings are downloaded, decrypted into memory and compared there. There is no server-side vector database. A search sends only its query text to be embedded, treated like content.
- Doctor-side translation goes through the same relay, authorised by the share and limited to its expiry.
- Provider retention is set to none and checked before the first real user (the checklist in the requirements), because it is a contract, not a property of the code.
- A self-hosted install could point the relay at its own model endpoint, and then the question of who sees plaintext is the operator's own. The relay has two adapters today (Vertex, Anthropic); an OpenAI-compatible one is **not built**, and is one file in `server/src/llm/adapters/`.

## Limits we state rather than hide

- A web client served by the operator could in principle be swapped for a malicious one that steals keys. The mitigations are a strict content security policy, subresource integrity on the page's scripts and styles, and a reproducible build whose `hashes.txt` anyone can compare with a build of the commit ([verify-build.md](verify-build.md), SECURITY.md **M-40**), all in place; **not built**, a list of hashes signed and published apart from the site, and native apps as the reference client (cut from the first release). They reduce the risk; they do not remove the need to trust the build you run. The code is open (AGPL-3.0) so the build can be checked.
- Metadata that must be visible to work (sizes, timestamps, share counts, the account email) is visible.
- A model provider sees the plaintext of the calls you choose to make.
- Nothing here has been audited.

## Reporting a flaw

See [Reporting a vulnerability](../SECURITY.md#reporting-a-vulnerability).
