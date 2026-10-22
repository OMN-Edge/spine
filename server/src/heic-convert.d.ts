declare module 'heic-convert' {
  /** Decodes the first image of a HEIC/HEIF file and encodes it; no types ship with the package. */
  export default function convert(options: { buffer: Buffer | Uint8Array; format: 'JPEG' | 'PNG'; quality?: number }): Promise<ArrayBuffer>;
}
