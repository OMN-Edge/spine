import { sodium, toB64, fromB64 } from './sodium.js';
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';

/**
 * The browser side of opening the vault with a passkey (the WebAuthn PRF extension). A sign-in asks the authenticator to evaluate its PRF
 * on a fixed input; the 32 bytes that come back are the same every time for this passkey and mean nothing to anyone else. They are used
 * on the device to open the account key (`keys.ts`) and are **removed from what is sent to the server**, which verifies the sign-in and
 * never sees them.
 *
 * Not every authenticator has the extension (Chrome 116+, Safari 18+, Firefox 135+ with a platform or a recent security key). Without it
 * the sign-in still works and the vault asks for the master password, as before.
 */
export const prfSupported = (): boolean =>
  typeof PublicKeyCredential !== 'undefined' && typeof (PublicKeyCredential as { parseRequestOptionsFromJSON?: unknown }).parseRequestOptionsFromJSON === 'function';

const LABEL = 'spine/v1/passkey-prf';

/** The fixed input: a hash of a label, so it is 32 bytes and the same on every device. */
async function prfInput(): Promise<string> {
  const s = await sodium();
  return toB64(s, s.crypto_generichash(32, LABEL, null));
}

type PrfJson = { clientExtensionResults?: { prf?: { enabled?: boolean; results?: { first?: string } } } };

/** The ceremony with the PRF asked for. `prf` is null when the authenticator gave none; `response` is safe to send to the server. */
export async function getWithPrf(options: PublicKeyCredentialRequestOptionsJSON): Promise<{ response: AuthenticationResponseJSON; prf: Uint8Array | null }> {
  if (!prfSupported()) throw new Error('this browser cannot open the vault with a passkey');
  const publicKey = (PublicKeyCredential as unknown as { parseRequestOptionsFromJSON(o: unknown): PublicKeyCredentialRequestOptions })
    .parseRequestOptionsFromJSON({ ...options, extensions: { ...options.extensions, prf: { eval: { first: await prfInput() } } } });
  const credential = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error('no passkey was chosen');
  const json = (credential as unknown as { toJSON(): AuthenticationResponseJSON & PrfJson }).toJSON();
  const first = json.clientExtensionResults?.prf?.results?.first;
  const s = await sodium();
  const prf = first ? fromB64(s, first) : null;
  // What the server gets has no extension results: the PRF output stays on this device.
  return { response: { ...json, clientExtensionResults: {} } as AuthenticationResponseJSON, prf };
}
