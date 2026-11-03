import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Deleting an account removes the backup's copy of its vault (`deleteAccount`), so the process that serves the app must be able to write
 * where the backup is, however it is installed. On Nov 3 the systemd unit could not (ProtectSystem=strict, the backup on another path):
 * the deletion failed with "Read-only file system". In compose the web service did not have the backups volume at all, so the copy was
 * never removed and nothing said so.
 */
const file = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

describe('where the app may write, as installed', () => {
  it('the systemd unit may write to the backup as well as the archive, and waits for both disks', () => {
    const unit = file('systemd/spine-web.service');
    expect(unit).toMatch(/^ReadWritePaths=.*\bSPINE_DIR\/data\b.*\bSPINE_BACKUP_TARGET\b/m);
    expect(unit).toMatch(/^RequiresMountsFor=.*\bSPINE_BACKUP_TARGET\b/m);
    // install.sh writes the backup's path into this unit, as into the backup's own.
    expect(file('install.sh')).toMatch(/for unit in spine-web\.service spine-backup\.service[\s\S]*?s\|SPINE_BACKUP_TARGET\|/);
  });

  it('in compose, the web service has the backups volume where the backup service writes it', () => {
    const compose = file('compose.yaml');
    const service = (name: string) => compose.split(/^ {2}(?=\S)/m).find(block => block.startsWith(`${name}:`)) ?? '';
    for (const name of ['web', 'backup']) {
      expect(service(name), name).toMatch(/SPINE_BACKUP_DIR: \/backups/);
      expect(service(name), name).toMatch(/- backups:\/backups/);
    }
  });
});
