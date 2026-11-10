import { afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Setup file of the server's test runs: each test file gets a data directory of its own. The files run side by side in one process, and the
 * sealed objects of `user-owner` (the account most of them use) are files under the data directory, so one file erasing them (an account
 * deleted, a reset that starts over) took another's away and made it fail now and then. A file that names a directory itself still may.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-test-data-'));
process.env.DATA_DIR = dir;
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
