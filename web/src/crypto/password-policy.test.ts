import { describe, it, expect } from 'vitest';
import { checkPasswordPolicy } from './password-policy.js';

describe('the master password policy', () => {
  it('accepts a long phrase', () => {
    expect(checkPasswordPolicy('purple tractors drink quiet coffee')).toBeNull();
  });
  it('refuses short, over-long and easy ones', () => {
    expect(checkPasswordPolicy('short')).toBe('short');
    expect(checkPasswordPolicy('x'.repeat(300))).toBe('long');
    expect(checkPasswordPolicy('password12345')).toBe('easy');
    expect(checkPasswordPolicy('aaaaaaaaaaaaaa')).toBe('easy');
    expect(checkPasswordPolicy('qwertyuiopasdf')).toBe('easy');
  });
  it('refuses one made of the address', () => {
    expect(checkPasswordPolicy('alexandru-is-here-1', { email: 'alexandru@example.com' })).toBe('easy');
  });
});
