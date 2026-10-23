import { sodium } from '../crypto/sodium';
import { memory } from './shims/fs';

/**
 * What the device keeps in the vault: the working database and the files the core holds (originals, page images, raw photos), sealed.
 * The server stores opaque objects and nothing else (docs/crypto-design.md).
 *
 *  - The database is one SQLite file cut into 1 MiB pieces. A change to the database changes a few pages, so a few pieces; only those are
 *    sealed and sent again, each as a new object, so an object is never rewritten and a half-finished save leaves the old state whole.
 *  - Every file is an object of its own, brought in when something asks for it (`fill`), not at unlock.
 *  - One small object, the index, says which objects make up the whole. It is written last, with the sequence number it was read at,
 *    so two devices saving over one another is a conflict, not a mix: the loser reloads.
 *
 * `ObjectStore` is the vault as this layer needs it (VaultSession fits), so the layer is tested without a server.
 */
export interface ObjectStore {
  put(kind: 'bundle' | 'blob' | 'library', id: string, plaintext: Uint8Array, baseSeq: number): Promise<number>;
  get(id: string, kind: 'bundle' | 'blob' | 'library'): Promise<{ plaintext: Uint8Array; seq: number }>;
  remove(id: string, baseSeq: number): Promise<unknown>;
}

interface Part { id: string; hash: string; size: number; seq: number }
interface Index { v: 1; db: Part[]; files: Record<string, Part> }

const PIECE = 1024 * 1024;
/** Scratch the core makes and removes within one request; not worth sealing. */
const SCRATCH = /(^|\/)tmp\/|\.part$|\.turning$/;

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (s: string) => new TextEncoder().encode(s);

export class Persistence {
  private index: Index = { v: 1, db: [], files: {} };
  private indexSeq = 0;
  private busy: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ObjectStore,
    /** The profile's index lives at a name only this profile has. */
    private readonly indexId: string,
    private readonly newId: () => Promise<string>,
  ) {}

  private async hash(data: Uint8Array): Promise<string> {
    const s = await sodium();
    return s.to_base64(s.crypto_generichash(24, data, null), s.base64_variants.URLSAFE_NO_PADDING);
  }

  /** The database as it was last saved (null for a vault that has none yet), with every saved file announced to the file layer. */
  async load(): Promise<Uint8Array | null> {
    let got: { plaintext: Uint8Array; seq: number };
    try {
      got = await this.store.get(this.indexId, 'library');
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
    this.index = JSON.parse(text(got.plaintext)) as Index;
    this.indexSeq = got.seq;

    const pieces: Uint8Array[] = [];
    for (const part of this.index.db) {
      const { plaintext } = await this.store.get(part.id, 'bundle');
      if ((await this.hash(plaintext)) !== part.hash) throw new Error('a piece of the database is not what was saved');
      pieces.push(plaintext);
    }
    for (const [path, part] of Object.entries(this.index.files)) memory.known(path, part.size);
    memory.settle();
    const out = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of pieces) { out.set(p, at); at += p.length; }
    return out;
  }

  /** Brings a file the vault holds into memory. */
  async fill(path: string): Promise<void> {
    const part = this.index.files[path];
    if (!part) throw new Error(`${path} is not in the vault`);
    const { plaintext } = await this.store.get(part.id, 'blob');
    if ((await this.hash(plaintext)) !== part.hash) throw new Error('a file is not what was saved');
    memory.fill(path, plaintext);
  }

  /** One save at a time, in order. */
  save(database: () => Uint8Array): Promise<void> {
    const run = this.busy.then(() => this.saveNow(database));
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async saveNow(database: () => Uint8Array): Promise<void> {
    const data = database();
    const next: Index = { v: 1, db: [], files: { ...this.index.files } };
    const obsolete: Part[] = [];

    for (let at = 0, n = 0; at < data.length; at += PIECE, n++) {
      const piece = data.subarray(at, at + PIECE);
      const hash = await this.hash(piece);
      const had = this.index.db[n];
      if (had && had.hash === hash && had.size === piece.length) { next.db.push(had); continue; }
      const id = await this.newId();
      const seq = await this.store.put('bundle', id, piece, 0);
      next.db.push({ id, hash, size: piece.length, seq });
      if (had) obsolete.push(had);
    }
    obsolete.push(...this.index.db.slice(next.db.length));

    const { written, removed } = memory.changes();
    const saved: Array<[string, Uint8Array]> = [];
    for (const path of written) {
      const file = memory.take(path);
      if (!file || SCRATCH.test(path)) continue;
      const id = await this.newId();
      const seq = await this.store.put('blob', id, file, 0);
      if (next.files[path]) obsolete.push(next.files[path]);
      next.files[path] = { id, hash: await this.hash(file), size: file.length, seq };
      saved.push([path, file]);
    }
    for (const path of removed) {
      if (next.files[path]) { obsolete.push(next.files[path]); delete next.files[path]; }
    }

    this.indexSeq = await this.store.put('library', this.indexId, bytes(JSON.stringify(next)), this.indexSeq);
    this.index = next;
    // What was sent is settled, unless it was written again meanwhile; scratch is never sent and is simply let go.
    const unchanged = saved.filter(([path, file]) => memory.take(path) === file).map(([path]) => path);
    memory.settle({ written: [...unchanged, ...written.filter(path => SCRATCH.test(path))], removed });

    // Only now is nothing pointing at the old objects. A failure here leaves garbage, not a broken vault.
    for (const part of obsolete) await this.store.remove(part.id, part.seq).catch(() => undefined);
  }
}
