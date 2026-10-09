/**
 * #4352 — page-level `visibility: private` enforcement for untrusted callers.
 *
 * Pages have carried `frontmatter.visibility` for a long time (the `remember`
 * verb documents "private: local CLI reads only"), but nothing on the READ
 * side ever enforced it for pages: a remote/MCP caller could retrieve a
 * `visibility: private` page through search, recall's query arm, entity
 * cards, context_pack — and the sibling read ops (get_page/fetch/list_pages,
 * get_chunks/get_versions/get_timeline/get_raw_data, resolve_slugs,
 * get_links/get_backlinks/traverse_graph). This module is the single
 * trust+config resolver:
 *
 *   ctx.remote === false          → see everything (trusted local CLI)
 *   GBRAIN_REMOTE_PRIVATE_PAGES=1 → operator escape hatch, see everything
 *   config search.remote_private_pages ∈ {visible,true,1}
 *                                 → operator opt-out, see everything
 *   otherwise                     → exclude private pages (FAIL-CLOSED default)
 *
 * The SQL predicate itself lives in buildVisibilityClause (sql-ranking.ts)
 * behind SearchOpts.excludePrivate; this resolver decides whether to set it.
 */

import type { BrainEngine } from '../engine.ts';

export const REMOTE_PRIVATE_PAGES_KEY = 'search.remote_private_pages';

/**
 * #5525 — extracted atoms and synthesized concept pages are derived from
 * other pages or from private transcripts, so a missing `visibility` field on
 * them means "origin unknown", not "world". They fail closed; every other page
 * keeps the documented default (absent visibility is world).
 */
function derivedPageSql(pageAlias: string): string {
  return `(${pageAlias}.type = 'atom' OR (${pageAlias}.type = 'concept' AND ${pageAlias}.frontmatter->>'synthesized_by' IS NOT NULL))`;
}

/**
 * Raw SQL predicate hiding `visibility: private` pages (absent visibility
 * defaults to 'world', except on derived atoms and concepts where it defaults
 * to 'private'). Single source of truth for the fragment — consumed by
 * buildVisibilityClause (search paths), both engines' listPages, the
 * relational-arm hydrate, and get_page's fuzzy-candidate filter. `pageAlias`
 * is a code-provided literal, never user input.
 */
export function privatePagesFilterFragment(pageAlias: string): string {
  return `(${privateSnapshotFilterFragment(pageAlias)}
    AND NOT ${derivedOriginPrivateSql(pageAlias)}
    AND NOT ${declaredLineagePrivateSql(pageAlias)})`;
}

/**
 * `privatePagesFilterFragment` with a cheap first test: a page with no
 * `visibility` or `derived_from` key whose type is not atom, concept or event
 * is visible by every rule above, so only the remaining pages run the full
 * check. For scans over thousands of candidate pages (an entity's referrers).
 */
export function privatePagesFilterFragmentFast(pageAlias: string): string {
  return `((${pageAlias}.frontmatter->'visibility' IS NULL AND ${pageAlias}.frontmatter->'derived_from' IS NULL
      AND ${pageAlias}.type NOT IN ('atom', 'concept', 'event'))
    OR ${privatePagesFilterFragment(pageAlias)})`;
}

/**
 * Declared lineage: a page whose frontmatter `derived_from` names a page (one
 * slug or a list, `.md` optional) that is explicitly `visibility: private` in
 * the same source is private too, whatever its own field says. Summaries,
 * digests and reports written from finance-only or other private material
 * therefore stay behind the same boundary as their inputs. Only an explicitly
 * private input propagates; a missing input does not hide the page.
 */
function declaredLineagePrivateSql(p: string): string {
  return `(CASE WHEN jsonb_typeof(${p}.frontmatter->'derived_from') IN ('array', 'string') THEN EXISTS (
    SELECT 1 FROM pages declared_origin
    WHERE declared_origin.source_id = ${p}.source_id
      AND declared_origin.frontmatter->>'visibility' = 'private'
      AND declared_origin.slug = ANY(ARRAY(
        SELECT regexp_replace(declared.slug, '\\.md$', '') FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(${p}.frontmatter->'derived_from') = 'array' THEN ${p}.frontmatter->'derived_from'
            ELSE jsonb_build_array(${p}.frontmatter->'derived_from') END) AS declared(slug)))) ELSE false END)`;
}

/**
 * The same rule on a row's own `type`/`frontmatter` only, for snapshots such
 * as `page_versions` that have no page identity to follow to an origin. Callers
 * pair it with privatePagesFilterFragment on the live page.
 */
export function privateSnapshotFilterFragment(alias: string): string {
  return `COALESCE(${alias}.frontmatter->>'visibility', CASE WHEN ${derivedPageSql(alias)} THEN 'private' ELSE 'world' END) <> 'private'`;
}

/**
 * #5525 — a later private flip of an origin page reaches its derived pages
 * before any repair runs: an atom whose origin page is explicitly private, and
 * a synthesized concept with a private input atom (or an input atom whose
 * origin is private), are private whatever their own field says.
 * `gbrain repair visibility` then stamps the stricter value on the rows.
 */
function derivedOriginPrivateSql(p: string): string {
  const privateOrigin = (atom: string, alias: string) => `EXISTS (SELECT 1 FROM pages ${alias} WHERE ${alias}.source_id = ${atom}.source_id
      AND ${alias}.slug = ${atom}.frontmatter->>'source_slug' AND ${alias}.frontmatter->>'visibility' = 'private')`;
  return `(CASE WHEN ${p}.type = 'atom' THEN ${privateOrigin(p, 'derived_origin')}
    WHEN ${derivedPageSql(p)} THEN EXISTS (SELECT 1 FROM links derived_input_link
      JOIN pages derived_input ON derived_input.id = derived_input_link.to_page_id
      WHERE derived_input_link.from_page_id = ${p}.id AND derived_input_link.link_source = 'concept-provenance'
        AND derived_input_link.link_type = 'synthesized_from'
        AND (COALESCE(derived_input.frontmatter->>'visibility', CASE WHEN derived_input.type = 'atom' THEN 'private' ELSE 'world' END) = 'private'
          OR ${privateOrigin('derived_input', 'derived_input_origin')}))
    WHEN ${p}.type = 'event' AND ${p}.frontmatter->>'captured_via' LIKE 'life-chronicle:%' THEN ${chronicleOriginNotVisibleSql(p)}
    ELSE false END)`;
}

/**
 * #5876 (C4a/E7) — a Life Chronicle event is private whenever the meeting,
 * conversation or calendar page it was extracted from (`event.depth`, same
 * source) is private by its own field or its declared lineage, and fails
 * closed when that origin is missing (renamed or purged). Covers events
 * written before the rule existed, at read time.
 */
function chronicleOriginNotVisibleSql(p: string): string {
  return `NOT EXISTS (SELECT 1 FROM pages chronicle_origin WHERE chronicle_origin.source_id = ${p}.source_id
      AND chronicle_origin.slug = ${p}.frontmatter->'event'->>'depth'
      AND ${privateSnapshotFilterFragment('chronicle_origin')}
      AND NOT ${declaredLineagePrivateSql('chronicle_origin')})`;
}

export type Visibility = 'private' | 'world';

/**
 * #5525 — the visibility a derived page takes from its origin under the
 * read-side rule: transcripts and missing origins are private, and a page
 * origin is private exactly when remote readers cannot see it.
 */
export function effectiveVisibility(origin: { kind: 'transcript' } | { kind: 'page'; page: { type?: string | null; frontmatter?: unknown } | null }): Visibility {
  if (origin.kind === 'transcript' || !origin.page) return 'private';
  return isPrivatePage(origin.page) ? 'private' : 'world';
}

/** Derived outputs take the strictest visibility of their inputs. */
export function strictestVisibility(values: Iterable<Visibility>): Visibility {
  for (const value of values) if (value === 'private') return 'private';
  return 'world';
}

/** Check the actual origin, independently of joins that redact its source. */
export function privateLinkOriginFilterFragment(linkAlias: string): string {
  return `(${linkAlias}.origin_page_id IS NULL OR EXISTS (
    SELECT 1 FROM pages origin_private
    WHERE origin_private.id = ${linkAlias}.origin_page_id
      AND ${privatePagesFilterFragment('origin_private')}
  ))`;
}

/** A projection's private event must stay hidden even when its join is source-redacted. */
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

/**
 * Row-side twin of privatePagesFilterFragment for pages already fetched
 * (get_page / fetch read one row by slug; re-querying just to filter would
 * be a second round-trip). Same semantics: an explicit 'private' hides a
 * page, and an absent value hides only derived atoms and concepts.
 */
export function isPrivatePage(page: { type?: string | null; frontmatter?: unknown }): boolean {
  const frontmatter = typeof page.frontmatter === 'object' && page.frontmatter !== null
    ? page.frontmatter as Record<string, unknown> : {};
  const derived = page.type === 'atom' || (page.type === 'concept' && frontmatter.synthesized_by != null);
  return (frontmatter.visibility ?? (derived ? 'private' : 'world')) === 'private';
}

/**
 * Slugs an untrusted caller must not see enumerated: every in-scope page row
 * for the slug is `visibility: private`. A slug with at least one non-private
 * in-scope page stays visible (multi-source: private in one source, world in
 * another). Slugs with no page row at all (dangling link endpoints) are not
 * returned — they reveal nothing private. Used only for get_page's fuzzy
 * candidate enumeration; data-bearing reads authorize concrete rows in the
 * engine instead of treating a visible namesake as authorization. `scope` follows the
 * canonical precedence (federated array > scalar > nothing); with
 * `includeDeleted` unset, only live rows are considered.
 */
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
  return new Set(rows.map(r => r.slug));
}

const CACHE_TTL_MS = 30_000;
let cache = new WeakMap<BrainEngine, { at: number; expose: boolean }>();

/** Test helper: drop the per-engine config cache. */
export function __resetPrivateVisibilityCacheForTests(): void {
  cache = new WeakMap();
}

/**
 * Should this caller's page reads exclude `visibility: private` pages?
 * `remote` follows the repo trust convention: anything that is not strictly
 * `false` is untrusted. Config lookups are cached 30s per engine; a failed
 * lookup counts as "not opted out" (fail-closed).
 */
export async function resolveExcludePrivatePages(
  engine: BrainEngine,
  remote: boolean | undefined,
): Promise<boolean> {
  if (remote === false) return false; // trusted local CLI sees everything
  if (process.env.GBRAIN_REMOTE_PRIVATE_PAGES === '1') return false; // incident escape hatch
  const hit = cache.get(engine);
  let expose: boolean;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    expose = hit.expose;
  } else {
    try {
      const v = await engine.getConfig(REMOTE_PRIVATE_PAGES_KEY);
      expose = v === 'visible' || v === 'true' || v === '1';
    } catch {
      expose = false; // config unreadable → enforce (fail-closed)
    }
    cache.set(engine, { at: Date.now(), expose });
  }
  return !expose;
}
