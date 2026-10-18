import { describe, it, expect } from 'vitest';
import { checkPasswordPolicy } from '../passwords.js';

describe('password policy (S-34)', () => {
  it.each([
    'password1234',
    'Password2024!!',
    'P@ssw0rd12345',
    'qwertyuiop12',
    'qwertyuiopasdf',
    '1234567890123',
    'aaaaaaaaaaaaaa',
    'abcdefghijkl',
    'iloveyou2024!',
    'welcomewelcome',
    'letmein123456',
    'Parola-spine-1',
  ])('refuses %s', password => {
    expect(checkPasswordPolicy(password)).toMatch(/too easy to guess/);
  });

  it.each([
    'correct horse battery staple',
    'a-long-test-password',
    'mauve-lantern-quarry-47',
    'Tr0ub4dor&3-meadow',
    'my dog ate the green kettle',
  ])('accepts %s', password => {
    expect(checkPasswordPolicy(password)).toBeNull();
  });

  it('refuses a password made of the address', () => {
    expect(checkPasswordPolicy('alexandru-2026-x', { email: 'alexandru@example.net' })).toMatch(/too easy/);
    expect(checkPasswordPolicy('alexandru-2026-x')).toBeNull();
  });

  it('keeps the length rules first', () => {
    expect(checkPasswordPolicy('short')).toMatch(/at least 12/);
    expect(checkPasswordPolicy(undefined)).toMatch(/required/);
  });
});
