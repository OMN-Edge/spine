import { describe, expect, it } from 'vitest';
import { showsGreeting } from './ChatWelcome';

describe('when the chat greets instead of offering questions', () => {
  it('greets a person with nothing of their own and no sample', () => {
    expect(showsGreeting(false, 0, false)).toBe(true);
  });

  it('offers questions about the records once the sample is in, though the person has uploaded nothing', () => {
    expect(showsGreeting(false, 0, true)).toBe(false);
  });

  it('offers questions once the person has an upload, or has put the greeting away', () => {
    expect(showsGreeting(false, 1, false)).toBe(false);
    expect(showsGreeting(true, 0, false)).toBe(false);
  });
});
