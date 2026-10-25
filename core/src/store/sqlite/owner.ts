/**
 * A repository method called without an acting user would match `user_id = NULL`
 * or `user_id = ''` — nothing, quietly. That is safe but hides a bug at the call
 * site, so it is an error instead (SECURITY.md P12).
 */
export function owner(userId: string): string {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new Error('repository method called without an acting user (P12)');
  }
  return userId;
}

/**
 * A create that names a record the user does not own inserts nothing. Silently
 * dropping a create would lose data, so it throws.
 */
export function expectInserted(changes: number, what: string): void {
  if (changes === 0) throw new Error(`${what} not found for this user`);
}
