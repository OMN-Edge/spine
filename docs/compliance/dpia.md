# Data protection impact assessment (Art. 35)

Required before launch: the processing is of health data (Art. 9) of many people, with new technology (AI models). A first assessment from what the software does; to be completed with the data protection adviser.

## 1. The processing
Users upload their own health documents. The service stores them, reads out dates, names and values (locally from the PDF's text layer; with a model for scans and photos where the operator allows it), groups and summarises them, translates them on request, answers questions about them and shows chosen documents to a recipient by a time-limited link. Details: ARCHITECTURE.md.

## 2. Necessity and proportionality
The purpose is the user's own record keeping and showing it to a doctor. Only what the user uploads is processed; the model calls carry only what the feature needs (a page, a summary card, a handful of results), never the whole archive; nothing is used for training, advertising or profiling; no decision is made about anyone. The user can export everything and delete everything at any time.

## 3. Risks to the people concerned, and what is done
| Risk | Measure | Residual |
| --- | --- | --- |
| Someone else reads an account's records (stolen password, session) | argon2id, refused common passwords, optional second factor, sessions that expire and can be ended, password asked again for the export and scans, mail on a new browser | Low-medium |
| One user sees another's records | every query filtered by the account, tested as a second user, response shapes scanned | Low |
| A share link leaks | random unguessable token stored as a digest, expiry from one hour, revocation, optional approval of each browser, access log with country and document | Medium: a recipient can copy what they viewed |
| The operator or an intruder with the database reads records | Today records are stored readable on the host (SECURITY.md). The design for end-to-end encryption is in docs/key-hierarchy.md and is **not built** | **High until it is built or the claim is not made** |
| Records go to a model provider | Off unless the operator switches it on; EU endpoint required for Vertex; every call counted; no key fallback; the provider's retention settings must be zero and are verified before launch | Medium: depends on a contract |
| A wrong extraction or translation is relied on | Labelled as machine output, original always one tap away, low-confidence values marked, allergies, medicines and doses marked in translations, nothing interpreted | Low-medium |
| A child's record | Managed by a guardian; account under 16 needs guardian consent | Needs the family design (FR-PRF, FR-FAM) |
| Loss of data | Daily snapshot and originals mirror, restore tested | Low |

## 4. Consultation and decision
Data subjects were not consulted at this stage; the adviser's and, where needed, the supervisory authority's views are to be recorded here. **Do not launch with the "operator cannot read your records" claim until the high residual risk above is closed.**
