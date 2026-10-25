import type { DigitalSigner } from './signatures-parse.js';

/**
 * Reading the digital signatures of a PDF without poppler, so the device can do what the server does with `pdfsig`:
 * a signature counts when the bytes it covers still match it. That alone is a check of integrity, not of who holds the
 * certificate, so a name is a label from the file (SECURITY.md S-23). Given trust anchors (certificates the operator
 * names), a signer is also marked `verified` when the certificates in the file chain up to one of them: every link
 * signed by the next, every certificate in date at the time of signing, every issuer a CA. Revocation is read only from the lists inside
 * the signature (a CRL it carries), never looked up (that would tell a third party whose certificate was used): a certificate a signed
 * list shows as revoked before the signing makes the signer not verified; with no usable list the answer is `unknown`. OCSP responses and
 * PAdES document security stores are not read. Pure: bytes in,
 * signers out, WebCrypto only.
 */

type Source = Parameters<typeof crypto.subtle.digest>[1];

interface Node { tag: number; start: number; header: number; end: number }

function read(bytes: Uint8Array, at: number): Node {
  if (at + 2 > bytes.length) throw new Error('truncated');
  const tag = bytes[at];
  let length = bytes[at + 1];
  let header = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || at + 2 + count > bytes.length) throw new Error('unsupported length');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[at + 2 + i];
    header += count;
  }
  const end = at + header + length;
  if (end > bytes.length) throw new Error('truncated');
  return { tag, start: at, header, end };
}

function children(bytes: Uint8Array, node: Node): Node[] {
  const out: Node[] = [];
  for (let at = node.start + node.header; at < node.end;) { const child = read(bytes, at); out.push(child); at = child.end; }
  return out;
}

const body = (bytes: Uint8Array, node: Node) => bytes.subarray(node.start + node.header, node.end);
const whole = (bytes: Uint8Array, node: Node) => bytes.subarray(node.start, node.end);

function oid(bytes: Uint8Array, node: Node): string {
  const b = body(bytes, node);
  const parts: number[] = [];
  let value = 0;
  for (const byte of b) { value = value * 128 + (byte & 0x7f); if (!(byte & 0x80)) { parts.push(value); value = 0; } }
  const first = parts.shift() ?? 0;
  return [first < 40 ? 0 : first < 80 ? 1 : 2, first < 40 ? first : first < 80 ? first - 40 : first - 80, ...parts].join('.');
}

const HASHES: Record<string, string> = {
  '1.3.14.3.2.26': 'SHA-1', '2.16.840.1.101.3.4.2.1': 'SHA-256', '2.16.840.1.101.3.4.2.2': 'SHA-384', '2.16.840.1.101.3.4.2.3': 'SHA-512',
};
const CURVES: Record<string, { name: string; size: number }> = {
  '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 }, '1.3.132.0.34': { name: 'P-384', size: 48 }, '1.3.132.0.35': { name: 'P-521', size: 66 },
};
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';
const OID_RSA = '1.2.840.113549.1.1.1';
const OID_RSA_PSS = '1.2.840.113549.1.1.10';
const OID_EC = '1.2.840.10045.2.1';
const NAME_PARTS: Record<string, string> = { '2.5.4.42': 'givenName', '2.5.4.4': 'SN', '2.5.4.3': 'CN' };

const text = (bytes: Uint8Array, node: Node) => node.tag === 0x1e
  ? new TextDecoder('utf-16be').decode(body(bytes, node))
  : new TextDecoder(node.tag === 0x0c ? 'utf-8' : 'latin1').decode(body(bytes, node));

/** A UTCTime or GeneralizedTime as an ISO string, or null. */
function parseTime(bytes: Uint8Array, value: Node): string | null {
  const raw = text(bytes, value);
  const m = value.tag === 0x17 ? raw.match(/^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/) : raw.match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/);
  if (!m) return null;
  const year = value.tag === 0x17 ? (Number(m[1]) >= 50 ? 1900 : 2000) + Number(m[1]) : Number(m[1]);
  const time = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

/** The parts of a certificate's subject this reads: given name, surname, common name. */
function subject(bytes: Uint8Array, subjectNode: Node): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rdn of children(bytes, subjectNode)) for (const pair of children(bytes, rdn)) {
    const [type, value] = children(bytes, pair);
    const name = NAME_PARTS[oid(bytes, type)];
    if (name && value && !(name in out)) out[name] = text(bytes, value);
  }
  return out;
}

interface Certificate {
  der: Uint8Array; serial: Uint8Array; issuerAndSerial: string; spki: Uint8Array; subject: Record<string, string>; keyAlgorithm: string; curve: string | null;
  issuerDer: Uint8Array; subjectDer: Uint8Array; notBefore: string | null; notAfter: string | null; isCa: boolean;
  tbs: Uint8Array; signatureAlgorithm: string; signature: Uint8Array;
}

const OID_BASIC_CONSTRAINTS = '2.5.29.19';

function certificate(bytes: Uint8Array, node: Node): Certificate {
  const [tbs, outerAlgorithm, outerSignature] = children(bytes, node);
  let parts = children(bytes, tbs);
  if (parts[0].tag === 0xa0) parts = parts.slice(1); // the explicit version
  const [serial, , issuer, validity, subjectNode, spki] = parts;
  const [from, to] = children(bytes, validity);
  let isCa = false;
  const extensions = parts.find(n => n.tag === 0xa3);
  if (extensions) {
    for (const extension of children(bytes, children(bytes, extensions)[0])) {
      const fields = children(bytes, extension);
      if (oid(bytes, fields[0]) !== OID_BASIC_CONSTRAINTS) continue;
      const inner = children(bytes, read(bytes, fields[fields.length - 1].start + fields[fields.length - 1].header));
      isCa = inner[0]?.tag === 0x01 && body(bytes, inner[0])[0] !== 0;
    }
  }
  const algorithm = children(bytes, children(bytes, spki)[0]);
  const keyAlgorithm = oid(bytes, algorithm[0]);
  return {
    der: whole(bytes, node),
    serial: body(bytes, serial),
    issuerAndSerial: `${hex(whole(bytes, issuer))}:${hex(body(bytes, serial))}`,
    spki: whole(bytes, spki),
    subject: subject(bytes, subjectNode),
    keyAlgorithm,
    curve: keyAlgorithm === OID_EC && algorithm[1] ? oid(bytes, algorithm[1]) : null,
    issuerDer: whole(bytes, issuer),
    subjectDer: whole(bytes, subjectNode),
    notBefore: parseTime(bytes, from),
    notAfter: parseTime(bytes, to),
    isCa,
    tbs: whole(bytes, tbs),
    signatureAlgorithm: oid(bytes, children(bytes, outerAlgorithm)[0]),
    signature: body(bytes, outerSignature).subarray(1), // the first byte of a BIT STRING counts unused bits
  };
}

/** An ECDSA signature is a DER pair; WebCrypto wants the two numbers side by side at the curve's size. */
function rawEcdsa(bytes: Uint8Array, node: Node, size: number): Uint8Array {
  const out = new Uint8Array(size * 2);
  children(bytes, node).slice(0, 2).forEach((integer, i) => {
    let value = body(bytes, integer);
    while (value.length > size && value[0] === 0) value = value.subarray(1);
    if (value.length > size) throw new Error('number too long');
    out.set(value, size * (i + 1) - value.length);
  });
  return out;
}

async function digest(name: string, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(name, data as Source));
}

/** The hash and key family a certificate's own signature algorithm names; RSA-PSS and anything unlisted is not checked (so not trusted). */
const CERT_SIGNATURES: Record<string, { hash: string; family: 'rsa' | 'ec' }> = {
  '1.2.840.113549.1.1.5': { hash: 'SHA-1', family: 'rsa' }, '1.2.840.113549.1.1.11': { hash: 'SHA-256', family: 'rsa' },
  '1.2.840.113549.1.1.12': { hash: 'SHA-384', family: 'rsa' }, '1.2.840.113549.1.1.13': { hash: 'SHA-512', family: 'rsa' },
  '1.2.840.10045.4.3.2': { hash: 'SHA-256', family: 'ec' }, '1.2.840.10045.4.3.3': { hash: 'SHA-384', family: 'ec' }, '1.2.840.10045.4.3.4': { hash: 'SHA-512', family: 'ec' },
};

/** What a certificate and a revocation list have in common: the bytes that were signed, how, and the signature. */
interface Signed { tbs: Uint8Array; signatureAlgorithm: string; signature: Uint8Array }

/** Was `cert` (a certificate, or a revocation list) signed by the key in `issuer`? */
async function signedBy(cert: Signed, issuer: Certificate): Promise<boolean> {
  const how = CERT_SIGNATURES[cert.signatureAlgorithm];
  if (!how) return false;
  try {
    if (how.family === 'rsa' && issuer.keyAlgorithm === OID_RSA) {
      const key = await crypto.subtle.importKey('spki', issuer.spki as Source, { name: 'RSASSA-PKCS1-v1_5', hash: how.hash }, false, ['verify']);
      return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, cert.signature as Source, cert.tbs as Source);
    }
    if (how.family === 'ec' && issuer.keyAlgorithm === OID_EC && issuer.curve && CURVES[issuer.curve]) {
      const curve = CURVES[issuer.curve];
      const key = await crypto.subtle.importKey('spki', issuer.spki as Source, { name: 'ECDSA', namedCurve: curve.name }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'ECDSA', hash: how.hash }, key, rawEcdsa(cert.signature, read(cert.signature, 0), curve.size) as Source, cert.tbs as Source);
    }
  } catch { /* a key this cannot use does not vouch */ }
  return false;
}

/** A revocation list: who issued it, when, and the serial numbers it names with the date each was revoked (null: a date this cannot read). */
interface RevocationList extends Signed { issuerDer: Uint8Array; thisUpdate: string | null; revoked: Map<string, string | null> }

function revocationList(bytes: Uint8Array, node: Node): RevocationList {
  const [tbs, outerAlgorithm, outerSignature] = children(bytes, node);
  let parts = children(bytes, tbs);
  if (parts[0].tag === 0x02) parts = parts.slice(1); // the version
  const [, issuer, thisUpdate, ...rest] = parts;
  const revoked = new Map<string, string | null>();
  // After the times come the revoked certificates, then the extensions ([0]); the next update is a time as well.
  const list = rest.find(n => n.tag === 0x30);
  if (list) for (const entry of children(bytes, list)) {
    const [serial, date] = children(bytes, entry);
    revoked.set(hex(body(bytes, serial)), date ? parseTime(bytes, date) : null);
  }
  return {
    tbs: whole(bytes, tbs),
    signatureAlgorithm: oid(bytes, children(bytes, outerAlgorithm)[0]),
    signature: body(bytes, outerSignature).subarray(1),
    issuerDer: whole(bytes, issuer),
    thisUpdate: parseTime(bytes, thisUpdate),
    revoked,
  };
}

const inDate = (cert: Certificate, at: string) => !!cert.notBefore && !!cert.notAfter && cert.notBefore <= at && at <= cert.notAfter;

/**
 * The certificates from `signer` up to one of the anchors, if the file's certificates lead there, each link signed by the next and in date
 * at `at`: the signer, any intermediate authorities, and the anchor last. Null if they do not.
 */
async function chainOf(signer: Certificate, pool: Certificate[], anchors: Certificate[], at: string): Promise<Certificate[] | null> {
  let current = signer;
  const path: Certificate[] = [];
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth++) {
    if (!inDate(current, at) || seen.has(hex(current.der))) return null;
    seen.add(hex(current.der));
    path.push(current);
    if (anchors.some(a => same(a.der, current.der))) return path;
    for (const anchor of anchors) {
      if (same(anchor.subjectDer, current.issuerDer) && inDate(anchor, at) && await signedBy(current, anchor)) return [...path, anchor];
    }
    const next = pool.find(c => !same(c.der, current.der) && c.isCa && same(c.subjectDer, current.issuerDer));
    if (!next || !(await signedBy(current, next))) return null;
    current = next;
  }
  return null;
}

/**
 * What the lists in the file say about every certificate below the anchor, as of `at` (the signing). A signed list that names a
 * certificate as revoked on or before `at` makes it `revoked`. One issued after `at` that does not name it (or names it later) shows it
 * was fine when it signed. Without such a list for a link the answer is `unknown`: nothing is looked up, and a list issued before the
 * signing cannot show that a certificate was not revoked in between.
 */
async function revocationOf(path: Certificate[], lists: RevocationList[], at: string): Promise<'good' | 'revoked' | 'unknown'> {
  let unknown = false;
  for (let i = 0; i < path.length - 1; i++) {
    const cert = path[i];
    const issuer = path[i + 1];
    let status: 'good' | 'unknown' = 'unknown';
    for (const list of lists) {
      if (!same(list.issuerDer, cert.issuerDer) || !(await signedBy(list, issuer))) continue;
      const when = list.revoked.get(hex(cert.serial));
      if (when !== undefined) {
        if (when === null || when <= at) return 'revoked'; // an unreadable date is read as the worst
        status = 'good'; // revoked, but after it signed
      } else if (list.thisUpdate && list.thisUpdate >= at) {
        status = 'good';
      }
    }
    if (status === 'unknown') unknown = true;
  }
  return unknown ? 'unknown' : 'good';
}

const hex = (b: Uint8Array) => Array.from(b, v => v.toString(16).padStart(2, '0')).join('');
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Does the CMS signature in `cms` hold for `signed` (the bytes outside the signature)? Returns the signer, or null. */
async function check(cms: Uint8Array, signed: Uint8Array, fallbackTime: string | null, anchors: Certificate[]): Promise<DigitalSigner | null> {
  const info = children(cms, read(cms, 0));
  if (oid(cms, info[0]) !== OID_SIGNED_DATA) return null;
  const signedData = children(cms, children(cms, info[1])[0]);
  const certNode = signedData.find(n => n.tag === 0xa0);
  const certificates = certNode ? children(cms, certNode).filter(n => n.tag === 0x30).map(n => certificate(cms, n)) : [];
  // Revocation lists the signer put in the signature ([1]); one that cannot be read is left out.
  const listNode = signedData.find(n => n.tag === 0xa1);
  const lists: RevocationList[] = [];
  if (listNode) for (const n of children(cms, listNode)) if (n.tag === 0x30) { try { lists.push(revocationList(cms, n)); } catch { /* a list this cannot read says nothing */ } }
  const signerInfo = children(cms, signedData[signedData.length - 1])[0];
  if (!signerInfo) return null;

  const parts = children(cms, signerInfo);
  const sid = parts[1];
  const hashName = HASHES[oid(cms, children(cms, parts[2])[0])];
  const attrs = parts.find(n => n.tag === 0xa0);
  const algorithm = parts[attrs ? 4 : 3];
  const signature = parts[attrs ? 5 : 4];
  if (!hashName || !attrs || !algorithm || !signature) return null;

  // sid is an IssuerAndSerialNumber, or a [0] subject key identifier (tried against every certificate).
  let wanted: string | null = null;
  if (sid.tag === 0x30) { const [issuer, serial] = children(cms, sid); wanted = `${hex(whole(cms, issuer))}:${hex(body(cms, serial))}`; }
  const candidates = certificates.filter(c => wanted === null || c.issuerAndSerial === wanted);

  let messageDigest: Uint8Array | null = null;
  let signingTime: string | null = null;
  for (const attribute of children(cms, attrs)) {
    const [type, values] = children(cms, attribute);
    const kind = oid(cms, type);
    const value = values ? children(cms, values)[0] : null;
    if (kind === OID_MESSAGE_DIGEST && value) messageDigest = body(cms, value);
    if (kind === OID_SIGNING_TIME && value) signingTime = parseTime(cms, value);
  }
  // The signature covers the attributes, which carry the digest of the file's bytes.
  if (!messageDigest || !same(messageDigest, await digest(hashName, signed))) return null;
  const toSign = Uint8Array.from(whole(cms, attrs));
  toSign[0] = 0x31; // signed as a SET, stored as [0]

  const algorithmId = oid(cms, children(cms, algorithm)[0]);
  for (const cert of candidates) {
    try {
      let ok = false;
      if (cert.keyAlgorithm === OID_RSA && algorithmId !== OID_RSA_PSS) {
        const key = await crypto.subtle.importKey('spki', cert.spki as Source, { name: 'RSASSA-PKCS1-v1_5', hash: hashName }, false, ['verify']);
        ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, body(cms, signature) as Source, toSign as Source);
      } else if (cert.keyAlgorithm === OID_EC && cert.curve && CURVES[cert.curve]) {
        const curve = CURVES[cert.curve];
        const key = await crypto.subtle.importKey('spki', cert.spki as Source, { name: 'ECDSA', namedCurve: curve.name }, false, ['verify']);
        ok = await crypto.subtle.verify({ name: 'ECDSA', hash: hashName }, key, rawEcdsa(cms, read(cms, signature.start + signature.header), curve.size) as Source, toSign as Source);
      }
      if (!ok) continue;
      // A personal signature has a given name and a surname; a company seal has neither (the serial number is an identifier of the person and is not kept).
      const { givenName, SN } = cert.subject;
      if (!givenName || !SN) return null;
      const signedAt = signingTime ?? fallbackTime;
      const at = signedAt ?? new Date().toISOString();
      const path = anchors.length > 0 ? await chainOf(cert, certificates, anchors, at) : null;
      const revocation = path ? await revocationOf(path, lists, at) : undefined;
      return { name: `${givenName} ${SN}`, signedAt, verified: !!path && revocation !== 'revoked', revocation };
    } catch { /* a key this cannot use is no match */ }
  }
  return null;
}

/** A signature without a signing-time attribute (CAdES leaves it out) says when in its dictionary's /M, `D:YYYYMMDDHHmmSS` and an offset. */
function dictionaryTime(latin: string, at: number): string | null {
  const start = Math.max(latin.lastIndexOf(' obj', at), 0);
  const end = latin.indexOf('endobj', at);
  const m = latin.slice(start, end < 0 ? at + 4000 : end).match(/\/M\s*\(D:(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:([+\-Z])(?:(\d\d)'?(\d\d)?'?)?)?\)/);
  if (!m) return null;
  const offset = m[7] === '+' || m[7] === '-' ? (m[7] === '+' ? 1 : -1) * (Number(m[8] ?? 0) * 60 + Number(m[9] ?? 0)) : 0;
  const time = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - offset * 60_000);
  return Number.isNaN(time.getTime()) ? null : time.toISOString();
}

/** The people whose signatures in a PDF still hold. Empty if there are none, or if anything goes wrong. */
export async function readSigners(pdf: Uint8Array, trustAnchors: Uint8Array[] = []): Promise<DigitalSigner[]> {
  const out: DigitalSigner[] = [];
  const anchors: Certificate[] = [];
  for (const der of trustAnchors) { try { anchors.push(certificate(der, read(der, 0))); } catch { /* an anchor this cannot read vouches for nobody */ } }
  const latin = new TextDecoder('latin1').decode(pdf);
  for (const match of latin.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g)) {
    try {
      const [a, b, c, d] = match.slice(1).map(Number);
      if (a !== 0 || a + b > c || c + d > pdf.length) continue;
      // The gap holds the signature as "<hex>", padded with zeros.
      const gap = latin.slice(a + b, c).trim();
      if (!gap.startsWith('<') || !gap.endsWith('>')) continue;
      const hex = gap.slice(1, -1).replace(/\s+/g, '');
      if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) continue;
      const cms = Uint8Array.from(hex.match(/../g) ?? [], h => parseInt(h, 16));
      const signed = new Uint8Array(b + d);
      signed.set(pdf.subarray(a, a + b));
      signed.set(pdf.subarray(c, c + d), b);
      const signer = await check(cms.subarray(0, read(cms, 0).end), signed, dictionaryTime(latin, match.index ?? 0), anchors);
      if (signer) out.push(signer);
    } catch { /* a signature this cannot read is not counted */ }
  }
  // The same person signing twice is one signer, verified if any of their signatures is.
  return out.filter((signer, i) => out.findIndex(o => o.name === signer.name) === i).map(signer => {
    const best = out.find(o => o.name === signer.name && o.verified) ?? signer;
    return { ...signer, verified: !!best.verified, revocation: best.revocation };
  });
}
