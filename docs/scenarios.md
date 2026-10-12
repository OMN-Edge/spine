# Scenarios

How Spine is meant to be used, with the checks that say a scenario works. Not a formal
specification: each scenario is a goal, the steps a person takes, and what must be true at the
end. If a scenario and the app disagree, one of them is wrong; fix whichever it is.

**People:** the **owner** (you, with an account), a **recipient** (a doctor with a share link and
no account), the **operator** (whoever runs the Pi), and a **second user** (another account on the
same instance, who must never see the owner's records).

**Status** shows how much each scenario has been checked:

- **auto**: automated tests cover it (named where useful).
- **hand**: checked by hand in the running app, with the model replaced by a fake server.
- **real model**: depends on what a real provider returns. Nothing here has been run against one yet.
- **not built**: described because it is wanted, but it does not exist.

---

## 1. Getting in

### 1.1 Sign in
The owner opens the site, enters their email and password, and lands on the Timeline.

- A right email and password signs in; a wrong password and an unknown email give the same answer
  in the same time.
- Repeated failures are slowed down, per source and across the whole instance.
- With two-factor on, the password alone does not sign in: a six-digit code (or a recovery code,
  once) is also needed.
- Every page and API route except the login pages and a share link refuses a visitor with no session.

Status: auto (`auth`, `second-factor`, `isolation`).

### 1.2 Forgotten password
The owner asks for a reset. With a mailer they get a link by email; without one, the operator
produces a one-time link.

- Asking for a reset looks the same whether or not the address has an account.
- The link works once, and carries its token in the part of the URL the server never sees.
- A new password signs out the owner's other sessions.
- The mail has no document content and no clinical words.

Status: auto (`accounts`, `mail`, `cli`). Brevo delivery itself: real provider, untested.

### 1.3 Turn on two-factor
The owner scans a QR code, confirms one code, and saves ten recovery codes.

- A wrong first code does not turn it on.
- Each recovery code works once.
- The same code cannot be used twice, even within its time window.
- A lost phone and lost codes are fixed by the operator, not by the owner.

Status: auto (`totp`, `second-factor`).

---

## 2. Getting documents in

### 2.1 Upload a PDF that holds several documents
The owner drops a 40-page scan on the Upload page. It was a stack of letters, results and a discharge note.

- The upload is accepted at once, and the page shows progress while it is read.
- When it finishes, the upload is listed under the documents it became, each with a title (the
  one printed on it, else a short generated one), never the file name.
- A page numbered "1 / 1" after one numbered "3 / 3" starts a new document; a page numbered
  "2 / 3" continues the one before.
- If the model cannot be reached, the upload is marked as failed with the reason; the original file
  is kept and nothing is half-written.
- Every document starts **unreviewed**.

Status: auto (`pipeline`, `continuation`, `upload`); boundary quality on real scans: real model.

### 2.2 The same file twice, or a file that is not a document
- A file already uploaded is refused as a duplicate and points at the existing one.
- A file over 200 MB is refused with a reason.
- Only PDFs are accepted, judged by the file's contents (the PDF signature near its start), not by
  its name or the type the browser reported. Anything else is refused and named on the page, and
  nothing of it is kept on disk or recorded.
- A duplicate leaves no second copy on disk.
- Photos (JPEG, PNG) are **not** accepted: the pipeline renders PDFs only. See "Not covered yet".

Status: auto (`upload`).

### 2.3 A scan with no text layer
The file is a PDF made by a scanner or a scanning app, so its pages are pictures with no text.

- With the default settings, the page keeps whatever local reading found and nothing leaves the machine.
- With image reading switched on (two settings, both required), only pages with no text layer
  that local OCR could not read confidently are sent to the model, one page per call.
- A page that has a text layer is never sent as an image.
- If the model fails on a page, the page keeps its local reading.

Status: auto (`parser`, `ocr`, `read-page`); quality on real handwriting: real model.

### 2.4 Fix how the pages were grouped
The owner opens an upload's **Pages and grouping**. Pages 11 and 12 belong with the document before them.

- Pages show as thumbnails grouped by document; clicking a page opens a large preview.
- A split between any two pages of a document, and a join between two neighbouring documents, are each one action.
- After either, the affected documents are read again, which replaces the owner's earlier edits to
  them. If a document that was reviewed is affected, the screen says so first and asks for a yes or
  a cancel; for unreviewed documents there is nothing to lose and it goes ahead.
- Afterwards the screen says whether the new reading worked.
- If the new reading fails, the grouping still changes and the documents wait for review.
- Values, doctors and fields move with the pages they were read from.

Status: auto (`regroup`, `structured`); screens: hand.

---

## 3. Checking what was read

### 3.1 Review a document
The owner opens a document from the Timeline or the review queue. Reading mode shows the details,
doctors, measurements and fields beside the scan. **Review** makes the same page editable; **Done**
saves and marks it reviewed.

- Every part is editable: title, date, type, provider, tags, summary, notes, doctors, measurements
  (name, value, unit, range, date) and each extracted field.
- Hovering a field or measurement shows its page and the box it was read from.
- Done saves everything in one step. If anything is invalid, nothing is saved and the problem is shown.
- A measurement's flag (low, high, normal) is worked out again from its value and range on save.
- Fields that belong together, such as one medicine's drug, dose and frequency, show together.
- A document opened from the review queue starts in edit mode; from the Timeline, in reading mode.
- A document that has been edited, regrouped or read again shows up as unreviewed.

Status: auto (`document-edit`, `structured`); screens: hand.

### 3.2 A page the machine could not read
The owner opens a document, sees an empty text view for page 3, and asks for that page to be read with AI.

- The button is offered per page, never per document, and only when image reading is switched on.
- Only the pages chosen leave the machine, and the owner is told that before it happens.
- The page's text replaces the empty one only if the new reading succeeds, and the document's
  details are then extracted again.
- A page marked as read by a model says so, and its highlights are shown as approximate.

Status: auto (`ai-reading`, `read-page`); quality: real model.

### 3.3 The details look wrong, but the text is right
"Extract details again" re-runs extraction on the page text already read, with no image.

- It replaces fields, measurements and doctors only if the new answer is valid; otherwise the old ones stay.
- The document goes back to unreviewed.

Status: auto (`reread`).

---

## 4. Following my health over time

### 4.1 Watch one test
The owner opens **Trends**, picks "Hemoglobin", and sees a chart.

- Every test with a value is listed with its latest value and a low/high mark.
- The chart is a line through the values in date order, the newest reference range as a band, each
  point coloured low/high/in range and linking to its document. A table of the same values sits beside it.
- A value in a different unit, a value that is not a number (`<0.5`, `pozitiv`), a value with no
  date, and a repeat of a value already drawn are listed in the table but not drawn, and the page says so.
- A unit written two ways (`mUI/mL`, `mIU/mL`; `µg`, `ug`) counts as one unit.
- A value known only to the month ("03.2026") is drawn at that month and marked "month only".
- Lab results are dated by when the sample was collected, not issued.
- Values quoted inside a consultation ("TSH 3.10 on 03.2026") join the same trend, with their own date.

Status: auto (`trends-doctors`, `structured`); chart look and phone layout: hand; what a real model
extracts from real reports: real model.

### 4.2 Two labs call a test different things
Regina Maria prints "TSH", another lab "Hormon tireostimulant". The owner opens one and chooses "same test as" the other.

- The values move to the chosen test, and the old name stops being listed.
- A document read later that uses the old name is filed under the chosen one.
- A new reading is told the names already in the archive and asked to reuse one when it is the same test.
- Nothing is merged without the owner choosing it, and a merge cannot touch another user's tests.
- Undoing a merge is by editing the values; there is no undo button.

Status: auto (`test-names`); screens: hand; whether a real model reuses names well: real model.

### 4.3 Something is out of range
- A value outside its printed range shows as high or low everywhere it appears (the document, the list, the chart).
- The range used is the one printed for the patient, not the other groups listed beside it.
- A value with a printed flag but no range keeps the printed flag.

Status: auto (`structured`); the range choice on real reports: real model.

---

## 5. People

### 5.1 The doctors list grows by itself
Each reading adds the doctors a document names, with a role: wrote it, prescribed, referred, mentioned.

- "Dr. Popescu Ion", "POPESCU ION" and "Ion Popescu" are one entry; so are "Ioana-Maria" and "Ioana Maria".
- Two doctors with the same professional code are one entry whatever the spelling; a code is
  filled in once and never replaced.
- The same doctor on a hundred documents is one entry with a count and a last-seen date.
- The patient is never listed as a doctor, and the national ID, patient code and phone are never extracted.

Status: auto (`structured`); finding names in real reports: real model. Signing doctors and codes
in signature stamps are pictures and are usually not read from text; see 5.2.

### 5.2 Correct the directory
The owner finds two entries for one person ("Popescu I." and "Popescu Ion").

- An entry can be renamed, given a specialty, clinic and professional code, and merged into another.
- A merge keeps every document and role and removes the other entry.
- A name or code that already belongs to another doctor is refused, not silently merged.
- An entry that no document names can be deleted; one that is named cannot.
- A stamped signature's name and code can be entered by hand.

Status: auto (`trends-doctors`, `structured`); screens: hand.

### 5.3 Which investigations have I had
An ultrasound or an MRI is stored as text on the document that holds it.

- The result appears on that document, and a search for words in it finds the document.
- There is **no** list of investigations over time, and nothing links one ultrasound to the next.

Status: not built beyond the text.

---

## 6. Finding things

### 6.1 Search
The owner searches for "lombar", or filters by date, tag, type or provider.

- A keyword search matches a document's title, type, provider, summary and notes, the text of its
  pages, its extracted values, its measurements' names and its doctors' names.
- A word matches by its start ("lombar" finds "lombară"), accents and case are ignored, and every
  word typed must match.
- Punctuation, quotes and words like OR in the box never cause an error.
- Best matches come first, a hit in the title above one deep in a page.
- The results stay right after the document changes: an edited value, a page read again, a renamed
  doctor, a split or a join.
- Filters combine with the keyword and with each other.
- Results show only the owner's documents.
- Search results show a loose vertebra per result and no spine axis, since they are not yet part of the timeline.

Status: auto (`documents`, `tags`); screens: hand.

---

## 7. Sharing with a doctor

### 7.1 Send a doctor what they need
The owner creates a link scoped to everything, a tag, chosen documents, or a date range, and sends it.

- The link shows only what the scope allows; a scope that cannot be fully worked out is refused at
  creation and serves nothing at read time.
- It expires (default 7 days, at most 30) and can be revoked at once.
- The recipient needs no account and sees text only: no page images, no way to reach anything else.
- Every use is logged, and a guessed token leaves a trace.
- The raw token appears once, when the link is created. After that only its hash is stored.
- Opening the link in a browser shows the documents, not raw JSON.

Status: auto (`share`, `public-share-scoped`, `share-token`).

---

## 8. More than one person

### 8.1 Two users on one instance
- A second user sees none of the first's uploads, documents, fields, measurements, doctors, tags
  or links, and cannot change them by guessing an id: those requests answer "not found".
- The same test name or doctor name for two users is two separate things.
- Deleting a user removes all of their records, and only theirs.

Status: auto (`isolation`, `response-shape`, `cli`).

---

## 9. Running it

### 9.1 Install and first start
The operator follows [docs/setup.md](setup.md) on a fresh Pi.

- The service refuses to start, and says why, if the session secret is missing or weak, if image
  reading is half-enabled, if a Vertex endpoint or region is missing, or if a Google API key is
  set that would send requests to a global host.
- An old-shaped database is refused with a message saying whether it is safe to delete.

Status: auto (`config`, `legacy-database`); a full install on a fresh machine: not yet done.

### 9.2 Back up and restore
- A daily snapshot of the database and a copy of the original files are made; the snapshot is
  never a plain file copy of a live database.
- A restore from the snapshot brings back every record.
- Page images are not backed up; they can be made again from the originals.

Status: auto for making the snapshot (`backup`); a restore to a blank machine: not yet rehearsed.

### 9.3 Where the data goes
- With default settings, only document text (and, for extraction, the names of the tests already
  in the archive) goes to the model provider; with Vertex configured, to the endpoint stated.
- Page images leave only for pages and files the owner chose or that image reading selected, and
  only when both settings are on.
- Nothing about a document goes in an email.

Status: stated in [ARCHITECTURE.md](../ARCHITECTURE.md#egress-what-leaves-the-host); residency at the
provider is checked against the provider's request logs, which has not been done.

---

## Gaps found while writing this

Found by checking each scenario against the code.

Fixed: search covering only titles and summaries; splitting or joining replacing reviewed edits
without asking; the upload type not being checked on the server (and a duplicate leaving a copy
on disk).

Still open:

- **Stamped signatures** (a doctor's name, specialty and code) are images and are not read from
  text, so the signing doctor is often missing until it is entered by hand.
- **Search shows no snippet**, so when a document matches on page text the page does not say where.

## Not covered yet

Things people will reasonably ask for that no scenario above promises: reading **photos** of paper
(only PDFs are read; a phone scanning app that saves a PDF works), exporting everything,
deleting an account from the app itself (today the operator does it), reminders for follow-ups the
documents mention, sharing a chart, and merging two uploads' history. Add a scenario when one is wanted.
