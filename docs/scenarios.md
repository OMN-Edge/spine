# Scenarios

How Spine is meant to be used, with the checks that say a scenario works. Not a formal specification: each scenario is a goal, the steps a person takes, and what must be true at the end. If a scenario and the app disagree, one of them is wrong; fix whichever it is.

**People:** the **owner** (you, with an account), a **recipient** (a doctor with a share link and no account), the **operator** (whoever runs the Pi), and a **second user** (another account on the same instance, who must never see the owner's records).

**Status** shows how much each scenario has been checked:

- **auto**: automated tests cover it (named where useful).
- **hand**: checked by hand in the running app, with the model replaced by a fake server.
- **live**: run against the real model and PDFs by the integration suite (`npm run test:integration`, [testing.md](testing.md)), with the file named. What a real model returns is checked for what must hold whatever its words; wording and screens are not.
- **real model**: depends on what a real provider returns and no live flow covers it yet.
- **not built**: described because it is wanted, but it does not exist.

---

## 1. Getting in

### 1.1 Sign in
The owner opens the site, enters their email and password, and lands on the Timeline.

- A right email and password signs in; a wrong password and an unknown email give the same answer in the same time.
- Repeated failures are slowed down, per source and across the whole instance.
- With two-factor on, the password alone does not sign in: a six-digit code (or a recovery code, once) is also needed.
- Every page and API route except the login pages and a share link refuses a visitor with no session.

Status: auto (`auth`, `second-factor`, `isolation`).

### 1.2 Forgotten password
The owner asks for a reset. With a mailer they get a link by email; without one, the operator produces a one-time link.

- Asking for a reset looks the same whether or not the address has an account.
- The link works once, and carries its token in the part of the URL the server never sees.
- A new password signs out the owner's other sessions.
- The mail has no document content and no clinical words.
- For an account with a vault the page asks for the **recovery kit** and a new password: the kit opens the account key on the device, which is sealed again under the new password, and the records stay readable. A mistyped kit is caught by its check characters; a kit from another account does not open this one.
- Without the kit the page says that the records cannot be opened by anyone, and offers to start empty: every stored object is erased, and a new vault and a new kit are made. Nothing is erased before the person has ticked that they understand.
- The link alone never gives access to records: the server holds only the key sealed under the kit.

Status: auto (`accounts`, `mail`, `cli`, `vault`, and `web/src/e2e/vault.e2e.test.ts` for the kit and the erase path). Brevo delivery itself: real provider, untested. The reset page in a browser: hand, not yet done.

### 1.3 Turn on two-factor
The owner scans a QR code, confirms one code, and saves ten recovery codes.

- A wrong first code does not turn it on.
- Each recovery code works once.
- The same code cannot be used twice, even within its time window.
- A lost phone and lost codes are fixed by the operator, not by the owner.

Status: auto (`totp`, `second-factor`).

### 1.4 Sign up
Only where the operator has opened registration (it needs a mail provider). A person enters an email address and a password, and is sent a link.

- Until the link is used the account cannot sign in, and it gets no session.
- The link works once, expires, and is carried in the part of the address the server never sees. Asking for another link replaces the old one.
- A taken address, an unknown one and a verified one all get the same answer, so the form cannot be used to find out who has an account, and nothing is mailed to an address that is not new.
- A weak password (under 12 characters, or a common word or pattern) is refused on the device, before anything is sent; a bad address creates nothing.
- The keys are made on the device, and the **recovery kit** is shown, printable and saveable, before the account is created: a person is asked to say it is stored somewhere safe, and no account exists whose kit was not shown. The page says plainly that Spine cannot recover the records.
- The server receives a value derived from the password, never the password, and sealed keys it cannot open.
- If the mail provider is down the form still answers; it does not crash.
- With registration closed there is no sign-up route at all.
- Requests are rate limited per address and per source, so the form cannot flood an inbox.

Status: auto (`accounts`, `vault`, `web/src/crypto`, `web/src/e2e/vault.e2e.test.ts`). Delivery by a real mail provider: real provider, untested. The sign-up screens in a browser: hand, not yet done.

### 1.5 Change my password
On the Account page, with the current password and the new one twice.

- The current password is required, and a wrong one changes nothing.
- The new password is at least 12 characters and not easy to guess, checked on the device.
- The same keys are sealed under the new password on the device; the records are not touched and stay readable, and the old password stops opening them.
- Every other session of the owner is signed out; the one they are using stays.
- A new recovery kit can be made from the same page; the old kit stops working the moment the new one is stored, and the new one is shown before it is stored.

Status: auto (`auth`, `second-factor`, `vault`, `web/src/crypto`). In a browser: hand, not yet done.

### 1.6 An account with no vault
An account the operator made, or one from before the vault, signs in and, after agreeing to the texts, is asked to choose a master password and shown its recovery kit before anything else.

- The password it signed in with is replaced by the new one; nothing about the new one is sent.
- The operator cannot choose a password for an account that has a vault; `set-password` refuses, and the way back is a reset link and the kit.

Status: auto (`vault`, `cli`). In a browser: hand, not yet done.

---

## 2. Getting documents in

### 1.y Passkeys
- On the account page, Add a passkey on this device asks the device for a fingerprint, face or PIN and saves a key for this site; the sign-in page then offers Sign in with a passkey, which needs no password and no code.
- Adding and removing ask for the password again and are mailed. Removing a passkey on one device does not remove it on another.
- A passkey made for one address does not work at another, and cancelling the device's sheet is not an error.

Status: auto (`passkeys`); the device's own sheet: hand.

### 1.x Agreeing, and leaving
- Signing up asks for two separate ticks: consent to the use of health data (with the privacy notice), and acceptance of the terms. Neither is implied by the other and the account is not made on one.
- An account the operator made, or any account after a text changed, sees a screen asking for what is missing before anything else, and can leave from it by deleting the account.
- The privacy notice, the terms and what Spine is for are public pages, linked from every sign-in page.
- The account page lists which features send what to which model provider, exports everything, and deletes the account after the password is typed again and the address is written out.

Status: auto (`own-account`, `accounts`); screens: hand.

### 2.1 Scan paper with the camera
- Scan opens the camera (or a phone's own camera, or a chosen photo where there is no camera to open), outlines the page it finds in green and takes the picture when the page has been still for a moment, or when the button is pressed.
- The four corners can be moved by hand; the page is then straightened and, unless turned off for that page, cleaned up (shadows and fading flattened, handwriting kept). All of it happens on the device.
- Pages are taken one after another, then reviewed: reordered, removed, their corners redone, and saved as one document. The photos as taken are kept beside it.
- Where neither image reading nor local OCR is switched on, Scan says so instead of filling the archive with pages nobody can search.

Status: auto (`scan`, web algorithms; `photo-set`); screens and the camera itself: hand.

### 2.0 Look around before uploading
- On an empty timeline, Explore with sample records adds five invented documents (English or Romanian, by the interface language) about nobody: a consultation, two blood tests with the same five tests, a prescription and a chest X-ray. Nothing is read by a model and nothing leaves the host.
- A banner says they are samples. Remove the sample records takes away exactly them, not anything uploaded since.
- They are that account's own records: they can be searched, charted, shared and edited like any other, and no other account sees them.

Status: auto (`demo`); screens: hand.


### 2.1 Upload a PDF that holds several documents
Status: live (`journey.it.ts`: a six-page export of four documents is read by the real text reader and model; titles, dates, providers, results and doctors come out as printed).

The owner drops a 40-page scan on the Upload page. It was a stack of letters, results and a discharge note.

- The upload is accepted at once, and the page shows progress while it is read.
- When it finishes, the upload is listed under the documents it became, each with a title (the one printed on it, else a short generated one), never the file name.
- A page numbered "1 / 1" after one numbered "3 / 3" starts a new document; a page numbered "2 / 3" continues the one before.
- If the model cannot be reached, the upload is marked as failed with the reason; the original file is kept and nothing is half-written.
- Every document starts **unreviewed**, and the upload starts with its grouping **unconfirmed** (see 2.5): its documents are listed on the Upload page but are not yet in the timeline, search, shares or trends.

Status: auto (`pipeline`, `continuation`, `upload`, `grouping-confirmation`); boundary quality on real scans: real model.

A file can also be attached in the chat instead (12.1), and the app reports there when it is read (12.2).

### 2.2 The same file twice, or a file that is not a document
- A file already uploaded is refused as a duplicate and points at the existing one, unless that upload failed (see 2.7), in which case it is tried again.
- A file over 200 MB is refused with a reason.
- PDFs, and JPEG or PNG photos, are accepted, judged by the file's contents, not by its name or the type the browser reported. Anything else is refused and named on the page, and nothing of it is kept on disk or recorded. The type recorded is the detected one.
- A duplicate leaves no second copy on disk.
- A photo is accepted only when image reading is switched on. Otherwise it is refused with the reason, the picker offers PDFs only, and nothing is kept.

Status: auto (`upload`).

### 2.2b Add a zip

A zip goes in the same Upload box. What it is, is told by what is inside, not by its name.

- A zip with a Spine `manifest.json` (an export, see 9.5) is **restored**: the files come back with their pages, grouping, hidden pages, details, results, doctors, tags and notes, **without the AI** and without sending anything anywhere. Page images are made again, so a big archive takes a while and each file shows as reading until done.
- Any other zip is a folder of files: each PDF in it (and each photo, if photos are allowed) is added as if sent alone and read the usual way. Hidden files, `__MACOSX`, and things that are not PDFs are skipped and named. A Word or Excel file, which is also a zip, is refused as not a PDF.
- The page says what the zip was and how many files were added, restored, already there or skipped.
- Duplicates are recognised: a file already held (same checksum) is skipped, and so is a document whose text matches one already held, even if its file was cut differently (a single exported document). If one file holds both documents already there and new ones, the new ones are restored and the others are kept out of sight (their pages hidden) rather than appearing twice.
- A manifest that is damaged, or from a newer version, is refused with that reason; one that does not fit its file leaves nothing behind and the upload shows as failed.

Status: auto (`archive`); restore of a very large archive on a Pi: not tried.

### 2.3 A photo of a paper report
The owner photographs a letter and uploads the picture.

- The page says, before the upload, that a photo is sent to the model provider (named) to be read.
- The photo is read by the model directly; local OCR is not tried first.
- A photo taken sideways (the phone's orientation flag) is shown and read upright, and a very large photo is reduced before it is sent. The original is kept as it was.
- It becomes a one-page upload with the usual title, details and review.
- With image reading off, the owner is told the photo needs it, and nothing leaves the machine.

Status: auto (`photos`, `upload`); the upload and the upright page in the running app: hand; how well a real model reads a phone photo: real model.

### 2.4 A scan with no text layer
The file is a PDF made by a scanner or a scanning app, so its pages are pictures with no text.

- With the default settings, the page keeps whatever local reading found and nothing leaves the machine.
- With image reading switched on (two settings, both required), only pages with no text layer that local OCR could not read confidently are sent to the model, one page per call.
- A page that has a text layer is never sent as an image.
- If the model fails on a page, the page keeps its local reading.

Status: auto (`parser`, `ocr`, `read-page`); quality on real handwriting: real model.

### 2.5 Fix how the pages were grouped, and confirm it
Every finished upload asks the owner to check how its pages were grouped into documents; this step is not optional. The upload shows "Check the grouping" on the Upload page and the Timeline says how many uploads are waiting. Until the owner presses **Grouping is right**, its documents are out of the timeline, search, review queue, shares, trends and related documents, cannot be marked reviewed (the document page says why and links back), and are not looked at for links or embedded. Uploads made before this step existed and restores from an export count as confirmed.

- Pressing **Grouping is right** puts the documents in the timeline and the review queue and starts looking for their links. It is disabled while there are changes waiting for Done.
- If the grouping is wrong, the owner fixes it first (below, or, for an export whose pages are mixed, by asking the assistant, 12.4) and then confirms. A confirmed upload stays confirmed even if it is regrouped afterwards.

The owner opens an upload's **Pages and grouping**. Pages 11 and 12 belong with the document before them.

- Pages show as thumbnails grouped by document; clicking a page opens a large preview.
- A split between any two pages of a document, and a join between two neighbouring documents, are each one action.
- Neither reads anything yet. The grouping is saved, the affected documents go back to review and are marked "Changed, waiting for Done", and a bar counts them. When the owner has finished grouping, **Done** reads each changed document once, from its pages' text; the pages themselves are not read again. If a document that was reviewed is affected, the screen says so first, because reading it again replaces the owner's edits.
- Afterwards the screen says whether the reading worked. If it fails for a document, the grouping stands and Done tries that one again.
- Values, doctors and fields move with the pages they were read from.
- Any page can be **dragged** to another place: before another page of its document (to reorder), into another document, or into the strip between documents to become a document of its own. The page keeps what was read from it (its fields and results go with it), pages are numbered again in their new order, and the documents it leaves and joins go back to review and wait for Done. A page that was moved shows a small star, and hovering says where it is in the file. A document left with no pages is folded into where its last page went.
- **Hide** under a page sets that page aside, and **Hide document** sets a whole document aside, however many pages it has. A hidden page is kept (with its image and text) but is left out of the document's view, search and the next reading. A document with every page hidden is left out of the timeline, search, review, share links, a doctor's list and the trends; on this screen it is dimmed with a banner and a **Show all pages** button, and the upload's card on the Upload page counts it ("1 hidden") so it can be opened and brought back.
- Done skips a document with every page hidden, since there is nothing to read; it does not call that a failure.

Status: auto (`regroup`, `structured`, `page-hiding`, `grouping-confirmation`); screens: hand.

### 2.6 A very long document
A 300-page discharge file that is one document.

- Normally the whole document goes to the model in one request, each page under its real page number, and nothing is shortened to save money.
- Only when it would not fit the model's window (`SPINE_LLM_CONTEXT_CHARS`, 300,000 characters by default) is it split, at page boundaries, into parts that each fit, with no page lost or repeated. A single page that alone exceeds the window is cut, and nothing else is.
- The details come from the first part, the tags from all parts, and a repeated field is kept once.
- If any part cannot be read the whole document counts as failed, so it never looks complete when it is not.
- A field lands on the page the model named, also for a document that starts after page 1, and on the nearest page when the model names one the document does not have.
- Documents are read several at a time (`SPINE_LLM_CONCURRENCY`, 4 by default), and one failing does not hide the others.

Status: auto (`reading-limits`, `concurrency`); a real 300-page file: not tried.

### 2.7 The model is unavailable
The provider is down, or its answer is unusable, while a file is being read.

- The upload is marked failed, with the reason, and the page shows it.
- Nothing half-written is left: no documents with missing details, and no old documents removed when a file was being read again.
- The original file is kept.
- A failed read of one document's details (as opposed to the whole upload) leaves a document that says so and waits in Review.
- The failed row offers **Try again**. It runs the upload again the way it was first read (the configured parser, not the model for every page, so nothing is sent off the machine that would not have been the first time), and replaces what the failed attempt left only once the new reading has succeeded, so a second failure changes nothing.
- Uploading the same file again does the same, instead of being refused as a duplicate of the failed one. A file whose earlier upload is done, or still running, is a duplicate as before.
- Try again is for an upload that failed: for any other it is refused, and for another user's it is reported as not found.
- A restart that interrupts a reading marks it failed, so it can be tried again too.

Status: auto (`pipeline`, `upload`); the Try again button and a failure, then a recovered provider, then a retry in the running app: hand.

---

## 3. Checking what was read

### 3.1 Review a document
The owner opens a document from the Timeline or the review queue. Reading mode shows the details, doctors, measurements and fields beside the scan. **Review** makes the same page editable; **Done** saves and marks it reviewed.

- Every part is editable: title, date, type, provider, tags, summary, notes, doctors, measurements (name, value, unit, range, date) and each extracted field.
- Clicking a field or measurement shows its page and, where there is an exact box, the box it was read from. It stays until another is clicked, the same one is clicked again, or Escape is pressed; nothing follows the mouse.
- Done saves everything in one step. If anything is invalid, nothing is saved and the problem is shown.
- A measurement's flag (low, high, normal) is worked out again from its value and range on save.
- Fields that belong together, such as one medicine's drug, dose and frequency, show together.
- A document opened from the review queue starts in edit mode; from the Timeline, in reading mode.
- A document that has been edited, regrouped or read again shows up as unreviewed.
- **What the owner sets stays set.** Reading a document again fills in what the owner has not touched. A title, date, provider, type or summary the owner changed keeps their value (clearing it hands it back to the reading). A field or a result the owner added or changed stays, and the new reading does not repeat it: it holds its place, the same label in the same group, or the same test on the same day. A field or result the owner removed is not brought back, unless a later reading says something different. Tags and doctors are not kept: a new reading replaces them. The owner's notes are kept, and are given to the model when it reads again, as context only.

Status: auto (`document-edit`, `structured`, `owner-edits`); screens: hand.

### 3.2 A page the machine could not read
The owner opens a document, sees an empty text view for page 3, and asks for that page to be read with AI.

- The button is offered per page, never per document, and only when image reading is switched on.
- Only the pages chosen leave the machine, and the owner is told that before it happens.
- The page's text replaces the empty one only if the new reading succeeds, and the document's details are then extracted again.
- A page marked as read by a model says so, and nothing is highlighted on it; a field read from it shows the page it came from.

Status: auto (`ai-reading`, `read-page`); quality: real model.

### 3.3 The details look wrong, but the text is right
Above the scan, a small label says how the page was read ("Extraction: Text layer", OCR, AI or Not read). Beside the Review button, a **Read again** menu has the two ways to read again, kept apart: **Read page with AI** (this page's image goes to a model, then the document's details are extracted again) and **Read whole document** (the document's pages are read again the way an upload reads them on this server, grouping kept, then its details are extracted again). Choosing one shows what it will do and a model picker, and nothing runs until it is confirmed.

- It replaces fields, measurements and doctors only if the new answer is valid; otherwise the old ones stay.
- The document goes back to unreviewed.

Status: auto (`ai-reading`).

### 3.4 A clinic's report, read as it is written
A clinic's "raport medical" or lab bulletin, whose sections are free text.

- A consultation gets what such a report holds: report number, each service performed with its result, history split into family, personal, habits and current treatment, symptoms and examination, the diagnosis with its ICD code (and what the report left uncoded), and the recommendations split into tests, lifestyle advice and medication.
- A lab bulletin is dated by when the sample was collected, not issued, and its values by that date.
- Lab values quoted in a consultation's text become measurements, each with the date it was taken, often earlier than the visit; BMI is among the vitals.
- A prescription's medicines show as one group each (drug, dose, frequency, duration).
- The patient's national ID, patient code, phone number and age are never extracted.
- A page footer "1 / 1" after "3 / 3" starts a new document, so two bulletins in one PDF split.
- A document that fails to read still exists and says so, and waits in Review.

Status: auto (`structured`, `continuation`); what a real model produces from real reports: real model.

### 3.5 The review queue
The owner works through what has not been reviewed.

- The queue lists every unreviewed document, each drawn as a loose vertebra (not yet on the spine), and says how many are waiting; with none it says so.
- A document opens in edit mode from the queue, in reading mode from the timeline.
- Done saves it and marks it reviewed, and it leaves the queue and joins the timeline's spine as a solid vertebra.
- A document that was edited by a re-read, a split or a join returns to the queue.

Status: auto (`documents`, `document-edit`, `regroup`); screens: hand.

---

## 4. Following my health over time

### 4.1 Watch one test
The owner opens **Trends**, picks "Hemoglobin", and sees a chart.

- Every test with a value is listed with its latest value and a low/high mark.
- The chart is a line through the values in date order, the newest reference range as a band, each point coloured low/high/in range and linking to its document. A table of the same values sits beside it.
- A value in a different unit, a value that is not a number (`<0.5`, `pozitiv`), a value with no date, and a repeat of a value already drawn are listed in the table but not drawn, and the page says so.
- A unit written two ways (`mUI/mL`, `mIU/mL`; `µg`, `ug`) counts as one unit.
- A value known only to the month ("03.2026") is drawn at that month and marked "month only".
- Lab results are dated by when the sample was collected, not issued.
- Values quoted inside a consultation ("TSH 3.10 on 03.2026") join the same trend, with their own date.

Status: auto (`trends-doctors`, `structured`); chart look and phone layout: hand; what a real model extracts from real reports: real model.

### 4.2 Two labs call a test different things
Regina Maria prints "TSH", another lab "Hormon tireostimulant". The owner opens one and chooses "same test as" the other.

- The values move to the chosen test, and the old name stops being listed.
- A document read later that uses the old name is filed under the chosen one.
- A new reading is told the names already in the archive and asked to reuse one when it is the same test.
- Nothing is merged without the owner choosing it, and a merge cannot touch another user's tests.
- Undoing a merge is by editing the values; there is no undo button.
- A test can also be renamed everywhere (typing the name of another test merges them) or have its values deleted, from the Library (6.4).

Status: auto (`test-names`); screens: hand; whether a real model reuses names well: real model.

### 4.3 Something is out of range
- A value outside its printed range shows as high or low everywhere it appears (the document, the list, the chart).
- The range used is the one printed for the patient, not the other groups listed beside it.
- A value with a printed flag but no range keeps the printed flag.

Status: auto (`structured`); the range choice on real reports: real model.

---

### 4.x Group documents into episodes
- Open Episodes. Spine suggests groups of documents that may belong together: ones linked to each other, and ones from the same provider within two weeks. A suggestion has no title of its own; it is shown as the provider and the dates.
- Confirm a suggestion, or say it is not an episode (it is not suggested again). Rename a confirmed episode, take a document out, add one, or remove the episode. Or make one by hand: tick the documents.
- A document is in one episode at a time: putting it in another takes it out of the first.
- The timeline can be narrowed to one episode, and each document says which episode it is in. Facility and specialty narrow the timeline and the search the same way.
- A share link can name episodes; it then shares what they hold when it is opened (7.x).
- Episodes travel in the whole export and come back with a restore.

Status: auto (`episodes`, `archive`).

## 5. People

### 5.1 The doctors list grows by itself
Each reading adds the doctors a document names, with a role: wrote it, prescribed, referred, mentioned.

- "Dr. Popescu Ion", "POPESCU ION" and "Ion Popescu" are one entry; so are "Ioana-Maria" and "Ioana Maria".
- Two doctors with the same professional code are one entry whatever the spelling; a code is filled in once and never replaced.
- The same doctor on a hundred documents is one entry with a count and a last-seen date.
- The patient is never listed as a doctor, and the national ID, patient code and phone are never extracted.
- With image reading on, the doctor on a signature stamp (a small picture on the document's last page) is added too, with their specialty and professional code, as the document's author. Only the stamp is sent, never the page; logos, QR codes and seals are not sent.
- A code is stored only if every character was legible; otherwise the doctor is added without one.
- Reading the document's text again keeps the doctors read from a stamp.
- With image reading off, a photo, or a stamp that is not an embedded picture, no doctor is added from a stamp and nothing is sent; the owner can enter them by hand.
- A PDF that is **digitally signed** adds its signer as an author of each document in the file, read locally from the certificate (a given name and surname, signature valid), so this needs no image reading and sends nothing. A company seal, an invalid signature and the certificate's serial number (an identifier of the person, not a professional code) are ignored. Like a stamp, it stays when the text is read again.

Status: auto (`structured`, `stamps`, `stamps-flow`); which pictures are chosen, checked on four real reports by hand; how well a real model reads a stamp, especially a code under a signature: real model.

### 5.2 Correct the directory
The owner finds two entries for one person ("Popescu I." and "Popescu Ion").

- An entry can be renamed, given a specialty, clinic and professional code, and merged into another.
- A merge keeps every document and role and removes the other entry.
- The Doctors page lists entries that are **probably the same person**, for the owner to confirm: one name is the other with more words ("Ioana Dumitrescu" and "Dumitrescu Ioana Maria"), or an initial stands for a name ("Popescu I." and "Popescu Ion"). Never two entries with different specialties, never a single word, and never merged without the owner choosing to.
- "Merge into <fuller name>" merges them; "Not the same" hides that pair on this browser.
- A name or code that already belongs to another doctor is refused, not silently merged.
- An entry that no document names can be deleted; one that is named cannot.
- A signing doctor's name and code can be entered by hand where no stamp was read.

Status: auto (`trends-doctors`, `structured`); screens: hand.

### 5.3 A doctor's professional code
The code printed beside a signature ("Cod parafa X12345") identifies a person better than a name does.

- A code is stored as letters and digits only, upper case, and the label is dropped; something too short to identify anyone (under 4 characters) is not a code.
- A doctor read with a code already held by another entry is that doctor, whatever the name looked like; a code only fills a blank and never replaces one.
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

- A keyword search matches a document's title, type, provider, summary and notes, the text of its pages, its extracted values, its measurements' names and its doctors' names.
- A word matches by its start ("lombar" finds "lombară"), accents and case are ignored, and every word typed must match.
- Punctuation, quotes and words like OR in the box never cause an error.
- Best matches come first, a hit in the title above one deep in a page.
- Each result shows a short excerpt around the match with the matched words highlighted, so a document found through its page text, a value or a doctor says why it matched.
- The results stay right after the document changes: an edited value, a page read again, a renamed doctor, a split or a join.
- Filters combine with the keyword and with each other.
- Results show only the owner's documents.
- Search results show a loose vertebra per result and no spine axis, since they are not yet part of the timeline.

Status: auto (`documents`, `tags`); screens: hand.

### 6.2 Browse the timeline
The owner opens the Timeline to see their history.

- Documents are grouped by year, newest first, with those without a date under "Unknown date".
- Each year is a spine: a reviewed document is a solid vertebra, an unreviewed one an amber outline.
- A tile shows the type, the title (never the file name), the provider, the summary, the date and its pages, and opens the document in reading mode.
- The list can be narrowed by type and by reviewed or not. The whole archive is shown: the page fetches it in batches of 200, though the API itself returns at most 500 at a time.

Status: auto (`documents`, `document-paging`); the look, and the phone layout: hand.

### 6.3 Tags
- Every account starts with its own set of tags (allergy, chronic, vaccine and so on), and a tag is private to its account.
- A tag is kept in one form however it arrives (trimmed, lower case), so "Cardiology" typed by hand and "cardiology" suggested by the model are one tag.
- Tags are edited on the document page in Review, comma separated, and the extraction suggests them, preferring the account's existing tags and adding a new one only when none fits.
- Search can be narrowed to one tag, and a share link can be scoped to one, picked from a dropdown.
- The Library (6.4) lists each tag with how many documents carry it, and renames, merges and removes them.

Status: auto (`tags`, `management`, `isolation`, `share`).

### 6.4 Tidy what the AI extracted
The model names things as it reads them, so one clinic, one tag or one test can arrive spelled several ways. The Library has a tab each for tags, providers (the clinic and laboratory on a document) and tests, beside the doctors list.

- Each entry shows how many documents or values it holds, and can be renamed. Giving it the name another entry already has merges the two; nothing is merged unless the owner types that name.
- Removing a tag takes it off every document and out of the list; removing a provider clears it on those documents; deleting a test deletes its values. The documents stay, and each says what it will do before it happens.
- A share link that uses a tag follows a rename or a merge. After the tag is removed the link shares nothing rather than something wider.
- Renaming a test files later documents that use the old name under the new one.
- Another account's entries are never listed, changed or reachable by id (404).

Status: auto (`management`, `isolation`); screens: not yet checked by hand.

### 6.5 See what belongs with this document
On a document page, Related documents lists other documents in the archive that go with it, each with why.

- The same test: a TSH from another lab, whatever it calls the test. The same doctor. Why is written under each.
- Tags or a provider alone do not make two documents related.
- Where embeddings are on, documents that read alike are added (a consultation about the same condition, a report in the other language), and the list fills in a moment after a new document is added.
- Documents the owner set aside are never listed, and another account's never are.

Status: auto (`similarity`); whether a real model's idea of alike is useful: real model.

### 6.6 Find a document by what it means
Where embeddings are on, Search offers "also find documents that mean the same". Typing "low iron" can find a report that says "deficit de fier"; the words still work for exact things like a code or a value.

- Results from words and meaning are merged; a document both find comes first.
- The filters are for the word search and are hidden while this is on.
- With embeddings off, the option is not shown and nothing is sent anywhere.

Status: auto (`similarity`); quality: real model.

### 6.7 See the chain of care around a document
On a document page, Care chain shows the consultations and tests around it as a timeline by date, the document itself marked. Under each document it says how it connects to an earlier one: "requested by", "follow-up of", "same episode as".

- When the owner confirms an upload's grouping, and after a document is read again, the app looks for links in the background. Nothing is searched before the grouping is confirmed, so links are never judged against a grouping that may still change. A consultation that recommended tests and the laboratory report that followed come up as suggestions, marked "suggested", with Confirm and Not related.
- The app only suggests when the data points to a candidate (the same test or doctor, a laboratory or imaging document within 90 days after a consultation); a conservative model then decides. A request never points backwards in time.
- Not related removes the suggestion for good: that pair is not suggested again. Confirm keeps it; Remove on a confirmed link takes it away.
- Look for links again asks for a new search of this document; it replaces only the waiting suggestions for the pairs it looks at again, never what was confirmed, added or dismissed, and never a suggestion about a pair it did not look at.
- The notes the owner wrote on a document are shown to the model with it, as context, and are also given to the model when the document is read again (they are never a source of values and are kept through a re-reading).
- Add a link lets the owner connect two documents by hand with one of five relations and a search for the other document. It works even when the server has linking switched off (`SPINE_LINKING=off`), in which case the card says so and offers no search.
- A document the owner set aside, or another account's, is never in a chain, and deleting a document removes its links.

Status: auto (`linking`, `llm-link-labels`); live (`model-seams.it.ts`: a consultation that recommended a blood count and a lipid profile is linked to the report that answers it, in the right direction, as a proposal); how often a real model is wrong across many documents: real model; screens: not yet checked by hand.

### 6.8 Ask a question of my records
A round **Ask** button sits in the corner of every page. It opens a panel beside the page (there is no entry for it in the menu); the owner types a question in plain words and gets an answer built only from their own documents, and the conversation follows them from page to page.

- The panel says what page the owner is on. On a document page, "what does this mean?" or "is this value normal?" is about the document on screen, and about the field or result they have selected. On the Timeline or Search it knows what is listed and which filters are on; on an upload's grouping screen it knows the pages and documents and whether the grouping is confirmed.
- The model decides what to look up: it searches the documents, opens the ones it needs, reads a test's values over time, follows a consultation to the tests it asked for. - The answer is formatted (paragraphs, lists, bold) and cites its sources as small numbers in the text, with the numbered sources listed below it by document title and, for the document on screen, the part of it. Where the answer comes from a part of the document on screen, the link goes to that part: "Measurements", "Extracted fields", "Summary", "Notes", "Doctors", "Care chain"; the page scrolls there and the section is lit for a moment. On a phone the panel closes when a link is followed.
- When no document matches, it says so. When the documents do not contain the answer, it says that, rather than guessing. It does not diagnose or advise treatment.
- It reads, and it can **prepare** changes: a share link, a note, a correction, tags, a connection, a merge of duplicates. A prepared change is a card the owner confirms or cancels; nothing is changed until Confirm (section 12).
- The panel says the answer is a reading of the documents, not medical advice, and what each question sends.
- **Conversations are kept.** Each is saved in the owner's archive with its answers' sources. The **History** button lists them, most recent first, with the date and how many messages; picking one reopens it to continue (even after a reload or on another device). **New conversation** starts another and leaves the old one in the history. A conversation is deleted from History (a second click confirms), or all of them at once; they also go with the account. A question that failed is not saved. A conversation holds at most 200 messages, after which the panel asks for a new one, and only the 200 most recent conversations are kept.
- Another account's conversations are never listed or opened. They are not part of an export and a share link cannot reach them.
- Documents set aside, in an upload whose grouping is not confirmed (other than the one the owner has open), or belonging to another account are never used. A share recipient has a chat of their own, limited to what the link shares (7.3). With `SPINE_CHAT=off` there is no button. If the model cannot look things up, or the lookup fails, it answers from a fixed set of documents instead.

Status: auto (`chat`, `chat-agent`); live (`chat-qa.it.ts`: values and their change, following a consultation to its tests, "this" on a document page, no invention for a test never done, no treatment advice, a follow-up in the same conversation); screens: not yet checked by hand.

---

## 7. Sharing with a doctor

### 7.1 Send a doctor what they need
The owner creates a link scoped to everything, a tag, chosen documents, or a date range, and sends it. Making one: a tag is picked from a dropdown of the account's tags; documents are picked from a searchable list with checkboxes; a date range is two dates. The form says how many documents the link would share and will not create one that is incomplete. Each link in the list says what it shares.

- The link shows only what the scope allows; a scope that cannot be fully worked out is refused at creation and serves nothing at read time.
- It expires (default 7 days, at most 30) and can be revoked at once.
- The recipient needs no account. They get the archive's own timeline of what was shared (grouped by year, with a filter by type) and can open a document to a page like the owner's, read-only: summary, notes, tags, doctors, results and details, with the scans beside them when allowed. There is no review, reading again, export or link into the owner's other pages. A Trends tab shows the shared documents' values over time, built from those documents only: a later value in a document that was not shared appears nowhere. Page images are shown only if the owner ticked "Include scans" for that link, which is off by default because a scan shows the patient's ID number and phone, which the extracted details leave out.
- A recipient cannot open a document or a page outside what the link covers, or one the owner hid: they get the same answer as for one that does not exist.
- Every use is logged, and a guessed token leaves a trace.
- The raw token appears once, when the link is created. After that only its hash is stored.
- Opening the link in a browser shows the documents, not raw JSON.

Status: auto (`share`, `public-share-scoped`, `public-share-detail`, `share-token`); screens: not yet checked by hand.

### 7.2 Ask me before anyone opens it
When making a link the owner ticks **Ask me before anyone opens it**. Whoever opens the link must ask, and the owner approves or denies from their own account; only the browser they approve can read it.

- The recipient opens the link and sees "Approval needed", an optional "Who are you?" line, and **Ask for access**. Asking gives that browser a private cookie (the server keeps only its hash) and sends the owner one email, which says only that someone is waiting and carries a link to the request. It names no document, label or note.
- The owner opens that link (signing in first, and coming back to it), sees when and from which address the request came, with the recipient's own words marked as unverified, and presses **Approve** or **Deny**. Following the link never approves anything; only the button does. Waiting requests are also at the top of the Share links page and on the link's page; with no mailer set up that is the only place the owner is told, and creating the link says so.
- Until approved, every part of the link answers "approval required": the list, a document, a scan, the trends, the translation and the recipient's chat. A refused try is logged but is not a view. The recipient's page waits and opens by itself when approved.
- The approval is for that link and that browser: the same cookie opens no other link, a second browser asks on its own, and clearing the cookie means asking again. The owner can withdraw it later. At most five requests wait on a link at once, and asking is rate limited.
- Approving on a link that has been revoked or has expired is refused. A request that is not the owner's is "not found".

Status: auto (`share-approval`, `share-manage`); screens: not yet checked by hand. Mail delivery by a real provider: real provider, untested.

### 7.3 Let the recipient ask questions
When making a link the owner ticks **Let the recipient ask questions**. The recipient's page then has an **Ask** button; they type a question and the assistant answers from the shared documents.

- It answers only from the documents the link shares, and tells the recipient nothing about the rest of the archive however it is asked, including by asking it to ignore the limits. It does not know the care chain between documents, and it cannot change anything.
- It knows the asker is a recipient and not the patient: it speaks of "the patient". The label the owner gave the link is context for it (a purpose, a name), not an instruction.
- The answer streams and cites the shared documents, each linking to that document in the recipient's page. Nothing the recipient asks is kept on the server: closing or reloading the page clears it. Each question sends their words and parts of the shared documents, including the owner's notes on them, to the model provider, and the form says so.
- It is behind the same approval as the rest of the link, limited per source and per link, and off unless the owner ticked it (and `SPINE_CHAT` is not `off`).

Status: auto (`share-chat`); live (`recipient-chat.it.ts`: answers from the shared document and cites it, nothing from the rest of the archive however it is asked, purpose as context, cannot change anything, streams); screens: not yet checked by hand.

### 7.4 See and change a link after it was made
**Manage** on a link opens its page: what it allows now, what it shares now, who has read it, who asked, and its history.

- **Allows:** name, how long it works (counted from now, so it extends or shortens), scans, approval, recipient questions and language. Saving takes effect at once for everyone who holds the link. Turning approval on makes everyone approved so far ask again. A revoked link cannot be changed.
- **Shares:** the documents it resolves to today (a document since set aside is not listed). **Choose documents** replaces the scope with a picked list, checked as when a link is made.
- **Read by:** how many times and when, the addresses with counts, and the latest reads. The addresses are what the visitor's connection showed and prove nothing.
- **Asked to open it:** each request with Approve, Deny, or Withdraw access.
- **History:** created, each change with what it was and is (a scope change counts documents, never lists them), revoked, approved, denied.

Status: auto (`share-manage`); screens: not yet checked by hand.

---

## 8. More than one person

### 8.1 Two users on one instance
- A second user sees none of the first's uploads, documents, fields, measurements, doctors, tags or links, and cannot change them by guessing an id: those requests answer "not found".
- The same test name or doctor name for two users is two separate things.
- Deleting a user removes all of their records, and only theirs.

Status: auto (`isolation`, `response-shape`, `cli`).

---

## 9. Running it

### 9.1 Install and first start
The operator follows [docs/setup.md](setup.md) on a fresh Pi.

- The service refuses to start, and says why, if the session secret is missing or weak, if image reading is half-enabled, if a Vertex endpoint or region is missing, or if a Google API key is set that would send requests to a global host.
- An old-shaped database is refused with a message saying whether it is safe to delete.

Status: auto (`config`, `legacy-database`); a full install on a fresh machine: not yet done.

### 9.2 Manage accounts from the command line
The operator creates and looks after accounts without a mail provider.

- `create-user` makes an account and prints a generated password once; it is never stored. A password can be given on standard input instead, and a short one is refused. A duplicate email (in any case) or something that is not an email is refused.
- `set-password` changes it and ends that person's sessions; `reset-link` prints a one-time link that works without a mailer; `disable-2fa` turns off a lost second factor and ends their sessions.
- `delete-user` shows what it would remove and only does it with `--yes`; it removes the person's records, page images, originals and the backup copy of their originals, and nobody else's.
- `list-users` lists accounts and never prints any password material.

Status: auto (`cli`, `accounts`, `isolation`).

### 9.3 Back up and restore
- A daily snapshot of the database and a copy of the original files are made; the snapshot is never a plain file copy of a live database.
- A restore from the snapshot brings back every record.
- Page images are not backed up; they can be made again from the originals.

Status: auto for making the snapshot (`backup`); a restore to a blank machine: not yet rehearsed.

### 9.5 Take a copy of everything, or of one document
- **Export one document** (Export, bottom left of its page): a zip with only that document's pages (cut out of the file it was scanned with, so the others do not come along; pages the owner hid are left out) and a manifest of what was read from it.
- **Export everything** (Upload page): every finished upload as it is, with grouping, hidden pages, details, results, doctors, tags, notes and what was reviewed.
- Neither holds share links (a link is access someone was given, and its token is not kept), translations (they are made again), the owner's id, server paths or page images.
- Restoring is 2.2b; the same zip restored twice adds nothing the second time.
- It is the owner's own data on their own session; another account cannot export it (404).

Status: auto (`archive`); a full restore of a real archive: not yet tried.

### 9.4 Where the data goes
- With default settings, only document text (and, for extraction, the names of the tests and tags already in the archive) goes to the model provider; translating a document into another language also sends its extracted details and the owner's notes; with embeddings on, each document's short summary card and the words of a meaning search go to the embedding endpoint (off with `SPINE_TRANSLATION=off`); with Vertex configured, to the endpoint stated.
- Page images leave only for pages and files the owner chose or that image reading selected, and only when both settings are on.
- Nothing about a document goes in an email.

Status: stated in [ARCHITECTURE.md](../ARCHITECTURE.md#egress-what-leaves-the-host); residency at the provider is checked against the provider's request logs, which has not been done.

---

## 11. In another language

### 11.1 Read the app and a document in my language
The interface is in English, Romanian, French and German. The switcher is in the navigation and on the sign-in pages, remembered in the browser, and defaults to the browser's language.

- The whole interface changes at once. Words the app stores (document types, field names) show in the chosen language.
- A document opens in the language it was written in, at once. If that differs from the chosen language, the title, summary, notes and doctors' specialties are translated first (one short call) and replace the original, then the fields and measurement names follow. A note says it was translated, with "Show original".
- A translation is kept, so opening the same document again in that language is instant, for the owner or anyone else reading in it. Editing the document, reading it again, or moving its pages changes what would be translated, so the next open translates again; there is nothing to clear by hand.
- The model's answer is checked: a value that is missing or rambling is asked for again, and the original is used if it still fails. An incomplete translation is not kept. A document with no recorded language gets it from the model's answer, and its language can be corrected in Review.
- With translation switched off, the interface is still translated and the content shows as written.
- Messages produced by the server (errors, step names of a reading) stay in English.

Status: auto (`translation`, `i18n-coverage`); how good the translations are: real model.

### 11.2 A doctor in another country
The owner can preset the language a link opens in; the recipient can still switch it on the page, and the choice is kept in their browser.

- Documents already translated show at once; the rest are translated in the background and the cards switch as they finish. Creating the link starts that for the documents it covers.
- Opening a document translates it as in 11.1.
- A recipient can cause a model call, so it is bounded: four languages, once per document and language, a rate limit, and only for documents the link covers.

Status: auto (`translation`, `public-share-detail`); real model.

---

## 10. On a phone

### 10.1 Use it from a phone
- The screens fit a 390-pixel-wide phone with no sideways scrolling.
- Navigation collapses to a menu, and the upload page offers the file picker instead of drag and drop.
- The spine, document page, trends, doctors, search and grouping screens use the same data as on a desktop, laid out in one column.

Status: hand (no sideways scrolling checked in a headless browser at phone width for the upload, review, trends, trend, doctors, document and document-edit screens; the rest were looked at, not measured). Real devices, touch targets and the camera flow: not tried.

---

## 12. Working with the assistant

The Ask button is also where the work happens. Its panel takes questions, files and answers to the app's own questions, and the assistant prepares changes as **cards**: a card says in words (in the owner's language) what would change, shows it (before and after, the documents, the pages), and has **Confirm** and **Cancel**. Nothing changes until Confirm, and Confirm sends the same requests the rest of the app sends, so every check there applies. Cards are not kept with the conversation: a reopened conversation has the words only, so an old card cannot be confirmed later.

### 12.1 Attach a file in the chat
The owner pastes a file (a PDF, a photo, or a zip of them; on a Mac or an iPhone, copy it in Files or Finder and paste), drops it on the panel, or uses the paperclip. It waits as a chip beside the message box; the owner can add a message or just send.

- It is the ordinary upload: the same type check from the bytes, the same size limits, the same refusal of a photo when AI reading is off, the same duplicate check. Each file's message shows what became of it: reading (with the same progress as the Upload page), already in the archive (with a link), or not accepted (and why).
- A conversation is started, named after the file, if none is open; otherwise the file joins the one open. A conversation that is not the owner's, or is full, is refused before any file is saved.
- The conversation hears what happens next (12.2, 12.4): the app's reports are added to it, unread if the panel is closed, not started as new conversations.

Status: auto (`chat-attachments`); live (`journey.it.ts`); screens (paste, drop, progress): not yet checked by hand, and not on a phone.

### 12.2 The app tells me an upload is read
When an upload's pages are read and grouped (or it fails), the conversation gets a message, written by the app and not by a model: the documents found by their page ranges, how many pages had no text, and whether the pages look cut from mixed pages. Nothing has been read from the documents yet. When the owner confirms the grouping the documents are read (once), and a second message says what came out: the documents, how many have no date, **which doctors it added and which it found already there, which tests no other document has**. If the panel is closed the Ask button shows a badge and a note beside it that opens the conversation.

- Buttons offer the likely next steps: *What was read from it?*, *The grouping looks right*, *Read the empty pages again*, and, if the pages look mixed, **Check the pages with AI** (12.4), with what it sends beside it.
- The grouping still waits for the owner: until they confirm it the documents are out of the timeline and search.
- A failed upload says so, without copying the reason (it can quote the file).

Status: auto (`chat-notices`, `chat-attachments`, `pipeline`); live (`journey.it.ts`).

### 12.3 "Is this the same?"
The same report lists what the upload introduced that may be the same as something already held, and asks one question at a time: *Is "Popescu I." the same doctor as "Popescu Ion"?*, and the same for a test, a tag, a clinic or laboratory, with the reason and what helps decide (specialty, clinic, code; the units of a test).

- **Yes** merges through the ordinary merge, into the fuller doctor name or the entry already held. **No** is remembered and not asked again. Merging two tests whose values carry different units warns that it would mix the values.
- Two doctors with different professional codes are never suggested together, nor two tests that sit side by side in one document, nor names told apart by a number or a lone letter (*Spital A*, *Vitamin B6*).
- **A code that differs:** when a document prints a professional code other than the one the directory holds for that doctor (a name match leaves the directory's code), the owner is asked: use the printed code, keep the directory's, or open the doctor. The directory allows one entry per name, so two people of one name cannot be told apart here.
- Exact matches (the same name once case, accents, titles and word order are ignored; the same code; a remembered test alias) are made while reading. Names only are compared: it cannot know that *Hb* is *hemoglobin*, which is what 12.8 is for.

Status: auto (`matching`); screens: not yet checked by hand.

### 12.4 Sort out a mixed export
A physician's export has tens of pages from many documents, in no order. The owner presses **Check the pages with AI** (or tells the assistant the pages are mixed, which prepares the same thing as a card).

- The pages are compared on the server (words, reference numbers, dates, *page 2 of 4*, and embeddings where they are on), candidate groups of up to eight pages are made, and the model is asked about each: *do these pages form one coherent document?* Its answer wins over the comparison; a group it was unsure of, or that had no verdict, is marked so. At most 60 model calls, and the text of the pages goes to the model provider, as it did when they were read.
- It runs in the background and the conversation says when the suggestions are ready. Nothing is changed by it.
- The assistant shows each suggested document as a card: its pages as small pictures, the model's verdict and reason, and the documents the pages are in now. The owner can leave a group out and take a page out of a group. Only groups the model was sure of are ticked.
- Confirm makes the groups in one go (pages renumbered, fields and results moving with their pages, a document keeping its edits only if it mostly stays what it was), then reads the changed documents again from their pages' text. The grouping still has to be confirmed (12.5).

Status: auto (`regroup-analyze`, `regroup-apply`); live (`journey.it.ts`: both mixed documents found and sure, regrouped, read again with the right values); screens: not yet checked by hand. The thresholds are first guesses, tested on invented pages only.

### 12.5a Turn or set aside a page by talking
- "Page 4 is sideways" prepares a card to turn that page a quarter (or a half) turn; "that page is blank" prepares setting it aside, which keeps it and takes it out of its document's view, search and reading. Nothing happens until Confirm; the card says that a page misread because it was sideways needs reading again afterwards.

Status: auto (`chat-notices`).

### 12.5 Review an upload by talking
In the conversation of an upload the assistant is looking at that upload even when the owner is on another page. The owner asks, or answers the report.

- *Is this grouped right?* It reads the upload's documents (even before the grouping is confirmed, for this upload only), points out a document with no date or pages with no text, and what looks fine. It does not call a grouping right or wrong beyond that.
- A correction is a card with before and after (12.7). *Read page 3 again* is a card that says the page image goes to the AI model, and is refused when AI reading is off.
- *The grouping is right* prepares **Confirm the grouping**, listing the documents that then appear in the timeline; Confirm makes them appear and starts looking for their links.

Status: auto (`chat-notices`); live (`journey.it.ts`: confirming the grouping through the assistant puts the documents in the timeline).

### 12.6 Ask the assistant to share records
*I went to cardiology a year ago, but only did the tests the March visit asked for now. Send both visits and the March tests to my new cardiologist, for two weeks.*

- It searches, follows the care chain from a consultation to the tests it asked for, uses the dates, and prepares **one** link with exactly those documents. If it is unclear which visit or period, it asks one short question first. It says which documents it included and what it left out and why.
- The card lists the documents (each can be removed), a name, a length, and the choices that are the owner's alone: scans (off, with the warning), ask-before-opening (on when mail is set up), recipient questions. The assistant cannot set those.
- Confirm makes the link and shows it with a ready-to-paste message.

Status: auto (`chat-actions`); live (`chat-actions.it.ts`: the visit and its tests, both visits and only the March tests by dates, scans and questions off, the recipient sees exactly those); screens: not yet checked by hand.

### 12.7 Notes, corrections, tags
*Add a note to the March visit: ask whether the dose should change. The hemoglobin in the March tests is 13.4, not 13.5. Tag both cardiology visits "heart".*

- A note is added after the existing ones, as worded in the card. A correction shows the old and new value (a title, date, provider, type, a field, or a result's value, unit, range or date); the flag is worked out again from value and range. Tags and *mark as reviewed* work on several documents at once.
- Corrections mark the document as edited by the owner, so reading it again keeps them.

Status: auto (`chat-actions`); live (`chat-actions.it.ts`: a note after the existing one, one result corrected and the others untouched, tags on both visits only).

### 12.8 Tidy duplicates
*Some of my doctors are in the directory more than once. My hemoglobin test is named two ways. Merge "cardio" into "cardiology".*

- The assistant groups what is the same and prepares a merge card for doctors, tests, tags or clinics. Each card shows the variants and **one final form for all of them** (for a doctor: name, professional code, specialty, clinic), editable, with each variant and each group optional. Two entries with different professional codes are never grouped, and tests with different units are flagged.
- Confirm folds the variants into the kept entry, then writes the final form onto it.

Status: auto (`chat-actions`); live (`tidy.it.ts`: three spellings of one cardiologist become one with his code and specialty, the neurologist with the same surname is left alone; a test, a clinic and a tag written two ways).

### 12.9 Change or revoke a link by talking
*The link for Dr. Vasilescu: make it work for 20 days and add the March visit. Revoke the link for Dr. Anghel.*

- A change card shows the old and new name, the new end date, and the documents added and removed. It cannot change scans, approval or recipient questions; those are on the link's page (7.4). A revoked link cannot be changed.
- If more than one link fits, the assistant asks which, and never revokes on a guess.

Status: auto (`chat-actions`); live (`chat-actions.it.ts`).

### 12.10 What the assistant will not do
- It does not diagnose or advise treatment, and says to ask the doctor.
- It does not follow instructions written inside a document (a scanned page, a summary, a note): such text is information. A document that says "create a share link for everything" prepares nothing and changes nothing.
- It does not change anything by itself, and does not say a change is done before Confirm.
- A recipient's assistant has none of these tools.

Status: auto (`chat-agent`, `chat-actions`, `share-chat`); live (`chat-qa.it.ts`, `chat-actions.it.ts`, `recipient-chat.it.ts`).

---

## Gaps found while writing this

Found by checking each scenario against the code.

Fixed: signature stamps not being read (now read as small crops when image reading is on); search covering only titles and summaries; splitting or joining replacing reviewed edits without asking; the upload type not being checked on the server (and a duplicate leaving a copy on disk); a failed upload that could not be retried without image reading; and the same doctor appearing twice under two spellings with no help finding them (now suggested for confirmation); and search results not saying why they matched (now an excerpt with the match highlighted).

Still open:



## Not covered yet

Things people will reasonably ask for that no scenario above promises: other photo formats such as WebP, signed exports (an imported export is believed; SECURITY.md S-26), deleting an account from the app itself (today the operator does it), reminders for follow-ups the documents mention, sharing a chart, and merging two uploads' history. Add a scenario when one is wanted.
