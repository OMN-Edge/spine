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

  // The Cloud Run files are settings written by hand: a name misspelt there is a setting that silently does nothing, so each is looked for in the page of settings.
  describe('the Cloud Run files', () => {
    const files = ['app.service.yaml', 'relay.service.yaml', 'jobs.job.yaml'];
    const names = (text: string) => [...text.matchAll(/^\s*(?:#\s*)?- \{ name: ([A-Z0-9_]+),/gm)].map(m => m[1]);
    it('set only settings the configuration page and the relay page know', () => {
      const page = file('docs/configuration.md') + file('docs/relay.md');
      const unknown: string[] = [];
      for (const f of files) for (const name of names(file(`deploy/cloud-run/${f}`))) if (!page.includes(name)) unknown.push(`${f}: ${name}`);
      expect(unknown).toEqual([]);
    });

    it('give the relay none of the server’s secrets, and the server a stand-alone setup: no disk, shared limits, the jobs outside', () => {
      const relay = file('deploy/cloud-run/relay.service.yaml');
      for (const secret of ['SESSION_SECRET', 'BREVO_API_KEY', 'PADDLE_API_KEY', 'PADDLE_WEBHOOK_SECRET']) expect(relay, secret).not.toMatch(new RegExp(`name: ${secret}\\b`));
      const app = file('deploy/cloud-run/app.service.yaml');
      for (const [name, value] of [['SPINE_STORE', 'postgres'], ['SPINE_OBJECTS', 'gcs'], ['SPINE_LIMITS', 'store'], ['SPINE_JOBS', 'external'], ['SPINE_SERVER_HEADERS', 'on']]) {
        expect(app, name).toMatch(new RegExp(`name: ${name}, value: "?${value}"? `));
      }
      expect(app).toMatch(/run\.googleapis\.com\/ingress: internal-and-cloud-load-balancing/);
      expect(app).toMatch(/path: \/healthz/);
    });
  });
});
