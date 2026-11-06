import { observeServerClock } from 'spine-core/store/sync';
import { visitorCode } from 'spine-core/share-code';
import { askForPassword } from '../reauth.js';
import { sodium, toB64 } from './sodium.js';
import type { SealedCache } from './sealed-cache.js';
import { checkKdfAnswer, type KdfAnswer } from './kdf-trust.js';
import {
  createAccountKeys, rewrapObjectKey, deriveFromPassword, lock, newId, newProfileKey, openObject, openObjectNow, openProfileKey, openProfileRecord, sealObject, sealProfileRecord,
  unlockWithMaster, unlockWithPasskey, type KdfParams, type UnlockedKeys, type VaultKeyPayload,
} from './keys.js';
import { fromInviteCode, helloFor, inviteKeyFromBlob, makeInvite, openGrantKey, openInvite, openPin, readHello, sealGrantKey, sealPin } from './delegation.js';

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

/** What a profile's record says of who it is: a name, and for a child a birth date (sealed with it, so only devices that hold the key know it). */
export interface ProfileSummary { id: string; name: string; kind?: 'child'; born?: string }

function readRecord(plain: Uint8Array): Omit<ProfileSummary, 'id'> {
  const r = JSON.parse(new TextDecoder().decode(plain)) as { name?: unknown; kind?: unknown; born?: unknown };
  return { name: typeof r.name === 'string' ? r.name : '', ...(r.kind === 'child' ? { kind: 'child' as const } : {}), ...(typeof r.born === 'string' ? { born: r.born } : {}) };
}

/** What `GET /api/delegations` answers (SECURITY.md M-49). */
export interface Delegations {
  owned: Array<{ id: string; profile_id: string; delegate_email: string; delegate_public_key: string | null; role: 'guardian' | 'viewer' | 'self'; state: 'pending' | 'active' | 'paused' | 'revoked'; created_at: string; delegate_hello: string | null; owner_blob: string | null; delegate_pin: string | null; bound: boolean }>;
  invites: Array<{ id: string; profile_id: string; role: 'guardian' | 'viewer' | 'self'; expires_at: string }>;
  received: Array<{ id: string; owner_email: string; owner_public_key: string | null; profile_id: string; role: 'guardian' | 'viewer' | 'self'; state: 'pending' | 'active' | 'paused' | 'revoked'; wrapped_key: string | null; owner_pin: string | null; delegate_pinned: boolean; others: Array<{ id: string; role: 'guardian' | 'viewer' | 'self'; state: 'pending' | 'active' | 'paused' | 'revoked'; delegate_email: string; delegate_public_key: string | null }> }>;
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
  // The answer decides what is sent next, so it is not taken as it comes (kdf-trust.ts).
  return checkKdfAnswer(email, await res.json()) as Awaited<ReturnType<typeof fetchKdf>>;
}

/**
 * Step one of signing in: the credential to send in place of the password, and the master key to keep for step two. For an account
 * with no vault yet the password itself is the credential and there is no master key.
 */
export async function prepareSignIn(
  email: string,
  password: string,
  f: Fetch = defaultFetch,
  /** Where the (slow, memory-hungry) key derivation runs; the page gives its core's worker, so the screen keeps moving while it does. */
  derive: Derive = deriveFromPassword,
): Promise<{ credential: string; masterKey: Uint8Array | null; kdf: KdfAnswer }> {
  const kdf = await fetchKdf(email, f);
  if (!kdf.vault) return { credential: password, masterKey: null, kdf };
  const { masterKey, authValue } = await derive(password, kdf.salt, kdf.params);
  return { credential: authValue, masterKey, kdf };
}

/** The keys as the server holds them, sealed. Fetched alone so a page can have them ready before the password is typed. */
export type KeysResponse = VaultKeyPayload & { seq: number };
export async function fetchKeys(f: Fetch = defaultFetch): Promise<KeysResponse> {
  const res = await f('/api/vault/keys');
  if (!res.ok) return fail(res);
  return (await res.json()) as KeysResponse;
}

/** Everything sent to register: the credential, the keys, and the recovery key to show once. */
export async function prepareSignUp(password: string) {
  return createAccountKeys(password);
}

/** What a passkey sign-in leaves for opening the vault: its PRF output, which credential it came from, and the sealed key the server holds for it. */
export type Derive = (password: string, salt: string, params: KdfParams) => Promise<{ masterKey: Uint8Array; authValue: string }>;

export interface PasskeyUnlock { prf: Uint8Array; credentialId: string; wrapped: string }

/** Written once and never changed, so a copy kept on the device cannot be stale: everything but the index (`library`) and the profile. */
const WRITTEN_ONCE = (kind: ObjectKind) => kind !== 'library' && kind !== 'profile';

export class VaultSession {
  private profileKeys = new Map<string, Uint8Array>();
  private cache: SealedCache | null = null;

  private constructor(
    readonly unlocked: UnlockedKeys,
    /** The keys as the server holds them; replaced after a change of password or of kit. */
    public keys: VaultKeyPayload,
    private readonly f: Fetch,
    /** Where this session's objects are: the account's own vault, or one profile of another account's (`delegated`). */
    private readonly base = '/api/vault',
    /** False for a session on a grant, which borrows the account's keys and must not wipe them when it ends. */
    private readonly owns = true,
  ) {}

  /** Step two, once the server has accepted the credential (and any second factor): fetch the keys and open them. */
  static async open(masterKey: Uint8Array, f: Fetch = defaultFetch, keys?: KeysResponse): Promise<VaultSession> {
    const payload = keys ?? (await fetchKeys(f));
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

  /**
   * A session on one profile of another account's vault, for a grant: the same calls over `/api/delegated/<grant>`, with the profile key the
   * grant held. It borrows this account's keys (they are not wiped when it ends) and holds a copy of the profile key of its own.
   */
  static delegated(parent: VaultSession, grantId: string, profileId: string, profileKey: Uint8Array): VaultSession {
    const session = new VaultSession(parent.unlocked, parent.keys, parent.f, `/api/delegated/${encodeURIComponent(grantId)}`, false);
    session.profileKeys.set(profileId, profileKey);
    return session;
  }

  /** A profile's record, read with the key held for it (for a person let in: the owner's record of who it is). */
  async profileRecord(profileId: string): Promise<Omit<ProfileSummary, 'id'>> {
    const got = await this.fetchObject(profileId);
    return readRecord(await openProfileRecord(this.keyOf(profileId), profileId, got.body));
  }

  /**
   * Changes who a profile says it is: the name and, for a child, the birth date. The record is opened, changed and sealed again under the
   * same key, and stored over the old one (`ConflictError` if another device changed it first). Only the account that owns the profile can: a
   * person let in cannot write the record. Nothing else in the vault changes.
   */
  async updateProfile(profileId: string, change: { name?: string; born?: string }): Promise<void> {
    const got = await this.fetchObject(profileId);
    const key = this.keyOf(profileId);
    const current = JSON.parse(new TextDecoder().decode(await openProfileRecord(key, profileId, got.body))) as Record<string, unknown>;
    const next = { ...current, ...(change.name !== undefined ? { name: change.name } : {}), ...(change.born !== undefined ? { born: change.born } : {}) };
    await this.send(profileId, 'profile', profileId, await sealProfileRecord(key, profileId, new TextEncoder().encode(JSON.stringify(next))), got.wrappedKey, got.seq);
  }

  /** Right after sign-up, when the keys are already in memory. */
  static adopt(unlocked: UnlockedKeys, keys: VaultKeyPayload, f: Fetch = defaultFetch): VaultSession {
    return new VaultSession(unlocked, keys, f);
  }

  /**
   * Where sealed objects are kept on this device, or none (the default): reads that find one there do not go to the server. `listed` is a
   * full listing the caller already holds, which says what the vault has, so what it no longer has is dropped from the copy.
   */
  useCache(cache: SealedCache | null, listed?: ObjectList): void {
    this.cache = cache;
    if (listed) this.dropUnlisted(listed);
  }

  private dropUnlisted(listed: ObjectList): void {
    if (this.cache) void this.cache.keepOnly(new Set(listed.objects.filter(o => !o.deleted).map(o => o.id)));
  }

  async list(since = 0): Promise<ObjectList> {
    const res = await this.f(`${this.base}/objects?since=${since}`);
    if (!res.ok) return fail(res);
    const listed = (await res.json()) as ObjectList;
    // A full listing says what the vault holds: what another device removed is not kept here any longer.
    if (since === 0) this.dropUnlisted(listed);
    return listed;
  }

  /** The profiles this account has, opened. `listed` is a listing the caller already has, so it is not asked for twice. */
  async loadProfiles(listed?: ObjectList): Promise<ProfileSummary[]> {
    const profiles = (listed ?? (await this.list(0))).objects.filter(meta => meta.kind === 'profile' && !meta.deleted);
    // Together, not one after the other: each is a round trip.
    return Promise.all(profiles.map(async meta => {
      const got = await this.fetchObject(meta.id);
      const profileKey = await openProfileKey(this.unlocked, meta.id, got.wrappedKey);
      this.profileKeys.set(meta.id, profileKey);
      return { id: meta.id, ...readRecord(await openProfileRecord(profileKey, meta.id, got.body)) };
    }));
  }

  private inflight = new Map<string, ReturnType<VaultSession['fetchObject']>>();

  /** Starts fetching an object now, for a read that will come once the keys to open it are ready; the read takes what was started. */
  prefetch(id: string): void {
    if (this.inflight.has(id)) return;
    const started = this.fetchObject(id, true);
    started.catch(() => undefined); // said to whoever reads it, not here
    this.inflight.set(id, started);
  }

  async createProfile(name: string, extra: { kind?: 'child'; born?: string } = {}): Promise<string> {
    const id = await newId();
    const { profileKey, wrapped } = await newProfileKey(this.unlocked, id);
    const body = await sealProfileRecord(profileKey, id, new TextEncoder().encode(JSON.stringify({ name, ...extra })));
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
    const seq = await this.send(id, kind, profileId, sealed.body, sealed.wrappedKey, baseSeq);
    // What this device wrote is what it will read next time (its own segments, the files it saved).
    if (WRITTEN_ONCE(kind)) void this.cache?.put(id, { body: sealed.body, wrappedKey: sealed.wrappedKey, seq, profileId });
    return seq;
  }

  /** Reads and opens an object. */
  async get(id: string, kind: Exclude<ObjectKind, 'profile'>): Promise<{ plaintext: Uint8Array; seq: number; profileId: string }> {
    const keep = WRITTEN_ONCE(kind) ? this.cache : null;
    const kept = keep ? await keep.get(id) : null;
    if (kept) {
      try {
        return { plaintext: await openObject(this.keyOf(kept.profileId), kind, id, kept.body, kept.wrappedKey), seq: kept.seq, profileId: kept.profileId };
      } catch {
        // A copy that does not open (damaged, or of another vault) is not trusted and not kept: it is read from the server.
        void keep!.forget(id);
      }
    }
    const got = await this.fetchObject(id);
    const plaintext = await openObject(this.keyOf(got.profileId), kind, id, got.body, got.wrappedKey);
    if (keep) void keep.put(id, got);
    return { plaintext, seq: got.seq, profileId: got.profileId };
  }

  /**
   * `get` without waiting, for the core's file system, which must answer a read at once: a synchronous request, which a worker may make
   * (a page may not). Libsodium and the profile must already be loaded.
   */
  getSync(id: string, kind: Exclude<ObjectKind, 'profile'>): Uint8Array {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `${this.base}/objects/${encodeURIComponent(id)}`, false);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    if (xhr.status !== 200) throw Object.assign(new Error(`could not read an object of the vault (${xhr.status})`), { status: xhr.status });
    return openObjectNow(this.keyOf(xhr.getResponseHeader('x-spine-profile') ?? ''), kind, id, new Uint8Array(xhr.response as ArrayBuffer), xhr.getResponseHeader('x-spine-wrapped-key') ?? '');
  }

  async remove(id: string, baseSeq: number): Promise<number> {
    const res = await this.f(`${this.base}/objects/${encodeURIComponent(id)}?base=${baseSeq}`, { method: 'DELETE' });
    if (!res.ok) return fail(res);
    void this.cache?.forget(id);
    return ((await res.json()) as { seq: number }).seq;
  }

  private async send(id: string, kind: ObjectKind, profileId: string, body: Uint8Array, wrappedKey: string, baseSeq: number): Promise<number> {
    const res = await this.f(`${this.base}/objects/${encodeURIComponent(id)}`, {
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

  private async fetchObject(id: string, starting = false): Promise<{ body: Uint8Array; wrappedKey: string; seq: number; profileId: string }> {
    const started = starting ? undefined : this.inflight.get(id);
    if (started) { this.inflight.delete(id); return started; }
    const res = await this.f(`${this.base}/objects/${encodeURIComponent(id)}`);
    if (!res.ok) return fail(res);
    return {
      body: new Uint8Array(await res.arrayBuffer()),
      wrappedKey: res.headers.get('x-spine-wrapped-key') ?? '',
      seq: Number(res.headers.get('x-spine-seq')),
      profileId: res.headers.get('x-spine-profile') ?? '',
    };
  }

  // --- Letting another account into a profile (SECURITY.md M-49) ------------------------------------------------------------

  private async json<T>(path: string, method = 'GET', body?: unknown, retried = false): Promise<T> {
    const res = await this.f(path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) {
      // A sensitive step asks for the password again; once it is typed the same request is sent again (S-33).
      if (res.status === 403 && !retried && ((await res.clone().json().catch(() => ({}))) as { code?: string }).code === 'reauth_required' && (await askForPassword())) return this.json<T>(path, method, body, true);
      return fail(res);
    }
    return (await res.json()) as T;
  }

  /** Who may reach what: grants of my profiles, invitations waiting, and grants made to me. */
  delegations(): Promise<Delegations> {
    return this.json<Delegations>('/api/delegations');
  }

  /** Makes an invitation to one of my profiles. The code is for the person to tell the other; it is not kept. */
  async invite(profileId: string, role: 'guardian' | 'viewer' | 'self'): Promise<{ code: string; expiresAt: string }> {
    // What the code opens holds this account's own public key, and the invitation's key is kept sealed under this account's key, so that the
    // other person's key reaches this account through the code and not through the server (SECURITY.md S-39, S-41).
    const made = await makeInvite(this.keyOf(profileId), this.unlocked.publicKey, this.unlocked.accountKey);
    const sent = await this.json<{ expires_at: string }>('/api/delegations/invites', 'POST', { id: made.id, profile_id: profileId, role, wrapped: made.wrapped, proof_hash: made.proofHash, owner_blob: made.ownerBlob });
    return { code: made.code, expiresAt: sent.expires_at };
  }

  cancelInvite(id: string): Promise<unknown> { return this.json(`/api/delegations/invites/${encodeURIComponent(id)}`, 'DELETE'); }

  /** Who an invitation is from and what it lets this account do, without using it. Throws (404) if the code is not valid, used or ended. */
  async previewInvite(code: string): Promise<{ ownerEmail: string; role: 'guardian' | 'viewer' | 'self'; expiresAt: string }> {
    const invite = await fromInviteCode(code);
    try {
      const seen = await this.json<{ owner_email: string; role: 'guardian' | 'viewer' | 'self'; expires_at: string }>('/api/delegations/invites/preview', 'POST', { id: invite.id, proof: invite.proof });
      return { ownerEmail: seen.owner_email, role: seen.role, expiresAt: seen.expires_at };
    } finally {
      (await sodium()).memzero(invite.key);
    }
  }

  /**
   * Removes one of this account's own people with everything kept for them: used only for the empty records an account starts with, when the
   * person joins their own records as themselves. The profile record goes last, so an interruption leaves the person listed, never half gone.
   */
  async removeProfile(profileId: string): Promise<void> {
    const mine = (await this.list(0)).objects.filter(o => o.profile_id === profileId && !o.deleted);
    for (const o of mine.filter(o => o.kind !== 'profile')) await this.remove(o.id, o.seq);
    for (const o of mine.filter(o => o.kind === 'profile')) await this.remove(o.id, o.seq);
    this.profileKeys.delete(profileId);
  }

  /** Takes up an invitation: opens the profile key with the code and seals it to this account's own key pair. Throws if the code is not valid. */
  async accept(code: string): Promise<{ grantId: string; ownerEmail: string; role: 'guardian' | 'viewer' | 'self'; waiting: boolean; code: string }> {
    const invite = await fromInviteCode(code);
    const s = await sodium();
    try {
      const claimed = await this.json<{ grant: { id: string; profile_id: string; role: 'guardian' | 'viewer' | 'self'; owner_email: string }; wrapped: string }>('/api/delegations/claim', 'POST', { id: invite.id, proof: invite.proof });
      const { profileKey, ownerPublicKey } = await openInvite(invite, claimed.wrapped);
      try {
        if (ownerPublicKey) {
          // The owner's key as the code carried it is kept, sealed under this account's key, and this account's own key is sent under the code's key:
          // each side then knows the other's key without the server's word. The first key is sealed to this account by this account, so a server
          // cannot put one of its own in its place later (S-39, S-41).
          await this.json(`/api/delegations/${encodeURIComponent(claimed.grant.id)}/key`, 'PUT', {
            wrapped_key: await sealGrantKey(this.unlocked, this.unlocked.publicKey, profileKey),
            hello: await helloFor(invite, this.unlocked.publicKey),
            owner_pin: await sealPin(this.unlocked.accountKey, claimed.grant.profile_id, ownerPublicKey),
          });
        } else {
          // An invitation made before the code carried the owner's key would make a grant whose keys cannot be told from a server's, and a
          // server could present any grant as one of those, so none is accepted: the owner makes a new invitation.
          throw Object.assign(new Error('this invitation is from an older version of Spine; ask for a new one'), { status: 410 });
        }
      } finally {
        s.memzero(profileKey);
      }
      // From a device that binds keys the grant waits until the owner has confirmed the code this account's key makes, which this account reads out to them.
      return { grantId: claimed.grant.id, ownerEmail: claimed.grant.owner_email, role: claimed.grant.role, waiting: ownerPublicKey !== null, code: await visitorCode(toB64(s, this.unlocked.publicKey)) };
    } finally {
      s.memzero(invite.key);
    }
  }

  setGrantState(id: string, state: 'active' | 'paused'): Promise<unknown> { return this.json(`/api/delegations/${encodeURIComponent(id)}/state`, 'POST', { state }); }

  /** Ends a grant I gave, and replaces the profile's key so what the other person's key opened stays closed from now on. */
  async revoke(id: string): Promise<void> {
    const { profile_id: profileId } = await this.json<{ profile_id: string }>(`/api/delegations/${encodeURIComponent(id)}/revoke`, 'POST');
    await this.rotateProfile(profileId);
  }

  /**
   * Promotion at eighteen (CR-FAM-02, SECURITY.md M-51): this account takes into its own vault a profile it was let into as the person it is
   * of. A new profile key is made under this account's key, every data key and the profile record are sealed under it, and it is sealed to
   * everyone else who had the profile, whose access then waits, paused, for the new owner's choice. One step at the server.
   */
  async promote(entry: { grant: Delegations['received'][number]; profileKey: Uint8Array }): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try { return await this.promoteOnce(entry); } catch (err) { if (!(err instanceof ConflictError) || attempt >= 4) throw err; }
    }
  }

  private async promoteOnce({ grant, profileKey }: { grant: Delegations['received'][number]; profileKey: Uint8Array }): Promise<void> {
    const profileId = grant.profile_id;
    const view = VaultSession.delegated(this, grant.id, profileId, profileKey);
    const mine = (await view.list(0)).objects.filter(o => o.profile_id === profileId && !o.deleted);
    // The record is theirs now: no longer a child in someone's care, so it says so no more (the birth date stays).
    const { kind: _child, ...own } = JSON.parse(new TextDecoder().decode(await openProfileRecord(profileKey, profileId, (await view.fetchObject(profileId)).body))) as Record<string, unknown>;
    const plain = new TextEncoder().encode(JSON.stringify(own));
    const next = await newProfileKey(this.unlocked, profileId);
    const body = await sealProfileRecord(next.profileKey, profileId, plain);
    const objects = await Promise.all(mine.filter(o => o.kind !== 'profile').map(async o => ({ id: o.id, wrapped_key: await rewrapObjectKey(profileKey, next.profileKey, o.id, o.wrapped_key) })));
    // The owner it came from is paused, holding the new key until let back in. The key it is sealed to is the one the code gave this account, not
    // the one the server lists; the box says it is from this account, which the old owner knows by the key it pinned for it (S-39, S-41).
    const ownerKey = grant.owner_pin ? await openPin(this.unlocked.accountKey, profileId, grant.owner_pin) : null;
    if (!ownerKey) throw new Error('the key of the owner of these records was not bound through the code, so the new one is not sealed to them');
    const formerWrappedKey = await sealGrantKey(this.unlocked, ownerKey, next.profileKey);
    // Everyone else who looked after the person ends here: this account never met them and has no way to know their keys, so a key sealed to what
    // the server lists for them would be the server's to take. The new owner invites them again, and that carries each side's key through a code.
    const grants: Array<{ id: string; wrapped_key: string | null }> = grant.others.map(other => ({ id: other.id, wrapped_key: null }));
    const s = await sodium();
    await this.json(`/api/delegations/${encodeURIComponent(grant.id)}/promote`, 'POST', { profile_wrapped: next.wrapped, profile_body: toB64(s, body), objects, grants, former_wrapped_key: formerWrappedKey });
    s.memzero(profileKey);
    this.profileKeys.set(profileId, next.profileKey);
  }

  /** Gives up an access I was given. */
  leave(id: string): Promise<unknown> { return this.json(`/api/delegations/${encodeURIComponent(id)}`, 'DELETE'); }

  /** The people let into my profiles whose own copy of the key is current, and the profiles let into me with their keys opened. */
  async openReceived(received: Delegations['received']): Promise<Array<{ grant: Delegations['received'][number]; profileKey: Uint8Array }>> {
    const out: Array<{ grant: Delegations['received'][number]; profileKey: Uint8Array }> = [];
    for (const grant of received) {
      if (grant.state !== 'active' || !grant.wrapped_key) continue;
      // A grant opens only from the owner's key as the code gave it, or from this account's own. One with no such pin is left shut, whether it
      // is from before or a server took the pin away, since the two look alike and an anonymous sealed box is what a server can make (S-39, S-41).
      const ownerKey = grant.owner_pin ? await openPin(this.unlocked.accountKey, grant.profile_id, grant.owner_pin) : null;
      if (!ownerKey) continue;
      const profileKey = await openGrantKey(this.unlocked, grant.wrapped_key, [ownerKey, this.unlocked.publicKey]);
      if (profileKey) out.push({ grant, profileKey });
    }
    return out;
  }

  /**
   * Replaces a profile's key (TR-CRY-07): a new key, every data key of the profile sealed under it, the profile record sealed again, and
   * the new key sealed to each person still let in; sent as one step. Content someone already read cannot be recalled, but what they hold
   * opens nothing stored from now on. The account's other sign-ins end at the server, so no device goes on writing under the old key.
   */
  async rotateProfile(profileId: string): Promise<void> {
    // The account's own devices may write while this runs; a write that lands between the listing and the step makes the server answer that
    // the vault changed, and the whole step is done again with the new listing.
    for (let attempt = 1; ; attempt++) {
      try { return await this.rotateOnce(profileId); } catch (err) { if (!(err instanceof ConflictError) || attempt >= 4) throw err; }
    }
  }

  private async rotateOnce(profileId: string): Promise<void> {
    const old = this.keyOf(profileId);
    const mine = (await this.list(0)).objects.filter(o => o.profile_id === profileId && !o.deleted);
    const record = await this.fetchObject(profileId);
    const plain = await openProfileRecord(old, profileId, record.body);
    const next = await newProfileKey(this.unlocked, profileId);
    const body = await sealProfileRecord(next.profileKey, profileId, plain);
    const objects = await Promise.all(mine.filter(o => o.kind !== 'profile').map(async o => ({ id: o.id, wrapped_key: await rewrapObjectKey(old, next.profileKey, o.id, o.wrapped_key) })));
    const s = await sodium();
    const grants: Array<{ id: string; wrapped_key: string }> = [];
    for (const g of (await this.delegations()).owned) {
      if (g.profile_id !== profileId || (g.state !== 'active' && g.state !== 'paused')) continue;
      grants.push({ id: g.id, wrapped_key: await this.sealForDelegate(g, next.profileKey) });
    }
    await this.json(`/api/vault/profiles/${encodeURIComponent(profileId)}/rotate`, 'POST', { profile_wrapped: next.wrapped, profile_body: toB64(s, body), objects, grants });
    s.memzero(old);
    this.profileKeys.set(profileId, next.profileKey);
    // What this device kept of the profile's objects is sealed under keys that no longer open: read from the server again.
    for (const o of mine) void this.cache?.forget(o.id);
  }

  /**
   * The delegate's public key as this account has confirmed it (SECURITY.md S-39): the pin written when the owner checked the code the key makes
   * with the person. Null for a grant made before keys were bound, and for one whose code has not been confirmed yet.
   */
  private async verifiedKeyOf(g: Delegations['owned'][number]): Promise<Uint8Array | null> {
    return g.delegate_pin ? openPin(this.unlocked.accountKey, g.profile_id, g.delegate_pin) : null;
  }

  /** Whether a grant waits for this account to confirm the code its delegate's key makes: bound, paused, and not yet pinned. */
  static needsConfirmation(g: Pick<Delegations['owned'][number], 'state' | 'delegate_pin' | 'delegate_hello'>): boolean {
    return g.state === 'paused' && !g.delegate_pin && !!g.delegate_hello;
  }

  /** The delegate's key as the code carried it, read from what they sent under its key; null if it does not open. */
  private async helloKeyOf(g: Delegations['owned'][number]): Promise<Uint8Array | null> {
    if (!g.delegate_hello || !g.owner_blob) return null;
    const inviteKey = await inviteKeyFromBlob(this.unlocked.accountKey, g.owner_blob);
    if (!inviteKey) return null;
    const key = await readHello(inviteKey, g.delegate_hello);
    (await sodium()).memzero(inviteKey);
    return key;
  }

  /** The code the delegate's key makes, for the owner to compare with the one the delegate reads out; null if the hello does not open. */
  async pendingCode(g: Delegations['owned'][number]): Promise<string | null> {
    const key = await this.helloKeyOf(g);
    return key ? visitorCode(toB64(await sodium(), key)) : null;
  }

  /** The owner has asked the delegate for their code and it is the same: the key is pinned, sealed, and the grant resumes (S-39). */
  async confirmGrant(g: Delegations['owned'][number]): Promise<void> {
    const key = await this.helloKeyOf(g);
    if (!key) throw new Error('the key of this person could not be checked');
    await this.json(`/api/delegations/${encodeURIComponent(g.id)}/pin`, 'PUT', { pin: await sealPin(this.unlocked.accountKey, g.profile_id, key) });
    await this.setGrantState(g.id, 'active');
  }

  /**
   * A profile key sealed for a person let in: to the key this account confirmed for them through the code, as a box from this account that
   * they can tell is from it. A grant with no confirmed key is not sealed to at all, from before or because a server took the binding away: the
   * one to seal to would be the server's list, which is what S-39 is about.
   */
  private async sealForDelegate(g: Delegations['owned'][number], profileKey: Uint8Array): Promise<string> {
    const verified = await this.verifiedKeyOf(g);
    if (!verified) throw new Error('the key of someone let in has not been confirmed, so the new one is not sealed to them: confirm their code, or end their access and invite them again, first');
    return sealGrantKey(this.unlocked, verified, profileKey);
  }

  /** Signing out: the keys are wiped from memory. */
  async close(): Promise<void> {
    if (this.owns) await lock(this.unlocked);
    for (const k of this.profileKeys.values()) (await sodium()).memzero(k);
    this.profileKeys.clear();
  }
}

