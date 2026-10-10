import type { ParseResponse } from '../types.js';

const INGESTION_URL = process.env.INGESTION_URL ?? 'http://127.0.0.1:8000';

export async function parseDocument(filePath: string): Promise<ParseResponse> {
  const res = await fetch(`${INGESTION_URL}/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_path: filePath }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingestion sidecar error ${res.status}: ${text}`);
  }

  return res.json() as Promise<ParseResponse>;
}
