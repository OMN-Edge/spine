import { parseBorn } from 'spine-core/family';
import type { UploadPart } from 'spine-core/http';
import './shims/globals';
import { Buffer } from 'buffer';
import { startCore, type Core } from './boot';
import { startShareCore, type ShareCore } from './boot-share';
import { applyRelayConfig, relayFetch, relayToken, useTokenUrl } from './native/relay-auth';
import { useRelayHooks } from 'spine-core/llm/adapters/relay';
import { deviceSettings } from './native/settings';
import { VaultSession, type KeysResponse } from '../crypto/vault-client';
import { deriveFromPassword } from '../crypto/keys';
import { indexIdFor } from './persist';
import { openSealedCache } from '../crypto/sealed-cache';
import type { FromWorker, Part, ToWorker } from './protocol';

/**
 * The core in a Web Worker: the page sends requests, the worker answers them from the database it holds. The vault is opened here, with
 * the master key the page handed over once at unlock, so the keys never sit in the page's own memory beyond that moment, and the
 * database never blocks the screen.
 */
// A worker's console is easy to miss; what the core logs as a problem is also said on the page's console (its own words, no records).
for (const level of ['warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    (self as unknown as Worker).postMessage({ id: 0, trace: `${level}: ${args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 400)}` } satisfies FromWorker);
  };
}

let core: Core | ShareCore | null = null;
let session: VaultSession | null = null;

const partOf = (p: Part): UploadPart =>
  p.data === undefined
    ? { type: 'field' as const, fieldname: p.fieldname, value: p.value ?? '' }
    : (() => {
        const bytes = new Uint8Array(p.data);
        const file = (async function* () { yield bytes; })();
        return { type: 'file' as const, fieldname: p.fieldname, filename: p.filename, mimetype: p.mimetype, file };
      })();

const trace = (step: string) => (self as unknown as Worker).postMessage({ id: 0, trace: step } satisfies FromWorker);

let currentProfile = '';
/** The people of this account, opened once at start (a profile is read from the server only then) and added to when one is made. */
let knownProfiles: Person[] = [];
/** The profiles other accounts let this one into, each read through its grant (id `grant:<grant>`; SECURITY.md M-49). */
const grants = new Map<string, { session: VaultSession; profileId: string }>();

interface Person { id: string; name: string; kind?: 'child'; born?: string; shared?: { owner: string; role: 'guardian' | 'viewer' | 'self' } }

/** Opens the profiles other accounts have let this one into. A failure leaves them out and the account's own people are still there. */
async function loadGrants(received: Awaited<ReturnType<VaultSession['delegations']>>['received']): Promise<Person[]> {
  for (const g of grants.values()) await g.session.close();
  grants.clear();
  const people: Person[] = [];
  for (const { grant, profileKey } of await session!.openReceived(received)) {
    try {
      const view = VaultSession.delegated(session!, grant.id, grant.profile_id, profileKey);
      const id = `grant:${grant.id}`;
      people.push({ id, ...(await view.profileRecord(grant.profile_id)), shared: { owner: grant.owner_email, role: grant.role } });
      grants.set(id, { session: view, profileId: grant.profile_id });
    } catch { /* paused or ended meanwhile, or the key no longer opens it: left out */ }
  }
  return people;
}
let cachedList: Awaited<ReturnType<VaultSession['list']>> | null = null;

async function start(opening: Uint8Array | { prf: Uint8Array; credentialId: string; wrapped: string }, keys?: KeysResponse, preferred?: string): Promise<void> {
  trace('opening the vault');
  session = opening instanceof Uint8Array ? await VaultSession.open(opening, undefined, keys) : await VaultSession.openWithPasskey(opening);
  trace('loading profiles');
  // Each of these is a round trip to the server, so what does not depend on another is asked together: the model settings, the listing,
  // and, as soon as the listing names the profile, its index; the keys to open them are ready by the time they arrive.
  const relay = applyRelayConfig().catch(() => false);
  const received = session.delegations().then(d => d.received).catch(() => []);
  const listed = await session.list(0);
  const named = listed.objects.find(o => o.kind === 'profile' && !o.deleted);
  if (named) session.prefetch(indexIdFor(named.id));
  const profiles = await session.loadProfiles(listed);
  const shared = await loadGrants(await received);
  knownProfiles = [...profiles, ...shared];
  // The person's own choice on this device, if it is still open to this account; else the first of this account's own.
  const profileId = (preferred && knownProfiles.find(p => p.id === preferred)?.id) ?? profiles[0]?.id ?? (await session.createProfile('Me'));
  trace((await relay) ? 'relay configured' : 'no relay');
  await openProfile(profileId, grants.has(profileId) ? await grants.get(profileId)!.session.list(0) : listed);
  trace('ready');
}

/** Opens one person's records: their cached sealed objects, then the core over them. Used at start and when another person is chosen. */
async function openProfile(profileId: string, listed: NonNullable<typeof cachedList>): Promise<void> {
  const view = grants.get(profileId);
  const s = view ? view.session : session!;
  // The records are the profile's own; for one let in through a grant, its id at the owner's vault and the grant's session carry them.
  const records = view ? view.profileId : profileId;
  currentProfile = profileId;
  // What was fetched before is read from this device, so a reload brings in only what changed (SECURITY.md M-43). None where the browser has no storage.
  s.useCache(await openSealedCache(profileId), listed);
  trace('starting the core');
  // The listing just made is the first the core asks for: a second one a moment later would say the same.
  let first: typeof listed | null = listed;
  core = await startCore({
    profileId: records,
    objects: {
      put: (kind, id, data, seq) => s.put(records, kind, id, data, seq),
      get: (id, kind) => s.get(id, kind),
      getSync: (id, kind) => s.getSync(id, kind),
      remove: (id, seq) => s.remove(id, seq),
      list: async since => { if (since === 0 && first) { const had = first; first = null; return had; } return s.list(since); },
    },
  }, {
    onChanged: () => (self as unknown as Worker).postMessage({ id: 0, changed: true } satisfies FromWorker),
    onSaveState: state => (self as unknown as Worker).postMessage({ id: 0, save: state } satisfies FromWorker),
  });
}

/**
 * The demo's core: no vault, so nothing is saved, and no share host, so no link can be made. Where the operator lets visitors read files of
 * their own (`SPINE_DEMO_UPLOADS=on`, SECURITY.md M-39), the server gives the settings for it, the demo's limits among them, and the passes
 * are the demo's (`/api/demo-relay/token`), counted by the relay per address; otherwise there is no relay and nothing is sent to a model.
 * Either way the questions, translations, links and vectors are off. The page loads the sample records into it.
 */
async function startDemo(): Promise<{ uploads: number; pages: number } | null> {
  let limits: { uploads: number; pages: number } | null = null;
  const res = await fetch('/api/demo-relay/config').catch(() => null);
  if (res?.ok) {
    const body = (await res.json()) as { env: Record<string, string>; limits: { uploads: number; pages: number } };
    Object.assign(deviceSettings, body.env);
    useTokenUrl('/api/demo-relay/token', 'POST');
    useRelayHooks({ tokenProvider: relayToken, fetchImpl: relayFetch });
    limits = body.limits;
  } else {
    Object.assign(deviceSettings, { SPINE_PARSER: 'text' });
  }
  Object.assign(deviceSettings, { SPINE_CHAT: 'off', SPINE_TRANSLATION: 'off', SPINE_LINKING: 'off', SPINE_EMBEDDINGS: 'none' });
  core = await startCore(undefined, {}, { shares: false });
  trace('ready');
  return limits;
}

const streaming = new Map<number, () => void>();

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const m = event.data;
  const reply = (r: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(r, transfer);
  try {
    if (m.type === 'start') {
      await start(m.masterKey, m.keys, m.profileId);
      reply({ id: m.id, ok: true });
    } else if (m.type === 'derive') {
      const { masterKey, authValue } = await deriveFromPassword(m.password, m.salt, m.params);
      const body = masterKey.buffer.slice(masterKey.byteOffset, masterKey.byteOffset + masterKey.byteLength) as ArrayBuffer;
      reply({ id: m.id, ok: true, headers: { authValue }, body }, [body]);
    } else if (m.type === 'startWithPasskey') {
      await start(m.passkey, undefined, m.profileId);
      reply({ id: m.id, ok: true });
    } else if (m.type === 'profiles') {
      if (!session) throw Object.assign(new Error('the vault is locked'), { status: 423, code: 'locked' });
      reply({ id: m.id, ok: true, body: new TextEncoder().encode(JSON.stringify({ profiles: knownProfiles, current: currentProfile })).buffer as ArrayBuffer });
    } else if (m.type === 'reloadKeys') {
      // The page replaced a profile's key or changed who is let in: take the keys and the people as they now are, and stay on the same person.
      if (!session) throw Object.assign(new Error('the vault is locked'), { status: 423, code: 'locked' });
      const own = await session.loadProfiles();
      knownProfiles = [...own, ...(await loadGrants((await session.delegations()).received))];
      reply({ id: m.id, ok: true });
    } else if (m.type === 'createProfile') {
      if (!session) throw Object.assign(new Error('the vault is locked'), { status: 423, code: 'locked' });
      const name = m.name.trim().slice(0, 60) || 'Someone';
      // A child's profile carries a birth date, sealed in its record: only a real date is kept.
      const born = m.kind === 'child' ? parseBorn(m.born ?? '') : null;
      if (m.kind === 'child' && !born) throw Object.assign(new Error('a child’s profile needs a birth date'), { status: 400 });
      const extra = m.kind === 'child' ? { kind: 'child' as const, born: born! } : {};
      const id = await session.createProfile(name, extra);
      knownProfiles = [...knownProfiles.filter(p => !p.shared), { id, name, ...extra }, ...knownProfiles.filter(p => p.shared)];
      reply({ id: m.id, ok: true, body: new TextEncoder().encode(JSON.stringify({ id })).buffer as ArrayBuffer });
    } else if (m.type === 'switchProfile') {
      if (!session || !core) throw Object.assign(new Error('the vault is locked'), { status: 423, code: 'locked' });
      if (m.profileId !== currentProfile && !knownProfiles.some(p => p.id === m.profileId)) throw Object.assign(new Error('not one of this account’s people'), { status: 404 });
      if (m.profileId !== currentProfile) {
        // Saves first, and refuses (code `unsaved`) rather than drop what could not be saved; then the other person's records open in its place.
        await core.close(m.force);
        core = null;
        await openProfile(m.profileId, await (grants.get(m.profileId)?.session ?? session).list(0));
      }
      reply({ id: m.id, ok: true });
    } else if (m.type === 'startDemo') {
      const limits = await startDemo();
      reply({ id: m.id, ok: true, body: new TextEncoder().encode(JSON.stringify({ limits })).buffer as ArrayBuffer });
    } else if (m.type === 'startShare') {
      // Reading a share: no vault, no account; the key is the access.
      core = await startShareCore(m.shareId, m.key);
      reply({ id: m.id, ok: true });
    } else if (m.type === 'lock') {
      // Refuses (code `unsaved`) rather than dropping what could not be saved; the page asks the person, and may say `force`.
      await core?.close(m.force);
      await session?.close();
      core = null; session = null; currentProfile = ''; knownProfiles = []; grants.clear();
      reply({ id: m.id, ok: true });
    } else if (m.type === 'save') {
      if (core && 'flush' in core) await core.flush();
      reply({ id: m.id, ok: true });
    } else if (m.type === 'abort') {
      streaming.get(m.target)?.();
      reply({ id: m.id, ok: true });
    } else {
      if (!core) throw Object.assign(new Error('the vault is locked'), { status: 423, code: 'locked' });
      const res = await core.inject({ method: m.method, url: m.url, headers: m.headers, payload: m.body, parts: m.parts?.map(partOf) });
      if (res.stream) {
        const post = (r: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(r, transfer);
        post({ id: m.id, ok: true, status: res.statusCode, headers: res.headers, stream: true });
        streaming.set(m.id, () => res.close?.());
        try {
          for await (const chunk of res.stream) { const copy = chunk.slice().buffer as ArrayBuffer; post({ id: m.id, chunk: copy }, [copy]); }
        } finally {
          streaming.delete(m.id);
          post({ id: m.id, end: true });
        }
        return;
      }
      const body = res.bytes ?? new TextEncoder().encode(res.body);
      const copy = body.slice().buffer as ArrayBuffer;
      reply({ id: m.id, ok: true, status: res.statusCode, headers: res.headers, body: copy }, [copy]);
    }
  } catch (err) {
    const e = err as { name?: string; message?: string; status?: number; code?: string };
    reply({ id: m.id, ok: false, error: { name: e.name ?? 'Error', message: e.message ?? String(err), status: e.status, code: e.code } });
  }
};

// Said last: until the modules above have started (SQLite's WebAssembly among them) nothing listens, and a request sent before would be lost.
trace('loaded');
