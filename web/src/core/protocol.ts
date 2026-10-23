/** What the page and the core's worker say to one another. */
export type Part = { fieldname: string; filename?: string; mimetype?: string; data?: ArrayBuffer; value?: string };
export type ToWorker =
  | { id: number; type: 'start'; masterKey: Uint8Array }
  | { id: number; type: 'request'; method: string; url: string; headers: Record<string, string>; body?: string; parts?: Part[] }
  | { id: number; type: 'startShare'; shareId: string; key: string }
  | { id: number; type: 'lock' };
/** Where the worker is in starting up, for the console of whoever is finding out why it does not. Names of steps, never content. */
export type Trace = { id: 0; trace: string };
export type FromWorker =
  | Trace

  | { id: number; ok: true; status?: number; headers?: Record<string, string>; body?: ArrayBuffer }
  | { id: number; ok: false; error: { name: string; message: string; status?: number; code?: string } };
