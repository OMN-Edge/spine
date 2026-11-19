import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A page of settings does not shout (T-23): the account page's security and device cards use the outlined button, and the teal one stays for what a section is mainly for (a plan to buy,
 * a seat to take). A card that goes back to the teal button, or a switch that weakens the account that is teal again, fails here.
 */
const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

describe('the account page’s buttons', () => {
  for (const file of ['pages/Account.tsx', 'components/TwoFactor.tsx', 'components/EmailTwoFactor.tsx', 'components/RecoveryKitSettings.tsx', 'components/Passkeys.tsx', 'components/AddDevice.tsx']) {
    it(`${file} has no primary button`, () => {
      expect(read(file)).not.toMatch(/\{buttonClass\}|\$\{buttonClass\}/);
    });
  }

  it('turning off recovery by email is a quiet text button, not a filled one', () => {
    const source = read('components/EmailRecovery.tsx');
    expect(source).not.toMatch(/\{buttonClass\}|\$\{buttonClass\}/);
    expect(source).toMatch(/on \? 'text-sm text-red-700 hover:underline/);
  });
});
