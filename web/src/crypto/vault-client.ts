import { observeServerClock } from 'spine-core/store/sync';
import { sodium } from './sodium.js';
import {
  createAccountKeys, deriveFromPassword, lock, newId, newProfileKey, openObject, openObjectNow, openProfileKey, openProfileRecord, sealObject, sealProfileRecord,
  unlockWithMaster, unlockWithPasskey, type KdfParams, type UnlockedKeys, type VaultKeyPayload,
} from './keys.js';

/**
 * The device's side of the vault: derive the credential, unlock the keys, and move sealed objects to and from the server. Everything
 * the server is given is sealed or public; everything read back is opened here. `fetch` is a parameter so tests can stand in for it.
 */
export type ObjectKind = 'profile' | 'bundle' | 'blob' | 'library' | 'embedding' | 'log';

export interface ObjectMeta {
  id: string;
  profile_id: string;
  kind: ObjectKind;
  seq: number;
  size: number;
  wrapped_key: string;
  deleted: boolean;
  created_at: string;
  updated_at: string;
}

export interface ObjectList {
  seq: number;
  usage: { objects: number; bytes: number };
  objects: ObjectMeta[];
}

/** The object changed on another device since it was read; read it again and redo the change. */
export class ConflictError extends Error {
  constructor() {
    super('this object changed elsewhere');
    this.name = 'ConflictError';
  }
}

export class VaultFullError extends Error {
  constructor() {
    super('the vault is full');
    this.name = 'VaultFullError';
  }
}

type Fetch = typeof fetch;

/** `fetch` called on its own: kept as a field and called as `this.f(...)` the browser refuses it ("Illegal invocation"), so it is wrapped. */
const defaultFetch: Fetch = async (input, init) => {
  const sent = Date.now();
  const res = await fetch(input, init);
  // Every device sees the same server clock, and changes are stamped on it (see `observeServerClock`), so a wrong clock here does not decide a conflict.
  observeServerClock(res.headers.get('date'), sent, Date.now());
  return res;
};

async function fail(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (res.status === 409) throw new ConflictError();
  if (res.status === 413) throw new VaultFullError();
  throw Object.assign(new Error(body.error ?? `request failed (${res.status})`), { status: res.status, code: body.code });
}

const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** What a sign-in needs from the server before it can start. */
export async function fetchKdf(email: string, f: Fetch = defaultFetch): Promise<{ vault: false } | { vault: true; salt: string; params: KdfParams }> {
  const res = await f('/api/auth/kdf', json({ email }));
  if (!res.ok) return fail(res);
  return res.json();
}

/**
 * Step one of signing in: the credential to send in place of the password, and the master key to keep for step two. For an account
 * with no vault yet the password itself is the credential and there is no master key.
 */
export async function prepareSignIn(email: string, password: string, f: Fetch = defaultFetch): Promise<{ credential: string; masterKey: Uint8Array | null }> {
  const kdf = await fetchKdf(email, f);
  if (!kdf.vault) return { credential: password, masterKey: null };
  const { masterKey, authValue } = await deriveFromPassword(password, kdf.salt, kdf.params);
  return { credential: authValue, masterKey };
}

/** Everything sent to register: the credential, the keys, and the recovery key to show once. */
export async function prepareSignUp(password: string) {
  return createAccountKeys(password);
}

/** What a passkey sign-in leaves for opening the vault: its PRF output, which credential it came from, and the sealed key the server holds for it. */
export interface PasskeyUnlock { prf: Uint8Array; credentialId: string; wrapped: string }

export class VaultSession {
  private profileKeys = new Map<string, Uint8Array>();

  private constructor(
    readonly unlocked: UnlockedKeys,
    /** The keys as the server holds them; replaced after a change of password or of kit. */
    public keys: VaultKeyPayload,
    private readonly f: Fetch,
  ) {}

  /** Step two, once the server has accepted the credential (and any second factor): fetch the keys and open them. */
  static async open(masterKey: Uint8Array, f: Fetch = defaultFetch): Promise<VaultSession> {
    const res = await f('/api/vault/keys');
    if (!res.ok) return fail(res);
    const payload = (await res.json()) as VaultKeyPayload & { seq: number };
    const unlocked = await unlockWithMaster(masterKey, payload);
    return new VaultSession(unlocked, payload, f);
  }

  /** The same step with a passkey's PRF output (`passkey-prf.ts`) in place of the master key. */
  static async openWithPasskey(unlock: PasskeyUnlock, f: Fetch = defaultFetch): Promise<VaultSession> {
    const res = await f('/api/vault/keys');
    if (!res.ok) return fail(res);
    const payload = (await res.json()) as VaultKeyPayload & { seq: number };
    const unlocked = await unlockWithPasskey(unlock.prf, unlock.credentialId, unlock.wrapped, payload);
    return new VaultSession(unlocked, payload, f);
  }

  /** Right after sign-up, when the keys are already in memory. */
  static adopt(unlocked: UnlockedKeys, keys: VaultKeyPayload, f: Fetch = defaultFetch): VaultSession {
    return new VaultSession(unlocked, keys, f);
  }

  async list(since = 0): Promise<ObjectList> {
    const res = await this.f(`/api/vault/objects?since=${since}`);
    if (!res.ok) return fail(res);
    return res.json();
  }

  /** The profiles this account has, opened. */
  async loadProfiles(): Promise<Array<{ id: string; name: string }>> {
    const out: Array<{ id: string; name: string }> = [];
    for (const meta of (await this.list(0)).objects) {
      if (meta.kind !== 'profile' || meta.deleted) continue;
      const got = await this.fetchObject(meta.id);
      const profileKey = await openProfileKey(this.unlocked, meta.id, got.wrappedKey);
      this.profileKeys.set(meta.id, profileKey);
      const record = JSON.parse(new TextDecoder().decode(await openProfileRecord(profileKey, meta.id, got.body))) as { name: string };
      out.push({ id: meta.id, name: record.name });
    }
    return out;
  }

  async createProfile(name: string): Promise<string> {
    const id = await newId();
    const { profileKey, wrapped } = await newProfileKey(this.unlocked, id);
    const body = await sealProfileRecord(profileKey, id, new TextEncoder().encode(JSON.stringify({ name })));
    await this.send(id, 'profile', id, body, wrapped, 0);
    this.profileKeys.set(id, profileKey);
    return id;
  }

  private keyOf(profileId: string): Uint8Array {
    const key = this.profileKeys.get(profileId);
    if (!key) throw new Error('profile not loaded');
    return key;
  }

  /** Seals and stores an object; returns its new sequence number. `baseSeq` is the one read last (0 for a new object). */
  async put(profileId: string, kind: Exclude<ObjectKind, 'profile'>, id: string, plaintext: Uint8Array, baseSeq = 0): Promise<number> {
    const sealed = await sealObject(this.keyOf(profileId), kind, id, plaintext);
    return this.send(id, kind, profileId, sealed.body, sealed.wrappedKey, baseSeq);
  }

  /** Reads and opens an object. */
  async get(id: string, kind: Exclude<ObjectKind, 'profile'>): Promise<{ plaintext: Uint8Array; seq: number; profileId: string }> {
    const got = await this.fetchObject(id);
    const plaintext = await openObject(this.keyOf(got.profileId), kind, id, got.body, got.wrappedKey);
    return { plaintext, seq: got.seq, profileId: got.profileId };
  }

  /**
   * `get` without waiting, for the core's file system, which must answer a read at once: a synchronous request, which a worker may make
   * (a page may not). Libsodium and the profile must already be loaded.
   */
  getSync(id: string, kind: Exclude<ObjectKind, 'profile'>): Uint8Array {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/api/vault/objects/${encodeURIComponent(id)}`, false);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    if (xhr.status !== 200) throw Object.assign(new Error(`could not read an object of the vault (${xhr.status})`), { status: xhr.status });
    return openObjectNow(this.keyOf(xhr.getResponseHeader('x-spine-profile') ?? ''), kind, id, new Uint8Array(xhr.response as ArrayBuffer), xhr.getResponseHeader('x-spine-wrapped-key') ?? '');
  }

  async remove(id: string, baseSeq: number): Promise<number> {
    const res = await this.f(`/api/vault/objects/${encodeURIComponent(id)}?base=${baseSeq}`, { method: 'DELETE' });
    if (!res.ok) return fail(res);
    return ((await res.json()) as { seq: number }).seq;
  }

  private async send(id: string, kind: ObjectKind, profileId: string, body: Uint8Array, wrappedKey: string, baseSeq: number): Promise<number> {
    const res = await this.f(`/api/vault/objects/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'x-spine-kind': kind,
        'x-spine-profile': profileId,
        'x-spine-wrapped-key': wrappedKey,
        'x-spine-base-seq': String(baseSeq),
      },
      body: body as BodyInit,
    });
    if (!res.ok) return fail(res);
    return ((await res.json()) as { seq: number }).seq;
  }

  private async fetchObject(id: string): Promise<{ body: Uint8Array; wrappedKey: string; seq: number; profileId: string }> {
    const res = await this.f(`/api/vault/objects/${encodeURIComponent(id)}`);
    if (!res.ok) return fail(res);
    return {
      body: new Uint8Array(await res.arrayBuffer()),
      wrappedKey: res.headers.get('x-spine-wrapped-key') ?? '',
      seq: Number(res.headers.get('x-spine-seq')),
      profileId: res.headers.get('x-spine-profile') ?? '',
    };
  }

  /** Signing out: the keys are wiped from memory. */
  async close(): Promise<void> {
    await lock(this.unlocked);
    for (const k of this.profileKeys.values()) (await sodium()).memzero(k);
    this.profileKeys.clear();
  }
}

