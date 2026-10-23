import type { DigitalSigner, StampDoctor } from '../../../../server/src/ingestion/signatures-parse';

export * from '../../../../server/src/ingestion/signatures-parse';

/**
 * Not on the device yet. Reading the doctors on a stamp needs the pictures pulled out of the PDF (poppler's `pdfimages` on the server),
 * and a digital signature is checked by `pdfsig` against certificates: neither has a browser equivalent here. Both answers are the same
 * as when the server finds nothing, or fails: no doctors from them, and the upload goes on.
 */
export async function readSignatures(): Promise<Map<number, StampDoctor[]>> { return new Map(); }
export async function readDigitalSigners(): Promise<DigitalSigner[]> { return []; }
