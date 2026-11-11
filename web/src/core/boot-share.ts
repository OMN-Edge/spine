import { LocalApp, type InjectRequest, type InjectResponse } from './local-app';
import { openDeviceStore } from './device-store';
import { browserTools } from './native';
import { useNativeTools } from 'spine-core/native-tools';
import { ready as hashingReady, browserDigests } from './native/digests';
import { useDigests } from 'spine-core/digest';
import { memory, browserFiles } from './shims/fs';
import { useFiles } from 'spine-core/files';
import { useSettings } from 'spine-core/config';
import { deviceSettings } from './native/settings';

import { resetStore } from 'spine-core/store/index';
import type { Change } from 'spine-core/store/types';
import { publicShareRoutes } from 'spine-core/routes/public-share';
import { openPart, openPartNow, sharePassCheck } from './share/keys';
import { useTokenUrl } from './native/relay-auth';
import { useRelayHooks } from 'spine-core/llm/adapters/relay';
import { relayFetch, relayToken } from './native/relay-auth';

/**
 * The core for someone reading a share: the sealed copy is fetched, opened with the key from the link, and the same route files that
 * served a recipient from the server answer from it, in this browser. Nothing is signed in: possession of the key is the access, and
 * the copy holds only what the link shares (core/src/store/sqlite/slice.ts).
 */
export interface ShareCore { inject(request: InjectRequest): Promise<InjectResponse>; lock(): void; /** A share is read-only: nothing to save. */ close(force?: boolean): Promise<void> }

export async function startShareCore(shareId: string, key: string): Promise<ShareCore> {
  await hashingReady();
  const id = encodeURIComponent(shareId);

  const bundle = await fetch(`/api/shared/${id}/bundle`);
  if (!bundle.ok) {
    // A link past the plan's limit (the free plan's) says so; one past a fair-use ceiling is only said to be unavailable, with no reason and no time.
    const { code } = (await bundle.json().catch(() => ({}))) as { code?: string };
    throw Object.assign(new Error(bundle.status === 410 ? 'this link is no longer active' : bundle.status === 429 ? 'this link is not available just now' : 'this link could not be opened'), { status: bundle.status, code });
  }
  // A wrong key is the same failure as a changed copy: it does not open.
  const copy = JSON.parse(new TextDecoder().decode(await openPart(key, shareId, 'records', new Uint8Array(await bundle.arrayBuffer())))) as { v: number; owner: string; changes: Change[] };
  if (copy.v !== 1) throw new Error('this link was made by a newer version of Spine');

  // The page images are sealed files beside the copy, fetched when one is asked for: the copy names each (`<name>.jpg`, or `<n>.png` in a
  // copy made before images had names).
  const image = /^\/share\/pages\/([A-Za-z0-9_-]{1,64})\.(?:jpg|png)$/;
  for (const c of copy.changes) {
    const path = c.t === 'pages' ? c.r?.image_path : null;
    if (typeof path === 'string' && image.test(path)) memory.known(path, 0);
  }
  memory.useLoader(path => {
    const name = image.exec(path)?.[1];
    if (!name) throw Object.assign(new Error('not a file of this share'), { code: 'ENOENT' });
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/api/shared/${id}/blob/${name}`, false);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    if (xhr.status !== 200) throw Object.assign(new Error(`could not read a page of the share (${xhr.status})`), { code: 'EIO' });
    return openPartNow(key, shareId, `blob-${name}`, new Uint8Array(xhr.response as ArrayBuffer));
  });

  // Model calls (translating, a question) go through the relay with a pass for this share alone.
  useTokenUrl(`/api/shared/${id}/relay-token`, 'POST', { check: await sharePassCheck(key, shareId) });
  const config = (await (await fetch(`/api/shared/${id}/config`)).json().catch(() => ({ env: {} }))) as { env: Record<string, string> };
  Object.assign(deviceSettings, config.env);
  useRelayHooks({ tokenProvider: relayToken, fetchImpl: relayFetch });

  useNativeTools(browserTools);
  useDigests(browserDigests);
  useFiles(browserFiles);
  useSettings(deviceSettings);
  const store = openDeviceStore();
  resetStore(store);
  // Nobody is signed in here; the copy's rows name the owner, who needs a row to be found by.
  const now = new Date().toISOString();
  await store.users.create({ id: copy.owner, email: 'shared@invalid.example', passwordHash: 'x', createdAt: now, verifiedAt: now, starterTags: false });
  await store.changes.apply(copy.changes);

  const local = new LocalApp();
  await publicShareRoutes(local);
  const lock = () => { memory.useLoader(null); memory.clear(); resetStore(null); };
  return {
    inject: request => local.inject(request),
    lock,
    async close() { lock(); },
  };
}
