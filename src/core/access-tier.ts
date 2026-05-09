/**
 * Runtime MCP access control: AccessTier primitive.
 *
 * ACCESS_POLICY.md is prompt-layer enforcement; a direct MCP caller
 * bypasses it. This file ships the structural primitive that turns
 * the policy into a runtime boundary by adding sender identity
 * checking + tier-aware response filtering on top of the existing
 * scope hierarchy.
 *
 * Tier model mirrors templates/ACCESS_POLICY.md.template:
 *
 *   None    everyone else; "this is a private agent."
 *   Family  logistics, scheduling
 *   Work    brain pages (people, companies, deals, projects), tasks
 *   Full    owner; everything
 *
 * The tiers are linearly ordered for INVOCATION rights (Full
 * subsumes Work subsumes Family subsumes None). RESPONSE-side data
 * scoping (Work cannot see personal pages; Family cannot see work
 * content) is a separate concern enforced via slug-prefix
 * visibility, see `tierAllowsSlug`.
 */

export type AccessTier = 'None' | 'Family' | 'Work' | 'Full';

export const ACCESS_TIERS: ReadonlyArray<AccessTier> = Object.freeze([
  'None',
  'Family',
  'Work',
  'Full',
]);

/**
 * Default tier GRANTED to a caller when no explicit value is on the
 * record. Set to Full so legacy `oauth_clients` rows that pre-date
 * v45 keep their existing behavior; operators tighten per-client via
 * `gbrain auth set-tier`. Distinct from OP_TIER_DEFAULT_REQUIRED
 * (which is also Full but means "most restrictive op gate"), so the
 * two purposes can diverge if the policy ever needs to.
 */
export const ACCESS_TIER_DEFAULT: AccessTier = 'Full';

/**
 * Default tier REQUIRED to invoke an op when the op omits the
 * `tier?` annotation. Full is the most restrictive bar so a new op
 * lands fail-closed until its annotation is added.
 */
export const OP_TIER_DEFAULT_REQUIRED: AccessTier = 'Full';

/**
 * Membership set for `isAccessTier`. Backed by a real Set so a
 * caller-supplied string like `'toString'` cannot match an
 * `Object.prototype` key the way a plain `key in obj` lookup would.
 */
const TIER_MEMBERS: ReadonlySet<AccessTier> = new Set<AccessTier>([
  'None',
  'Family',
  'Work',
  'Full',
]);

/**
 * Numeric rank used by `tierImplies`. Higher = more access. Kept
 * as an internal map; consumers should call `tierImplies` rather
 * than compare ranks directly.
 */
const RANK: Record<AccessTier, number> = {
  None: 0,
  Family: 1,
  Work: 2,
  Full: 3,
};

export function isAccessTier(value: unknown): value is AccessTier {
  return typeof value === 'string' && TIER_MEMBERS.has(value as AccessTier);
}

/**
 * Does the granted tier satisfy the required tier? Strict ordering:
 * Full implies Work, Work implies Family, Family implies None.
 *
 * Returns false if either argument is not a recognised tier; the
 * MCP dispatch layer should surface this as `insufficient_tier`.
 */
export function tierImplies(granted: AccessTier, required: AccessTier): boolean {
  if (!isAccessTier(granted) || !isAccessTier(required)) return false;
  return RANK[granted] >= RANK[required];
}

/**
 * Parse a tier string from CLI / config / DB. Returns undefined for
 * empty/null inputs (caller decides on a default); throws on a
 * non-empty string that is not a recognised tier so a typo at
 * registration time fails loudly.
 */
export function parseAccessTier(value: string | null | undefined): AccessTier | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (!isAccessTier(trimmed)) {
    throw new InvalidAccessTierError(trimmed);
  }
  return trimmed;
}

/**
 * Coerce an `oauth_clients.access_tier` row value into an AccessTier.
 *
 * Two paths:
 *   - NULL (pre-v45 row that pre-dated the column) -> ACCESS_TIER_DEFAULT.
 *     Preserves backward compatibility for rows the migration default
 *     could not reach.
 *   - Any present-but-unrecognised string -> 'None' (fail-closed).
 *     The schema declares the column NOT NULL with a default, so a
 *     present-but-bad value can only come from out-of-band SQL or DB
 *     corruption; the safe response is to refuse the request, not to
 *     promote it to Full.
 */
export function resolveStoredAccessTier(value: unknown): AccessTier {
  if (value === null || value === undefined) return ACCESS_TIER_DEFAULT;
  if (typeof value !== 'string') return 'None';
  const trimmed = value.trim();
  if (trimmed === '') return ACCESS_TIER_DEFAULT;
  return isAccessTier(trimmed) ? (trimmed as AccessTier) : 'None';
}

/**
 * Slug-prefix visibility map. Each tier sees pages whose slug starts
 * with one of its declared prefixes; `'*'` means "no filter".
 * Operators override via `gbrain.yml.access` (see config.ts).
 */
export type TierPrefixMap = Record<AccessTier, ReadonlyArray<string>>;

/**
 * Defaults derived from templates/ACCESS_POLICY.md.template. Family
 * sees logistics + scheduling; Work sees brain pages (people,
 * companies, deals, projects, concepts, ideas); Full sees
 * everything. Slug prefixes match gbrain's wiki/* namespacing
 * convention without committing to a specific operator's layout —
 * an operator with different slugs must override.
 */
export const DEFAULT_TIER_PREFIXES: TierPrefixMap = Object.freeze({
  Full: ['*'],
  Work: [
    'people/',
    'companies/',
    'deals/',
    'projects/',
    'concepts/',
    'ideas/',
    'wiki/people/',
    'wiki/companies/',
    'wiki/deals/',
    'wiki/projects/',
    'wiki/concepts/',
    'wiki/ideas/',
  ],
  Family: [
    'logistics/',
    'meetings/',
    'calendar/',
    'scheduling/',
    'wiki/logistics/',
    'wiki/meetings/',
  ],
  None: [],
}) as TierPrefixMap;

/**
 * Does the slug satisfy the visibility prefixes for this tier? '*'
 * is the wildcard "see everything." A tier with an empty prefix
 * list rejects every slug.
 */
export function tierAllowsSlug(
  slug: string,
  tier: AccessTier,
  prefixes: TierPrefixMap = DEFAULT_TIER_PREFIXES,
): boolean {
  if (typeof slug !== 'string' || slug.length === 0) return false;
  const list = prefixes[tier];
  if (!list || list.length === 0) return false;
  for (const prefix of list) {
    if (prefix === '*') return true;
    if (slug.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Apply tier-aware visibility to a tools/call response. Used by the
 * MCP dispatch layer between op.handler() and writing the response,
 * so a Work-tier caller cannot see personal pages even when the op
 * itself was permitted to run.
 *
 * Coverage in this PR: ops that return a single page-shaped object
 * keyed by `slug` (`get_page`), or an array of slug-bearing rows
 * (`list_pages`, `search`, `query`, `get_chunks`, `find_orphans`,
 * `get_recent_salience`). Ops that return non-page shapes (graph
 * traversal, links, takes, system stats) pass through; their tier
 * gate runs at invocation time only.
 *
 * Full callers (and undefined tier — local CLI, stdio MCP) bypass
 * the filter entirely. Family/Work callers see only rows whose
 * slug starts with one of the prefixes for their tier.
 *
 * For `get_page`: when the resolved page is outside the visible
 * prefix set, return a `page_not_found` shape rather than a
 * `permission_denied` so a Work-tier caller cannot probe slug
 * existence by status code.
 */
export interface FilterContext {
  tier?: AccessTier;
  prefixes?: TierPrefixMap;
}

const READ_OPS_RETURNING_PAGE_LIST: ReadonlySet<string> = new Set([
  'list_pages',
  'search',
  'query',
  'get_chunks',
  'find_orphans',
  'get_recent_salience',
]);

const READ_OPS_RETURNING_SINGLE_PAGE: ReadonlySet<string> = new Set([
  'get_page',
]);

export function filterResponseByTier(
  opName: string,
  result: unknown,
  ctxFilter: FilterContext,
): unknown {
  const tier = ctxFilter.tier;
  // No tier set (local CLI, stdio MCP) or Full tier: bypass.
  if (!tier || tier === 'Full') return result;
  const prefixes = ctxFilter.prefixes ?? DEFAULT_TIER_PREFIXES;

  if (READ_OPS_RETURNING_SINGLE_PAGE.has(opName)) {
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const slug = (result as { slug?: unknown }).slug;
      if (typeof slug === 'string' && !tierAllowsSlug(slug, tier, prefixes)) {
        // Mimic the engine's `page_not_found` shape so a tier-rejected
        // page is indistinguishable from an absent page on the wire.
        return {
          error: 'page_not_found',
          message: `Page not found: ${slug}`,
        };
      }
    }
    return result;
  }

  if (READ_OPS_RETURNING_PAGE_LIST.has(opName)) {
    if (Array.isArray(result)) {
      return result.filter((row) => {
        if (!row || typeof row !== 'object') return true;
        const slug = (row as { slug?: unknown }).slug;
        if (typeof slug !== 'string') return true;
        return tierAllowsSlug(slug, tier, prefixes);
      });
    }
  }

  return result;
}

export class InvalidAccessTierError extends Error {
  constructor(public readonly invalidTier: string) {
    super(
      `Unknown access tier "${invalidTier}". Allowed: ${ACCESS_TIERS.join(', ')}.`,
    );
    this.name = 'InvalidAccessTierError';
  }
}
