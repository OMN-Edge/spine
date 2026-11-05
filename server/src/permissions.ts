import fs from 'node:fs';

/**
 * Who on the machine may read the data (SECURITY.md S-61). The accounts database holds the credential hashes, the sealed keys, the shares'
 * metadata and the encrypted authenticator seeds, and every sealed object is a file beside it; a process that makes them with the usual umask
 * of 022 leaves them readable by every local user. This makes what the server creates private to its own user, and the two directories that
 * hold everything closed to the rest, whatever mode earlier files were made with.
 */

/** Files and directories this process makes from now on are for its own user alone. Not available in a worker thread, where it is skipped. */
export function privateByDefault(): void {
  try { process.umask(0o077); } catch { /* a worker thread cannot change it */ }
}

/**
 * Closes each existing directory to everyone but its owner (mode 700), which shuts out the files inside whatever their own modes are, and
 * returns the ones it had to change. A directory that is not there, or that another user owns, is left alone.
 */
export function keepPrivate(dirs: string[]): string[] {
  const changed: string[] = [];
  for (const dir of dirs) {
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory() || (stat.mode & 0o077) === 0) continue;
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) continue;
      fs.chmodSync(dir, 0o700);
      changed.push(dir);
    } catch { /* not there, or not ours to change */ }
  }
  return changed;
}
