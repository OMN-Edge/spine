import { Buffer } from 'buffer';
import process from 'process';

/**
 * The server's code reaches for `Buffer` and `process` as globals. This module is imported first by the core's entry, so they exist
 * before any of that code runs. The core's own settings are not in `process.env`: they are `deviceSettings` (native/settings.ts).
 */
/** The `buffer` package predates the 'base64url' encoding that the server's code uses for tokens; it is base64 with two characters changed and no padding. */
const toString = Buffer.prototype.toString;
Buffer.prototype.toString = function (this: Buffer, encoding?: BufferEncoding, start?: number, end?: number) {
  if (encoding === ('base64url' as BufferEncoding)) return toString.call(this, 'base64', start, end).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return toString.call(this, encoding, start, end);
};
const from = Buffer.from.bind(Buffer) as (...args: unknown[]) => Buffer;
(Buffer as unknown as { from: unknown }).from = (value: unknown, encoding?: unknown, length?: unknown) =>
  typeof value === 'string' && encoding === 'base64url' ? from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64') : from(value, encoding, length);

const g = globalThis as unknown as { Buffer: typeof Buffer; process: typeof process };
g.Buffer = Buffer;
g.process = process;
process.env.NODE_ENV = 'production';
