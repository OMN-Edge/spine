import fs from 'fs';
import path from 'path';

/**
 * The certificates the operator names as authorities for digital signatures (SECURITY.md S-23): `.pem`, `.crt`, `.cer` and `.der`
 * files in `SPINE_TRUST_ANCHORS_DIR`. Public data. A signer is marked verified only when the certificates in a signed file lead
 * to one of these; with none, a signature is still read but is a label. At most 200 files of 64 KiB are read; anything else is skipped.
 */
const MAX_FILES = 200;
const MAX_BYTES = 64 * 1024;

export function trustAnchorsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = (env.SPINE_TRUST_ANCHORS_DIR ?? '').trim();
  return dir ? path.resolve(dir) : null;
}

/** DER certificates: a PEM file may hold several, a binary one holds one. */
export function loadTrustAnchors(dir: string | null = trustAnchorsDir()): Uint8Array[] {
  if (!dir) return [];
  let names: string[];
  try { names = fs.readdirSync(dir).filter(n => /\.(pem|crt|cer|der)$/i.test(n)).sort().slice(0, MAX_FILES); } catch { return []; }
  const out: Uint8Array[] = [];
  for (const name of names) {
    try {
      const file = path.join(dir, name);
      if (fs.statSync(file).size > MAX_BYTES) continue;
      const raw = fs.readFileSync(file);
      const asText = raw.toString('latin1');
      if (asText.includes('-----BEGIN CERTIFICATE-----')) {
        for (const m of asText.matchAll(/-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/g)) out.push(new Uint8Array(Buffer.from(m[1].replace(/\s+/g, ''), 'base64')));
      } else if (raw[0] === 0x30) {
        out.push(new Uint8Array(raw));
      }
    } catch { /* a file that cannot be read names no authority */ }
  }
  return out;
}
