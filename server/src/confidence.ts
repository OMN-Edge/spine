/**
 * A value the model read with less confidence than this is marked "check" (FR-EXT-04), and so is every one the owner has not
 * confirmed: handwriting, a faded or cut-off line, an ambiguous digit. The model is told to score by how sure it is that the value
 * is exactly what is printed (`llm/prompts.ts`); a first guess, to be tuned from what is flagged in real use.
 */
export const LOW_CONFIDENCE = 0.7;
