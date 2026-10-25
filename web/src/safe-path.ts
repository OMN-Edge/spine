/**
 * The path to go to after signing in, if it is one of this app's own and nothing else. A path that the address bar can carry must not be able
 * to send a person to another site once they have signed in: `//host` and `/\host` (browsers read a backslash as a slash) both mean "the
 * site `host`", and an encoded backslash, a control character or a scheme can be made to. Only a path that starts with a single slash and has
 * none of those is followed; anything else is the home page.
 */
export function inAppPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  let decoded = value;
  try { decoded = decodeURIComponent(value); } catch { return fallback; }
  if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith('//')) return fallback;
  return value;
}
