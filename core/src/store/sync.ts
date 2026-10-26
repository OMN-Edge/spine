import type { Cell, Change, ChangeLog } from './types.js';

/**
 * How records travel between devices (docs/crypto-design.md, "Syncing devices"), apart from how any one store keeps them. This file is
 * the rules, and every store that offers `changes` shares them: a hybrid logical clock stamps each write; a row's newest change wins (a
 * deletion is a change); a tag or doctor made on two devices becomes one, the later arrival remembered as another name for the first;
 * and anything else that must be unique goes to the newer change, so every device ends with the same row whichever order the changes
 * reach it. What a store supplies is `Rows`: how to note a write, read and write a row, keep the clocks and the aliases, and do a merge
 * all at once. `store/sqlite/changes.ts` is that for SQLite, with triggers; `__tests__/helpers/memory-rows.ts` is one over plain maps, which
 * is what shows the rules do not lean on an engine.
 */

/** The tables that hold the person's records, which are synced. The accounts tables, the search index and the engine's own are not. */
export const REPLICATED = [
  'source_files', 'regroup_plans', 'pages', 'documents', 'measurements', 'removed_readings', 'measurement_aliases', 'doctors', 'document_doctors',
  'match_decisions', 'extracted_fields', 'tags', 'document_tags', 'share_links', 'share_link_keys', 'vault_files', 'share_access_requests', 'share_link_events', 'share_link_access_log',
  'document_translations', 'document_embeddings', 'episodes', 'episode_documents', 'document_links', 'chat_conversations', 'chat_messages',
] as const;

/** Rows that name another by a key two devices may have made differently for one thing: [column, the table whose key it is]. */
export const ALIASED: Record<string, Array<[string, string]>> = {
  tags: [['id', 'tags']], document_tags: [['tag_id', 'tags']],
  doctors: [['id', 'doctors']], document_doctors: [['doctor_id', 'doctors']],
};

/** A write the store noted, in the order it happened. `r` is the whole row after it (null: deleted); `at` is when, in milliseconds. */
export interface Note { t: string; k: Record<string, Cell>; r: Record<string, Cell> | null; at: number }

/** A row that could not be written because another already holds the values of a unique constraint: the columns of that constraint. */
export interface Clash { columns: string[] }

type Key = Record<string, Cell>;

/**
 * What a store gives the rules. Everything here is synchronous on purpose: a merge is one unit, and nothing else may touch the store
 * between its first step and its last. A store whose engine is asynchronous does the merge in its own transaction and offers this
 * as the view inside it.
 */
export interface Rows {
  /** The tables this store holds that are in `REPLICATED`, in that order. */
  tables(): string[];
  inTransaction(): boolean;

  /** The writes noted since the last `clearNotes`, oldest first. */
  notes(): Note[];
  hasNotes(): boolean;
  clearNotes(): void;

  /** The clock of a row, `key` being its key as `JSON.stringify` of the key object. */
  clock(table: string, key: string): string | undefined;
  setClock(table: string, key: string, h: string): void;
  clocks(): Array<{ t: string; k: string; h: string }>;
  alias(table: string, incoming: string): string | undefined;
  addAlias(table: string, incoming: string, local: string): void;

  /** Inserts the row, or replaces the one with its key. A unique constraint another row holds is answered, not thrown. */
  write(table: string, row: Key): Clash | null;
  remove(table: string, key: Key): void;
  /** The keys of the rows that hold `values` in `columns`, other than `except` when it is given. */
  holders(table: string, columns: string[], values: Cell[], except: Key | null): Key[];
  removeAll(table: string, keys: Key[]): void;
  /** Every row of a table, as its key and itself. */
  every(table: string): Array<{ k: Key; r: Key }>;

  /** All or nothing, with checks that rows point at rows suspended inside. */
  atomic<T>(fn: () => T): T;
  /**
   * A merge: `atomic`, and with the writes made inside it not noted as the device's own, rows left pointing at nothing removed, and whatever
   * is derived from the records (search) rebuilt if a table in the set `fn` returns changed.
   */
  merging(fn: () => Set<string>): void;
}

/**
 * How far this device's clock is from the server's, in milliseconds (server minus here). The newest change wins, and "newest" is read from
 * the clocks of the devices that wrote them, so a device whose clock is wrong would win edits it should lose, or lose ones it should win.
 * Every device sees the same server clock on each request it makes to the vault, so stamps are made on that clock, not on the device's own.
 * Zero until a reading has been taken.
 */
let clockOffset = 0;

/** A smaller difference than this is the noise of a reading (the `Date` header has a resolution of a second), not a wrong clock. */
const CLOCK_DEAD_ZONE_MS = 5_000;
/** A reading from a request that took longer than this says little about the moment the server answered. */
const CLOCK_MAX_ROUND_TRIP_MS = 10_000;
let bestRoundTrip = Infinity;

/**
 * The server's time from the `Date` header of its answer, to `sentAt` and `receivedAt` (this device's times): the offset, or null if the
 * header is missing or unreadable. The header is cut to the second, so half a second is added; the answer is taken to have been made
 * halfway through the request.
 */
export function serverClockOffset(dateHeader: string | null, sentAt: number, receivedAt: number): number | null {
  if (!dateHeader) return null;
  const server = Date.parse(dateHeader);
  if (Number.isNaN(server)) return null;
  return server + 500 - (sentAt + receivedAt) / 2;
}

/** Takes one reading. The one from the quickest round trip is kept, since it is the one that says most about the server's time. */
export function observeServerClock(dateHeader: string | null, sentAt: number, receivedAt: number): void {
  const roundTrip = receivedAt - sentAt;
  const offset = serverClockOffset(dateHeader, sentAt, receivedAt);
  if (offset === null || roundTrip < 0 || roundTrip > CLOCK_MAX_ROUND_TRIP_MS || roundTrip >= bestRoundTrip) return;
  bestRoundTrip = roundTrip;
  clockOffset = Math.abs(offset) < CLOCK_DEAD_ZONE_MS ? 0 : Math.round(offset);
}

/** The offset in use, and a way to set it (tests, and a device that locks and forgets). */
export const currentClockOffset = (): number => clockOffset;
export function resetServerClock(): void { clockOffset = 0; bestRoundTrip = Infinity; }

/** The clock. Sorts as text: the time in milliseconds, a counter for changes in the same millisecond, and the device that made it. */
export class HybridClock {
  private wall = 0;
  private counter = 0;
  readonly device: string;

  constructor(device?: string) {
    if (device) {
      this.device = device;
      return;
    }
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    this.device = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  stamp(at: number = Date.now()): string {
    const now = at + clockOffset;
    if (now > this.wall) { this.wall = now; this.counter = 0; } else this.counter++;
    return `${String(this.wall).padStart(14, '0')}.${String(this.counter).padStart(5, '0')}.${this.device}`;
  }

  /** A change from elsewhere moves this clock forward, so what is written here next is later than anything seen. */
  observe(h: string): void {
    const m = h.match(/^(\d{14})\.(\d{5})\./);
    if (!m) return;
    const wall = Number(m[1]);
    const counter = Number(m[2]);
    if (wall > this.wall) { this.wall = wall; this.counter = counter; } else if (wall === this.wall && counter > this.counter) this.counter = counter;
  }
}

const norm = (k: Key) => JSON.stringify(k);

/** The change log over any store that can supply `Rows`. One per store: it holds that device's clock. */
export function createChangeLog(rows: Rows, clock: HybridClock = new HybridClock()): ChangeLog {
  const known = new Set(rows.tables());

  /** The change as this device names things: a key that another device made for a tag or doctor this one already has is replaced by its own. */
  function translate(c: Change): Change {
    const columns = ALIASED[c.t];
    if (!columns) return c;
    const out: Change = { ...c, k: { ...c.k }, r: c.r && { ...c.r } };
    for (const [column, table] of columns) {
      for (const target of [out.k, out.r]) {
        const value = target?.[column];
        if (value === null || value === undefined) continue;
        const local = rows.alias(table, String(value));
        if (local !== undefined) target![column] = typeof value === 'number' ? Number(local) : local;
      }
    }
    return out;
  }

  function put(change: Change): void {
    const row = change.r!;
    const clash = rows.write(change.t, row);
    if (!clash) return;

    const keyColumns = Object.keys(change.k);
    const values = clash.columns.map(c => row[c]);
    if (ALIASED[change.t]?.some(([column]) => column === 'id') && keyColumns.length === 1) {
      // The same tag or doctor made on two devices: the one already here stays, and the other's key means it from now on.
      const existing = rows.holders(change.t, clash.columns, values, null)[0];
      if (existing) { rows.addAlias(change.t, String(row[keyColumns[0]]), String(existing[keyColumns[0]])); return; }
    }
    // Anything else that must be unique (a page's place, a visitor's request): the newer change takes the place, so a row already here that was
    // written later keeps it and the incoming one is dropped, and every device ends with the same row whichever order the changes reach it.
    const holders = rows.holders(change.t, clash.columns, values, Object.fromEntries(keyColumns.map(c => [c, row[c]])));
    const later = holders.some(h => {
      const held = rows.clock(change.t, norm(h));
      return held !== undefined && held > change.h;
    });
    if (later) return;
    rows.removeAll(change.t, holders);
    if (rows.write(change.t, row)) throw new Error(`a row of ${change.t} still clashes after the rows that held its place were removed`);
  }

  return {
    async busy() {
      return rows.inTransaction();
    },

    async pending() {
      return rows.hasNotes();
    },

    async drain() {
      if (rows.inTransaction()) throw new Error('the change log cannot be drained inside a transaction');
      const notes = rows.notes();
      if (notes.length === 0) return [];
      const last = new Map<string, Note>();
      for (const note of notes) {
        const id = `${note.t}|${norm(note.k)}`;
        last.delete(id); // a row written twice is stamped when it was written last, after the rows written between
        last.set(id, note);
      }
      const changes: Change[] = [];
      rows.atomic(() => {
        for (const note of last.values()) {
          const h = clock.stamp(note.at);
          changes.push({ t: note.t, k: note.k, r: note.r, h });
          rows.setClock(note.t, norm(note.k), h);
        }
        rows.clearNotes();
      });
      return changes;
    },

    async apply(changes) {
      if (rows.inTransaction()) throw new Error('changes cannot be applied inside a transaction');
      if (changes.length === 0) return 0;
      if (rows.hasNotes()) throw new Error('drain the change log before applying changes from elsewhere');
      const ordered = [...changes].sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
      let applied = 0;
      rows.merging(() => {
        const touched = new Set<string>();
        for (const incoming of ordered) {
          clock.observe(incoming.h);
          if (!known.has(incoming.t)) continue;
          const change = translate(incoming);
          const key = norm(change.k);
          const had = rows.clock(change.t, key);
          if (had !== undefined && had >= change.h) continue;
          if (change.r === null) rows.remove(change.t, change.k); else put(change);
          rows.setClock(change.t, key, change.h);
          applied++;
          touched.add(change.t);
        }
        return touched;
      });
      return applied;
    },

    async dump() {
      if (rows.hasNotes()) throw new Error('drain the change log before taking a snapshot');
      const clocks = new Map<string, string>();
      for (const c of rows.clocks()) clocks.set(`${c.t}|${c.k}`, c.h);
      const out: Change[] = [];
      const seen = new Set<string>();
      for (const table of rows.tables()) {
        for (const { k, r } of rows.every(table)) {
          const id = `${table}|${norm(k)}`;
          seen.add(id);
          out.push({ t: table, k, r, h: clocks.get(id) ?? '00000000000000.00000.00000000' });
        }
      }
      for (const [id, h] of clocks) {
        if (seen.has(id)) continue;
        const at = id.indexOf('|');
        out.push({ t: id.slice(0, at), k: JSON.parse(id.slice(at + 1)) as Key, r: null, h });
      }
      return out;
    },
  };
}
