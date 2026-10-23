import { Buffer } from 'buffer';
import process from 'process';

/**
 * The server's code reaches for `Buffer` and `process` as globals. This module is imported first by the core's entry, so they exist
 * before any of that code runs. `process.env` is the core's configuration: nothing here is a secret, and nothing is read from the page.
 */
const g = globalThis as unknown as { Buffer: typeof Buffer; process: typeof process };
g.Buffer = Buffer;
g.process = process;
process.env.SPINE_DB_PATH = ':memory:';
process.env.DATA_DIR = '/data';
process.env.NODE_ENV = 'production';
