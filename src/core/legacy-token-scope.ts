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
