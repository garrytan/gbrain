import type { BrainEngine } from '../engine.ts';

export const REMOTE_PRIVATE_PAGES_KEY = 'search.remote_private_pages';

export function privatePagesFilterFragment(pageAlias: string): string {
  return `COALESCE(${pageAlias}.frontmatter->>'visibility', 'world') <> 'private'`;
}

export function privateTimelineEventFilterFragment(timelineAlias: string): string {
  return `(${timelineAlias}.event_page_id IS NULL OR EXISTS (
    SELECT 1 FROM pages event_private
    WHERE event_private.id = ${timelineAlias}.event_page_id
      AND ${privatePagesFilterFragment('event_private')}
  ))`;
}

/**
 * Fact-row twin for ontology provenance: hide an observation whose provenance
 * page (`source_markdown_slug`, looked up in the fact's own source) is
 * private. Non-page provenance (e.g. `manual`) has no page row and passes;
 * deleted page rows still count (fail-closed). Keys on (facts.source_id, slug),
 * so a provenance page living in a DIFFERENT source than the fact is not
 * consulted — fail-open for cross-source provenance, acceptable under source
 * isolation because ontology_propose stamps the fact with ctx.sourceId.
 */
export function privateProvenanceFilterFragment(factAlias: string): string {
  return `NOT EXISTS (SELECT 1 FROM pages pp WHERE pp.source_id = ${factAlias}.source_id ` +
    `AND pp.slug = ${factAlias}.source_markdown_slug AND NOT (${privatePagesFilterFragment('pp')}))`;
}

export function isPrivatePage(frontmatter: unknown): boolean {
  return typeof frontmatter === 'object'
    && frontmatter !== null
    && (frontmatter as Record<string, unknown>).visibility === 'private';
}

export async function findPrivateOnlySlugs(
  engine: BrainEngine,
  slugs: string[],
  scope: { sourceId?: string; sourceIds?: string[] } = {},
  opts: { includeDeleted?: boolean } = {},
): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();
  const params: unknown[] = [slugs];
  let scopeClause = '';
  if (scope.sourceIds && scope.sourceIds.length > 0) {
    params.push(scope.sourceIds);
    scopeClause = `AND p.source_id = ANY($${params.length}::text[])`;
  } else if (scope.sourceId) {
    params.push(scope.sourceId);
    scopeClause = `AND p.source_id = $${params.length}`;
  }
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT p.slug FROM pages p
      WHERE p.slug = ANY($1::text[])
        ${opts.includeDeleted ? '' : 'AND p.deleted_at IS NULL'}
        ${scopeClause}
      GROUP BY p.slug
      HAVING bool_and(NOT (${privatePagesFilterFragment('p')}))`,
    params,
  );
  return new Set(rows.map(row => row.slug));
}

export async function slugHiddenFromCaller(
  engine: BrainEngine,
  remote: boolean | undefined,
  slug: string,
  scope: { sourceId?: string; sourceIds?: string[] } = {},
): Promise<boolean> {
  if (!(await resolveExcludePrivatePages(engine, remote))) return false;
  return (await findPrivateOnlySlugs(engine, [slug], scope, { includeDeleted: true })).has(slug);
}

const CACHE_TTL_MS = 30_000;
let cache = new WeakMap<BrainEngine, { at: number; expose: boolean }>();

export function __resetPrivateVisibilityCacheForTests(): void {
  cache = new WeakMap();
}

export async function resolveExcludePrivatePages(
  engine: BrainEngine,
  remote: boolean | undefined,
): Promise<boolean> {
  if (remote === false) return false;
  if (process.env.PMBRAIN_REMOTE_PRIVATE_PAGES === '1' || process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1') return false;
  const hit = cache.get(engine);
  let expose: boolean;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    expose = hit.expose;
  } else {
    try {
      const value = await engine.getConfig(REMOTE_PRIVATE_PAGES_KEY);
      expose = value === 'visible' || value === 'true' || value === '1';
    } catch {
      expose = false;
    }
    cache.set(engine, { at: Date.now(), expose });
  }
  return !expose;
}

export function privateLinkOriginFilterFragment(linkAlias: string): string {
  return `(${linkAlias}.origin_page_id IS NULL OR EXISTS (SELECT 1 FROM pages origin_private WHERE origin_private.id=${linkAlias}.origin_page_id AND ${privatePagesFilterFragment('origin_private')}))`;
}
