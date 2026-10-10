import { DOC_TYPES } from './types.js';

/**
 * Prompts live above the adapters: they are provider-agnostic, and keeping them
 * here is what lets a second provider be a map entry plus an adapter file.
 *
 * The slice sizes are the egress budget, not an implementation detail — they
 * are what ARCHITECTURE.md's egress table promises leaves the host per call.
 */
export const CONTINUATION_CONTEXT_CHARS = 500;
export const EXTRACTION_CONTEXT_CHARS = 6000;

export function buildContinuationPrompt(previousPageText: string, currentPageText: string): string {
  return `You are analyzing two consecutive pages from a PDF to determine if they belong to the same logical document.

Page N-1 text (last ~${CONTINUATION_CONTEXT_CHARS} chars):
${previousPageText.slice(-CONTINUATION_CONTEXT_CHARS)}

Page N text (first ~${CONTINUATION_CONTEXT_CHARS} chars):
${currentPageText.slice(0, CONTINUATION_CONTEXT_CHARS)}

Decide: does page N directly continue page N-1, or does it start a new document?

is_continuation = true if page N:
- Lacks its own date/letterhead/greeting
- Continues a sentence or numbered list from page N-1
- Has pagination markers like "pag. 2/3", "page 2 of 3", "continued", etc.
- Shares the same patient context without re-introduction

is_continuation = false if page N:
- Has a new date, provider name, or letterhead
- Starts with a new greeting or patient identifier
- Is clearly a different document type

Respond with ONLY valid JSON, no markdown:
{"is_continuation": boolean, "confidence": 0.0-1.0, "reasoning": "one concise sentence"}`;
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

export function buildExtractionPrompt(documentText: string): string {
  return `Extract structured metadata from this medical document. The document may be in Romanian or English.

Document text:
${documentText.slice(0, EXTRACTION_CONTEXT_CHARS)}

Extract and return ONLY valid JSON (no markdown):
{
  "doc_date": "YYYY-MM-DD or null if not found",
  "provider": "clinic/hospital name or null",
  "doc_type": one of ${JSON.stringify(DOC_TYPES)},
  "ai_summary": "2-3 sentence summary of what this document contains and its clinical significance",
  "suggested_tags": ["array", "of", "tag", "names", "from: allergy, chronic, vaccine, medication, imaging, follow-up-needed, cardiology, oncology, lab"],
  "fields": [
    {
      "label": "field name (e.g. diagnosis, allergy, medication, lab_value, result, follow_up)",
      "value": "extracted value",
      "source_snippet": "the exact phrase from the document text that supports this value",
      "page_number": 1,
      "confidence": 0.0-1.0
    }
  ]
}

Rules:
- source_snippet must be a substring that actually appears in the document text
- Include diagnoses, allergies, medications, key lab values, referrals, and follow-up instructions as fields
- page_number is 1-indexed; estimate based on text position if unclear`;
}
