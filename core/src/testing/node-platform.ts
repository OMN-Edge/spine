import os from 'node:os';
import path from 'node:path';
import { useDefaultDataDir, useSettings } from '../config.js';
import { useNodeDigests } from './node-digests.js';
import { useNodeFiles } from './node-files.js';

/**
 * What a process that runs the shared code on Node registers besides its store: hashing, files, and the settings (the environment, and a
 * directory of the tests' own where a configuration given as a literal names none, never the repository's). The setup files of the test runs
 * call this, and so does the server's test app when it is built in a process that has not been set up (the web's test of the device against it).
 */
export function useNodePlatform(): void {
  useNodeDigests();
  useNodeFiles();
  useSettings(process.env);
  useDefaultDataDir(path.join(os.tmpdir(), 'spine-test-default-data'));
}
