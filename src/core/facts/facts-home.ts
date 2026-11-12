/**
 * GST-2492 PR 2: where the facts of a strict source that have no Git home stand, and what `gbrain repair facts-home` does
 * with each (the doctor check `strict_facts_outside_git` reads the same scan). Read-only.
 *
 * Groups, one per row:
 * - `entity_page_exists`: a database-only fact (or a fact held on memory/unattributed) whose entity now has a page; the
 *   extract_facts upkeep step moves it there.
 * - `entity_page_missing`: a database-only fact for an entity with no page; the repair writes it to memory/unattributed
 *   as a held row that names the entity.
 * - `no_entity`: a database-only fact with no entity; the repair writes it to memory/unattributed.
 * - `cannot_render`: a database-only fact the Facts table cannot render as it stands (its class says why); stays, listed.
 * - `folder_restricted`: a database-only fact for an entity under a folder access rule; it is never named on the
 *   world-readable holding page, so it stays, listed.
 * - `entity_page_deleted`: a database-only fact whose entity page is soft-deleted (it may be private, and its purge would
 *   not reach a row on the holding page); restore or purge that page; stays, listed.
 * - `held_fact_unmovable`: a held row whose entity has a page that cannot take it, or whose bare name matches two or more
 *   pages (`entity_ambiguous`, naming them); its reason says why; stays, listed.
 * - `held_over_30_days`: a held row whose entity still has no page after 30 days, with the nearest existing page the
 *   resolver finds; no action.
 * - `fenced_page_missing`: a fact row of a page that was deleted; restore or purge that page.
 * - `ontology_observation`: an ontology observation (`dimension` set), which belongs to its entity's ontology and has no
 *   row on any page's Facts table; the census counts it, so it is listed, never moved.
 */
import type { BrainEngine } from '../engine.ts';
import { UNATTRIBUTED_MEMORY_SLUG } from '../facts-fence.ts';
import { resolveEntitySlugWithSource } from '../entities/resolve.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
import { folderRestricted } from '../search/private-visibility.ts';
import { adoptableClaim, pageHasFile, planPageFence, type UnfencedFactRow } from './unfenced-facts.ts';
import { ambiguousHeldReason, heldFactTarget } from './held-fact-move.ts';

export const FACTS_HOME_DOCS = 'docs/guides/repair.md#facts-home';
export const HELD_TOO_LONG_DAYS = 30;
export const factsHomePreviewCommand = (sourceId: string) => `gbrain repair facts-home --source ${sourceId}`;

export const FACTS_HOME_GROUPS = ['entity_page_exists', 'entity_page_missing', 'no_entity', 'cannot_render', 'folder_restricted',
  'entity_page_deleted', 'held_fact_unmovable', 'held_over_30_days', 'fenced_page_missing', 'ontology_observation'] as const;
export type FactsHomeGroup = typeof FACTS_HOME_GROUPS[number];

export interface FactsHomeRow {
  id: number;
  entity_slug: string | null;
  group: FactsHomeGroup;
  /** cannot_render: the render class; held_fact_unmovable: the reason; fenced_page_missing: the deleted page. */
  reason?: string;
  /** held_over_30_days: the nearest existing page the resolver finds for the entity, or null. */
  nearest?: string | null;
  /** held_over_30_days: when the row was written. */
  held_since?: string;
}

export interface FactsHomeScan {
  source_id: string;
  strict: boolean;
  rows: FactsHomeRow[];
  counts: Record<FactsHomeGroup, number>;
  /** entity_page_missing and no_entity rows, as the repair writes them to memory/unattributed. */
  homeable: UnfencedFactRow[];
}

const ROW_COLUMNS = `f.id, f.source_id, f.entity_slug, f.fact, f.kind, f.visibility, f.notability, f.context, f.valid_from, f.valid_until, f.source,
  f.confidence, f.claim_metric, f.claim_value, f.claim_unit, f.claim_period, f.attributed_to`;

/** Whether the source's pages are canonical in Git (`canonical: git`). */
export async function isStrictSource(engine: BrainEngine, sourceId: string): Promise<boolean> {
  return (await getWorktreeBinding(engine, sourceId))?.canonical_git === true;
}

export async function scanFactsHome(engine: BrainEngine, sourceId: string): Promise<FactsHomeScan> {
  const counts = Object.fromEntries(FACTS_HOME_GROUPS.map(group => [group, 0])) as Record<FactsHomeGroup, number>;
  const out: FactsHomeScan = { source_id: sourceId, strict: await isStrictSource(engine, sourceId), rows: [], counts, homeable: [] };
  const add = (row: FactsHomeRow) => { out.rows.push(row); counts[row.group]++; };
  const pageLive = 'EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NULL)';
  const unfenced = await engine.executeRaw<UnfencedFactRow & { dimension: string | null; page_deleted: boolean }>(`SELECT ${ROW_COLUMNS}, f.dimension, ${pageLive} AS page_exists,
    EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.entity_slug AND p.deleted_at IS NOT NULL) AS page_deleted FROM facts f
    WHERE f.source_id=$1 AND f.row_num IS NULL AND f.expired_at IS NULL ORDER BY f.entity_slug NULLS FIRST, f.id`, [sourceId]);
  for (const row of unfenced) {
    const base = { id: Number(row.id), entity_slug: row.entity_slug };
    if (row.dimension != null) { add({ ...base, group: 'ontology_observation', reason: row.dimension }); continue; }
    if (row.entity_slug !== null && row.page_exists) { add({ ...base, group: 'entity_page_exists' }); continue; }
    if (row.entity_slug !== null && row.page_deleted) { add({ ...base, group: 'entity_page_deleted' }); continue; }
    if (row.entity_slug !== null && row.entity_slug !== UNATTRIBUTED_MEMORY_SLUG && await folderRestricted(engine, sourceId, row.entity_slug)) { add({ ...base, group: 'folder_restricted', reason: 'folder_rule' }); continue; }
    const oracle = adoptableClaim(row);
    if ('rejected' in oracle) { add({ ...base, group: 'cannot_render', reason: oracle.rejected }); continue; }
    add({ ...base, group: row.entity_slug === null || row.entity_slug === UNATTRIBUTED_MEMORY_SLUG ? 'no_entity' : 'entity_page_missing' });
    out.homeable.push(row);
  }
  const held = await engine.executeRaw<UnfencedFactRow & { held_since: string; old: boolean }>(`SELECT ${ROW_COLUMNS}, ${pageLive} AS page_exists,
      to_char(f.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS held_since, f.created_at < now() - ($3 || ' days')::interval AS old
     FROM facts f WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND f.row_num IS NOT NULL AND f.expired_at IS NULL AND f.dimension IS NULL
      AND f.entity_slug IS NOT NULL AND f.entity_slug <> $2 ORDER BY f.entity_slug, f.id`, [sourceId, UNATTRIBUTED_MEMORY_SLUG, String(HELD_TOO_LONG_DAYS)]);
  const waiting = new Map<string, typeof held>();
  const targets = new Map<string, Awaited<ReturnType<typeof heldFactTarget>>>();
  for (const row of held) {
    const key = row.entity_slug!;
    if (!targets.has(key)) targets.set(key, row.page_exists ? { slug: key } : await heldFactTarget(engine, sourceId, key));
    const target = targets.get(key)!;
    if (target && 'ambiguous' in target) { add({ id: Number(row.id), entity_slug: key, group: 'held_fact_unmovable', reason: ambiguousHeldReason(target.ambiguous) }); continue; }
    if (target) { waiting.set(target.slug, [...waiting.get(target.slug) ?? [], row]); continue; }
    if (!row.old) continue;
    add({ id: Number(row.id), entity_slug: row.entity_slug, group: 'held_over_30_days', nearest: await nearestPage(engine, sourceId, row.entity_slug!), held_since: row.held_since });
  }
  for (const [slug, group] of waiting) {
    for (const [id, reason] of await heldUnmovable(engine, sourceId, slug, group)) add({ id, entity_slug: slug, group: reason ? 'held_fact_unmovable' : 'entity_page_exists', ...(reason ? { reason } : {}) });
  }
  const orphaned = await engine.executeRaw<{ id: number; slug: string }>(`SELECT f.id, f.source_markdown_slug AS slug FROM facts f WHERE f.source_id=$1 AND f.row_num IS NOT NULL
      AND f.expired_at IS NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL) ORDER BY f.id`, [sourceId]);
  for (const row of orphaned) add({ id: Number(row.id), entity_slug: null, group: 'fenced_page_missing', reason: row.slug });
  return out;
}

/** The nearest existing page the resolver reaches for a slug with no page: the slug itself, then its last segment as a name. */
async function nearestPage(engine: BrainEngine, sourceId: string, slug: string): Promise<string | null> {
  const name = slug.split('/').pop()!;
  for (const candidate of [slug, name, name.replace(/-/g, ' ')]) {
    const resolved = await resolveEntitySlugWithSource(engine, sourceId, candidate).catch(() => null);
    if (resolved && resolved.source !== 'fallback_slugify' && resolved.slug !== slug) return resolved.slug;
  }
  return null;
}

/** Each held row of `slug` with why its page cannot take it (null: the upkeep move takes it), planned read-only as the move plans it. */
async function heldUnmovable(engine: BrainEngine, sourceId: string, slug: string, group: UnfencedFactRow[]): Promise<Array<[number, string | null]>> {
  const planned = await planPageFence(engine, sourceId, slug, group);
  if (!planned) return group.map(row => [Number(row.id), null]);
  if (!await pageHasFile(engine, sourceId, slug, planned.snapshot.page)) return group.map(row => [Number(row.id), 'entity_page_database_only']);
  const plan = planned.fence;
  if ('warnings' in plan) return group.map(row => [Number(row.id), `entity_fence_malformed: ${plan.warnings.join('; ')}`]);
  const rejected = new Map(plan.rejected.map(record => [record.fact_id, record.class]));
  return group.map(row => [Number(row.id), rejected.get(Number(row.id)) ?? null]);
}
