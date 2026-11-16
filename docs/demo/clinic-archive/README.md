# The invented clinic archive

Forty PDFs for one invented patient over two years: a polyclinic's endocrinology and cardiology visits, a lab's reports, a hospital stay, a radiology centre, a urology clinic, a family doctor, an eye check, a dental invoice. Nothing in it is real: the person, the clinics, the doctors, the codes and the values are invented. The documents are drawn to look like what a clinic hands over (a letterhead and logo in each provider's colours, a patient box, lab tables with reference ranges and flags, an ECG on grid paper, a drawn radiograph and ultrasound, a signature, a round stamp with a professional code, an official sick-leave form with a code, a prescription with a code, an invoice), and each has a real text layer, so the app reads it as it reads an export.

It is for two things: to try the app on a believable archive, and to check that the suggested links and episodes mean something (`server/src/__integration__/linking-quality.it.ts`, which runs the whole flow with the real model and marks the result).

## Where it comes from

Everything is generated from one script, so it is the same every time: `server/src/__integration__/support/clinic/specs.ts` holds what each document says (the text, the values, the dates, the doctor) and what is true of the archive, `render.ts` draws the pages, and `build.ts` writes the files and `manifest.json` here: `npm run demo-archive -w spine-server`. Because the values are known, the evaluation also checks what was read from each document against them (date, kind, provider, doctor, every numeric lab value and whether it was flagged).

## The stories, and what makes them hard

A care cycle is one story: a visit, what it asked for, what answered it, the visit that read the answers.

- **The thyroid, three cycles a year apart** (February, May to June, November to December 2025): each visit asks for tests and the next visit leads on from the last. They are linked as follow-ups, but they are three episodes, never one that spans a year.
- **The eye check on the day of a blood test, at the same clinic** (2 June 2025): the clinic's own lab drew the thyroid blood and the ophthalmologist saw the patient the same day. They are not related.
- **A dental invoice on the day of the cardiology visit** (20 February 2026) and an **annual panel** that repeats tests (TSH, lipids, glucose) that belong to other stories.
- **Cardiology in two cycles** six months apart: chest pain, an ECG and a lipid panel, a statin; then the control with the lipids repeated.
- **Pneumonia** with a family doctor, a radiograph, a hospital stay, a sick-leave certificate and a control radiograph a month and a half on.
- **Urology**: a visit, a urine culture, an ultrasound, a control and a prescription, and an invoice for the visits.
- **A skin visit** with a prescription, alone.
- **Two documents held twice** (a lipid report and the sick-leave certificate, the second copy scanned a little askew): a copy is not a relative of its original, and only one of the two carries links.

`manifest.json` lists every document with its story, and the ground truth: which stories exist, which links between neighbouring cycles of one condition are real, which pairs must never be linked, and which are a matter of taste.
