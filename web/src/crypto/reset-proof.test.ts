import { describe, it, expect } from 'vitest';
import { createAccountKeys, resetProof, resetVerifierOf, resetWithRecovery } from './keys';
import { verifyResetProof, resetMessage as serverMessage } from '../../../server/src/reset-proof';

/** The device signs and the server verifies, written apart (SECURITY.md S-38): one test that they agree on the bytes and the key. */
describe('the signature a reset by the recovery kit carries', () => {
  it('is accepted by the server for the verifier the account key makes, and for nothing else', async () => {
    const account = await createAccountKeys('a long enough master password');
    expect(account.keys.reset_verifier).toBe(await resetVerifierOf(account.unlocked.accountKey));

    const reset = await resetWithRecovery(account.recoveryKey, account.keys, 'another long master password');
    const token = 'T'.repeat(43);
    const proof = await resetProof(reset.unlocked.accountKey, token, reset.authValue, reset.keys);
    const message = serverMessage(token, reset.authValue, reset.keys, reset.keys.kdf_params);
    expect(verifyResetProof(account.keys.reset_verifier!, message, proof)).toBe(true);

    // another link, other keys, another account
    expect(verifyResetProof(account.keys.reset_verifier!, serverMessage('U'.repeat(43), reset.authValue, reset.keys, reset.keys.kdf_params), proof)).toBe(false);
    expect(verifyResetProof(account.keys.reset_verifier!, serverMessage(token, reset.authValue, { ...reset.keys, wrapped_by_master: account.keys.wrapped_by_master }, reset.keys.kdf_params), proof)).toBe(false);
    const other = await createAccountKeys('a long enough master password');
    expect(verifyResetProof(other.keys.reset_verifier!, message, proof)).toBe(false);
  });

  it('is the same key after a new master password, so a verifier added once keeps working', async () => {
    const account = await createAccountKeys('a long enough master password');
    const reset = await resetWithRecovery(account.recoveryKey, account.keys, 'another long master password');
    expect(await resetVerifierOf(reset.unlocked.accountKey)).toBe(account.keys.reset_verifier);
  });
});
