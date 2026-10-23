import { ZipFile } from 'yazl';

/**
 * A zip being written: entries added by name, from memory or from a file, then `finish()` gives the bytes as a stream. Nothing is
 * compressed (the files in it are PDFs and photos already). The device writes zips with its own library (web/src/core/native/zip-write.ts).
 */
export interface ZipWriter {
  /** Stored as it is unless `compress` (the manifest is text and shrinks). */
  addBuffer(data: Buffer, name: string, options?: { compress?: boolean }): void;
  addFile(path: string, name: string): void;
  finish(): NodeJS.ReadableStream;
}

export function newZip(): ZipWriter {
  const zip = new ZipFile();
  return {
    addBuffer: (data, name, options) => zip.addBuffer(data, name, { compress: options?.compress ?? false }),
    addFile: (path, name) => zip.addFile(path, name, { compress: false }),
    finish: () => { zip.end(); return zip.outputStream; },
  };
}
