# Keys and trust boundaries

This is the public write-up of how Spine is meant to keep records readable only by their owner and the doctors the owner chooses (requirements TR-CRY, TR-SHC, TR-AI, TR-OSS-03). It describes the **design for the hosted service**. It is not what the code does today.

> **Status.** Built, not audited ([crypto-design.md](crypto-design.md) has the stages). Keys are made on the device, records are kept in a database the browser holds and saved to the server as sealed objects, the server registers no route that reads a record, and shares are sealed copies ([SECURITY.md](../SECURITY.md) **M-34** to **M-37**). Gaps are listed there and in the status table: the relay sees model calls in plaintext as they pass, passkeys cannot unlock the vault, and a share is a snapshot. Each section ends with what stays visible, so the claim can be checked against the design.

## Claim, in one sentence

Spine can never read your records. AI features send the content you choose, through a relay that logs nothing, to an EU-hosted model that keeps nothing. "Zero-knowledge" and "end-to-end encrypted" describe this; "zero trust" is a different thing (a network model) and is not used.

## Who sees plaintext

| Party | Sees plaintext | What it can see |
| --- | --- | --- |
| Patient's device | Yes | Everything in the vault |
| Doctor's browser | Yes, scoped | Only the shared episodes, until the link expires or is revoked |
| EU model endpoint | Yes, transient | The content of each AI call; retention set by contract |
| Relay | Yes, in transit | The content of each AI call, passing through; it stores and logs none. Today this is a promise about open-source code, not a property: only an attested confidential-computing relay would make it one |
| Spine servers | No | Account email, ciphertext sizes, timestamps, share metadata |
| Email provider | No | That a share was requested; never medical content |

The weakest point is the AI path. A plain relay terminates TLS and can see what passes through, so until the relay runs in an attested enclave (Google Cloud Confidential Space), the honest wording is "does not store or log content", never "cannot see it".

## Key hierarchy

Primitives come from an audited library (libsodium or equivalent); nothing is invented.

1. **Master key.** Derived on the device from the master password with Argon2id. The server never receives the password: sign-in uses a separately derived value (or OPAQUE).
2. **Account key.** Random, wrapped by the master key. Also wrapped by the **recovery key**, which exists only in the printable recovery kit made at sign-up.
3. **Profile key**, one per profile (a child, a parent), wrapped by the account key.
4. **Data key**, one per document, wrapped by the profile key. Content is encrypted with AES-256-GCM or XChaCha20-Poly1305.
5. **Account key pair** (X25519), used to wrap a profile key for another account when a profile is delegated.

Everything about a document is encrypted, not only its pages: titles, dates, tags, doctors, episodes, extracted fields, summaries and embeddings. In plaintext on the server stay only opaque identifiers, sizes and timestamps.

**Recovery.** Only the recovery kit recovers an account. The operator has no recovery path, and sign-up says so plainly. A lost password and a lost kit together mean the data is gone.

**New devices** are enrolled from a device that is already signed in, or with the master password.

**Rotation.** Promoting a child's profile to an adult account at 18, and revoking any delegate, rotate the profile key: the data keys are re-wrapped under a new key the removed party never held. Content someone already viewed cannot be recalled.

**Deleting an account** destroys the keys, which makes the stored ciphertext unrecoverable, including in backups (which hold ciphertext only).

Stays visible to the operator: that an account exists, how many blobs it has and how large they are, when they changed.

## Sharing with a doctor

A share gets its own random **share key**, and the data keys of the shared documents are re-wrapped under it.

- **Direct mode.** The share key travels in the URL fragment (after `#`), which browsers never send to a server. Anyone holding the whole link can read; the server holds only wrapped keys it cannot open.
- **Approval mode.** The doctor's browser makes an ephemeral key pair and sends the public key with its request. The patient's app approves and wraps the share key to that public key. A leaked link alone then opens nothing.
- **Expiry and revocation** delete the wrapped keys and the share bundle on the server. Content already viewed may have been copied; the interface says so.
- **Emergency card** has its own key carried in the QR code. The offline variant encodes the compressed card itself.

Stays visible to the operator: that a share exists, its expiry, when and from which country it was opened. Not which documents it holds.

## The AI path

- Every model call starts on the device: content is decrypted locally and sent over TLS to the relay, which forwards it to a regional EU endpoint (never the global one) of Vertex AI with Gemini Flash.
- The device never holds the provider's credential. The relay does, enforces per-user quotas, and only passes requests through: it writes nothing to a database or storage. The device encrypts every result (extraction, summary, embedding, translation) before upload.
- Each call carries the minimum: one document or page for extraction, a few retrieved snippets for chat, never the vault. Identifiers such as a national ID number are masked where extraction does not need them.
- Search runs on the device: encrypted embeddings are downloaded, decrypted into memory and compared there. There is no server-side vector database. A search sends only its query text to be embedded, treated like content.
- Doctor-side translation goes through the same relay, authorised by the share and limited to its expiry.
- Provider retention is set to none and checked before the first real user (the checklist in the requirements), because it is a contract, not a property of the code.
- A self-hosted install points at its own OpenAI-compatible endpoint, and then the question of who sees plaintext is the operator's own.

## Limits we state rather than hide

- A web client served by the operator could in principle be swapped for a malicious one that steals keys. The mitigations are a strict content security policy, subresource integrity, reproducible builds with published hashes, and native apps as the reference client. They reduce the risk; they do not remove the need to trust the build you run. The code is open (AGPL-3.0) so the build can be checked.
- Metadata that must be visible to work (sizes, timestamps, share counts, the account email) is visible.
- A model provider sees the plaintext of the calls you choose to make.
- Nothing here has been audited.

## Reporting a flaw

See [Reporting a vulnerability](../SECURITY.md#reporting-a-vulnerability).
