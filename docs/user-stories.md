# Who Spine is for, and what they come to do

The people Spine is built for and the situations that bring them to it. [requirements.md](requirements.md) says what Spine must do and [scenarios.md](scenarios.md) how each flow behaves; this page says who is on the other side of those flows and why, so a screen can be judged by whether it serves them. Each story names the scenarios that serve it today and what is still missing. The people here are composites: no name, place or record on this page is a real person's.

## Profiles

**P1 — The person who moved.** Grew up or has lived in several cities or countries, so their history is in many clinics' hands, in more than one language, and much of it on paper. When they need it, it arrives as a pile: a clinic's export of tens of pages in no order, photocopies, faded scans, handwritten letters and prescriptions, some from childhood. They want it in one place, readable, in order, once, and never to collect it again.

**P2 — The expat or person working abroad.** Lives in one country with records from another. Their new doctor cannot read the old letters, and their family doctor at home cannot read the new ones. They want to hand a doctor, in either country, what matters in the doctor's own language, and to keep both sides in one timeline.

**P3 — The frequent traveller.** Healthy most of the time, but falls ill or has an accident away from home: a clinic abroad gives them a letter, a prescription or test results in a language they do not read. They have a phone, maybe a poor connection, and little patience. They want to understand what they were given, keep it, and show their history to the doctor in front of them.

**P4 — The person with scattered care at home.** Never leaves the country, but their care is split: consultations with one doctor at a private clinic, tests at a laboratory chain, a hospital stay elsewhere, the family doctor in the public system. No one of them sees the whole picture, and each asks for "the last results" again. They want one timeline and to bring the right papers to each visit.

**P5 — The carer.** Keeps records for a child or an ageing parent besides their own: vaccinations, a child's growth and visits, a parent's medicines and specialists. They need the people kept apart, and sometimes a partner or sibling to see them too (scenarios 15.1, 15.2).

**P6 — The doctor who receives a link.** Has a few minutes, may not share the patient's language, owes the patient nothing, and has no reason to trust an app. They need to see whose records these are, why they were sent and what matters, in their language, with the original one tap away.

**P7 — The operator.** Runs Spine: approves accounts, watches the numbers that say whether it is working, sets prices, and sends the invoices. Never sees a record.

A person is often more than one profile: someone who moved as a child (P1) may now live abroad (P2) and travel for work (P3).

## Stories

### S1 — Consultations at one clinic, tests at another (P4, P1)
*I see an endocrinologist at one clinic, do my blood tests at a laboratory chain, and had a scan at the hospital. Each visit someone asks for the results from the others.*

- **They need:** every document in one timeline whoever wrote it; a test followed over time even when two laboratories name it differently; the visit, the tests it asked for and the visit that read them seen together; the right documents brought to the next visit.
- **Served by:** upload and grouping (2.1, 2.5), the doctors and providers lists (5.1–5.3, 6.4), one test followed and two labs' names joined (4.1, 4.2), links and episodes (6.5, 6.7, 4.x), a link scoped to an episode or a date range (7.1), what came from others since the last visit to a doctor, with "Share these" (5.2b), and on a phone one Filter button instead of five dropdowns (2.x, 11.x phone paragraph).
- **Missing:** a care-by-provider overview (who I see, for what, when last) across all providers at once; the page of one doctor has it.

### S2 — A medical history for an insurance claim (P4, P2, P1)
*My insurer wants my medical history for the last five years and the documents for this treatment, attached to a claim form.*

- **They need:** a chosen set of documents (a period, a condition, one treatment) as files they can attach to a claim portal or an email, with a list of what is included (date, provider, type); sometimes a translation for an insurer in another country; certainty about what they are handing over and nothing more.
- **Served by:** a share link scoped to a date range, an episode, a tag or chosen documents (7.1), which an insurer's assessor can open in their own language (11.2); exporting one document or everything (9.5).
- **Missing:** an insurer's portal takes files, not links. There is no export of a chosen set as one PDF (or a zip of PDFs) with a cover list of what is in it; the existing export is a Spine archive meant for restoring, not for a third party. A machine translation is not a certified one, and the export must say so where it carries one.

### S3 — A letter in a foreign language, while travelling (P3, P2)
*I was treated in a clinic abroad and given a discharge letter I cannot read. I want to know what it says, keep it, and show it to my doctor at home.*

- **They need:** from the phone, photograph the letter and read it in their language within a minute or two; the original kept beside the translation; the letter in their timeline with their other records; later, share it with the doctor at home in that doctor's language.
- **Served by:** scanning with the camera (2.8) or a photo (2.3), translation into the reader's language with the original one tap away (11.1), sharing in the doctor's language (11.2), "Take a photo" first on Upload and Scan in the phone menu, and a single photographed letter that opens by itself once it is read (2.8).
- **Missing:** a measured time from the shutter to the translated letter on a real phone; the first reading of a photo depends on the reading service.

### S4 — A bulk export with handwriting, from years of doctors (P1, P5)
*I asked my old clinics for my records. One sent a zip of scans, another a 60-page PDF in no order, with handwritten letters and prescriptions from when I was a child.*

- **They need:** to put the whole pile in at once and see it become documents; pages from many documents sorted into the right ones; handwriting read where it can be and flagged where it cannot, never guessed silently; old and undated documents placed sensibly; to know before they start whether their plan covers it.
- **Served by:** a zip or a long PDF (2.2b, 2.6), sorting a mixed export (12.4), the grouping check (2.5), scans and faded pages cleaned up with handwriting kept (2.8, FR-ING-09), low-confidence fields flagged for checking (FR-EXT-04, 3.2), the one-off import allowance (13.2e).
- **Missing:** a progress view for hundreds of pages that says what is done, what waits for the owner and what could not be read; a way to work through the flagged handwritten fields as a queue; testing on real handwritten pages (requirements: "The model tested on handwritten pages").

### S5 — A new doctor abroad (P2, P6)
*I moved and registered with a doctor here. She asked for my history; it is all in my first language.*

- **They need:** to send the doctor a link with what matters, in her language, that she opens without an account; the doctor to see whose records they are, why they were sent, and the current medicines, conditions and recent results before the list of documents.
- **Served by:** share links with a preset language (7.1, 11.2), approval before opening (7.2), the shared page with its overview, search and trends (13.4), the owner's own note, name and what they take now written on the share form (7.1).
- **Missing:** the owner's own words (an episode's title, a tag they wrote) stay in the owner's language on a translated page; only what the app made is translated.

### S6 — Taken ill abroad (P3, P2)
*I collapsed on a trip. The paramedic needs my allergies, conditions and medicines, and I cannot tell them.*

- **They need:** an emergency card someone can read with no account and no signal, in the reader's language.
- **Served by:** the emergency card, its code, the copy that works with no signal, and printing (14.1–14.3), starting from the records without filling anything, a blood type to choose and a preview before it is turned on (14.1).
- **Missing:** the card is written in one language: a second language, with the owner's words translated once and kept, is not built.

### S7 — A parent keeping a child's records (P5)
*My son has asthma and sees two specialists; my partner takes him to some appointments.*

- **Served by:** records kept apart for each person and someone else let in (15.1, 15.2), sharing a person's records with a doctor (7.1).
- **Missing:** nothing specific beyond the stories above; check each new screen in another person's records as well as the owner's own.

## How to use this page

- A change to a screen names the profiles and stories it serves in its plan or review, and is checked against them, not only against the flow in scenarios.md.
- When a story's "Missing" item is built, move it into "Served by" with its scenario.
- A new story is added here when someone brings a situation Spine should serve that none of these covers.
