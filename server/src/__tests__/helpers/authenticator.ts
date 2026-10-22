import crypto from 'node:crypto';

/**
 * A software authenticator for tests: what a phone or a security key does, with a key kept in memory, so the real routes and the
 * real verification run. It makes "none" attestations and ES256 assertions, the common case.
 */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    throw new Error('too long for this encoder');
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') { const b = Buffer.from(value); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error('unsupported');
}

const b64 = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest();

export interface AuthenticatorOptions {
  rpId: string;
  origin: string;
}

export class SoftAuthenticator {
  readonly id = crypto.randomBytes(32);
  readonly userHandle = crypto.randomBytes(16);
  counter = 0;
  private readonly key = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });

  constructor(private readonly rp: AuthenticatorOptions) {}

  private cose(): Buffer {
    const jwk = this.key.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  }

  private authData(flags: number, withKey: boolean): Buffer {
    const counter = Buffer.alloc(4); counter.writeUInt32BE(this.counter);
    const parts: Buffer[] = [sha256(this.rp.rpId), Buffer.from([flags]), counter];
    if (withKey) {
      const idLength = Buffer.alloc(2); idLength.writeUInt16BE(this.id.length);
      parts.push(Buffer.alloc(16), idLength, Buffer.from(this.id), this.cose());
    }
    return Buffer.concat(parts);
  }

  /** The reply to `navigator.credentials.create`. `userVerified: false` is a key that was tapped without a fingerprint or PIN. */
  register(challenge: string, o: { userVerified?: boolean; origin?: string } = {}) {
    const flags = 0x01 | (o.userVerified === false ? 0 : 0x04) | 0x40;
    const attestationObject = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(flags, true)]]));
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: o.origin ?? this.rp.origin, crossOrigin: false }));
    return {
      id: b64(this.id), rawId: b64(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ['internal'] },
    };
  }

  /** The reply to `navigator.credentials.get`. */
  assert(challenge: string, o: { userVerified?: boolean; origin?: string; counter?: number } = {}) {
    this.counter = o.counter ?? this.counter + 1;
    const flags = 0x01 | (o.userVerified === false ? 0 : 0x04);
    const authenticatorData = this.authData(flags, false);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: o.origin ?? this.rp.origin, crossOrigin: false }));
    const signature = crypto.sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), { key: this.key.privateKey, dsaEncoding: 'der' });
    return {
      id: b64(this.id), rawId: b64(this.id), type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64(clientDataJSON), authenticatorData: b64(authenticatorData), signature: b64(signature), userHandle: b64(this.userHandle) },
    };
  }
}
