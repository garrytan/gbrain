import { ALL_SOURCES_WILDCARD } from './operations.ts';

/**
 * Derive a legacy bearer token's source scope from its stored
 * `access_tokens.permissions.source_id` grant.
 *
 * ARRAY = federated read grant, exposed through `allowedSources` with the
 * first NON-wildcard source as the scalar write floor. A '*' entry means
 * "read every source, current and future" — but '*' is a READ grant only
 * and must never become the scalar write floor, so a wildcard-only array
 * falls back to 'default'. STRING = scalar source. Missing, empty, or
 * garbage values fail closed to the historical `default` floor and NEVER
 * widen to all sources implicitly.
 */
export function parseLegacyTokenScope(rawSource: unknown): { sourceId: string; allowedSources?: string[] } {
  if (Array.isArray(rawSource)) {
    const allowedSources = (rawSource as unknown[]).filter(s => typeof s === 'string' && s.length > 0) as string[];
    if (allowedSources.length > 0) {
      // Scalar floor = first NON-wildcard source (the write authority). '*' is a
      // READ grant only and must never become the scalar write floor, so a
      // wildcard-only grant falls back to the 'default' floor.
      const floor = allowedSources.find(s => s !== ALL_SOURCES_WILDCARD) ?? 'default';
      return { sourceId: floor, allowedSources };
    }
    return { sourceId: 'default' };
  }
  if (typeof rawSource === 'string' && rawSource.length > 0) {
    return { sourceId: rawSource };
  }
  return { sourceId: 'default' };
}
