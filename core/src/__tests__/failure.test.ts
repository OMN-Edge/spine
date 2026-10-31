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

import { failureKind } from '../failure-kind.js';

/** A person is told what to do about a failed upload, by kind; the message itself is for the log. */
describe('failureKind', () => {
  it('knows the reasons the page has words for', () => {
    expect(failureKind('a photo can only be read by the model, and image reading is switched off on this server')).toBe('reading_off');
    expect(failureKind('the daily limit of 40 model calls is reached; it starts again at midnight UTC')).toBe('limit');
    expect(failureKind('the model service answered 429')).toBe('limit');
    expect(failureKind('the model service answered 503: unavailable')).toBe('service');
    expect(failureKind('this device has no pass for the model service')).toBe('service');
  });

  it('says other for anything else, and for no message', () => {
    expect(failureKind('page 3 could not be read')).toBe('other');
    expect(failureKind(null)).toBe('other');
  });
});
