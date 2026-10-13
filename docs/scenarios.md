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

### 1.4 Sign up
Only where the operator has opened registration (it needs a mail provider). A person enters an email
address and a password, and is sent a link.

- Until the link is used the account cannot sign in, and it gets no session.
- The link works once, expires, and is carried in the part of the address the server never sees.
  Asking for another link replaces the old one.
- A taken address, an unknown one and a verified one all get the same answer, so the form cannot be
  used to find out who has an account, and nothing is mailed to an address that is not new.
- A weak password (under 12 characters) or a bad address creates nothing.
- If the mail provider is down the form still answers; it does not crash.
- With registration closed there is no sign-up route at all.
- Requests are rate limited per address and per source, so the form cannot flood an inbox.

Status: auto (`accounts`). Delivery by a real mail provider: real provider, untested.

### 1.5 Change my password
On the Account page, with the current password and the new one twice.

- The current password is required, and a wrong one changes nothing.
- The new password is at least 12 characters.
- Every other session of the owner is signed out; the one they are using stays.

Status: auto (`auth`, `second-factor`).

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
- A file already uploaded is refused as a duplicate and points at the existing one, unless that
  upload failed (see 2.7), in which case it is tried again.
- A file over 200 MB is refused with a reason.
- PDFs, and JPEG or PNG photos, are accepted, judged by the file's contents, not by its name or the
  type the browser reported. Anything else is refused and named on the page, and nothing of it is
  kept on disk or recorded. The type recorded is the detected one.
- A duplicate leaves no second copy on disk.
- A photo is accepted only when image reading is switched on. Otherwise it is refused with the
  reason, the picker offers PDFs only, and nothing is kept.

Status: auto (`upload`).

### 2.3 A photo of a paper report
The owner photographs a letter and uploads the picture.

- The page says, before the upload, that a photo is sent to the model provider (named) to be read.
- The photo is read by the model directly; local OCR is not tried first.
- A photo taken sideways (the phone's orientation flag) is shown and read upright, and a very large
  photo is reduced before it is sent. The original is kept as it was.
- It becomes a one-page upload with the usual title, details and review.
- With image reading off, the owner is told the photo needs it, and nothing leaves the machine.

Status: auto (`photos`, `upload`); the upload and the upright page in the running app: hand;
how well a real model reads a phone photo: real model.

### 2.4 A scan with no text layer
The file is a PDF made by a scanner or a scanning app, so its pages are pictures with no text.

- With the default settings, the page keeps whatever local reading found and nothing leaves the machine.
- With image reading switched on (two settings, both required), only pages with no text layer
  that local OCR could not read confidently are sent to the model, one page per call.
- A page that has a text layer is never sent as an image.
- If the model fails on a page, the page keeps its local reading.

Status: auto (`parser`, `ocr`, `read-page`); quality on real handwriting: real model.

### 2.5 Fix how the pages were grouped
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

### 2.6 A very long document
A 300-page discharge file that is one document.

- Normally the whole document goes to the model in one request, each page under its real page
  number, and nothing is shortened to save money.
- Only when it would not fit the model's window (`SPINE_LLM_CONTEXT_CHARS`, 300,000 characters by
  default) is it split, at page boundaries, into parts that each fit, with no page lost or repeated.
  A single page that alone exceeds the window is cut, and nothing else is.
- The details come from the first part, the tags from all parts, and a repeated field is kept once.
- If any part cannot be read the whole document counts as failed, so it never looks complete when
  it is not.
- A field lands on the page the model named, also for a document that starts after page 1, and on
  the nearest page when the model names one the document does not have.
- Documents are read several at a time (`SPINE_LLM_CONCURRENCY`, 4 by default), and one failing
  does not hide the others.

Status: auto (`reading-limits`, `concurrency`); a real 300-page file: not tried.

### 2.7 The model is unavailable
The provider is down, or its answer is unusable, while a file is being read.

- The upload is marked failed, with the reason, and the page shows it.
- Nothing half-written is left: no documents with missing details, and no old documents removed
  when a file was being read again.
- The original file is kept.
- A failed read of one document's details (as opposed to the whole upload) leaves a document that
  says so and waits in Review.
- The failed row offers **Try again**. It runs the upload again the way it was first read (the
  configured parser, not the model for every page, so nothing is sent off the machine that would not
  have been the first time), and replaces what the failed attempt left only once the new reading has
  succeeded, so a second failure changes nothing.
- Uploading the same file again does the same, instead of being refused as a duplicate of the failed
  one. A file whose earlier upload is done, or still running, is a duplicate as before.
- Try again is for an upload that failed: for any other it is refused, and for another user's it is
  reported as not found.
- A restart that interrupts a reading marks it failed, so it can be tried again too.

Status: auto (`pipeline`, `upload`, `reread`); the Try again button and a failure, then a recovered
provider, then a retry in the running app: hand.

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

### 3.4 A clinic's report, read as it is written
A clinic's "raport medical" or lab bulletin, whose sections are free text.

- A consultation gets what such a report holds: report number, each service performed with its
  result, history split into family, personal, habits and current treatment, symptoms and
  examination, the diagnosis with its ICD code (and what the report left uncoded), and the
  recommendations split into tests, lifestyle advice and medication.
- A lab bulletin is dated by when the sample was collected, not issued, and its values by that date.
- Lab values quoted in a consultation's text become measurements, each with the date it was taken,
  often earlier than the visit; BMI is among the vitals.
- A prescription's medicines show as one group each (drug, dose, frequency, duration).
- The patient's national ID, patient code, phone number and age are never extracted.
- A page footer "1 / 1" after "3 / 3" starts a new document, so two bulletins in one PDF split.
- A document that fails to read still exists and says so, and waits in Review.

Status: auto (`structured`, `continuation`); what a real model produces from real reports: real model.

### 3.5 The review queue
The owner works through what has not been reviewed.

- The queue lists every unreviewed document, each drawn as a loose vertebra (not yet on the spine),
  and says how many are waiting; with none it says so.
- A document opens in edit mode from the queue, in reading mode from the timeline.
- Done saves it and marks it reviewed, and it leaves the queue and joins the timeline's spine as a solid vertebra.
- A document that was edited by a re-read, a split or a join returns to the queue.

Status: auto (`documents`, `document-edit`, `regroup`); screens: hand.

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
- With image reading on, the doctor on a signature stamp (a small picture on the document's last page)
  is added too, with their specialty and professional code, as the document's author. Only the
  stamp is sent, never the page; logos, QR codes and seals are not sent.
- A code is stored only if every character was legible; otherwise the doctor is added without one.
- Reading the document's text again keeps the doctors read from a stamp.
- With image reading off, a photo, or a stamp that is not an embedded picture, no doctor is added
  from a stamp and nothing is sent; the owner can enter them by hand.
- A PDF that is **digitally signed** adds its signer as an author of each document in the file, read
  locally from the certificate (a given name and surname, signature valid), so this needs no image
  reading and sends nothing. A company seal, an invalid signature and the certificate's serial
  number (an identifier of the person, not a professional code) are ignored. Like a stamp, it stays
  when the text is read again.

Status: auto (`structured`, `stamps`, `stamps-flow`); which pictures are chosen, checked on four real
reports by hand; how well a real model reads a stamp, especially a code under a signature: real model.

### 5.2 Correct the directory
The owner finds two entries for one person ("Popescu I." and "Popescu Ion").

- An entry can be renamed, given a specialty, clinic and professional code, and merged into another.
- A merge keeps every document and role and removes the other entry.
- The Doctors page lists entries that are **probably the same person**, for the owner to confirm:
  one name is the other with more words ("Ioana Dumitrescu" and "Dumitrescu Ioana Maria"), or an
  initial stands for a name ("Popescu I." and "Popescu Ion"). Never two entries with different
  specialties, never a single word, and never merged without the owner choosing to.
- "Merge into <fuller name>" merges them; "Not the same" hides that pair on this browser.
- A name or code that already belongs to another doctor is refused, not silently merged.
- An entry that no document names can be deleted; one that is named cannot.
- A signing doctor's name and code can be entered by hand where no stamp was read.

Status: auto (`trends-doctors`, `structured`); screens: hand.

### 5.3 A doctor's professional code
The code printed beside a signature ("Cod parafa X12345") identifies a person better than a name does.

- A code is stored as letters and digits only, upper case, and the label is dropped; something too
  short to identify anyone (under 4 characters) is not a code.
- A doctor read with a code already held by another entry is that doctor, whatever the name looked
  like; a code only fills a blank and never replaces one.
- Two doctors cannot hold the same code; typing one that is taken is refused and says to merge.
- A merge hands the code to the entry that stays if it has none.
- The code is editable on the doctor's page, and cleared by emptying the box.

Status: auto (`structured`, `trends-doctors`); screens: hand.

### 5.4 Which investigations have I had
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
- Each result shows a short excerpt around the match with the matched words highlighted, so a
  document found through its page text, a value or a doctor says why it matched.
- The results stay right after the document changes: an edited value, a page read again, a renamed
  doctor, a split or a join.
- Filters combine with the keyword and with each other.
- Results show only the owner's documents.
- Search results show a loose vertebra per result and no spine axis, since they are not yet part of the timeline.

Status: auto (`documents`, `tags`); screens: hand.

### 6.2 Browse the timeline
The owner opens the Timeline to see their history.

- Documents are grouped by year, newest first, with those without a date under "Unknown date".
- Each year is a spine: a reviewed document is a solid vertebra, an unreviewed one an amber outline.
- A tile shows the type, the title (never the file name), the provider, the summary, the date and
  its pages, and opens the document in reading mode.
- The list can be narrowed by type and by reviewed or not. The whole archive is shown: the page fetches it
  in batches of 200, though the API itself returns at most 500 at a time.

Status: auto (`documents`, `document-paging`); the look, and the phone layout: hand.

### 6.3 Tags
- Every account starts with its own set of tags (allergy, chronic, vaccine and so on), and a tag
  is private to its account.
- Tags are edited on the document page in Review, comma separated, and the extraction suggests them.
- Search can be narrowed to one tag, and a share link can be scoped to one.

Status: auto (`tags`, `isolation`, `share`).

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

### 9.2 Manage accounts from the command line
The operator creates and looks after accounts without a mail provider.

- `create-user` makes an account and prints a generated password once; it is never stored. A
  password can be given on standard input instead, and a short one is refused. A duplicate email
  (in any case) or something that is not an email is refused.
- `set-password` changes it and ends that person's sessions; `reset-link` prints a one-time link
  that works without a mailer; `disable-2fa` turns off a lost second factor and ends their sessions.
- `delete-user` shows what it would remove and only does it with `--yes`; it removes the person's
  records, page images, originals and the backup copy of their originals, and nobody else's.
- `list-users` lists accounts and never prints any password material.

Status: auto (`cli`, `accounts`, `isolation`).

### 9.3 Back up and restore
- A daily snapshot of the database and a copy of the original files are made; the snapshot is
  never a plain file copy of a live database.
- A restore from the snapshot brings back every record.
- Page images are not backed up; they can be made again from the originals.

Status: auto for making the snapshot (`backup`); a restore to a blank machine: not yet rehearsed.

### 9.4 Where the data goes
- With default settings, only document text (and, for extraction, the names of the tests already
  in the archive) goes to the model provider; with Vertex configured, to the endpoint stated.
- Page images leave only for pages and files the owner chose or that image reading selected, and
  only when both settings are on.
- Nothing about a document goes in an email.

Status: stated in [ARCHITECTURE.md](../ARCHITECTURE.md#egress-what-leaves-the-host); residency at the
provider is checked against the provider's request logs, which has not been done.

---

## 10. On a phone

### 10.1 Use it from a phone
- The screens fit a 390-pixel-wide phone with no sideways scrolling.
- Navigation collapses to a menu, and the upload page offers the file picker instead of drag and drop.
- The spine, document page, trends, doctors, search and grouping screens use the same data as on a
  desktop, laid out in one column.

Status: hand (no sideways scrolling checked in a headless browser at phone width for the upload,
review, trends, trend, doctors, document and document-edit screens; the rest were looked at, not
measured). Real devices, touch targets and the camera flow: not tried.

---

## Gaps found while writing this

Found by checking each scenario against the code.

Fixed: signature stamps not being read (now read as small crops when image reading is on);
search covering only titles and summaries; splitting or joining replacing reviewed edits
without asking; the upload type not being checked on the server (and a duplicate leaving a copy
on disk); a failed upload that could not be retried without image reading; and the same doctor
appearing twice under two spellings with no help finding them (now suggested for confirmation); and
search results not saying why they matched (now an excerpt with the match highlighted).

Still open:



## Not covered yet

Things people will reasonably ask for that no scenario above promises: several photos as one
document (each photo is its own upload), other photo formats such as HEIC or WebP, exporting everything,
deleting an account from the app itself (today the operator does it), reminders for follow-ups the
documents mention, sharing a chart, and merging two uploads' history. Add a scenario when one is wanted.
