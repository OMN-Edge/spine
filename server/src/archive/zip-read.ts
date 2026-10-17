import yauzl from 'yauzl';
import { createWriteStream } from 'fs';
import { createHash } from 'crypto';

export interface ZipEntryInfo {
  name: string;
  /** What the zip says; the bytes actually read are counted and capped whatever it claims. */
  declaredSize: number;
  isDirectory: boolean;
}

export class ZipTooLarge extends Error {
  constructor() { super('an entry in the zip is larger than allowed'); this.name = 'ZipTooLarge'; }
}

/**
 * A zip opened for reading, a file that was given to us. Entries are found by name and read as a stream with their
 * size counted as it arrives; nothing is ever extracted to a path the zip chose, so a name like `../../x` is only
 * a name (SECURITY.md **M-14**). The declared size is not trusted: a small zip can claim to hold a small file and
 * expand to gigabytes, so every read has a limit of its own.
 */
export class ZipReader {
  private constructor(private readonly zip: yauzl.ZipFile, readonly entries: ZipEntryInfo[], private readonly raw: Map<string, yauzl.Entry>) {}

  static open(filePath: string, maxEntries = 20_000): Promise<ZipReader> {
    return new Promise((resolve, reject) => {
      yauzl.open(filePath, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (err, zip) => {
        if (err || !zip) return reject(err ?? new Error('cannot open the zip'));
        const entries: ZipEntryInfo[] = [];
        const raw = new Map<string, yauzl.Entry>();
        zip.on('entry', (entry: yauzl.Entry) => {
          if (entries.length >= maxEntries) { zip.close(); return reject(new Error('the zip has too many entries')); }
          if (!raw.has(entry.fileName)) {
            raw.set(entry.fileName, entry);
            entries.push({ name: entry.fileName, declaredSize: entry.uncompressedSize, isDirectory: entry.fileName.endsWith('/') });
          }
          zip.readEntry();
        });
        zip.on('end', () => resolve(new ZipReader(zip, entries, raw)));
        zip.on('error', reject);
        zip.readEntry();
      });
    });
  }

  private open(name: string): Promise<NodeJS.ReadableStream> {
    const entry = this.raw.get(name);
    if (!entry) return Promise.reject(new Error('no such entry'));
    return new Promise((resolve, reject) => this.zip.openReadStream(entry, (err, stream) => (err || !stream ? reject(err ?? new Error('cannot read the entry')) : resolve(stream))));
  }

  /** A small entry (the manifest) in memory. */
  async readBuffer(name: string, maxBytes: number): Promise<Buffer> {
    if ((this.raw.get(name)?.uncompressedSize ?? 0) > maxBytes) throw new ZipTooLarge();
    const stream = await this.open(name);
    const chunks: Buffer[] = [];
    let bytes = 0;
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { (stream as NodeJS.ReadableStream & { destroy(): void }).destroy(); reject(new ZipTooLarge()); return; }
        chunks.push(chunk);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  }

  /** An entry written to `destination`, with its sha256. Stops, and leaves a partial file for the caller to remove, at the limit. */
  async extractTo(name: string, destination: string, maxBytes: number): Promise<{ checksum: string; bytes: number }> {
    if ((this.raw.get(name)?.uncompressedSize ?? 0) > maxBytes) throw new ZipTooLarge();
    const stream = await this.open(name);
    const hash = createHash('sha256');
    const out = createWriteStream(destination);
    let bytes = 0;
    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) { (stream as NodeJS.ReadableStream & { destroy(): void }).destroy(); out.destroy(); reject(new ZipTooLarge()); return; }
        hash.update(chunk);
      });
      stream.on('error', err => { out.destroy(); reject(err); });
      out.on('error', reject);
      out.on('finish', () => resolve({ checksum: hash.digest('hex'), bytes }));
      stream.pipe(out);
    });
  }

  close(): void {
    this.zip.close();
  }
}
