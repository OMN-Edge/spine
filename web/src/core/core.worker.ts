import './shims/globals';
import { PassThrough } from 'stream';
import { Buffer } from 'buffer';
import { startCore, type Core } from './boot';
import { VaultSession } from '../crypto/vault-client';
import type { FromWorker, Part, ToWorker } from './protocol';

/**
 * The core in a Web Worker: the page sends requests, the worker answers them from the database it holds. The vault is opened here, with
 * the master key the page handed over once at unlock, so the keys never sit in the page's own memory beyond that moment, and the
 * database never blocks the screen.
 */
let core: Core | null = null;
let session: VaultSession | null = null;

const partOf = (p: Part) =>
  p.data === undefined
    ? { type: 'field', fieldname: p.fieldname, value: p.value ?? '' }
    : (() => {
        const file = new PassThrough();
        file.end(Buffer.from(p.data));
        return { type: 'file', fieldname: p.fieldname, filename: p.filename, mimetype: p.mimetype, file, truncated: false };
      })();

const trace = (step: string) => (self as unknown as Worker).postMessage({ id: 0, trace: step } satisfies FromWorker);

async function start(masterKey: Uint8Array): Promise<void> {
  trace('opening the vault');
  session = await VaultSession.open(masterKey);
  trace('loading profiles');
  const profiles = await session.loadProfiles();
  const profileId = profiles[0]?.id ?? (await session.createProfile('Me'));
  trace('starting the core');
  const s = session;
  core = await startCore({
    profileId,
    objects: {
      put: (kind, id, data, seq) => s.put(profileId, kind, id, data, seq),
      get: (id, kind) => s.get(id, kind),
      remove: (id, seq) => s.remove(id, seq),
    },
  });
  trace('ready');
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const m = event.data;
  const reply = (r: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(r, transfer);
  try {
    if (m.type === 'start') {
      await start(m.masterKey);
      reply({ id: m.id, ok: true });
    } else if (m.type === 'lock') {
      await core?.flush().catch(() => undefined);
      core?.lock();
      await session?.close();
      core = null; session = null;
      reply({ id: m.id, ok: true });
    } else {
      if (!core) throw Object.assign(new Error('the vault is locked'), { status: 423, code: 'locked' });
      const res = await core.inject({ method: m.method, url: m.url, headers: m.headers, payload: m.body, parts: m.parts?.map(partOf) });
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
