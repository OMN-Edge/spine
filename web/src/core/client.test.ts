import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { device, SAVE_STATE_CHANGED, UnsavedChangesError } from './client';

/** A stand-in for the core's worker: it answers what the page sends, and refuses to lock while it says it has unsaved changes. */
class FakeWorker {
  static last: FakeWorker;
  static refuseLock = true;
  static failLockWith: { name: string; message: string; code?: string } | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  sent: Array<Record<string, unknown>> = [];
  constructor() {
    FakeWorker.last = this;
    queueMicrotask(() => this.say({ id: 0, trace: 'loaded' }));
  }
  say(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
  postMessage(message: Record<string, unknown>) {
    this.sent.push(message);
    const id = message.id as number;
    queueMicrotask(() => {
      if (message.type === 'lock' && FakeWorker.failLockWith) this.say({ id, ok: false, error: FakeWorker.failLockWith });
      else if (message.type === 'lock' && FakeWorker.refuseLock && !message.force) this.say({ id, ok: false, error: { name: 'Error', message: 'some changes are not saved yet', code: 'unsaved' } });
      else this.say({ id, ok: true });
    });
  }
  terminate() { this.terminated = true; }
}

beforeEach(() => {
  FakeWorker.refuseLock = true;
  FakeWorker.failLockWith = null;
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('window', new EventTarget());
});
afterEach(async () => { await device.lock(true).catch(() => undefined); vi.unstubAllGlobals(); });

describe('locking the device’s core from the page', () => {
  it('stops with UnsavedChangesError, and keeps the core open, when the worker holds changes the vault does not have', async () => {
    await device.unlock(new Uint8Array(32));
    const worker = FakeWorker.last;
    await expect(device.lock()).rejects.toBeInstanceOf(UnsavedChangesError);
    expect(worker.terminated).toBe(false);
    expect(device.isOpen()).toBe(true);
    expect(worker.sent.at(-1)).toMatchObject({ type: 'lock', force: false });
  });

  it('locks anyway when the person chose to lose them', async () => {
    await device.unlock(new Uint8Array(32));
    const worker = FakeWorker.last;
    await device.lock(true);
    expect(worker.sent.at(-1)).toMatchObject({ type: 'lock', force: true });
    expect(worker.terminated).toBe(true);
    expect(device.isOpen()).toBe(false);
  });

  it('locks when there is nothing unsaved', async () => {
    FakeWorker.refuseLock = false;
    await device.unlock(new Uint8Array(32));
    const worker = FakeWorker.last;
    await device.lock();
    expect(worker.terminated).toBe(true);
  });

  it('still lets go of a worker that is gone, which has nothing left to save', async () => {
    FakeWorker.failLockWith = { name: 'CoreError', message: 'the core could not start' };
    await device.unlock(new Uint8Array(32));
    const worker = FakeWorker.last;
    await device.lock();
    expect(worker.terminated).toBe(true);
    expect(device.isOpen()).toBe(false);
  });
});

describe('what the page is told about saving', () => {
  it('keeps the state the worker announces and says on the window that it changed', async () => {
    await device.unlock(new Uint8Array(32));
    const told: string[] = [];
    (window as unknown as EventTarget).addEventListener(SAVE_STATE_CHANGED, () => told.push(JSON.stringify(device.saveState)));
    FakeWorker.last.say({ id: 0, save: { unsaved: true, error: 'offline' } });
    expect(device.saveState).toEqual({ unsaved: true, error: 'offline' });
    expect(told).toEqual([JSON.stringify({ unsaved: true, error: 'offline' })]);
  });

  it('forgets it when the core is locked', async () => {
    FakeWorker.refuseLock = false;
    await device.unlock(new Uint8Array(32));
    FakeWorker.last.say({ id: 0, save: { unsaved: true, error: 'offline' } });
    await device.lock();
    expect(device.saveState).toEqual({ unsaved: false, error: null });
  });
});
