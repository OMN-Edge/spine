import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { readSigners } from '../ingestion/signatures-cms.js';

// Made by fixtures/make-signed-pdf.py with openssl; the names are invented. openssl verifies each one; `pdfsig` is not asked, because it
// refuses these test certificates that its own check of a real clinic's file accepts, so it cannot stand for the fixture here.
const load = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));

describe('reading digital signatures without poppler', () => {
  it('names the signer of an RSA signature, with the time the signature carries', async () => {
    const [signer, ...rest] = await readSigners(load('signed-rsa.pdf'));
    expect(rest).toEqual([]);
    expect(signer.name).toBe('Ana Testescu');
    expect(signer.signedAt).toMatch(/^2026-10-24T/);
  });

  it('names the signer of an ECDSA signature', async () => {
    expect((await readSigners(load('signed-ec.pdf'))).map(s => s.name)).toEqual(['Dan Exemplu']);
  });

  it('does not count a company seal, which has a common name and no given name', async () => {
    expect(await readSigners(load('signed-seal.pdf'))).toEqual([]);
  });

  it('does not count a signature once a byte it covered has changed', async () => {
    const bytes = load('signed-rsa.pdf');
    const at = new TextDecoder('latin1').decode(bytes).indexOf('/MediaBox') + 10;
    bytes[at] = bytes[at] === 0x39 ? 0x38 : bytes[at] + 1;
    expect(await readSigners(bytes)).toEqual([]);
  });

  it('does not count a signature whose own bytes were damaged', async () => {
    const bytes = load('signed-rsa.pdf');
    const text = new TextDecoder('latin1').decode(bytes);
    // The last non-zero hex digits of the contents are the end of the signature value itself.
    const start = text.indexOf('/Contents <') + 11;
    let end = start + 8192;
    while (text[end - 1] === '0') end--;
    bytes[end - 1] = bytes[end - 1] === 0x31 ? 0x32 : 0x31;
    expect(await readSigners(bytes)).toEqual([]);
  });

  it('finds nothing in a PDF with no signature, in text, or in bytes that are not a PDF', async () => {
    expect(await readSigners(new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<< >>\nendobj\n%%EOF'))).toEqual([]);
    expect(await readSigners(new Uint8Array([1, 2, 3]))).toEqual([]);
  });
});

// Made by fixtures/make-chain-fixtures.sh: an invented root, and signers whose certificates it signed (or another invented root, or in the past).
/** A DER value: the tag, the length, and the parts. */
function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((n, p) => n + p.length, 0);
  const head = length < 128 ? [tag, length] : [tag, 0x81, length];
  return Uint8Array.from([...head, ...parts.flatMap(p => [...p])]);
}
const OID_SIGNED_DATA = Uint8Array.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02]);
const OID_DATA = Uint8Array.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x01]);

/** The signed RSA fixture with its signature (the /Contents) replaced by `cms`, which the signed bytes do not cover. */
function withContents(cms: Uint8Array): Uint8Array {
  const bytes = load('signed-rsa.pdf');
  const at = new TextDecoder('latin1').decode(bytes).indexOf('/Contents <') + 11;
  const hex = Array.from(cms, b => b.toString(16).padStart(2, '0')).join('');
  for (let i = 0; i < hex.length; i++) bytes[at + i] = hex.charCodeAt(i);
  for (let i = hex.length; bytes[at + i] !== 0x3e; i++) bytes[at + i] = 0x30;
  return bytes;
}

describe('a signature that is not what it says', () => {
  it('counts nothing when the contents are not a CMS signed-data structure', async () => {
    expect(await readSigners(withContents(der(0x30, OID_DATA)))).toEqual([]);
  });

  it('counts nothing when the signed data holds no signer', async () => {
    const empty = der(0x30, OID_SIGNED_DATA, der(0xa0, der(0x30, der(0x02, Uint8Array.of(1)), der(0x31), der(0x30, OID_DATA), der(0x31))));
    expect(await readSigners(withContents(empty))).toEqual([]);
  });

  it('counts nothing for contents that stop short', async () => {
    expect(await readSigners(withContents(Uint8Array.of(0x30, 0x82, 0xff)))).toEqual([]);
  });
});

describe('who vouches for a signer', () => {
  const root = load('chain-root.der');

  it('marks a signer verified when the file’s certificates chain up to an anchor the operator named', async () => {
    expect(await readSigners(load('signed-chain-good.pdf'), [root])).toMatchObject([{ name: 'Ana Exemplu', verified: true }]);
  });

  it('keeps the name but does not verify it with no anchors, or with the wrong one', async () => {
    expect(await readSigners(load('signed-chain-good.pdf'))).toMatchObject([{ name: 'Ana Exemplu', verified: false }]);
    expect(await readSigners(load('signed-chain-good.pdf'), [load('signed-ec.pdf').subarray(0, 10)])).toMatchObject([{ verified: false }]); // not a certificate
  });

  it('does not verify a certificate issued by a root the operator did not name', async () => {
    expect(await readSigners(load('signed-chain-foreign.pdf'), [root])).toMatchObject([{ name: 'Maria Altceva', verified: false }]);
  });

  it('does not verify a certificate that had expired when it was used', async () => {
    expect(await readSigners(load('signed-chain-old.pdf'), [root])).toMatchObject([{ name: 'Ion Vechi', verified: false }]);
  });

  it('does not verify a self-signed certificate that names a real-looking person', async () => {
    expect(await readSigners(load('signed-rsa.pdf'), [root])).toMatchObject([{ name: 'Ana Testescu', verified: false }]);
  });
});
