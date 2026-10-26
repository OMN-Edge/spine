import { fileSystem } from '../files.js';
import { sha256Hex } from '../digest.js';

/** The sha256 of a file that was just made here (a bundle of photos), which is small enough to read whole. */
export const sha256OfFileSync = (filePath: string): string => sha256Hex(fileSystem().readFileSync(filePath));
