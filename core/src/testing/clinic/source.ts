import type { DemoSource } from '../../demo/archive.js';
import { renderPdf } from './render.js';
import { DOCS, pageOf } from './specs.js';
import { demoArchiveOf } from './restore.js';

/** The sample archive straight from the script, for a host that has no built files (the tests that run the whole app on Node). `only` keeps a few documents. */
export function clinicDemoSource(options: { only?: string[] } = {}): DemoSource {
  const byId = new Map(DOCS.map(d => [d.id, d]));
  const cache = new Map<string, Promise<Uint8Array>>();
  return {
    async archive() { return demoArchiveOf(options); },
    pdf(name: string) {
      const key = name.replace(/\.pdf$/, '');
      const spec = byId.get(key);
      if (!spec) return Promise.reject(new Error(`no sample document ${name}`));
      if (!cache.has(key)) cache.set(key, renderPdf(pageOf(spec, byId)));
      return cache.get(key)!;
    },
  };
}
