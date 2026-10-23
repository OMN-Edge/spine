import path from 'path';
import { PassThrough, Writable } from 'stream';
import { Buffer } from 'buffer';

/**
 * The part of Node's `fs` that the core uses, over memory. The core is the server's code running on the device; what it keeps as files
 * (originals, page images, scratch) lives here and is never written to the browser's disk in the clear. What persists is sealed into the
 * vault by a layer above (docs/crypto-design.md). Paths are POSIX and absolute, as on the server.
 */
type Entry = { data: Uint8Array | null; size: number; mtime: Date };
/** Set when a file the vault holds is asked for before it has been brought in; the caller fetches it and asks again. */
export class NeedsFile extends Error {
  constructor(readonly path: string) { super(`${path} is in the vault and not loaded yet`); this.name = 'NeedsFile'; }
}
const written = new Set<string>();
const removed = new Set<string>();
const resident = (a: string, e: Entry): Uint8Array => { if (!e.data) throw new NeedsFile(a); return e.data; };
const files = new Map<string, Entry>();
const dirs = new Set<string>(['/']);

function fail(code: string, syscall: string, p: string): never {
  const err = new Error(`${code}: ${syscall}, '${p}'`) as Error & { code: string; errno?: number; syscall: string; path: string };
  err.code = code; err.syscall = syscall; err.path = p;
  throw err;
}
const abs = (p: string | URL) => path.resolve('/', String(p));

export function mkdirSync(p: string, options?: { recursive?: boolean }): string | undefined {
  const target = abs(p);
  if (!options?.recursive && !dirs.has(path.dirname(target))) fail('ENOENT', 'mkdir', p);
  let first: string | undefined;
  for (let at = target; !dirs.has(at); at = path.dirname(at)) { dirs.add(at); first = at; }
  return first;
}
export function existsSync(p: string): boolean { const a = abs(p); return files.has(a) || dirs.has(a); }

export function writeFileSync(p: string, data: string | Uint8Array): void {
  const a = abs(p);
  if (!dirs.has(path.dirname(a))) fail('ENOENT', 'open', p);
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : Uint8Array.from(data);
  files.set(a, { data: bytes, size: bytes.length, mtime: new Date() });
  written.add(a); removed.delete(a);
}
export function readFileSync(p: string, options?: string | { encoding?: string }): Buffer | string {
  const entry = files.get(abs(p));
  if (!entry) fail('ENOENT', 'open', p);
  const buf = Buffer.from(resident(abs(p), entry));
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding ? buf.toString(encoding as BufferEncoding) : buf;
}
export function copyFileSync(from: string, to: string): void { writeFileSync(to, (readFileSync(from) as Buffer)); }
export function renameSync(from: string, to: string): void {
  const entry = files.get(abs(from));
  if (!entry) fail('ENOENT', 'rename', from);
  files.set(abs(to), entry);
  files.delete(abs(from));
  written.add(abs(to)); written.delete(abs(from)); removed.add(abs(from)); removed.delete(abs(to));
}
export function rmSync(p: string, options?: { recursive?: boolean; force?: boolean }): void {
  const a = abs(p);
  if (files.delete(a)) { removed.add(a); written.delete(a); return; }
  if (dirs.has(a)) {
    const prefix = a === '/' ? '/' : `${a}/`;
    for (const f of [...files.keys()]) if (f.startsWith(prefix)) { files.delete(f); removed.add(f); written.delete(f); }
    for (const d of [...dirs]) if (d.startsWith(prefix) || d === a) dirs.delete(d);
    dirs.add('/');
    return;
  }
  if (!options?.force) fail('ENOENT', 'rm', p);
}
export function statSync(p: string) {
  const a = abs(p);
  const entry = files.get(a);
  if (entry) return { size: entry.size, mtime: entry.mtime, isFile: () => true, isDirectory: () => false };
  if (dirs.has(a)) return { size: 0, mtime: new Date(0), isFile: () => false, isDirectory: () => true };
  return fail('ENOENT', 'stat', p);
}
export function readdirSync(p: string, options?: { withFileTypes?: boolean }) {
  const a = abs(p);
  if (!dirs.has(a)) fail('ENOENT', 'scandir', p);
  const prefix = a === '/' ? '/' : `${a}/`;
  const names = new Map<string, boolean>();
  for (const f of files.keys()) if (f.startsWith(prefix)) { const rest = f.slice(prefix.length); const [head] = rest.split('/'); names.set(head, rest.includes('/') ? names.get(head) ?? true : false); }
  for (const d of dirs) if (d.startsWith(prefix) && d !== a) names.set(d.slice(prefix.length).split('/')[0], true);
  const list = [...names.keys()].sort();
  return options?.withFileTypes ? list.map(name => ({ name, isDirectory: () => names.get(name)!, isFile: () => !names.get(name)! })) : list;
}
let counter = 0;
export function mkdtempSync(prefix: string): string { const dir = `${prefix}${(++counter).toString(36)}${Math.random().toString(36).slice(2, 8)}`; mkdirSync(dir, { recursive: true }); return dir; }

const handles = new Map<number, string>();
let nextFd = 3;
export function openSync(p: string): number { const e = files.get(abs(p)); if (!e) fail('ENOENT', 'open', p); resident(abs(p), e); handles.set(nextFd, abs(p)); return nextFd++; }
export function closeSync(fd: number): void { handles.delete(fd); }
export function readSync(fd: number, into: Uint8Array, offset: number, length: number, position: number): number {
  const entry = files.get(handles.get(fd) ?? '');
  if (!entry) fail('EBADF', 'read', String(fd));
  const slice = resident(handles.get(fd)!, entry).subarray(position, position + length);
  into.set(slice, offset);
  return slice.length;
}

export function createReadStream(p: string): PassThrough {
  const entry = files.get(abs(p));
  if (!entry) fail('ENOENT', 'open', p);
  const out = new PassThrough();
  out.end(Buffer.from(resident(abs(p), entry)));
  return out;
}
export function createWriteStream(p: string): Writable {
  const a = abs(p);
  const chunks: Uint8Array[] = [];
  return new Writable({
    write(chunk, _enc, done) { chunks.push(Uint8Array.from(chunk)); done(); },
    final(done) {
      try {
        const data = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0; for (const c of chunks) { data.set(c, at); at += c.length; }
        if (!dirs.has(path.dirname(a))) fail('ENOENT', 'open', p);
        files.set(a, { data, size: data.length, mtime: new Date() });
        written.add(a); removed.delete(a);
        done();
      } catch (err) { done(err as Error); }
    },
  });
}

export const promises = {
  readFile: async (p: string, options?: string | { encoding?: string }) => readFileSync(p, options),
  writeFile: async (p: string, data: string | Uint8Array) => writeFileSync(p, data),
  readdir: async (p: string, options?: { withFileTypes?: boolean }) => readdirSync(p, options),
  rm: async (p: string, options?: { recursive?: boolean; force?: boolean }) => rmSync(p, options),
  mkdir: async (p: string, options?: { recursive?: boolean }) => mkdirSync(p, options),
  mkdtemp: async (prefix: string) => mkdtempSync(prefix),
  stat: async (p: string) => statSync(p),
};

/**
 * For the layers above (persistence): what changed since the last `settle()`, files the vault holds but this page has not brought in
 * (`known`), bringing one in (`fill`), letting a loaded one go (`evict`), and forgetting everything (locking the vault).
 */
export const memory = {
  put(p: string, data: Uint8Array) { mkdirSync(path.dirname(abs(p)), { recursive: true }); writeFileSync(p, data); },
  take(p: string): Uint8Array | undefined { return files.get(abs(p))?.data ?? undefined; },
  changes(): { written: string[]; removed: string[] } { return { written: [...written], removed: [...removed] }; },
  settle(paths?: { written?: string[]; removed?: string[] }) {
    for (const p of paths?.written ?? [...written]) written.delete(p);
    for (const p of paths?.removed ?? [...removed]) removed.delete(p);
  },
  known(p: string, size: number) { const a = abs(p); mkdirSync(path.dirname(a), { recursive: true }); if (!files.has(a)) files.set(a, { data: null, size, mtime: new Date(0) }); },
  fill(p: string, data: Uint8Array) { const a = abs(p); const e = files.get(a); if (e) { e.data = data; e.size = data.length; } },
  evict(p: string) { const e = files.get(abs(p)); if (e && !written.has(abs(p))) e.data = null; },
  isResident(p: string) { return !!files.get(abs(p))?.data; },
  clear() { files.clear(); dirs.clear(); dirs.add('/'); written.clear(); removed.clear(); },
};

export default { mkdirSync, existsSync, writeFileSync, readFileSync, copyFileSync, renameSync, rmSync, statSync, readdirSync, mkdtempSync, openSync, closeSync, readSync, createReadStream, createWriteStream, promises };
