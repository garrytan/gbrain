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

// OperationError is loaded lazily inside `filterResponseByTier` to avoid
// a module-load cycle: operations.ts imports `type AccessTier` from this
// file (type-only, erased), so a runtime back-edge from this file to
// operations.ts is safe but only at call time.

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
 * with one of its declared prefixes; `'*'` means "no filter". Threaded
 * into `filterResponseByTier` via the `prefixes` field of FilterContext;
 * operators wire up their own map by passing it in (config plumbing is
 * a separate concern from this primitive).
 */
export type TierPrefixMap = Record<AccessTier, ReadonlyArray<string>>;

/**
 * Defaults derived from templates/ACCESS_POLICY.md.template. Family
 * sees logistics + scheduling; Work sees brain pages (people,
 * companies, deals, projects, tasks, calendar) per the template;
 * Full sees everything. Slug prefixes match gbrain's wiki/* mirror
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
    'tasks/',
    'calendar/',
    'wiki/people/',
    'wiki/companies/',
    'wiki/deals/',
    'wiki/projects/',
    'wiki/tasks/',
    'wiki/calendar/',
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
 * Per-op result-shape declaration. Read ops that should be tier-filtered
 * MUST declare their shape here; the filter switches on this map rather
 * than guessing. Ops not in the map pass through unchanged.
 *
 * Adding an op is opt-in: a new tier-annotated read op without an entry
 * here passes through unfiltered. The tier-coverage parity test asserts
 * every tier-annotated read op either appears in this map or is gated
 * input-side in its handler (see `get_chunks`).
 *
 *   single-page         { ...page, slug, ...} OR
 *                       { error: 'ambiguous_slug', candidates: string[] }
 *   page-array          Array<{ slug, ... }>
 *   orphans-wrapper     { orphans: Array<{ slug, ... }>,
 *                         total_orphans, total_linkable, total_pages,
 *                         excluded }
 *   slug-string-array   string[] (each element is itself a slug)
 */
type FilterShape =
  | 'single-page'
  | 'page-array'
  | 'orphans-wrapper'
  | 'slug-string-array';

const OP_FILTER_SHAPE: Readonly<Record<string, FilterShape>> = Object.freeze({
  get_page: 'single-page',
  list_pages: 'page-array',
  search: 'page-array',
  query: 'page-array',
  get_recent_salience: 'page-array',
  find_orphans: 'orphans-wrapper',
  resolve_slugs: 'slug-string-array',
});

export function filterShapeFor(opName: string): FilterShape | undefined {
  return OP_FILTER_SHAPE[opName];
}

export interface FilterContext {
  tier?: AccessTier;
  prefixes?: TierPrefixMap;
}

/**
 * Apply tier-aware visibility to a tools/call response. Used by the
 * MCP dispatch layer between op.handler() and writing the response,
 * so a Work-tier caller cannot see personal pages even when the op
 * itself was permitted to run.
 *
 * Coverage:
 *   - get_page (single-page): a hidden slug throws OperationError
 *     'page_not_found' so the wire envelope is byte-identical to a
 *     real not-found result; ambiguous-slug branch filters its
 *     candidates list.
 *   - list_pages, search, query, get_recent_salience (page-array):
 *     drop rows whose slug is outside the visible prefix set.
 *   - find_orphans (orphans-wrapper): filter the inner orphans
 *     array, recompute total_orphans, fold dropped rows into
 *     `excluded`.
 *   - resolve_slugs (slug-string-array): drop bare-string slugs
 *     outside the visible prefix set.
 *
 * Ops with non-page shapes (graph traversal, links, takes, system
 * stats) pass through; their tier gate runs at invocation time only.
 * Some read ops with non-slug-bearing rows (`get_chunks`) are gated
 * input-side in their handler instead — see operations.ts.
 *
 * Full callers (and undefined tier — local CLI, stdio MCP) bypass
 * the filter entirely.
 */
// Lazy resolution of OperationError to avoid a module-load cycle through
// operations.ts. Cached after first hit. The serve-http error envelope
// matches `e instanceof OperationError`, so a tier-rejected single-page
// hit produces a response byte-identical to a real engine not-found.
let _OperationErrorCtor: (new (code: string, message: string) => Error) | undefined;
async function loadOperationError(): Promise<new (code: string, message: string) => Error> {
  if (_OperationErrorCtor) return _OperationErrorCtor;
  const mod = await import('./operations.ts');
  _OperationErrorCtor = mod.OperationError as unknown as new (code: string, message: string) => Error;
  return _OperationErrorCtor;
}

export async function filterResponseByTier(
  opName: string,
  result: unknown,
  ctxFilter: FilterContext,
): Promise<unknown> {
  const tier = ctxFilter.tier;
  // No tier set (local CLI, stdio MCP) or Full tier: bypass.
  if (!tier || tier === 'Full') return result;
  const prefixes = ctxFilter.prefixes ?? DEFAULT_TIER_PREFIXES;
  const shape = OP_FILTER_SHAPE[opName];
  if (!shape) return result;

  switch (shape) {
    case 'single-page': {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
      const obj = result as Record<string, unknown>;
      // Ambiguous-slug branch: filter the candidates list. If the
      // post-filter set is empty, fall through to a not-found throw
      // (so a Work-tier caller cannot probe slug existence by
      // observing a non-empty candidates array).
      if (obj.error === 'ambiguous_slug' && Array.isArray(obj.candidates)) {
        const visible = (obj.candidates as unknown[]).filter(
          (c) => typeof c === 'string' && tierAllowsSlug(c, tier, prefixes),
        );
        if (visible.length === 0) {
          const OperationError = await loadOperationError();
          throw new OperationError('page_not_found', `Page not found`);
        }
        return { ...obj, candidates: visible };
      }
      const slug = obj.slug;
      if (typeof slug === 'string' && !tierAllowsSlug(slug, tier, prefixes)) {
        // Throw rather than return a fabricated shape; serve-http's
        // unified error handler wraps this identically to a real
        // not-found from the engine, so a Work-tier probe cannot
        // distinguish hidden vs absent.
        const OperationError = await loadOperationError();
        throw new OperationError('page_not_found', `Page not found: ${slug}`);
      }
      return result;
    }

    case 'page-array': {
      if (!Array.isArray(result)) return result;
      return result.filter((row) => {
        if (!row || typeof row !== 'object') return false;
        const slug = (row as { slug?: unknown }).slug;
        if (typeof slug !== 'string') return false;
        return tierAllowsSlug(slug, tier, prefixes);
      });
    }

    case 'orphans-wrapper': {
      if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
      const wrapper = result as Record<string, unknown>;
      const orphans = wrapper.orphans;
      if (!Array.isArray(orphans)) return result;
      const visible = orphans.filter((row) => {
        if (!row || typeof row !== 'object') return false;
        const slug = (row as { slug?: unknown }).slug;
        if (typeof slug !== 'string') return false;
        return tierAllowsSlug(slug, tier, prefixes);
      });
      const dropped = orphans.length - visible.length;
      const excluded = typeof wrapper.excluded === 'number' ? wrapper.excluded : 0;
      return {
        ...wrapper,
        orphans: visible,
        total_orphans: visible.length,
        excluded: excluded + dropped,
      };
    }

    case 'slug-string-array': {
      if (!Array.isArray(result)) return result;
      return result.filter(
        (s) => typeof s === 'string' && tierAllowsSlug(s, tier, prefixes),
      );
    }
  }
}

export class InvalidAccessTierError extends Error {
  constructor(public readonly invalidTier: string) {
    super(
      `Unknown access tier "${invalidTier}". Allowed: ${ACCESS_TIERS.join(', ')}.`,
    );
    this.name = 'InvalidAccessTierError';
  }
}
