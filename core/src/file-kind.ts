import { fileSystem } from './files.js';
import { loadParserConfig } from './config.js';

/** What a file is by what is in it, never by its name or the type a browser reported. */
export type FileKind = 'pdf' | 'jpeg' | 'png';

export const MIME_OF: Record<FileKind, string> = { pdf: 'application/pdf', jpeg: 'image/jpeg', png: 'image/png' };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The kind of a file, or null for anything else. A PDF's signature "%PDF-" may sit anywhere in the first
 * 1024 bytes (some writers put a few bytes of junk before it); an image's signature is at the very start.
 */
export function detectFileKind(filePath: string): FileKind | null {
  const head = fileSystem().readHead(filePath, 1024);
  if (head.includes('%PDF-')) return 'pdf';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (head.length >= PNG_SIGNATURE.length && head.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'png';
  return null;
}

export const isImage = (kind: FileKind | null): boolean => kind === 'jpeg' || kind === 'png';


/**
 * Whether local OCR is what reads a PDF made of photos: the parser is `ocr` or `hybrid` with Tesseract on. A scan session's pages are
 * straightened and cleaned on the device, which is what OCR needs, so nothing has to leave the host to read them. (`hybrid` still
 * sends a page to a model if OCR cannot read it and image reading is allowed, as for any scan.)
 */
export function localOcrReadsPhotoSets(): boolean {
  const c = loadParserConfig();
  return (c.mode === 'ocr' || c.mode === 'hybrid') && c.ocrEnabled;
}

/** Whether a model reads this upload because it has no text layer: a single photo, or photos bundled into a PDF unless local OCR reads those. */
export const readsByModel = (file: { mime_type: string | null; photo_set?: boolean }): boolean => (file.photo_set ? !localOcrReadsPhotoSets() : false) || (file.mime_type?.startsWith('image/') ?? false);
