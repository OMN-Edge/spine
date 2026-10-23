import type { FastifyInstance } from 'fastify';
import { LocalApp, type InjectRequest, type InjectResponse } from './local-app';
import { WasmDatabase } from './sqlite-wasm';
import { ready as hashingReady } from './shims/crypto';
import { memory } from './shims/fs';
import accountsSchema from '../../../server/src/store/sqlite/schema-accounts.sql?raw';
import recordsSchema from '../../../server/src/store/sqlite/schema-records.sql?raw';

const schema = `${accountsSchema}\n${recordsSchema}`;
import { createSqliteStoreWith } from '../../../server/src/store/sqlite/store';
import { resetStore } from '../../../server/src/store/index';
import { publicShareRoutes } from '../../../server/src/routes/public-share';
import { openPart, openPartNow } from './share/keys';
import { useTokenUrl } from './native/relay-auth';
import { useEmbedderHooks } from '../../../server/src/embedding/index';
import { relayFetch, relayToken } from './native/relay-auth';

/**
 * The core for someone reading a share: the sealed copy is fetched, opened with the key from the link, and the same route files that
 * served a recipient from the server answer from it, in this browser. Nothing is signed in: possession of the key is the access, and
 * the copy holds only what the link shares (server/src/store/sqlite/slice.ts).
 */
export interface ShareCore { inject(request: InjectRequest): Promise<InjectResponse>; lock(): void }

export async function startShareCore(shareId: string, key: string): Promise<ShareCore> {
  await hashingReady();
  const id = encodeURIComponent(shareId);

  const bundle = await fetch(`/api/shared/${id}/bundle`);
  if (!bundle.ok) throw Object.assign(new Error(bundle.status === 410 ? 'this link is no longer active' : 'this link could not be opened'), { status: bundle.status });
  // A wrong key is the same failure as a changed copy: it does not open.
  const bytes = await openPart(key, shareId, 'db', new Uint8Array(await bundle.arrayBuffer()));

  const meta = (await (await fetch(`/api/shared/${id}/meta`)).json()) as { blobs: number };
  // The page images are sealed files beside the copy, fetched when one is asked for.
  for (let n = 0; n < meta.blobs; n++) memory.known(`/share/pages/${n}.png`, 0);
  memory.useLoader(path => {
    const n = Number(/^\/share\/pages\/(\d+)\.png$/.exec(path)?.[1]);
    if (!Number.isInteger(n)) throw Object.assign(new Error('not a file of this share'), { code: 'ENOENT' });
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/api/shared/${id}/blob/${n}`, false);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    if (xhr.status !== 200) throw Object.assign(new Error(`could not read a page of the share (${xhr.status})`), { code: 'EIO' });
    return openPartNow(key, shareId, `blob-${n}`, new Uint8Array(xhr.response as ArrayBuffer));
  });

  // Model calls (translating, a question) go through the relay with a pass for this share alone.
  useTokenUrl(`/api/shared/${id}/relay-token`, 'POST');
  const config = (await (await fetch(`/api/shared/${id}/config`)).json().catch(() => ({ env: {} }))) as { env: Record<string, string> };
  Object.assign(process.env, config.env);
  useEmbedderHooks({ tokenProvider: relayToken, fetchImpl: relayFetch });

  const db = new WasmDatabase(bytes);
  const store = createSqliteStoreWith({ adapter: 'sqlite', location: ':memory:' }, () => db, schema);
  resetStore(store);

  const local = new LocalApp();
  await (publicShareRoutes as unknown as (app: FastifyInstance, options?: object) => Promise<void>)(local as unknown as FastifyInstance, {});
  return {
    inject: request => local.inject(request),
    lock() { memory.useLoader(null); memory.clear(); db.close(); resetStore(null); },
  };
}
