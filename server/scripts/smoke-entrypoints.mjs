// Starts every entry point of the server as a process, the way it is deployed, and checks that it comes up and answers.  `npm run smoke`
// (after `npm run build`; the Dockerfiles and ./scripts/check.sh run it).
//
// An entry point is where the process registers what it uses (its store, its driver, its sign-in, its providers) and then starts. That is
// done in statements that must run in the right order, and nothing else starts the whole process, so a unit test cannot see it break: the
// relay once asked for its model client before it had registered a provider, and crashed on start, with every test green. The environment
// of each process is given here in full and not inherited, so nothing of the developer's own settings is used.
//
// Every entry point is listed in ENTRYPOINTS. `core/src/__tests__/architecture.test.ts` fails if the server has one that is not.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const ENTRYPOINTS = ['dist/index.js', 'dist/relay/main.js', 'dist/cli.js', 'dist/backup.js', 'dist/geoip-update.js'];

const server = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-smoke-'));
const baseEnv = {
  PATH: process.env.PATH ?? '', HOME: tmp, NODE_ENV: 'production',
  DATA_DIR: path.join(tmp, 'data'), SPINE_BACKUP_DIR: path.join(tmp, 'backup'),
  SESSION_SECRET: 'smoke-test-secret-that-is-long-enough-0123456789',
};

let failed = false;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !detail ? '' : `\n       ${detail.trim().split('\n').slice(-6).join('\n       ')}`}`); if (!ok) failed = true; };
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const wait = ms => new Promise(r => setTimeout(r, ms));

/** Runs a process that serves, waits until it answers, runs the probes, and stops it. */
async function serving(name, file, env, probes) {
  const port = await freePort();
  let output = '';
  let exited = null;
  const child = spawn(process.execPath, [path.join(server, file)], { cwd: server, env: { ...baseEnv, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  child.on('exit', code => { exited = code; });
  const url = p => `http://127.0.0.1:${port}${p}`;
  let up = false;
  for (let waited = 0; waited < 20_000 && exited === null && !up; waited += 200) {
    try { await fetch(url('/'), { method: 'OPTIONS' }); up = true; } catch { await wait(200); }
  }
  check(up, `${name} starts and listens`, exited !== null ? `it exited with ${exited}:\n${output}` : output);
  if (up) {
    for (const [what, method, p, body, accept] of probes) {
      try {
        const res = await fetch(url(p), { method, headers: body ? { 'content-type': 'application/json' } : {}, body });
        check(accept(res.status), `${name}: ${what}`, `answered ${res.status}`);
      } catch (err) { check(false, `${name}: ${what}`, String(err)); }
    }
  }
  child.kill('SIGTERM');
  await wait(300);
}

/** Runs a process that does a thing and ends. */
function running(name, file, args, env, accept) {
  const r = spawnSync(process.execPath, [path.join(server, file), ...args], { cwd: server, env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 30_000 });
  check(accept(r), name, `exit ${r.status}\n${r.stdout}${r.stderr}`);
}

await serving('the server', 'dist/index.js', { SPINE_HOST: '127.0.0.1' }, [
  ['answers the sign-in options', 'GET', '/api/auth/options', undefined, s => s === 200],
  ['has sign-in registered (a bad login is refused, not missing)', 'POST', '/api/auth/login', '{}', s => s === 400 || s === 401],
  ['keeps no route for records', 'GET', '/api/documents', undefined, s => s === 404],
]);
await serving('the relay', 'dist/relay/main.js', {
  SPINE_RELAY_SECRET: '0123456789012345678901234567890123456789', SPINE_RELAY_ORIGIN: 'https://app.example',
  SPINE_LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'not-a-real-key', SPINE_DB_PATH: ':memory:',
}, [
  ['answers the browser\'s preflight', 'OPTIONS', '/', undefined, s => s === 204],
  ['refuses a call with no pass', 'POST', '/v1/task/continuation', '{}', s => s === 401],
]);
running('the operator\'s commands run (create a user, list users)', 'dist/cli.js', ['create-user', 'smoke@example.com'], {}, r => r.status === 0 && /created smoke@example.com/.test(r.stdout));
running('the operator lists the user it created', 'dist/cli.js', ['list-users'], {}, r => r.status === 0 && /smoke@example.com/.test(r.stdout));
// Nothing listens at that address: the download fails, and a failed download must still end the process well (a unit runs it before the backup).
running('the country file update ends well when it cannot download', 'dist/geoip-update.js', [], { SPINE_GEOIP_URL: 'http://127.0.0.1:9/country.mmdb' }, r => r.status === 0 && /geoip: not updated/.test(r.stderr) && !fs.existsSync(path.join(baseEnv.DATA_DIR, 'geoip', 'country.mmdb')));
running('the backup runs and leaves a snapshot', 'dist/backup.js', [], {}, r => r.status === 0 && fs.existsSync(baseEnv.SPINE_BACKUP_DIR));

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
