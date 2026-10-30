import { sodium, sodiumNow } from '../crypto/sodium';
import { memory } from './shims/fs';
import type { Change, ChangeLog, FileRegistryRepository } from 'spine-core/store/types';

/**
 * What the device keeps in the vault (docs/crypto-design.md, "Syncing devices"). The server stores opaque objects and nothing else.
 *
 *  - Every write the person makes is a change of one row (the store's change log). A save seals the changes made since the last one as a
 *    **segment** (one object, kind `log`) and never rewrites an object, so two devices saving at once do not collide.
 *  - Another device's segments are found by listing the vault, opened and applied; the newest change to a row wins.
 *  - Now and then a device folds the segments it has applied into a **snapshot** (sealed parts of the whole record set, kind `bundle`) and
 *    writes the **index** (one small object, `library`) that names it; the segments it folded are deleted. The index is the one object that
 *    is written over, with the sequence number it was read at, so two devices compacting at once is a conflict for one of them to retry.
 *  - Every file is an object of its own (kind `blob`), brought in when something asks for it (`fill`), and found through the `vault_files`
 *    table, which is part of the records and syncs like them.
 *
 * Nothing here knows which engine holds the records: it moves `Change`s. `ObjectStore` is the vault as this layer needs it (VaultSession
 * fits), so the layer is tested without a server.
 */
export interface ObjectMeta { id: string; profile_id: string; kind: string; seq: number; deleted: boolean }

export interface ObjectStore {
  put(kind: 'bundle' | 'blob' | 'library' | 'log', id: string, plaintext: Uint8Array, baseSeq: number): Promise<number>;
  get(id: string, kind: 'bundle' | 'blob' | 'library' | 'log'): Promise<{ plaintext: Uint8Array; seq: number }>;
  /** The same, answered at once, for a file read by code that cannot wait. */
  getSync(id: string, kind: 'blob'): Uint8Array;
  remove(id: string, baseSeq: number): Promise<unknown>;
  /** Every object of the account whose sequence is above `since`. */
  list(since: number): Promise<{ objects: ObjectMeta[] }>;
}

/** The records as this layer needs them: the change log and the file registry, for the one person this core holds. */
export interface Records {
  changes: ChangeLog;
  files: FileRegistryRepository;
  userId: string;
}

interface Part { id: string; hash: string; size: number; seq: number }
interface IndexV2 { v: 2; snapshot: Part[]; covers: string[] }

/** Scratch the core makes and removes within one request; not worth sealing. */
const SCRATCH = /(^|\/)tmp\/|\.part$|\.turning$/;
/** A snapshot part or segment is cut to about this much JSON, so one object stays small. */
const CHUNK = 900_000;
/** Segments folded into a snapshot once this many wait. */
const COMPACT_AFTER = 40;

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const bytes = (s: string) => new TextEncoder().encode(s);

/** Cuts a list of changes into groups whose JSON is about `CHUNK` long. */
function chunks(changes: Change[]): Change[][] {
  const out: Change[][] = [];
  let current: Change[] = [];
  let size = 0;
  for (const change of changes) {
    const length = JSON.stringify(change).length;
    if (current.length > 0 && size + length > CHUNK) { out.push(current); current = []; size = 0; }
    current.push(change);
    size += length;
  }
  if (current.length > 0) out.push(current);
  return out;
}

export class Persistence {
  private index: IndexV2 = { v: 2, snapshot: [], covers: [] };
  private indexSeq = 0;
  private seen = 0;
  private busy: Promise<void> = Promise.resolve();
  /** Segments this device has applied or written and that no snapshot has folded yet, with their sequence numbers. */
  private open = new Map<string, number>();
  private registry = new Map<string, { objectId: string; hash: string; size: number; seq: number }>();
  /**
   * Changes taken out of the change log and not yet in the vault. Draining makes the log forget what it hands over, so a save that
   * failed after draining (the network, the vault's limit) would otherwise have lost them for good: they stay here and go first next time.
   */
  private unsent: Change[] = [];
  onChanged: (() => void) | null = null;

  constructor(
    private readonly store: ObjectStore,
    private readonly profileId: string,
    /** The profile's index lives at a name only this profile has. */
    private readonly indexId: string,
    private readonly newId: () => Promise<string>,
    private readonly records: Records,
  ) {}

  private async hash(data: Uint8Array): Promise<string> {
    const s = await sodium();
    return s.to_base64(s.crypto_generichash(24, data, null), s.base64_variants.URLSAFE_NO_PADDING);
  }

  private async putJson(kind: 'bundle' | 'log', value: unknown): Promise<Part> {
    const data = bytes(JSON.stringify(value));
    const id = await this.newId();
    return { id, hash: await this.hash(data), size: data.length, seq: await this.store.put(kind, id, data, 0) };
  }

  /** Whether changes were taken out of the log and the vault does not have them yet (a save failed part-way). */
  get waiting(): boolean { return this.unsent.length > 0; }

  /** Sends what the log holds, after what an earlier failed save left. A group leaves the list only once the vault has it. */
  private async sendChanges(): Promise<void> {
    // The server's clock is read just before the changes are stamped, not some seconds before, so a clock that was set in between does not
    // stamp them. Out of reach of the vault there is no reading: the changes stay in the log, unstamped, and this save fails and is
    // tried again, like any save the vault did not take. They are stamped from when they were written, on the clock read when it is back.
    if (await this.records.changes.pending()) await this.store.list(this.seen);
    // A loop, not push(...list): a first save after a large import can be more arguments than a call allows.
    for (const change of await this.records.changes.drain()) this.unsent.push(change);
    for (const group of chunks(this.unsent)) {
      const part = await this.putJson('log', { v: 1, changes: group });
      this.open.set(part.id, part.seq);
      this.unsent.splice(0, group.length);
    }
  }

  private async readParts(parts: Part[]): Promise<Change[]> {
    const out: Change[] = [];
    for (const part of parts) {
      const { plaintext } = await this.store.get(part.id, 'bundle');
      if ((await this.hash(plaintext)) !== part.hash) throw new Error('a part of the snapshot is not what was saved');
      out.push(...(JSON.parse(text(plaintext)) as { changes: Change[] }).changes);
    }
    return out;
  }

  /**
   * Brings the vault's records into the store: the snapshot, then every segment no snapshot folded. A vault of a kind this code does not
   * know is refused and left as it is.
   */
  async load(): Promise<{ empty: boolean }> {
    let got: { plaintext: Uint8Array; seq: number } | null = null;
    try {
      got = await this.store.get(this.indexId, 'library');
    } catch (err) {
      if ((err as { status?: number }).status !== 404) throw err;
    }
    const collected: Change[] = [];
    if (got) {
      const parsed = JSON.parse(text(got.plaintext)) as IndexV2;
      if (parsed.v !== 2) throw new Error(`this vault is of a kind (${String((parsed as { v?: unknown }).v)}) that this version cannot open`);
      this.indexSeq = got.seq;
      this.index = parsed;
      collected.push(...await this.readParts(parsed.snapshot));
    }
    collected.push(...await this.pullSegments((await this.store.list(0)).objects));
    await this.records.changes.apply(collected);
    await this.refreshRegistry();
    memory.settle();
    memory.useLoader(path => this.fill(path));
    return { empty: !got && collected.length === 0 };
  }

  /** Segments of this profile that are not folded into the snapshot and not already held; their changes, opened. */
  private async pullSegments(objects: ObjectMeta[]): Promise<Change[]> {
    const out: Change[] = [];
    const folded = new Set(this.index.covers);
    for (const meta of objects) {
      this.seen = Math.max(this.seen, meta.seq);
      if (meta.kind !== 'log' || meta.profile_id !== this.profileId || meta.deleted || folded.has(meta.id) || this.open.has(meta.id)) continue;
      const { plaintext, seq } = await this.store.get(meta.id, 'log');
      this.open.set(meta.id, seq);
      out.push(...(JSON.parse(text(plaintext)) as { changes: Change[] }).changes);
    }
    return out;
  }

  /** The vault's files, announced to the file layer so that reading one fetches it. */
  private async refreshRegistry(): Promise<void> {
    this.registry.clear();
    for (const file of await this.records.files.list(this.records.userId)) {
      this.registry.set(file.path, file);
      memory.known(file.path, file.size);
    }
  }

  /** A file the vault holds, fetched when something reads it. Checked against what was saved. */
  private fill(path: string): Uint8Array {
    const part = this.registry.get(path);
    if (!part || !part.objectId) throw Object.assign(new Error(`${path} is not in the vault`), { code: 'ENOENT' });
    const data = this.store.getSync(part.objectId, 'blob');
    const check = sodiumNow();
    if (check.to_base64(check.crypto_generichash(24, data, null), check.base64_variants.URLSAFE_NO_PADDING) !== part.hash) throw new Error('a file is not what was saved');
    return data;
  }

  /** One save at a time, in order: the files written, the changes made, the other devices' changes, and a snapshot when enough segments wait. */
  save(): Promise<void> {
    const run = this.busy.then(() => this.saveNow());
    this.busy = run.catch(() => undefined);
    return run;
  }

  private async saveNow(): Promise<void> {
    const obsolete: Array<{ id: string; seq: number }> = [];

    const { written, removed } = memory.changes();
    const saved: Array<[string, Uint8Array]> = [];
    for (const path of written) {
      const file = memory.take(path);
      if (!file || SCRATCH.test(path)) continue;
      const id = await this.newId();
      const seq = await this.store.put('blob', id, file, 0);
      const had = this.registry.get(path);
      if (had) obsolete.push({ id: had.objectId, seq: had.seq });
      await this.records.files.put(this.records.userId, { path, objectId: id, hash: await this.hash(file), size: file.length, seq });
      saved.push([path, file]);
    }
    for (const path of removed) {
      const had = this.registry.get(path);
      if (had) { obsolete.push({ id: had.objectId, seq: had.seq }); await this.records.files.remove(this.records.userId, path); }
    }

    await this.sendChanges();

    await this.pull();
    await this.refreshRegistry();

    // What was sent is settled, unless it was written again meanwhile; scratch is never sent and is simply let go.
    const unchanged = saved.filter(([path, file]) => memory.take(path) === file).map(([path]) => path);
    memory.settle({ written: [...unchanged, ...written.filter(path => SCRATCH.test(path))], removed });

    if (this.open.size >= COMPACT_AFTER) await this.compact(false).catch(err => { if ((err as Error)?.name !== 'ConflictError') throw err; });

    // Only now is nothing pointing at the old objects. A failure here leaves garbage, not a broken vault.
    for (const old of obsolete) await this.store.remove(old.id, old.seq).catch(() => undefined);
  }

  /** What other devices have written since this one last looked, and a newer snapshot if one was made. */
  private async pull(): Promise<void> {
    const { objects } = await this.store.list(this.seen);
    const index = objects.find(o => o.id === this.indexId && !o.deleted);
    const incoming: Change[] = [];
    if (index && index.seq !== this.indexSeq) {
      const got = await this.store.get(this.indexId, 'library');
      const next = JSON.parse(text(got.plaintext)) as IndexV2;
      if (next.v === 2) {
        const known = new Set(this.index.snapshot.map(p => p.id));
        incoming.push(...await this.readParts(next.snapshot.filter(p => !known.has(p.id))));
        this.index = next;
        this.indexSeq = got.seq;
        for (const id of next.covers) this.open.delete(id);
      }
    }
    incoming.push(...await this.pullSegments(objects));
    if (incoming.length > 0) {
      // A change is applied outside any transaction; if a request is in the middle of one, the next save tries again.
      const n = await this.records.changes.apply(incoming);
      if (n > 0) this.onChanged?.();
    }
  }

  /** Folds the segments held into a new snapshot. `force` writes one even when few wait. */
  private async compact(force: boolean): Promise<void> {
    if (!force && this.open.size < COMPACT_AFTER) return;
    // Writes made while this save was waiting on the vault are sent first, so the snapshot holds nothing a segment does not.
    await this.sendChanges();
    const all = await this.records.changes.dump();
    const parts: Part[] = [];
    for (const group of chunks(all)) parts.push(await this.putJson('bundle', { v: 1, changes: group }));
    const folded = [...this.open.entries()];
    const next: IndexV2 = { v: 2, snapshot: parts, covers: folded.map(([id]) => id) };
    let seq: number;
    try {
      seq = await this.store.put('library', this.indexId, bytes(JSON.stringify(next)), this.indexSeq);
    } catch (err) {
      for (const part of parts) await this.store.remove(part.id, part.seq).catch(() => undefined);
      throw err;
    }
    const before = this.index.snapshot;
    this.index = next;
    this.indexSeq = seq;
    this.open.clear();
    for (const part of before) await this.store.remove(part.id, part.seq).catch(() => undefined);
    for (const [id, s] of folded) await this.store.remove(id, s).catch(() => undefined);
  }
}
