/**
 * Accounts and sign-in: the one door to them. Nothing outside this folder imports one of its files (S14, `architecture.test.ts`); it asks for what it needs here, so
 * what an account is, how a person proves who they are and what is said to them about it can be read, changed and one day lifted out in one place (docs/architecture/packages.md).
 */
export * from './accounts.js';
export * from './sessions.js';
export * from './passwords.js';
export * from './totp.js';
export * from './passkeys.js';
export * from './second-factor.js';
export * from './email-code.js';
export * from './user-tokens.js';
export * from './session-auth.js';
export * from './notify.js';
