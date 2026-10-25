import { describe, it, expect } from 'vitest';
import { OutputParserException } from '@langchain/core/output_parsers';
import { describeError } from '../failure.js';

/** What is written to the log and stored with a failed upload must not quote the document. */
describe('describeError', () => {
  it('drops the quoted reply from a parse failure', () => {
    const err = new OutputParserException('Failed to parse. Text: "{\\"text\\": \\"invented patient note\\"}". Error: SyntaxError');
    expect(describeError(err)).toBe('the model’s reply was not valid JSON');
    expect(describeError(err)).not.toMatch(/invented patient note/);
  });

  it('drops it when the parse failure arrives wrapped in another error', () => {
    const wrapped = new Error('page 4 failed: Failed to parse. Text: "invented patient note" Error: SyntaxError');
    expect(describeError(wrapped)).not.toMatch(/invented patient note/);
    expect(describeError(wrapped)).toMatch(/^page 4 failed: the model’s reply was not valid JSON/);
  });

  it('keeps an ordinary message as it is', () => {
    expect(describeError(new Error('page 3 could not be read'))).toBe('page 3 could not be read');
    expect(describeError('plain string')).toBe('plain string');
  });

  it('is bounded', () => {
    expect(describeError(new Error('x'.repeat(5000))).length).toBe(500);
  });
});
