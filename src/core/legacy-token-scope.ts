import { ALLOWED_SCOPES } from './scope.ts';

/**
 * Derive a legacy bearer token's source scope from its stored
 * `access_tokens.permissions.source_id` grant.
 *
 * ARRAY = federated read grant, exposed through `allowedSources` with the
 * first granted source as the scalar write floor. STRING = scalar source.
 * Missing, empty, or garbage values fail closed to the historical `default`
 * floor and NEVER widen to all sources.
 */
export function parseLegacyTokenScope(rawSource: unknown): { sourceId: string; allowedSources?: string[] } {
  if (Array.isArray(rawSource)) {
    const allowedSources = (rawSource as unknown[]).filter(s => typeof s === 'string' && s.length > 0) as string[];
    if (allowedSources.length > 0) {
      return { sourceId: allowedSources[0], allowedSources };
    }
    return { sourceId: 'default' };
  }
  if (typeof rawSource === 'string' && rawSource.length > 0) {
    return { sourceId: rawSource };
  }
  return { sourceId: 'default' };
}

/**
 * Parse a legacy bearer token's stored `access_tokens.permissions.takes_holders`
 * grant. Shared by both HTTP transports (`src/mcp/http-transport.ts` and the
 * OAuth provider behind `serve --http`) so the two cannot drift.
 *
 * ARRAY → filtered to string entries, with the empty array PRESERVED as an
 * explicit deny-all grant (engines translate `[]` to `holder = ANY('{}')`,
 * which matches nothing). Missing or non-array values → undefined; consumers
 * apply their own fail-closed default (`['world']`).
 *
 * The filter is `typeof === 'string'` ONLY — no `length > 0` like
 * `parseLegacyTokenScope` above — because the legacy HTTP transport has always
 * kept empty-string entries and this helper must be a behavior no-op there.
 */
export function parseTakesHoldersAllowList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return (raw as unknown[]).filter((h): h is string => typeof h === 'string');
}

/**
 * Normalize a legacy token's `access_tokens.scopes TEXT[]` column value
 * (#4043 least-privilege: the dormant original-schema column is THE scope
 * store — a dedicated column is structurally immune to the whole
 * permissions-object-replacement bug class).
 *
 * NULL / undefined → undefined: the caller grandfathers to the historical
 * full-access grant, so every existing token (scopes was never written
 * before this feature) behaves byte-identically. An ARRAY input is filtered
 * to known scope names and returned AS IS — including `[]`: an explicit
 * array that yields nothing is a deny (a typo'd scope fails closed at verify
 * time; mint-time validation refuses unknown scopes loudly, so `[]` here
 * means the row was set deliberately or is damaged — either way, deny).
 *
 * A STRING in the Postgres array-literal shape (`{read,write}` — some
 * driver/pooler paths hand TEXT[] back undecoded) is parsed and filtered
 * like an array. Any OTHER non-null value is representation drift on a row
 * that WAS written — that must fail CLOSED (deny), never silently widen to
 * the grandfather grant: only the never-written NULL earns full access.
 *
 * Named away from the one-char-apart `parseLegacyTokenScope` (SINGULAR —
 * the source-isolation grant above) on purpose.
 */
export function normalizeTokenScopes(raw: unknown): string[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  const filterKnown = (items: unknown[]): string[] =>
    items.filter(
      (s): s is string => typeof s === 'string' && (ALLOWED_SCOPES as ReadonlySet<string>).has(s as never),
    );
  if (Array.isArray(raw)) return filterKnown(raw as unknown[]);
  if (typeof raw === 'string' && /^\{.*\}$/.test(raw.trim())) {
    const inner = raw.trim().slice(1, -1);
    if (inner === '') return [];
    return filterKnown(inner.split(',').map((s) => s.trim().replace(/^"|"$/g, '')));
  }
  return []; // damaged/drifted representation on a written row → deny
}

/**
 * Coerce a legacy token's raw `access_tokens.permissions` column value to a
 * plain object for grant extraction. A well-formed jsonb column reads back as
 * an object on both drivers, but a double-encoded jsonb string scalar (the
 * #2339 class) reads back as a JSON string — decode it here so BOTH the OAuth
 * provider and the legacy HTTP transport interpret the row identically instead
 * of one honoring the grant while the other silently fails open. Malformed
 * strings and non-object/non-string values → undefined (no grant).
 */
export function coerceLegacyPermissions(raw: unknown): Record<string, unknown> | undefined {
  const asObject = (v: unknown): Record<string, unknown> | undefined =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  if (typeof raw === 'string') {
    try {
      return asObject(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
  return asObject(raw);
}
