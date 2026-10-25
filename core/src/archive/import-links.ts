import { v4 as uuidv4 } from 'uuid';
import { getStore } from '../store/index.js';
import { describeError } from '../failure.js';
import { logger } from '../logger.js';
import type { Manifest } from './manifest.js';

/**
 * The links of an export, written once the files they join have been restored. A link names its documents by place in the
 * manifest, and a document only has an id once its file is restored, which happens in the background and one file at a time;
 * so each restore says what ids it made, and when the last has answered the links whose two ends both exist are written, in the
 * state they were exported in (an owner's decision stays the owner's, a dismissal stays a dismissal). A link with an end that
 * was not restored (a file or document already in the archive, one set aside, a restore that failed) is left out: the archive
 * already has its own links for what it already holds. No model is called.
 */
export class LinkRestore {
  private waiting = 0;
  private done = false;
  private readonly ids = new Map<string, string>();

  constructor(private readonly userId: string, private readonly links: Manifest['links'], private readonly episodes: Manifest['episodes'] = []) {}

  /** A file is being restored, and will say when it is done. */
  expect(): void { this.waiting += 1; }

  /** A file's restore ended: the new ids of its documents in the manifest's order, or null if it failed. */
  finished(fileIndex: number, documentIds: Array<string | null> | null): void {
    documentIds?.forEach((id, document) => { if (id) this.ids.set(`${fileIndex}:${document}`, id); });
    this.waiting -= 1;
    this.run();
  }

  /** Every file has been started; the links are written when the last one is done. */
  sealed(): void { this.done = true; this.run(); }

  private run(): void {
    if (!this.done || this.waiting > 0 || (this.links.length === 0 && this.episodes.length === 0)) return;
    const links = this.links.splice(0);
    const episodes = this.episodes.splice(0);
    void (async () => {
      const store = getStore();
      const now = new Date().toISOString();
      for (const l of links) {
        const from = this.ids.get(`${l.from.file}:${l.from.document}`);
        const to = this.ids.get(`${l.to.file}:${l.to.document}`);
        if (!from || !to) continue;
        try {
          await store.links.restore(this.userId, { from_document_id: from, to_document_id: to, kind: l.kind, source: l.source, state: l.state, reason: l.reason, confidence: l.confidence }, now);
        } catch (err) {
          logger.warn('a link from an export could not be restored', { error: describeError(err) });
        }
      }
      // Episodes after the documents exist: the ones that were restored, in the state they were exported in.
      for (const e of episodes) {
        const documentIds = e.documents.flatMap(d => (this.ids.get(`${d.file}:${d.document}`) ? [this.ids.get(`${d.file}:${d.document}`)!] : []));
        if (documentIds.length === 0) continue;
        try {
          await store.episodes.create(this.userId, { id: uuidv4(), title: e.title, state: e.state, source: e.source, documentIds }, now);
        } catch (err) {
          logger.warn('an episode from an export could not be restored', { error: describeError(err) });
        }
      }
    })();
  }
}
