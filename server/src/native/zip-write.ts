import { ZipFile } from 'yazl';
import type { ZipWriter } from 'spine-core/archive/zip-write.js';

export function newZip(): ZipWriter {
  const zip = new ZipFile();
  return {
    addBuffer: (data, name, options) => zip.addBuffer(data, name, { compress: options?.compress ?? false }),
    addFile: (path, name) => zip.addFile(path, name, { compress: false }),
    finish: () => { zip.end(); return zip.outputStream as unknown as AsyncIterable<Uint8Array>; },
  };
}
