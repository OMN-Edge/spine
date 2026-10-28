# Data protection impact assessment (Art. 35)

Required before launch: the processing is of health data (Art. 9) of many people, with new technology (AI models). A first assessment from what the software does; to be completed with the data protection adviser.

## 1. The processing
Users upload their own health documents. The user's device reads out dates, names and values (locally from the PDF's text layer and with local OCR; with a model, through a relay, for scans and photos where the operator allows it), groups and summarises them, translates them on request, answers questions about them and shows chosen documents to a recipient by a time-limited link. The service stores the records only as objects sealed on the device. Details: ARCHITECTURE.md.

## 2. Necessity and proportionality
The purpose is the user's own record keeping and showing it to a doctor. Only what the user uploads is processed; the model calls carry only what the feature needs (a page, a summary card, a handful of results), never the whole archive; nothing is used for training, advertising or profiling; no decision is made about anyone. The user can export everything and delete everything at any time.

## 3. Risks to the people concerned, and what is done
| Risk | Measure | Residual |
| --- | --- | --- |
| Someone else reads an account's records (stolen password, session) | A session alone opens nothing: the records open only with the master password, a passkey set up for it or the recovery kit, derived or unwrapped on the device; argon2id, refused common passwords, optional second factor, sessions that expire and can be ended, mail on a new browser | Low-medium: the master password is the key, so a weak or phished one is the exposure |
| One user sees another's records | the server holds no record to show; the vault's routes are scoped by account and tested as a second user; each person's keys are their own | Low |
| A share link leaks | the copy is sealed and its key is in the link, so whoever holds the whole link reads that copy and nothing else; expiry, revocation (deletes the copy), optional approval so a leaked link alone opens nothing, a record of each open with its country | Medium: a recipient can copy what they viewed |
| The operator or an intruder with the database reads records | The server holds only sealed objects and wrapped keys it cannot open (docs/key-hierarchy.md, SECURITY.md **M-34** to **M-38**). What it can see is the email, the size and time of objects and share metadata. An operator could serve a different web app that steals keys, which only a build check by the user prevents | Medium: **built, not audited**; the relay sees plaintext while it runs a call |
| Records go to a model provider | Page images are off unless the operator switches them on (a second switch); the text of pages and documents goes to the model through the relay whenever the instance has one, and `SPINE_TRANSLATION`, `SPINE_CHAT` and `SPINE_LINKING` can switch those features off; EU endpoint required for Vertex; every call counted; no key fallback; the provider's retention settings must be zero and are verified before launch | Medium: depends on a contract |
| A visitor with no account sends health data to a model through the demo, or runs up its cost | Off unless the operator sets `SPINE_DEMO_UPLOADS=on`; the visitor agrees before the first file; a few files, first pages only; nothing kept by the service; the relay counts calls per address (a keyed hash, not the IP) and for all demo visitors together, and refuses past either (SECURITY.md **M-39**). A copy the visitor chooses to keep for an account waits in their own browser, unencrypted, for a day at most | Medium: the consent is not recorded, since nothing of the visitor is kept; the per-address count can be spread across addresses, which only the total bounds |
| A wrong extraction or translation is relied on | Labelled as machine output, original always one tap away, low-confidence values marked, translations told to keep numbers, units, dates, codes, drug names and people's names as they are, nothing interpreted | Low-medium |
| A child's record | Managed by a guardian; account under 16 needs guardian consent | Needs the family design (FR-PRF, FR-FAM) |
| Loss of data | Daily snapshot of the accounts database and mirror of the sealed vault; a lost master password and recovery kit mean the records are gone, and sign-up says so | Low-medium: a restore to a blank machine has not been rehearsed |

## 4. Consultation and decision
Data subjects were not consulted at this stage; the adviser's and, where needed, the supervisory authority's views are to be recorded here. **The "operator cannot read your records" claim now describes what is built, but nothing has been audited, and the relay does see a model call's plaintext: word the claim as "does not store or log" for the relay and say that it is unaudited.**
