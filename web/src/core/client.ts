import type { FromWorker, Part, ToWorker } from './protocol';

/**
 * The page's side of the core: starts the worker, and answers `fetch`-shaped calls from it. `deviceFetch` is what the app's requests
 * for records go through; the ones for the account (sign-in, the vault's objects) still go to the server.
 */
let worker: Worker | null = null;
/** Resolves when the worker has started listening; a message sent before would be lost. */
let loaded: Promise<void> = Promise.resolve();
let next = 1;
let onLoaded: () => void = () => {};
const waiting = new Map<number, { resolve: (m: Extract<FromWorker, { ok: true }>) => void; reject: (e: Error) => void }>();

function ensure(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./core.worker.ts', import.meta.url), { type: 'module' });
  loaded = new Promise(resolve => { onLoaded = resolve; });
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const m = event.data;
    // SQLite's own worker support announces itself on the same channel; it is not for us.
    if (typeof m?.id !== 'number') return;
    if ('trace' in m) { if (m.trace === 'loaded') onLoaded(); else console.debug('[core]', m.trace); return; }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.ok) w.resolve(m);
    else w.reject(Object.assign(new Error(m.error.message), m.error));
  };
  // A worker that cannot start (or dies) must not leave every request waiting for an answer that will never come.
  worker.onerror = event => {
    const error = Object.assign(new Error(event.message || 'the core could not start'), { name: 'CoreError' });
    console.error('the core failed', event.message, event.filename, event.lineno);
    for (const w of waiting.values()) w.reject(error);
    waiting.clear();
  };
  return worker;
}

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
function send(message: WithoutId<ToWorker>, transfer: Transferable[] = []) {
  const id = next++;
  const w = ensure();
  return new Promise<Extract<FromWorker, { ok: true }>>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    void loaded.then(() => w.postMessage({ ...message, id }, transfer));
  });
}

export const device = {
  /** Opens the vault with this master key and loads the records. The key is handed over, not copied: this page no longer has it. */
  async unlock(masterKey: Uint8Array): Promise<void> {
    await send({ type: 'start', masterKey }, [masterKey.buffer]);
    ready = true;
  },
  /** Saves what changed, lets go of everything, and stops the worker. */
  async lock(): Promise<void> {
    if (worker) await send({ type: 'lock' }).catch(() => undefined);
    worker?.terminate();
    worker = null;
    ready = false;
  },
  isOpen: () => ready,
};
let ready = false;

/** `fetch`, answered by the core. A form's files are read here and handed over as parts. */
export async function deviceFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  let body: string | undefined;
  let parts: Part[] | undefined;
  const transfer: Transferable[] = [];
  if (init.body instanceof FormData) {
    parts = [];
    for (const [fieldname, value] of init.body.entries()) {
      if (typeof value === 'string') parts.push({ fieldname, value });
      else { const data = await value.arrayBuffer(); transfer.push(data); parts.push({ fieldname, filename: value.name, mimetype: value.type, data }); }
    }
  } else if (typeof init.body === 'string') body = init.body;

  try {
    const m = await send({ type: 'request', method: init.method ?? 'GET', url, headers, body, parts }, transfer);
    return new Response(m.status === 204 || m.status === 304 ? null : m.body, { status: m.status, headers: m.headers });
  } catch (err) {
    const e = err as { status?: number; code?: string; message: string };
    if (e.status === 423) return new Response(JSON.stringify({ error: e.message, code: e.code }), { status: 423, headers: { 'content-type': 'application/json' } });
    throw err;
  }
}

/** Requests the server answers (the account, the vault's objects, what a share's recipient reads); every other `/api` call is the core's. */
const SERVER_SIDE = /^\/(api\/(auth|account|legal|vault|share)\/|share\/)/;

/** What the app calls instead of `fetch`: the core for records, the network for the rest. */
export const appFetch = (url: string, init?: RequestInit): Promise<Response> =>
  SERVER_SIDE.test(url) || !url.startsWith('/api/') ? fetch(url, init) : deviceFetch(url, init);

/** A picture the core holds, as an address the page can show; the same address is reused, and the oldest are let go. */
const shown = new Map<string, Promise<string>>();
const KEEP = 80;
export function deviceObjectUrl(url: string): Promise<string> {
  let found = shown.get(url);
  if (found) { shown.delete(url); shown.set(url, found); return found; }
  found = deviceFetch(url).then(async res => {
    if (!res.ok) throw new Error(`could not load ${url}`);
    return URL.createObjectURL(await res.blob());
  });
  shown.set(url, found);
  for (const [key, value] of shown) {
    if (shown.size <= KEEP) break;
    shown.delete(key);
    void value.then(u => URL.revokeObjectURL(u));
  }
  return found;
}
export function forgetDeviceObjectUrls(): void {
  for (const value of shown.values()) void value.then(u => URL.revokeObjectURL(u));
  shown.clear();
}

/** Saves what the core returns for this address as a file, the way a link with `download` would. */
export async function downloadFromDevice(url: string, filename: string): Promise<void> {
  const res = await deviceFetch(url);
  if (!res.ok) throw new Error('could not make the file');
  const disposition = res.headers.get('content-disposition')?.match(/filename="?([^";]+)"?/)?.[1];
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await res.blob());
  link.download = disposition ?? filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}
