/**
 * The files of the shared code: originals, page images, scratch. It is a port because where they live differs: Node's disk for the tests that
 * run the whole app, the server's own storage, and, on the device, memory that is sealed into the vault and never written to the browser's disk
 * in the clear (`web/src/core/shims/fs.ts`). Paths are POSIX and absolute. The operations are the ones the shared code uses, and no more; a
 * process that registered none fails at the first use, saying so.
 */
export interface FileInfo {
  size: number;
  mtime: Date;
  isFile(): boolean;
}

/** A file being written piece by piece. `write` resolves when the piece is taken (so a slow disk slows the reader), and `end` when the file is whole. */
export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  end(): Promise<void>;
}

export interface Files {
  existsSync(path: string): boolean;
  /** Throws if there is no such file. */
  statSync(path: string): FileInfo;
  readFileSync(path: string): Buffer;
  readTextSync(path: string): string;
  readFile(path: string): Promise<Buffer>;
  /** The first `length` bytes, or fewer if the file is shorter. */
  readHead(path: string, length: number): Buffer;
  writeFileSync(path: string, data: string | Uint8Array): void;
  /** The directory and any missing ones above it. */
  mkdirSync(path: string): void;
  /** A file, or a directory with all it holds; nothing happens if there is none. */
  rmSync(path: string): void;
  renameSync(from: string, to: string): void;
  copyFileSync(from: string, to: string): void;
  readStream(path: string): AsyncIterable<Uint8Array>;
  writeStream(path: string): FileSink;
}

let current: Files | null = null;

/** Called once by the process that brings the files: the device when its core starts, the tests' setup file. */
export function useFiles(files: Files | null): void {
  current = files;
}

/** The files of this process. With none registered a feature that needs one fails at once, saying so. */
export function fileSystem(): Files {
  if (!current) throw new Error('no files have been registered for this process (useFiles)');
  return current;
}
