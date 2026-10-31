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

import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from '../engine.ts';
import { isValidSourceId } from '../source-id.ts';
import { atomOriginSlugsSql } from '../page-state/atom-origin.ts';

export const REMOTE_PRIVATE_PAGES_KEY = 'search.remote_private_pages';

/**
 * #5525 — extracted atoms and synthesized concept pages are derived from
 * other pages or from private transcripts, so a missing `visibility` field on
 * them means "origin unknown", not "world". Pinned-question pages (`type:
 * question`) are owner-private. They fail closed; every other page keeps the
 * documented default (absent visibility is world).
 */
function derivedPageSql(pageAlias: string): string {
  return `(${pageAlias}.type IN ('atom', 'question') OR (${pageAlias}.type = 'concept' AND ${pageAlias}.frontmatter->>'synthesized_by' IS NOT NULL))`;
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
 * `visibility` or `derived_from` key (nor, unless the operator turned
 * `visibility.honor_aliases` off, a privacy-alias key) whose type is not atom, concept or event is visible by every rule
 * above, so only the remaining pages run the full check. For scans over thousands of
 * candidate pages (an entity's referrers).
 */
export function privatePagesFilterFragmentFast(pageAlias: string): string {
  return `((${pageAlias}.frontmatter->'visibility' IS NULL AND ${pageAlias}.frontmatter->'derived_from' IS NULL${honorAliases()
      ? `\n      AND ${pageAlias}.frontmatter->'access' IS NULL AND ${pageAlias}.frontmatter->'confidentiality' IS NULL` : ''}
      AND ${pageAlias}.type NOT IN ('atom', 'concept', 'event'))
    OR ${privatePagesFilterFragment(pageAlias)})`;
}

/**
 * GBRA-156: the sources whose private pages the current remote read may see,
 * from its grant's `private_pages: granted_sources` axis (the sources the
 * grant names explicitly; never the no-grant floor, federation, an OAuth
 * client's bound source or a request's `source_ids`). Set only by MCP
 * dispatch around a non-mutating operation; empty everywhere else (local
 * CLI, writes, jobs, cycles), so every other path keeps the rule above.
 */
const privateReadable = new AsyncLocalStorage<readonly string[]>();

/** Runs `fn` with `sourceIds` as the private-readable set; an invalid id empties the whole set (fail closed). */
export function withPrivateReadableSources<T>(sourceIds: readonly string[] | undefined, fn: () => T): T {
  const ids = sourceIds?.length && sourceIds.every(isValidSourceId) ? Object.freeze([...new Set(sourceIds)]) : Object.freeze([]);
  return privateReadable.run(ids, fn);
}

/** The private-readable set of the current read; empty outside a granted remote read. */
export function privateReadableSources(): readonly string[] {
  return privateReadable.getStore() ?? [];
}

/**
 * `visiblePredicate`, widened to pages (`pageAlias`, a code-provided alias)
 * whose source is in the current private-readable set. A page carrying the
 * `pinned_question` marker never widens: pinned questions stay owner-private
 * (src/core/questions/pages.ts). The ids are embedded as literals: each passed
 * isValidSourceId, whose alphabet has no quote or backslash.
 */
export function orPrivateReadableSource(pageAlias: string, visiblePredicate: string): string {
  const ids = privateReadableSources();
  if (ids.length === 0) return visiblePredicate;
  return `((${pageAlias}.source_id IN (${ids.map(id => `'${id}'`).join(', ')}) AND NOT COALESCE(${pageAlias}.frontmatter ? 'pinned_question', false)) OR ${visiblePredicate})`;
}

/** privatePagesFilterFragment for a remote read: a page in a private-readable source passes. Read sites only; derived-visibility decisions keep the plain fragment. */
export function privatePagesFilterForCaller(pageAlias: string): string {
  return orPrivateReadableSource(pageAlias, privatePagesFilterFragment(pageAlias));
}

/** privatePagesFilterFragmentFast for a remote read. */
export function privatePagesFilterFastForCaller(pageAlias: string): string {
  return orPrivateReadableSource(pageAlias, privatePagesFilterFragmentFast(pageAlias));
}

/** isPrivatePage for a remote read: false for a page whose `source_id` is private-readable, unless it carries the `pinned_question` marker; a row without `source_id` keeps the plain rule. */
export function isPrivatePageForCaller(page: { type?: string | null; frontmatter?: unknown; source_id?: string | null }): boolean {
  if (!isPrivatePage(page)) return false;
  if (typeof page.frontmatter === 'object' && page.frontmatter !== null && (page.frontmatter as Record<string, unknown>).pinned_question != null) return true;
  return !(typeof page.source_id === 'string' && privateReadableSources().includes(page.source_id));
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
 * pair it with privatePagesFilterFragment on the live page. A page carrying the
 * `pinned_question` marker is private whatever its `visibility` says (pinned
 * questions are owner-private, src/core/questions/pages.ts). A page with no
 * `visibility` but a privacy alias is private too, unless the operator turned
 * `visibility.honor_aliases` off; the row-side isPrivatePage applies the same rule.
 */
export function privateSnapshotFilterFragment(alias: string): string {
  return `(COALESCE(${alias}.frontmatter->>'visibility', CASE WHEN ${derivedPageSql(alias)} THEN 'private' ELSE 'world' END) <> 'private'
    AND NOT COALESCE(${alias}.frontmatter ? 'pinned_question', false)${honorAliases()
      ? `\n    AND NOT (${alias}.frontmatter->>'visibility' IS NULL AND ${privacyAliasSql(alias)})` : ''})`;
}

/**
 * #5525 — a later private flip of an origin page reaches its derived pages
 * before any repair runs: an atom whose origin page is explicitly private, and
 * a synthesized concept with a private input atom (or an input atom whose
 * origin is private), are private whatever their own field says.
 * `gbrain repair visibility` then stamps the stricter value on the rows.
 * An atom whose origin a sync rename moved (#7462) is private when the page at
 * its `source_slug` or the page the rename moved it to is private.
 */
function derivedOriginPrivateSql(p: string): string {
  const privateOrigin = (atom: string, alias: string) => `EXISTS (SELECT 1 FROM pages ${alias} WHERE ${alias}.source_id = ${atom}.source_id
      AND ${alias}.slug = ANY(${atomOriginSlugsSql(atom)}) AND ${alias}.frontmatter->>'visibility' = 'private')`;
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
 * Privacy aliases: keys a page may carry instead of `visibility` (the
 * bulk-ingestion template's `access`, a `confidentiality` field), with the
 * values that mean private. Matching is case-insensitive on the trimmed value.
 * Everything derived from an aliased page (facts, chronicle events, timeline
 * rows, remember saves into it) is private. Remote page reads honor the aliases
 * too unless the operator sets `visibility.honor_aliases false`.
 */
export const PRIVACY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  access: ['private', 'restricted', 'confidential'],
  confidentiality: ['confidential', 'secret', 'private', 'restricted'],
};
export const HONOR_ALIASES_KEY = 'visibility.honor_aliases';

function hasPrivacyAlias(frontmatter: Record<string, unknown>): boolean {
  return Object.entries(PRIVACY_ALIASES).some(([key, values]) => {
    const value = frontmatter[key];
    return typeof value === 'string' && values.includes(value.trim().toLowerCase());
  });
}

/** SQL twin of hasPrivacyAlias on a page alias (a code-provided literal). */
export function privacyAliasSql(alias: string): string {
  return `(${Object.entries(PRIVACY_ALIASES).map(([key, values]) =>
    `COALESCE(lower(btrim(${alias}.frontmatter->>'${key}')) IN (${values.map(v => `'${v}'`).join(',')}), false)`).join(' OR ')})`;
}

/**
 * `visibility.honor_aliases` per brain in this process, as last read by
 * resolveExcludePrivatePages (the resolver every remote read runs before it builds
 * SQL). The fragments are synchronous, so the setting is process-wide and leans
 * private: the aliases are honored unless a brain turned them off and no brain in
 * the process keeps them on. Unset means on.
 */
const honorAliasEngines = new Set<BrainEngine>();
const aliasOptOutEngines = new Set<BrainEngine>();
const ALIAS_OPT_OUT_VALUES = ['false', '0', 'off', 'no'];
function honorAliases(): boolean {
  return honorAliasEngines.size > 0 || aliasOptOutEngines.size === 0;
}

/** Reads this brain's `visibility.honor_aliases` into the process setting; true unless it is false/0/off/no. Unreadable keeps the last value. */
export async function readHonorAliases(engine: BrainEngine): Promise<boolean> {
  try {
    const optOut = ALIAS_OPT_OUT_VALUES.includes((await engine.getConfig(HONOR_ALIASES_KEY))?.trim().toLowerCase() ?? '');
    (optOut ? aliasOptOutEngines : honorAliasEngines).add(engine);
    (optOut ? honorAliasEngines : aliasOptOutEngines).delete(engine);
    return !optOut;
  } catch {
    return !aliasOptOutEngines.has(engine);
  }
}

/** A page whatever is derived from it must not outrank: private to remote readers, or carrying a privacy alias. */
export function isDerivationPrivate(page: { type?: string | null; frontmatter?: unknown }): boolean {
  if (isPrivatePage(page)) return true;
  return typeof page.frontmatter === 'object' && page.frontmatter !== null && hasPrivacyAlias(page.frontmatter as Record<string, unknown>);
}

/** SQL twin of isDerivationPrivate. */
export function derivationPrivateSql(alias: string): string {
  return `(NOT ${privateSnapshotFilterFragment(alias)} OR ${privacyAliasSql(alias)})`;
}

/**
 * #5525 — the visibility a derived page takes from its origin: transcripts and
 * missing origins are private, and a page origin is private when remote
 * readers cannot see it or it carries a privacy alias.
 */
export function effectiveVisibility(origin: { kind: 'transcript' } | { kind: 'page'; page: { type?: string | null; frontmatter?: unknown } | null }): Visibility {
  if (origin.kind === 'transcript' || !origin.page) return 'private';
  return isDerivationPrivate(origin.page) ? 'private' : 'world';
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

/** privateLinkOriginFilterFragment for a remote read: an origin page in a private-readable source passes. */
export function privateLinkOriginFilterForCaller(linkAlias: string): string {
  return `(${linkAlias}.origin_page_id IS NULL OR EXISTS (
    SELECT 1 FROM pages origin_private
    WHERE origin_private.id = ${linkAlias}.origin_page_id
      AND ${privatePagesFilterForCaller('origin_private')}
  ))`;
}

/** privateTimelineEventFilterFragment for a remote read. */
export function privateTimelineEventFilterForCaller(timelineAlias: string): string {
  return `(${timelineAlias}.event_page_id IS NULL OR EXISTS (
    SELECT 1 FROM pages event_private
    WHERE event_private.id = ${timelineAlias}.event_page_id
      AND ${privatePagesFilterForCaller('event_private')}
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
  if (frontmatter.pinned_question != null) return true;
  if (frontmatter.visibility == null && honorAliases() && hasPrivacyAlias(frontmatter)) return true;
  const derived = page.type === 'atom' || page.type === 'question' || (page.type === 'concept' && frontmatter.synthesized_by != null);
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
      HAVING bool_and(NOT (${privatePagesFilterForCaller('p')}))`,
    params,
  );
  return new Set(rows.map(r => r.slug));
}

const CACHE_TTL_MS = 30_000;
let cache = new WeakMap<BrainEngine, { at: number; expose: boolean }>();

/** Test helper: drop the per-engine config cache. */
export function __resetPrivateVisibilityCacheForTests(): void {
  cache = new WeakMap();
  honorAliasEngines.clear();
  aliasOptOutEngines.clear();
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
    await readHonorAliases(engine);
    cache.set(engine, { at: Date.now(), expose });
  }
  return !expose;
}
