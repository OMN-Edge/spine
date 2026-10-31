import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkKey, checkPrefix, type ObjectStore } from './types.js';

/**
 * Objects as files under a directory (`<data>/` for the server): the adapter for a machine with a disk, such as the Pi. A write goes to a
 * file beside and is renamed over, so a reader never sees half an object and a failed write leaves the old one. The directory is given as a
 * function because the data directory is decided when the process starts, not when this is made.
 */
export function createFilesystemObjects(root: () => string): ObjectStore {
  const inside = (relative: string): string => {
    const base = path.resolve(root());
    const full = path.resolve(base, relative);
    if (full !== base && !full.startsWith(base + path.sep)) throw new Error('invalid object key');
    return full;
  };

  return {
    kind: 'filesystem',

    async put(key, bytes) {
      const target = inside(checkKey(key));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const staged = `${target}.${randomUUID()}.part`;
      fs.writeFileSync(staged, bytes);
      fs.renameSync(staged, target);
    },

    async get(key) {
      try {
        return fs.readFileSync(inside(checkKey(key)));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'EISDIR') return null;
        throw err;
      }
    },

    async remove(key) {
      fs.rmSync(inside(checkKey(key)), { force: true });
    },

    async list(prefix) {
      checkPrefix(prefix);
      const found: string[] = [];
      const walk = (relative: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(inside(relative), { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const child = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(child);
          else if (!entry.name.endsWith('.part') && child.startsWith(prefix)) found.push(child);
        }
      };
      walk(prefix.slice(0, prefix.lastIndexOf('/') + 1).replace(/\/$/, ''));
      return found;
    },

    async removeAll(prefix) {
      if (!prefix.endsWith('/')) throw new Error('invalid object prefix');
      fs.rmSync(inside(checkPrefix(prefix).replace(/\/$/, '')), { recursive: true, force: true });
    },
  };
}
