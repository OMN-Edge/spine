/**
 * Share-link scope vocabulary, validated in one place.
 *
 * SECURITY.md P2: scoping fails closed. A missing, malformed or unrecognised
 * scope is an error, never "return everything". Breadth is never the fallback,
 * so there is no branch here that widens a query on bad input — every path
 * either returns a fully resolved scope or throws.
 *
 * Both sides go through this module: creation rejects a scope it cannot resolve
 * (so a broken link cannot be stored), and the read path re-resolves the stored
 * row (so a row written before this existed, or by hand, still fails closed).
 */

export const SHARE_SCOPES = ['all', 'tag', 'document_ids', 'date_range', 'episode'] as const;
export type ShareScope = (typeof SHARE_SCOPES)[number];

export type ResolvedScope =
  | { scope: 'all' }
  | { scope: 'tag'; tag: string }
  | { scope: 'document_ids'; ids: string[] }
  | { scope: 'date_range'; from: string; to: string }
  /** The documents of these confirmed episodes, as they are when the link is read (an episode since dismissed or removed shares nothing). */
  | { scope: 'episode'; ids: string[] };

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScopeError';
  }
}

const MAX_TAG_LENGTH = 100;
/** Keeps the generated IN (...) well under SQLite's bound-parameter ceiling. */
const MAX_DOCUMENT_IDS = 500;
const MAX_EPISODE_IDS = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isShareScope(scope: unknown): scope is ShareScope {
  return typeof scope === 'string' && (SHARE_SCOPES as readonly string[]).includes(scope);
}

function requireCalendarDate(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new ScopeError(`${label} must be a YYYY-MM-DD date`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(value)) {
    throw new ScopeError(`${label} is not a real date`);
  }
  return value;
}

/**
 * Resolve a scope and its value into something the read path can execute.
 * Used for both an incoming creation request and a stored row's parsed value.
 */
export function resolveScope(scope: unknown, scopeValue: unknown): ResolvedScope {
  if (!isShareScope(scope)) {
    throw new ScopeError(`unknown scope; expected one of ${SHARE_SCOPES.join(', ')}`);
  }

  switch (scope) {
    case 'all': {
      if (scopeValue !== undefined && scopeValue !== null) {
        throw new ScopeError('scope "all" takes no scope_value');
      }
      return { scope: 'all' };
    }

    case 'tag': {
      if (typeof scopeValue !== 'string') {
        throw new ScopeError('scope "tag" requires a scope_value tag name');
      }
      const tag = scopeValue.trim();
      if (tag.length === 0) throw new ScopeError('scope "tag" requires a non-empty tag name');
      if (tag.length > MAX_TAG_LENGTH) {
        throw new ScopeError(`tag name exceeds ${MAX_TAG_LENGTH} characters`);
      }
      return { scope: 'tag', tag };
    }

    case 'document_ids': {
      if (!Array.isArray(scopeValue) || scopeValue.length === 0) {
        throw new ScopeError('scope "document_ids" requires a non-empty array of ids');
      }
      if (scopeValue.length > MAX_DOCUMENT_IDS) {
        throw new ScopeError(`scope "document_ids" accepts at most ${MAX_DOCUMENT_IDS} ids`);
      }
      const ids = scopeValue.map(id => {
        if (typeof id !== 'string' || id.trim().length === 0) {
          throw new ScopeError('every document id must be a non-empty string');
        }
        return id;
      });
      return { scope: 'document_ids', ids };
    }

    case 'episode': {
      if (!Array.isArray(scopeValue) || scopeValue.length === 0) {
        throw new ScopeError('scope "episode" requires a non-empty array of episode ids');
      }
      if (scopeValue.length > MAX_EPISODE_IDS) {
        throw new ScopeError(`scope "episode" accepts at most ${MAX_EPISODE_IDS} ids`);
      }
      const ids = scopeValue.map(id => {
        if (typeof id !== 'string' || id.trim().length === 0) throw new ScopeError('every episode id must be a non-empty string');
        return id;
      });
      return { scope: 'episode', ids };
    }

    case 'date_range': {
      if (typeof scopeValue !== 'object' || scopeValue === null || Array.isArray(scopeValue)) {
        throw new ScopeError('scope "date_range" requires { from, to }');
      }
      const { from, to } = scopeValue as { from?: unknown; to?: unknown };
      const resolvedFrom = requireCalendarDate(from, 'from');
      const resolvedTo = requireCalendarDate(to, 'to');
      if (resolvedFrom > resolvedTo) throw new ScopeError('from must not be after to');
      return { scope: 'date_range', from: resolvedFrom, to: resolvedTo };
    }
  }
}

/**
 * How a scope value is persisted: JSON for everything that has one, NULL for
 * "all". Scalars are JSON too, so the read path parses uniformly — storing a
 * tag as a bare string was S-6, where creation wrote `"cardiology"` with quotes
 * and the read path compared it to tags.name unparsed, matching nothing.
 */
export function serializeScopeValue(resolved: ResolvedScope): string | null {
  switch (resolved.scope) {
    case 'all':
      return null;
    case 'tag':
      return JSON.stringify(resolved.tag);
    case 'document_ids':
    case 'episode':
      return JSON.stringify(resolved.ids);
    case 'date_range':
      return JSON.stringify({ from: resolved.from, to: resolved.to });
  }
}

/** Re-resolve a stored row. Throws rather than widening the query (P2). */
export function resolveStoredScope(scope: string, scopeValue: string | null): ResolvedScope {
  let parsed: unknown = undefined;
  if (scopeValue !== null) {
    try {
      parsed = JSON.parse(scopeValue) as unknown;
    } catch {
      throw new ScopeError('stored scope_value is not valid JSON');
    }
  }
  return resolveScope(scope, parsed);
}
