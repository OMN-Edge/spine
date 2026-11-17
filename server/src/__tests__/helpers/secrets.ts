import { randomBytes } from 'node:crypto';

/**
 * A secret for one run of the tests: made when the tests start and gone when they end, so no secret is written in a file, and none is the same twice. A test needs only that both sides of a
 * signature (or the server's own start-up check) are given the same value, never what it is. Long enough for the server's minimum (`MIN_SECRET_LENGTH`).
 */
export const testSecret = (name = 'test'): string => `${name}-${randomBytes(24).toString('hex')}`;
