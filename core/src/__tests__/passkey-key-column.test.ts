import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { openDatabase } from '../store/sqlite/connection.js';
import { openNative } from '../testing/driver-native.js';

/** `user_passkeys.wrapped_key` is a new column without a default value other than NULL, so a database made without it is brought forward on open. */
describe('user_passkeys.wrapped_key', () => {
  it('is added to a database made without it, and every passkey already in it opens no vault', () => {
    const location = path.join(mkdtempSync(path.join(tmpdir(), 'spine-col-')), 'old.db');
    const fresh = openDatabase(location, openNative, undefined, 'accounts');
    fresh.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u', 'a@b.c', 'x', 'now')").run();
    fresh.prepare("INSERT INTO user_passkeys (id, user_id, public_key, name, created_at) VALUES ('p', 'u', 'k', 'phone', 'now')").run();
    fresh.exec('ALTER TABLE user_passkeys DROP COLUMN wrapped_key');
    fresh.close();

    const reopened = openDatabase(location, openNative, undefined, 'accounts');
    expect(reopened.prepare("SELECT wrapped_key FROM user_passkeys WHERE id = 'p'").get()).toEqual({ wrapped_key: null });
    reopened.close();
  });
});
