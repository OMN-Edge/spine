import { describe, it, expect } from 'vitest';
import { companyParts } from './operator';

describe('the company line', () => {
  const full = { name: 'Example SRL', ids: ['Reg. no. J00/0000/0000', 'Tax no. 0000000'], address: '1 Example Street, Exampleville, Examplia', contact: 'hello@example.test' };

  it('runs from the name to the numbers, the address and the contact, in that order', () => {
    expect(companyParts(full, 'Spine is operated by Example SRL')).toEqual(['Spine is operated by Example SRL', 'Reg. no. J00/0000/0000', 'Tax no. 0000000', '1 Example Street, Exampleville, Examplia', 'hello@example.test']);
  });

  it('leaves out what the operator has not given, and adds no number of its own', () => {
    expect(companyParts({ name: 'Example SRL', ids: [], address: null, contact: null }, 'Spine is operated by Example SRL')).toEqual(['Spine is operated by Example SRL']);
  });
});
