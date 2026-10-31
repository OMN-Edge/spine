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
  'document_translations', 'document_embeddings', 'episodes', 'episode_documents', 'document_links', 'chat_conversations', 'chat_messages', 'guide_marks',
] as const;

/** Rows that name another by a key two devices may have made differently for one thing: [column, the table whose key it is]. */
export const ALIASED: Record<string, Array<[string, string]>> = {
  tags: [['id', 'tags']], document_tags: [['tag_id', 'tags']],
  doctors: [['id', 'doctors']], document_doctors: [['doctor_id', 'doctors']],
};

/**
 * A write the store noted, in the order it happened. `r` is the whole row after it (null: deleted); `at` is when, in milliseconds. `o` is
 * the row as it was before an update that kept its key, which is how the columns it changed are found; absent for an insert, a delete, and a
 * store that does not note it (the write is then taken to be of the whole row).
 */
export interface Note { t: string; k: Record<string, Cell>; r: Record<string, Cell> | null; at: number; o?: Record<string, Cell> | null }

/**
 * When a row's columns were last written. `h` is the newest of them (and, for a deleted row, when it was deleted). Columns not named in
 * `cols` were written at `b`, or at `h` when there is no `b`: a row written whole has just `h`, and a row some of whose columns were
 * edited since has the stamp of the whole write as `b` and the later ones in `cols`.
 */
export interface Stamp { h: string; b?: string; cols?: Record<string, string> }

/** Older than any stamp a device makes: what a column nobody has written is taken to have been written at. */
export const NEVER = '00000000000000.00000.00000000';

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

  /** The stamp of a row (deleted ones too), `key` being its key as `JSON.stringify` of the key object. */
  stamp(table: string, key: string): Stamp | undefined;
  setStamp(table: string, key: string, stamp: Stamp): void;
  stamps(): Array<{ t: string; k: string; stamp: Stamp }>;
  /** Whether the row is there now. */
  exists(table: string, key: Key): boolean;
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
/** How many of the latest readings are kept. The quickest of them is used, so one slow request does not move the offset, and the offset follows the device's clock within this many requests. */
const CLOCK_READINGS = 8;
interface Reading { offset: number; roundTrip: number }
let readings: Reading[] = [];

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

/**
 * Takes one reading. Of the latest few, the one from the quickest round trip is kept, since it is the one that says most about the server's
 * time. Two honest readings differ by no more than their round trips and the header's second; a reading that differs by more than that
 * means this device's clock was set or jumped since the others, so they are forgotten and the offset follows the new one at once. (An
 * offset kept for ever would stamp every later write with the old error.)
 */
export function observeServerClock(dateHeader: string | null, sentAt: number, receivedAt: number): void {
  const roundTrip = receivedAt - sentAt;
  const offset = serverClockOffset(dateHeader, sentAt, receivedAt);
  if (offset === null || roundTrip < 0 || roundTrip > CLOCK_MAX_ROUND_TRIP_MS) return;
  if (readings.some(r => Math.abs(r.offset - offset) > r.roundTrip / 2 + roundTrip / 2 + 1_500 + CLOCK_DEAD_ZONE_MS)) readings = [];
  readings = [...readings, { offset, roundTrip }].slice(-CLOCK_READINGS);
  const best = readings.reduce((x, y) => (y.roundTrip < x.roundTrip ? y : x));
  clockOffset = Math.abs(best.offset) < CLOCK_DEAD_ZONE_MS ? 0 : Math.round(best.offset);
}

/** The offset in use, and a way to set it (tests, and a device that locks and forgets). */
export const currentClockOffset = (): number => clockOffset;
export function resetServerClock(): void { clockOffset = 0; readings = []; }

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

/** When `column` was last written, according to `stamp`. */
const stampOf = (stamp: Stamp | undefined, column: string): string => stamp?.cols?.[column] ?? stamp?.b ?? stamp?.h ?? NEVER;

/** A stamp with the same meaning and the least in it: a column written when the rest were is not listed. */
function tidy(stamp: Stamp): Stamp {
  if (!stamp.cols) return stamp.b === undefined ? { h: stamp.h } : stamp;
  const cols = Object.fromEntries(Object.entries(stamp.cols).filter(([, h]) => h !== stamp.b));
  if (Object.keys(cols).length === 0) return { h: stamp.b ?? stamp.h };
  return { h: stamp.h, b: stamp.b, cols };
}

/** The stamp after `columns` were written at `h`. */
function written(stamp: Stamp | undefined, columns: string[], h: string): Stamp {
  const cols = { ...stamp?.cols };
  for (const column of columns) cols[column] = h;
  return tidy({ h: stamp && stamp.h > h ? stamp.h : h, b: stamp ? (stamp.b ?? stamp.h) : NEVER, cols });
}

const same = (a: Cell | undefined, b: Cell | undefined) => (a ?? null) === (b ?? null);

/** The change log over any store that can supply `Rows`. One per store: it holds that device's clock. `now` is the device's own clock, which a write is never stamped after. */
export function createChangeLog(rows: Rows, clock: HybridClock = new HybridClock(), now: () => number = Date.now): ChangeLog {
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
      const held = rows.stamp(change.t, norm(h))?.h;
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
      // A row written twice is stamped when it was written last, after the rows written between. Of the columns it changed, those of every
      // write since the row was last whole here: an update after an insert (or a delete) in the same batch is the whole row.
      const last = new Map<string, { note: Note; columns: Set<string> | null }>();
      for (const note of notes) {
        const id = `${note.t}|${norm(note.k)}`;
        const before = last.get(id);
        last.delete(id);
        let columns: Set<string> | null = null;
        if (note.r !== null && note.o && !(before && before.columns === null)) {
          columns = new Set(before?.columns);
          for (const column of Object.keys(note.r)) if (!(column in note.k) && !same(note.o[column], note.r[column])) columns.add(column);
        }
        last.set(id, { note, columns });
      }
      const changes: Change[] = [];
      rows.atomic(() => {
        for (const { note, columns } of last.values()) {
          const key = norm(note.k);
          const held = rows.stamp(note.t, key);
          // Nothing changed (an update that wrote the values it had): nothing to send.
          if (columns && columns.size === 0 && held) continue;
          // Never later than now: a write cannot have happened after the moment it is stamped, so a write that seems to is on a clock that was set
          // back since, and a stamp ahead of the server's time would win conflicts it should lose.
          const h = clock.stamp(Math.min(note.at, now()));
          if (columns && held) {
            const named = [...columns].sort();
            changes.push({ t: note.t, k: note.k, r: note.r, h, c: named });
            rows.setStamp(note.t, key, written(held, named, h));
          } else {
            changes.push({ t: note.t, k: note.k, r: note.r, h });
            rows.setStamp(note.t, key, { h });
          }
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
          const held = rows.stamp(change.t, key);
          if (change.r === null) {
            if (held && held.h >= change.h) continue;
            rows.remove(change.t, change.k);
            rows.setStamp(change.t, key, { h: change.h });
          } else if (!rows.exists(change.t, change.k)) {
            // A new row, or one deleted since (a deletion newer than this write stays): the whole row comes, the columns the write did not
            // change as old as the deletion, so an older write to them is still beaten.
            if (held && held.h >= change.h) continue;
            put(change);
            rows.setStamp(change.t, key, change.c
              ? written({ h: held?.h ?? NEVER }, change.c, change.h)
              : { h: change.h });
          } else {
            // A row that is here: each column goes to the newest write of it, so two devices that changed different columns both keep theirs.
            const columns = (change.c ?? Object.keys(change.r)).filter(c => c in change.r! && !(c in change.k));
            const won = columns.filter(c => change.h > stampOf(held, c));
            if (won.length === 0) continue;
            put({ ...change, r: { ...change.k, ...Object.fromEntries(won.map(c => [c, change.r![c]!])) } });
            rows.setStamp(change.t, key, !change.c && won.length === columns.length ? { h: change.h } : written(held, won, change.h));
          }
          applied++;
          touched.add(change.t);
        }
        return touched;
      });
      return applied;
    },

    async dump() {
      if (rows.hasNotes()) throw new Error('drain the change log before taking a snapshot');
      const stamps = new Map<string, Stamp>();
      for (const c of rows.stamps()) stamps.set(`${c.t}|${c.k}`, c.stamp);
      const out: Change[] = [];
      const seen = new Set<string>();
      for (const table of rows.tables()) {
        for (const { k, r } of rows.every(table)) {
          const id = `${table}|${norm(k)}`;
          seen.add(id);
          const stamp = stamps.get(id);
          // The row as a whole at the time of the oldest column, then the later columns each at theirs: a device that applies them in any order ends with the same row.
          out.push({ t: table, k, r, h: stamp ? (stamp.cols ? (stamp.b ?? NEVER) : stamp.h) : NEVER });
          const byTime = new Map<string, string[]>();
          for (const [column, h] of Object.entries(stamp?.cols ?? {})) byTime.set(h, [...(byTime.get(h) ?? []), column]);
          for (const [h, columns] of [...byTime].sort(([x], [y]) => (x < y ? -1 : 1))) out.push({ t: table, k, r, h, c: columns.sort() });
        }
      }
      for (const [id, stamp] of stamps) {
        if (seen.has(id)) continue;
        const at = id.indexOf('|');
        out.push({ t: id.slice(0, at), k: JSON.parse(id.slice(at + 1)) as Key, r: null, h: stamp.h });
      }
      return out;
    },
  };
}
