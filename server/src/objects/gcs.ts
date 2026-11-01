import { GoogleAuth } from 'google-auth-library';
import { checkKey, checkPrefix, ObjectsConfigError, type ObjectStore } from './types.js';

/** Where requests get their credentials: the server's identity on Google Cloud (Application Default Credentials), or a test's stand-in. */
export interface Credentials { headers(): Promise<Record<string, string>> }

export interface GcsOptions {
  bucket: string;
  /** Under this prefix inside the bucket, so one bucket can hold several instances (`staging/`). */
  prefix?: string;
  credentials?: Credentials;
  fetchImpl?: typeof fetch;
  /** Waits between tries of a request that failed for a reason worth trying again. */
  retryDelaysMs?: number[];
  /** Base address, for a test or an emulator. */
  endpoint?: string;
}

const adc = (): Credentials => {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/devstorage.read_write'] });
  return { headers: async () => Object.fromEntries((await (await auth.getClient()).getRequestHeaders()).entries()) };
};

/**
 * Objects in a Google Cloud Storage bucket, through the JSON API with the identity the process runs as (no key file: on Cloud Run it is the
 * service account). The residency of the bytes is the bucket's location, which the operator chooses when making it (an EU region), as
 * for the model endpoint: configuration, not something this code can see. An object is replaced whole by an upload, so a reader gets the
 * old bytes or the new. A request that fails with a server error or a rate limit is tried again a few times; one that fails otherwise,
 * or still fails, throws, so "the bucket could not be reached" is never taken for "there is no such object".
 *
 * Authorisation needs `roles/storage.objectAdmin` on the bucket and no more. Turn on the bucket's versioning or soft delete: that, and
 * not this code, is the backup of the sealed bytes (docs/deployment-gcp.md).
 */
export function createGcsObjects(options: GcsOptions): ObjectStore {
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(options.bucket)) throw new ObjectsConfigError('SPINE_GCS_BUCKET is not a bucket name');
  const base = (options.endpoint ?? 'https://storage.googleapis.com').replace(/\/$/, '');
  const root = options.prefix ? `${options.prefix.replace(/^\/+|\/+$/g, '')}/` : '';
  const doFetch = options.fetchImpl ?? fetch;
  const delays = options.retryDelaysMs ?? [200, 800, 2000];
  let credentials = options.credentials;
  const named = (key: string) => `${root}${key}`;
  const bucket = encodeURIComponent(options.bucket);

  async function call(method: string, url: string, body?: Buffer, headers: Record<string, string> = {}): Promise<Response> {
    credentials ??= adc();
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await doFetch(url, { method, headers: { ...(await credentials.headers()), ...headers }, body: body as unknown as RequestInit['body'], signal: AbortSignal.timeout(60_000) });
      } catch (err) {
        if (attempt >= delays.length) throw new Error(`the object store could not be reached: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (res && res.status !== 429 && res.status < 500) return res;
      if (attempt >= delays.length) throw new Error(`the object store answered ${res?.status}`);
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }

  const failed = (what: string, res: Response) => new Error(`the object store answered ${res.status} to ${what}`);

  return {
    kind: 'gcs',

    async put(key, bytes) {
      const res = await call('POST', `${base}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(named(checkKey(key)))}`, bytes, { 'content-type': 'application/octet-stream' });
      if (!res.ok) throw failed('a write', res);
    },

    async get(key) {
      const res = await call('GET', `${base}/storage/v1/b/${bucket}/o/${encodeURIComponent(named(checkKey(key)))}?alt=media`);
      if (res.status === 404) return null;
      if (!res.ok) throw failed('a read', res);
      return Buffer.from(await res.arrayBuffer());
    },

    async remove(key) {
      const res = await call('DELETE', `${base}/storage/v1/b/${bucket}/o/${encodeURIComponent(named(checkKey(key)))}`);
      if (!res.ok && res.status !== 404) throw failed('a removal', res);
    },

    async list(prefix) {
      checkPrefix(prefix);
      const keys: string[] = [];
      let token = '';
      do {
        const res = await call('GET', `${base}/storage/v1/b/${bucket}/o?fields=items(name),nextPageToken&prefix=${encodeURIComponent(named(prefix))}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
        if (!res.ok) throw failed('a listing', res);
        const page = (await res.json()) as { items?: Array<{ name: string }>; nextPageToken?: string };
        for (const item of page.items ?? []) keys.push(item.name.slice(root.length));
        token = page.nextPageToken ?? '';
      } while (token);
      return keys;
    },

    async removeAll(prefix) {
      if (!prefix.endsWith('/')) throw new Error('invalid object prefix');
      for (const key of await this.list(prefix)) await this.remove(key);
    },
  };
}
