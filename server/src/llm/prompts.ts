import { DOC_TYPES } from './types.js';
import { guidesForPrompt } from './doc-types.js';

/**
 * Prompts live above the adapters: they are provider-agnostic, and keeping them
 * here is what lets a second provider be a map entry plus an adapter file.
 *
 * Nothing is shortened to save money or to send less. The one cap is the context window
 * (`contextChars`), so that a request is never refused for being too long.
 */

/** Keeps `text` within `max` characters, from the end when the end is what matters. */
const fit = (text: string, max: number, keep: 'start' | 'end') =>
  text.length <= max ? text : keep === 'start' ? text.slice(0, max) : text.slice(text.length - max);

export function buildContinuationPrompt(previousPageText: string, currentPageText: string, contextChars: number): string {
  // Each page gets half the window at most, which a page of text never approaches.
  const half = Math.floor(contextChars / 2);
  return `You are analyzing two consecutive pages from a PDF to determine if they belong to the same logical document.

Page N-1 text:
${fit(previousPageText, half, 'end')}

Page N text:
${fit(currentPageText, half, 'start')}

Decide: does page N directly continue page N-1, or does it start a new document?

is_continuation = true if page N:
- Lacks its own date/letterhead/greeting
- Continues a sentence or numbered list from page N-1
- Has pagination markers like "pag. 2/3", "Pg. 2 / 3", "page 2 of 3", "continued", etc. (a page numbered 2 of 3 follows page 1 of 3)
- Shares the same patient context without re-introduction

is_continuation = false if page N:
- Has a new date, provider name, or letterhead
- Starts with a new greeting or patient identifier
- Is clearly a different document type
- Is numbered 1 of N ("Pg. 1 / 1", "pagina 1/2") when page N-1 was the last page of its own document ("Pg. 3 / 3")

Respond with ONLY valid JSON, no markdown:
{"is_continuation": boolean, "confidence": 0.0-1.0, "reasoning": "one concise sentence"}`;
}

export function buildStampReadingPrompt(count: number): string {
  return `${count === 1 ? 'This image is' : `These ${count} images are`} cut from the last page of a medical document. Each may be a doctor's signature stamp, usually blue or black ink, often crossed by a handwritten signature. It may also be something else.

For every image that is a doctor's stamp, give:
- name: the doctor's name as printed, without "Dr." or other titles
- specialty: the specialty as printed (for example "medic specialist cardiolog" or "microbiologie medicala"), or null if none is printed
- code: the professional code printed with it (after "Cod", "COD:" or "cod"), letters and digits only, or null

Rules:
- Ignore logos, seals, quality marks, QR codes, barcodes, photographs and anything that is not a doctor's stamp
- Copy what is printed. Do not translate, correct or complete a name
- If any character of the code is covered by the signature or cannot be read with confidence, give code null. A wrong code is worse than none
- If no image is a doctor's stamp, return an empty list

Respond with ONLY valid JSON, no markdown:
{"doctors": [{"name": "...", "specialty": "... or null", "code": "... or null"}]}`;
}

export function buildPageReadingPrompt(): string {
  return `This image is one scanned page of a medical document. It may be handwritten, and it may be in Romanian or English.

Transcribe all the text on the page, as blocks (a line, or a few lines that belong together) in reading order.

For each block give its position as a box, as fractions of the page from the top-left corner:
x0, y0 is the top-left of the box and x1, y1 the bottom-right, each between 0 and 1.

Rules:
- Copy what is written. Do not translate, correct, summarise or add anything.
- Keep diacritics (ă â î ș ț) exactly as written.
- If a word cannot be read, write [illegible] in its place rather than guessing.
- A blank page has no blocks.

Respond with ONLY valid JSON, no markdown:
{"regions": [{"text": "...", "x0": 0.0, "y0": 0.0, "x1": 0.0, "y1": 0.0}]}`;
}

/**
 * The text is the pages of one document, each under a marker with its page number in the
 * upload (`--- page 4 ---`), so the model can say which page a value is on. The caller
 * keeps it within the context window by splitting a very long document into chunks.
 */
/**
 * The text is the pages of one document, each under a marker with its page number in the
 * upload (`--- page 4 ---`), so the model can say which page a value is on. The caller
 * keeps it within the context window by splitting a very long document into chunks.
 *
 * What to extract depends on the type of document, so the model first decides the type and
 * then follows that type's guide (llm/doc-types.ts).
 */
export function buildExtractionPrompt(documentText: string, knownTests: string[] = []): string {
  const known = knownTests.length
    ? `\nTests already in this person's archive (canonical names): ${knownTests.join(', ')}.
When a measurement is the same test as one of these, use that exact name as its canonical, even if this document prints it differently ("Hb" for hemoglobin, a Romanian name for an English one). Only when none matches, give the test a new standard English name.\n`
    : '';
  return `Extract structured data from this medical document. The document may be in Romanian or English.
Each page of the text begins with a marker such as "--- page 4 ---".

Document text:
${documentText}

First decide doc_type (one of ${JSON.stringify(DOC_TYPES)}). Then extract what that type calls for:
${guidesForPrompt()}
${known}
Return ONLY valid JSON (no markdown):
{
  "title": "the document's own title as printed on it (e.g. \"Bilet de externare\", \"Buletin de analize\"), in its original language; if it has none, a short descriptive title in the document's language, under 60 characters",
  "doc_date": "YYYY-MM-DD or null if not found",
  "provider": "clinic/hospital/laboratory name or null",
  "doc_type": "one of the types above",
  "ai_summary": "2-3 sentence summary of what this document contains and its clinical significance",
  "suggested_tags": ["array", "of", "tag", "names", "from: allergy, chronic, vaccine, medication, imaging, follow-up-needed, cardiology, oncology, lab"],
  "doctors": [{"name": "name as printed, without Dr./Prof./Conf. titles", "specialty": "e.g. cardiology, or null", "code": "the professional code printed with their signature, e.g. X12345, or null", "role": "author | prescriber | referrer | other"}],
  "fields": [
    {
      "label": "use the labels from the guide for this type when they apply, otherwise a short lowercase label",
      "value": "the extracted value, as text",
      "group": null,
      "source_snippet": "the exact phrase from the document text that supports this value",
      "page_number": 4,
      "confidence": 0.0-1.0
    }
  ],
  "measurements": [
    {
      "name": "the test or vital as printed, e.g. Hemoglobina",
      "canonical": "its standard English name, lower case, no unit or specimen, e.g. hemoglobin",
      "value": "exactly as printed, e.g. 13,5 or <0.5",
      "unit": "as printed, or null",
      "ref_low": "lower end of the printed reference range, or null",
      "ref_high": "upper end of the printed reference range, or null",
      "flag": "low, high or normal if the document marks it or it is outside the printed range, else null",
      "date": "when this value was taken, if the document says and it differs from the document's date: YYYY-MM-DD, or YYYY-MM if only the month is given (\"03.2026\"); else null",
      "source_snippet": "the exact phrase from the document text",
      "page_number": 4,
      "confidence": 0.0-1.0
    }
  ]
}

Rules:
- source_snippet must be a substring that actually appears in the document text
- page_number is the number in the page marker above the text that supports the value
- Numeric results go in measurements, not fields. The same test must get the same canonical name on every document (hemoglobin, glucose, creatinine, ldl cholesterol, blood pressure systolic, ...)
- Fields that belong together (the drug, dose and frequency of one prescription line; one vaccine's name, lot and site) share a number in "group", a different number for each item; a field on its own has group null
- Include only people acting in a clinical role in doctors, never the patient. A header that says who recommended the visit or sent the sample ("Recomandat de", "Trimis de", "Trimitor") names the referrer; the one who saw the patient ("Consultat de") or signed is the author
- Results quoted inside the text of a consultation or discharge note ("TSH 3.10 uU/ml", "FSH = 4.2 (1,5-12,4)") are measurements too; give each the date it was taken when the text gives one, which is often not the date of the visit
- A report that lists several services (a consult, an ultrasound) gets one "service" field per service, with only its name, and the result of each as an "investigations" field that starts with that service's name
- A reference range is the one printed for this patient beside the result (often in brackets, "[1.5 - 12.4]"). Ranges listed for other groups (by sex, age, pregnancy, Tanner stage) are not the reference range. A bound printed as "<0.5" or "≤ 5.8" is ref_high alone; ">10" is ref_low alone
- Do not extract the patient's personal identifiers (national ID number, patient code, phone number, age)
- Use [] for doctors, fields or measurements that the document does not have`;
}
