import { describe, expect, it } from 'vitest';
import { typedDate } from './DateInput';

/** A phone's number pad has no dash: the date field puts the dashes in, so a date can be typed with digits alone. */
describe('a typed date', () => {
  it('gets its dashes from the digits alone', () => {
    expect(typedDate('20150401')).toBe('2015-04-01');
    expect(typedDate('201504')).toBe('2015-04');
    expect(typedDate('2015')).toBe('2015');
  });

  it('is the same when the dashes are typed too, and cannot run past a day', () => {
    expect(typedDate('2015-04-01')).toBe('2015-04-01');
    expect(typedDate('2015-')).toBe('2015');
    expect(typedDate('2015-04-019')).toBe('2015-04-01');
  });

  it('turns round a date written day first, as one is pasted from a letter', () => {
    expect(typedDate('1.4.2015')).toBe('2015-04-01');
    expect(typedDate('01/04/2015')).toBe('2015-04-01');
  });
});
