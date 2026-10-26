import { nativeTools } from '../native-tools.js';

export interface ZipEntryInfo {
  name: string;
  /** What the zip says; the bytes actually read are counted and capped whatever it claims. */
  declaredSize: number;
  isDirectory: boolean;
}

/** Thrown by whoever reads a zip when an entry goes past its limit: one class, so a caller can tell it apart whichever tool read the zip. */
export class ZipTooLarge extends Error {
  constructor() { super('an entry in the zip is larger than allowed'); this.name = 'ZipTooLarge'; }
}

/**
 * A zip opened for reading, a file that was given to us. Entries are found by name and read with their size limited; nothing is ever
 * extracted to a path the zip chose, so a name like `../../x` is only a name (SECURITY.md **M-14**). The declared
 * size is not trusted (the Node reader counts bytes as they arrive; the browser's refuses a declared size over the cap and inflates into a buffer of that size, so a lie cannot make an entry larger): a small zip can claim to hold a small file and expand to gigabytes, so every read has a limit of its own.
 */
export interface ZipReader {
  readonly entries: ZipEntryInfo[];
  readBuffer(name: string, maxBytes: number): Promise<Buffer>;
  extractTo(name: string, destination: string, maxBytes: number): Promise<{ checksum: string; bytes: number }>;
  close(): void;
}

export const ZipReader = {
  /** Opens a zip with the host's tool (`native-tools.ts`). */
  open: (filePath: string, maxEntries?: number): Promise<ZipReader> => nativeTools().openZip(filePath, maxEntries),
};
