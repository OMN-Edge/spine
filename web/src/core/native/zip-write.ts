import fs from 'fs';
import { PassThrough } from 'stream';
import { Buffer } from 'buffer';
import { zipSync, type Zippable } from 'fflate';
import type { ZipWriter } from '../../../../server/src/archive/zip-write';

/** Same contract as server/src/archive/zip-write.ts. The zip is built in memory, which an export of this device's own records fits. */
export function newZip(): ZipWriter {
  const entries: Zippable = {};
  return {
    addBuffer: (data, name, options) => { entries[name] = [new Uint8Array(data), { level: options?.compress ? 6 : 0 }]; },
    addFile: (path, name) => { entries[name] = [new Uint8Array(fs.readFileSync(path) as Buffer), { level: 0 }]; },
    finish: () => { const out = new PassThrough(); out.end(Buffer.from(zipSync(entries))); return out; },
  };
}
