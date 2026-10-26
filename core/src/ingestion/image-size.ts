import { fileSystem } from '../files.js';

export function getPageImageDimensions(imagePath: string): { width: number; height: number } {
  // Read PNG dimensions from header (bytes 16-24 of the PNG file)
  const buf = fileSystem().readHead(imagePath, 24);

  // PNG header: 8 bytes signature + 4 bytes chunk length + 4 bytes 'IHDR' + 4 bytes width + 4 bytes height
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}
