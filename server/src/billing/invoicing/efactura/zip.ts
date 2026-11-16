import { inflateRawSync } from 'node:zlib';

/**
 * The files of a small zip, by name: what ANAF answers a download with (the invoice or its errors, and the Ministry's signature). Reads the central directory and
 * takes the two methods a zip made by Java uses (stored, deflated); anything else, or a damaged file, is an error. Not for archives of any size: ANAF's are a few kilobytes.
 */
export function readZip(zip: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  // The end-of-central-directory record is within the last 64 KiB + 22 bytes, found by its signature from the back.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('the zip directory is damaged');
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    at += 46 + nameLength + extraLength + commentLength;
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('the zip is damaged');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    if (method === 0) files.set(name, Buffer.from(raw));
    else if (method === 8) files.set(name, inflateRawSync(raw));
    else throw new Error(`the zip uses method ${method}, which is not read here`);
  }
  return files;
}
