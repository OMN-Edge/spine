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

  it('in compose, the relay reads the same database as the server, unless the database is Postgres, when it has a volume of its own (S-64, P9)', () => {
    const compose = file('compose.yaml');
    const service = (name: string) => compose.split(/^ {2}(?=\S)/m).find(block => block.startsWith(`${name}:`)) ?? '';
    expect(service('web')).toMatch(/- data:\/data/);
    expect(service('relay')).toMatch(/- \$\{SPINE_RELAY_DATA:-data\}:\/data/);
    expect(service('relay')).toMatch(/SPINE_DB_PATH: \/data\/spine\.db/);
    expect(compose).toMatch(/^ {2}relay-data:$/m);
  });

  it('as a systemd unit, the relay opens the server\'s database and may write where it is, or a directory of its own with Postgres (S-64, P9)', () => {
    const web = file('systemd/spine-web.service');
    const relay = file('systemd/spine-relay.service');
    const install = file('install.sh');
    expect(web).toMatch(/^Environment=DATA_DIR=SPINE_DIR\/data$/m);
    expect(relay).toMatch(/^Environment=DATA_DIR=RELAY_DATA_HERE$/m);
    expect(relay).toMatch(/^Environment=SPINE_DB_PATH=RELAY_DATA_HERE\/spine\.db$/m);
    expect(relay).toMatch(/^ReadWritePaths=RELAY_DATA_HERE$/m);
    // install.sh -r names data/ for SQLite and relay-data/ for Postgres, and fills the placeholder in
    expect(install).toMatch(/local relay_data="\$\{SPINE_DIR\}\/data"\n\s+if \[ "\$\(env_value SPINE_STORE\)" = "postgres" \]; then\n\s+relay_data="\$\{SPINE_DIR\}\/relay-data"/);
    expect(install).toMatch(/s\|RELAY_DATA_HERE\|\$\{relay_data\}\|g/);
  });
});
