import type { KeysResponse } from '../crypto/vault-client';
import type { KdfParams } from '../crypto/keys';
/** What the page and the core's worker say to one another. */
export type Part = { fieldname: string; filename?: string; mimetype?: string; data?: ArrayBuffer; value?: string };
export type ToWorker =
  /** `keys`: what the page already fetched from `/api/vault/keys`, so the worker does not ask again. */
  | { id: number; type: 'start'; masterKey: Uint8Array; keys?: KeysResponse; profileId?: string }
  /** The master key from a password, here and not in the page: it takes a second or more and 64 MiB, and the page must keep moving meanwhile. Answers with the key as the body and the sign-in value in `headers.authValue`. */
  | { id: number; type: 'derive'; password: string; salt: string; params: KdfParams }
  | { id: number; type: 'startWithPasskey'; passkey: { prf: Uint8Array; credentialId: string; wrapped: string }; profileId?: string }
  /** The people (profiles) this account keeps records for, and the one open now. Answers with `{ profiles, current }` as the body. */
  | { id: number; type: 'profiles' }
  /** Makes another person's records, with a key of their own; answers with `{ id }`. The server refuses past what the plan allows. */
  | { id: number; type: 'createProfile'; name: string }
  /** Look again at the keys and the people the account may open (after a profile's key was replaced, or access was given or taken). */
  | { id: number; type: 'reloadKeys' }
  /** Saves what is open, then opens another person's records. Refused with code `unsaved` unless `force`. */
  | { id: number; type: 'switchProfile'; profileId: string; force?: boolean }
  | { id: number; type: 'request'; method: string; url: string; headers: Record<string, string>; body?: string; parts?: Part[] }
  | { id: number; type: 'startShare'; shareId: string; key: string }
  /** The demo: no vault and no account, an archive in memory that is gone when the page is, and nothing that needs a model or the server. */
  | { id: number; type: 'startDemo' }
  /** Saves, then lets go of everything. Refused with code `unsaved` if something could not be saved, unless the person chose to lose it (`force`). */
  | { id: number; type: 'lock'; force?: boolean }
  /** Save now. Fails if the vault did not take it. */
  | { id: number; type: 'save' }
  /** The reader of a streamed reply went away: stop writing it. */
  | { id: number; type: 'abort'; target: number };
/** Where the worker is in starting up, for the console of whoever is finding out why it does not. Names of steps, never content. */
export type Trace = { id: 0; trace: string };
/**
 * Whether what the person did is all in the vault. `error` is set from a save that failed until one succeeds; the core keeps trying on
 * its own, and the page says so, so nobody works on believing it is saved when it is not.
 */
export interface SaveState { unsaved: boolean; error: string | null }
export type FromWorker =
  | Trace
  /** Another device saved first: this one has changes it could not save and has stopped trying (SECURITY.md M-34). */
  | { id: 0; changed: true }
  /** The state of saving changed. */
  | { id: 0; save: SaveState }

  | { id: number; ok: true; status?: number; headers?: Record<string, string>; body?: ArrayBuffer; stream?: boolean }
  /** A piece of a streamed reply, in the order written, and its end. */
  | { id: number; chunk: ArrayBuffer }
  | { id: number; end: true }
  | { id: number; ok: false; error: { name: string; message: string; status?: number; code?: string } };
