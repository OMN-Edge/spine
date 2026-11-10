/**
 * The code a share link's visitor and its owner compare before the owner approves (SECURITY.md S-40, M-19). Approval is of a browser, named by
 * the public key it made, and the server carries that key from the visitor to the owner, so a request the server made up with a key of its own
 * looks like a doctor's. Both sides show a short code made from the key: the visitor's page from the key it made, the owner's from the key the
 * request carries, and the owner approves only when the visitor reads out the same eight characters. A server that swaps the key cannot make
 * the codes agree without searching for a key that makes the visitor's (2^40 tries), and the person on the other end is who is read to.
 * Web Crypto only, so it is the same in the page, the device's core and the tests.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0, O, 1 or I: read aloud, or from paper, they are not mistaken

export async function visitorCode(publicKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(`spine/v1/share/visitor-code:${publicKey}`);
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  let code = '';
  for (let i = 0; i < 8; i++) code += ALPHABET[hash[i] & 31];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
