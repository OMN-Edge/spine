/** What the page and the core's worker say to one another. */
export type Part = { fieldname: string; filename?: string; mimetype?: string; data?: ArrayBuffer; value?: string };
export type ToWorker =
  | { id: number; type: 'start'; masterKey: Uint8Array }
  | { id: number; type: 'startWithPasskey'; passkey: { prf: Uint8Array; credentialId: string; wrapped: string } }
  | { id: number; type: 'request'; method: string; url: string; headers: Record<string, string>; body?: string; parts?: Part[] }
  | { id: number; type: 'startShare'; shareId: string; key: string }
  | { id: number; type: 'lock' }
  /** The reader of a streamed reply went away: stop writing it. */
  | { id: number; type: 'abort'; target: number };
/** Where the worker is in starting up, for the console of whoever is finding out why it does not. Names of steps, never content. */
export type Trace = { id: 0; trace: string };
export type FromWorker =
  | Trace
  /** Another device saved first: this one has changes it could not save and has stopped trying (SECURITY.md M-34). */
  | { id: 0; conflict: true }

  | { id: number; ok: true; status?: number; headers?: Record<string, string>; body?: ArrayBuffer; stream?: boolean }
  /** A piece of a streamed reply, in the order written, and its end. */
  | { id: number; chunk: ArrayBuffer }
  | { id: number; end: true }
  | { id: number; ok: false; error: { name: string; message: string; status?: number; code?: string } };
