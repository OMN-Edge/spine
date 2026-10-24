import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { openDatabase } from '../store/sqlite/connection.js';
import { openNative } from '../store/sqlite/driver-native.js';
import { usageRepository } from '../store/sqlite/usage.js';

const location = () => path.join(mkdtempSync(path.join(tmpdir(), 'spine-usage-')), 'a.db');
const addUser = (db: ReturnType<typeof openDatabase>, id: string) =>
  db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, 'x', 'now')").run(id, `${id}@example.test`);

describe('usage.spend (the daily count of model calls)', () => {
  it('counts up to the limit for a user and a day, then refuses without counting', async () => {
    const db = openDatabase(location(), openNative);
    addUser(db, 'u1'); addUser(db, 'u2');
    const usage = usageRepository(db);
    expect([await usage.spend('u1', '2026-10-24', 2), await usage.spend('u1', '2026-10-24', 2), await usage.spend('u1', '2026-10-24', 2)]).toEqual([1, 2, null]);
    expect(db.prepare("SELECT calls FROM model_usage WHERE user_id = 'u1'").get()).toEqual({ calls: 2 });
    expect(await usage.spend('u2', '2026-10-24', 2)).toBe(1); // another user has a day of their own
    expect(await usage.spend('u1', '2026-10-25', 2)).toBe(1); // and a new day starts again
    expect(db.prepare("SELECT COUNT(*) AS n FROM model_usage WHERE user_id = 'u1'").get()).toEqual({ n: 1 }); // the old day is dropped
    db.close();
  });

  it('survives a restart and is shared by a second connection to the same database', async () => {
    const file = location();
    const first = openDatabase(file, openNative);
    addUser(first, 'u1');
    const a = usageRepository(first);
    expect(await a.spend('u1', '2026-10-24', 2)).toBe(1);
    const second = openDatabase(file, openNative);
    const b = usageRepository(second);
    expect(await b.spend('u1', '2026-10-24', 2)).toBe(2);
    expect(await a.spend('u1', '2026-10-24', 2)).toBeNull();
    first.close(); second.close();
    const reopened = openDatabase(file, openNative);
    expect(await usageRepository(reopened).spend('u1', '2026-10-24', 2)).toBeNull();
    reopened.close();
  });

  it('refuses a call for a user it is not given', async () => {
    const db = openDatabase(location(), openNative);
    await expect(usageRepository(db).spend('', '2026-10-24', 5)).rejects.toThrow();
    db.close();
  });
});
