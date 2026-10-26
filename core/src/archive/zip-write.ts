import { nativeTools, type NativeTools } from '../native-tools.js';

/**
 * A zip being written: entries added by name, from memory or from a file, then `finish()` gives the bytes as a stream. Nothing is
 * compressed (the files in it are PDFs and photos already). Written by the host's tool (`native-tools.ts`).
 */
export interface ZipWriter {
  /** Stored as it is unless `compress` (the manifest is text and shrinks). */
  addBuffer(data: Buffer, name: string, options?: { compress?: boolean }): void;
  addFile(path: string, name: string): void;
  finish(): AsyncIterable<Uint8Array>;
}

export const newZip: NativeTools['newZip'] = () => nativeTools().newZip();
