import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { keepsFilesHere } from '../local-files.js';

const src = path.resolve(import.meta.dirname, '..');

describe('whether a process keeps files on the machine', () => {
  it('does, unless the accounts are in Postgres and the sealed bytes in a bucket', () => {
    expect(keepsFilesHere({})).toBe(true);
    expect(keepsFilesHere({ SPINE_STORE: 'postgres' })).toBe(true); // its objects are files
    expect(keepsFilesHere({ SPINE_OBJECTS: 'gcs' })).toBe(true); // its database is a file
    expect(keepsFilesHere({ SPINE_STORE: 'sqlite', SPINE_OBJECTS: 'gcs' })).toBe(true);
    expect(keepsFilesHere({ SPINE_STORE: 'postgres', SPINE_OBJECTS: 'filesystem' })).toBe(true);
    expect(keepsFilesHere({ SPINE_STORE: 'postgres', SPINE_OBJECTS: 'gcs' })).toBe(false);
  });

  // A file written by some other module would be a file an instance of the cloud deployment keeps, and so a state that a replaced or added instance does
  // not have. The modules that write are these, and each of them is reached only by a process that keeps files here (the database file, the filesystem
  // objects, the backup and the country file's download, which a cloud deployment replaces by the image's own file).
  it('is written only by the modules that are off when nothing is kept here', () => {
    const WRITERS = new Set(['driver-native.ts', 'permissions.ts', 'backup.ts', 'geoip-update.ts', 'objects/filesystem.ts']);
    const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const file = path.join(dir, name);
      return statSync(file).isDirectory() ? (['__tests__', 'testing', 'native', '__integration__'].includes(name) ? [] : walk(file)) : file.endsWith('.ts') ? [file] : [];
    });
    const writes = /\b(writeFile|writeFileSync|createWriteStream|mkdirSync|mkdir|appendFile|appendFileSync|renameSync|rename|copyFileSync|copyFile|rmSync|rm|unlinkSync|unlink|chmodSync)\(/;
    const found = walk(src).filter(f => writes.test(readFileSync(f, 'utf8'))).map(f => path.relative(src, f));
    expect(found.filter(f => !WRITERS.has(f)), 'a module that writes a file and is not on the list').toEqual([]);
  });
});
