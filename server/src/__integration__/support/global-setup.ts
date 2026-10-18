import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * The sidecar the pipeline reads PDFs through. If one answers at INGESTION_URL (default 127.0.0.1:8000) it is used; otherwise one is
 * started from the repository's own virtualenv on a port of its own and stopped afterwards. If neither is possible the flows that need
 * it are skipped, and the run says so.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

async function healthy(url: string): Promise<boolean> {
  try { return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

let child: ChildProcess | null = null;

export default async function setup() {
  const given = process.env.INGESTION_URL ?? 'http://127.0.0.1:8000';
  if (await healthy(given)) { process.env.INGESTION_URL = given; process.env.SPINE_IT_SIDECAR = '1'; return teardown; }

  const uvicorn = path.join(root, 'ingestion-service/.venv/bin/uvicorn');
  if (existsSync(uvicorn)) {
    const url = 'http://127.0.0.1:8765';
    child = spawn(uvicorn, ['main:app', '--host', '127.0.0.1', '--port', '8765'], { cwd: path.join(root, 'ingestion-service'), stdio: 'ignore' });
    for (let i = 0; i < 60 && !(await healthy(url)); i++) await new Promise(r => setTimeout(r, 500));
    if (await healthy(url)) { process.env.INGESTION_URL = url; process.env.SPINE_IT_SIDECAR = '1'; return teardown; }
    child.kill();
    child = null;
  }
  console.warn('[integration] no ingestion sidecar: the flows that read a PDF are skipped');
  return teardown;
}

function teardown() { child?.kill(); child = null; }
