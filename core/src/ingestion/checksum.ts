import { createHash } from 'crypto';
import { readFileSync } from 'fs';

/** The sha256 of a file that was just made here (a bundle of photos), which is small enough to read whole. */
export const sha256OfFileSync = (filePath: string): string => createHash('sha256').update(readFileSync(filePath)).digest('hex');
