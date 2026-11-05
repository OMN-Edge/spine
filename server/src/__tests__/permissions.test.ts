import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFilesystemObjects } from '../objects/filesystem.js';
import { keepPrivate } from '../permissions.js';

/**
 * SECURITY.md S-61. With the usual umask of 022 the data and every sealed object were readable by every local user of the machine. The modes
 * are asked for, not left to the umask, and the directories that hold everything are closed at start.
 */
const mode = (p: string) => fs.statSync(p).mode & 0o777;
const dirs: string[] = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-perm-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe.skipIf(process.platform === 'win32')('who can read what the server keeps', () => {
  it('makes a sealed object a file for its owner alone, in directories for its owner alone', async () => {
    const root = temp();
    const store = createFilesystemObjects(() => root);
    await store.put('vault/user-1/object-0001', Buffer.from('sealed'));
    expect(mode(path.join(root, 'vault', 'user-1', 'object-0001'))).toBe(0o600);
    expect(mode(path.join(root, 'vault', 'user-1'))).toBe(0o700);
    expect(mode(path.join(root, 'vault'))).toBe(0o700);
  });

  it('closes a data directory that others could read, and says which it changed', () => {
    const open = temp();
    fs.chmodSync(open, 0o755);
    const closed = temp();
    fs.chmodSync(closed, 0o700);
    expect(keepPrivate([open, closed, path.join(open, 'not-there')])).toEqual([open]);
    expect(mode(open)).toBe(0o700);
    expect(mode(closed)).toBe(0o700);
  });

  it('leaves a directory that is not a directory alone', () => {
    const file = path.join(temp(), 'a-file');
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, 0o644);
    expect(keepPrivate([file])).toEqual([]);
    expect(mode(file)).toBe(0o644);
  });
});
