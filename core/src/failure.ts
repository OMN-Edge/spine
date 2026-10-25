import { OutputParserException } from '@langchain/core/output_parsers';

/**
 * What to write down about an error: in the log, and with a failed upload.
 *
 * Not `err.message` as it stands. A reply the model gave that could not be parsed arrives as an
 * error that quotes the reply, and the reply is the document's text, so it would put a patient's
 * notes into the log and the database. This keeps the sentence and drops the quote. Everything
 * else (a missing tool, a page that could not be read, a provider's status) is already plain.
 */
export function describeError(err: unknown): string {
  if (err instanceof OutputParserException) return 'the model’s reply was not valid JSON';
  const message = err instanceof Error ? err.message : String(err);
  // Also when it arrives wrapped in another error.
  return message.replace(/Failed to parse\.\s*Text:[\s\S]*/i, 'the model’s reply was not valid JSON').slice(0, 500);
}
