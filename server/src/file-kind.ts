import { closeSync, openSync, readSync } from 'fs';

/** What a file is by what is in it, never by its name or the type a browser reported. */
export type FileKind = 'pdf' | 'jpeg' | 'png';

export const MIME_OF: Record<FileKind, string> = { pdf: 'application/pdf', jpeg: 'image/jpeg', png: 'image/png' };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The kind of a file, or null for anything else. A PDF's signature "%PDF-" may sit anywhere in the first
 * 1024 bytes (some writers put a few bytes of junk before it); an image's signature is at the very start.
 */
export function detectFileKind(filePath: string): FileKind | null {
  const buffer = Buffer.alloc(1024);
  const fd = openSync(filePath, 'r');
  let read: number;
  try {
    read = readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  const head = buffer.subarray(0, read);
  if (head.includes('%PDF-')) return 'pdf';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= PNG_SIGNATURE.length && head.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'png';
  return null;
}

export const isImage = (kind: FileKind | null): boolean => kind === 'jpeg' || kind === 'png';
