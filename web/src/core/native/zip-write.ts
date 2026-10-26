import fs from '../shims/fs';
import { Buffer } from 'buffer';
import { zipSync, type Zippable } from 'fflate';
import type { ZipWriter } from 'spine-core/archive/zip-write';

/** Same contract as core/src/archive/zip-write.ts. The zip is built in memory, which an export of this device's own records fits. */
export function newZip(): ZipWriter {
  const entries: Zippable = {};
  return {
    addBuffer: (data, name, options) => { entries[name] = [new Uint8Array(data), { level: options?.compress ? 6 : 0 }]; },
    addFile: (path, name) => { entries[name] = [new Uint8Array(fs.readFileSync(path) as Buffer), { level: 0 }]; },
    finish: () => (async function* () { yield zipSync(entries); })(),
  };
}
