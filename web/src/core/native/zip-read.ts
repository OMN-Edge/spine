import fs from 'fs';
import { Buffer } from 'buffer';
import { unzipSync } from 'fflate';
import { createHash } from 'crypto';

export interface ZipEntryInfo { name: string; declaredSize: number; isDirectory: boolean }

export class ZipTooLarge extends Error {
  constructor() { super('an entry in the zip is larger than allowed'); this.name = 'ZipTooLarge'; }
}

/**
 * Same contract as core/src/archive/zip-read.ts: a zip given to us, entries found by name, nothing extracted to a path the zip chose,
 * and every read capped whatever the zip claims. fflate lists the entries without inflating any, then inflates one at a time.
 */
export class ZipReader {
  private constructor(private readonly data: Uint8Array, readonly entries: ZipEntryInfo[]) {}

  static async open(filePath: string, maxEntries = 20_000): Promise<ZipReader> {
    const data = new Uint8Array(fs.readFileSync(filePath) as Buffer);
    const entries: ZipEntryInfo[] = [];
    const seen = new Set<string>();
    unzipSync(data, {
      filter: info => {
        if (entries.length >= maxEntries) throw new Error('the zip has too many entries');
        if (!seen.has(info.name)) { seen.add(info.name); entries.push({ name: info.name, declaredSize: info.originalSize, isDirectory: info.name.endsWith('/') }); }
        return false;
      },
    });
    return new ZipReader(data, entries);
  }

  private bytes(name: string, maxBytes: number): Uint8Array {
    const info = this.entries.find(e => e.name === name);
    if (!info) throw new Error('no such entry');
    if (info.declaredSize > maxBytes) throw new ZipTooLarge();
    const found = unzipSync(this.data, { filter: f => f.name === name })[name];
    if (!found) throw new Error('cannot read the entry');
    if (found.length > maxBytes) throw new ZipTooLarge();
    return found;
  }

  async readBuffer(name: string, maxBytes: number): Promise<Buffer> {
    return Buffer.from(this.bytes(name, maxBytes));
  }

  async extractTo(name: string, destination: string, maxBytes: number): Promise<{ checksum: string; bytes: number }> {
    const bytes = this.bytes(name, maxBytes);
    fs.writeFileSync(destination, bytes);
    return { checksum: createHash('sha256').update(bytes).digest('hex') as string, bytes: bytes.length };
  }

  close(): void {}
}
