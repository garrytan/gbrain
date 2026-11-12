/**
 * GST-2492: on a strict git-canonical source, `remember` for an entity that has no page holds the fact as a row of
 * memory/unattributed whose `entity` cell names the entity (memory-mutations.ts planRememberTarget), so Git has it
 * before the database does. Once the entity has a page, the extract_facts phase moves the held rows here: one
 * maintenance publication per entity appends them to the entity page's Facts fence and strikes their holding rows,
 * and the facts rows move in place (ids, embeddings and provenance kept; the belief ledger transfers their stream).
 * A row that cannot move stays held, active and searchable, and is reported as `held_fact_unmovable`.
 */
import type { BrainEngine } from '../engine.ts';
import { UNATTRIBUTED_MEMORY_SLUG } from '../facts-fence.ts';
import { maintenancePreflight, submitPlannedFactFenceAdoption } from '../persistence/prepared-maintenance.ts';
import { folderRestricted, privatePagesFilterFragment } from '../search/private-visibility.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
import { isFenceHold, pageHasFile, planManagedPage, type UnfencedFactRow } from './unfenced-facts.ts';

export interface HeldFactMoveOutcome {
  moved: number;
  moved_slugs: string[];
  /** Held rows that stay on memory/unattributed this run, with the reason (the entity page's fence, a duplicate claim, a refusal). */
  unmovable: Array<{ code: 'held_fact_unmovable'; slug: string; fact_ids: number[]; reason: string }>;
  /** #8568: entities whose move threw (I/O, database), as opposed to holds the next run settles. */
  write_errors: number;
}

/**
 * GST-2492 PR 2: whether a fact for `entity` (null: no entity) that has no page of its own is written to memory/unattributed
 * on this source: the source is strict, write-through is on, and no folder access rule covers the entity and its page is not
 * soft-deleted (such an entity is not named on the world-readable holding page, so its fact stays database-only).
 */
export async function holdsInGit(engine: BrainEngine, sourceId: string, entity: string | null): Promise<boolean> {
  if ((await getWorktreeBinding(engine, sourceId))?.canonical_git !== true) return false;
  if (/^(false|0|off|no)$/i.test(await engine.getConfig('sync.write_through') ?? 'true')) return false;
  return entity === null || !await folderRestricted(engine, sourceId, entity)
    && !(await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NOT NULL', [sourceId, entity])).length;
}

/**
 * The page a held row keyed `key` moves to: the page at that slug, else, for a key with no folder (remember keys a new
 * name that way), the one page `remember` itself would resolve the name to. Two or more such pages: the row stays held and
 * the candidates are named. Null: no page yet.
 */
export async function heldFactTarget(engine: BrainEngine, sourceId: string, key: string): Promise<{ slug: string } | { ambiguous: string[] } | null> {
  if ((await engine.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, key])).length) return { slug: key };
  if (key.includes('/')) return null;
  const { entityReferenceCandidates, resolveStrictEntityReference } = await import('../entities/resolve.ts');
  const strict = await resolveStrictEntityReference(engine, sourceId, key, { sameName: true });
  if (strict.slug !== null) return { slug: strict.slug };
  return strict.miss === 'ambiguous' ? { ambiguous: await entityReferenceCandidates(engine, sourceId, key) } : null;
}

export const ambiguousHeldReason = (candidates: string[]) => `entity_ambiguous: candidates ${candidates.join(', ')}`;

export async function moveHeldFacts(engine: BrainEngine, sourceId: string): Promise<HeldFactMoveOutcome> {
  const outcome: HeldFactMoveOutcome = { moved: 0, moved_slugs: [], unmovable: [], write_errors: 0 };
  const rows = await engine.executeRaw<UnfencedFactRow>(
    `SELECT id, source_id, entity_slug, fact, kind, visibility, notability, context, valid_from, valid_until, source, confidence,
            claim_metric, claim_value, claim_unit, claim_period, attributed_to, true AS page_exists
       FROM facts f
      WHERE f.source_id = $1 AND f.source_markdown_slug = $2 AND f.row_num IS NOT NULL AND f.expired_at IS NULL AND f.dimension IS NULL
        AND f.entity_slug IS NOT NULL AND f.entity_slug <> $2
        AND (f.entity_slug NOT LIKE '%/%' OR EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL))
      ORDER BY f.entity_slug, f.id`, [sourceId, UNATTRIBUTED_MEMORY_SLUG]);
  if (rows.length === 0) return outcome;
  const unmovable = (slug: string, ids: Array<string | number>, reason: string) => {
    if (ids.length) outcome.unmovable.push({ code: 'held_fact_unmovable', slug, fact_ids: ids.map(Number), reason });
  };
  const keys = new Map<string, UnfencedFactRow[]>();
  for (const row of rows) keys.set(row.entity_slug!, [...keys.get(row.entity_slug!) ?? [], row]);
  // A row keyed by a bare name moves to the page that name now resolves to, which re-keys it to that page.
  const groups: Array<{ slug: string; from?: string; group: UnfencedFactRow[] }> = [];
  for (const [key, group] of keys) {
    const target = await heldFactTarget(engine, sourceId, key);
    if (target && 'ambiguous' in target) unmovable(key, group.map(r => r.id), ambiguousHeldReason(target.ambiguous));
    else if (target) groups.push({ slug: target.slug, ...(target.slug === key ? {} : { from: key }), group });
  }
  if (groups.length === 0) return outcome;
  const authority = await maintenancePreflight(engine, sourceId);
  if (!authority) return outcome;
  for (const { slug, from, group } of groups) {
    try {
      const [page] = await engine.executeRaw<{ source_path: string | null; source_uri: string | null; visible: boolean }>(
        `SELECT p.source_path, p.source_uri, ${privatePagesFilterFragment('p')} AS visible FROM pages p WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL`, [sourceId, slug]);
      if (!page) continue;
      // The holding row is in Git; a move into a page kept out of Git would strike it there with no file holding the fact.
      if (!await pageHasFile(engine, sourceId, slug, page)) { unmovable(slug, group.map(r => r.id), 'entity_page_database_only'); continue; }
      // A fact moved into a page not every reader of the source can read leaves the world-readable holding page altogether.
      const plan = await planManagedPage(engine, authority, sourceId, slug, group, { note: page.visible === true ? `moved to ${slug}` : 'moved', ...(from ? { from_entity: from } : {}) });
      if (plan.kind === 'no_page') continue;
      if (plan.kind === 'warnings') { unmovable(slug, group.map(r => r.id), `entity_fence_malformed: ${plan.warnings.join('; ')}`); continue; }
      const rejected = plan.kind === 'unadoptable' ? plan.records : plan.fence.rejected;
      for (const reason of new Set(rejected.map(r => r.class))) unmovable(slug, rejected.filter(r => r.class === reason).map(r => r.fact_id), reason);
      if (plan.kind === 'unadoptable') continue;
      await submitPlannedFactFenceAdoption(engine, authority, slug, plan.request, true);
      outcome.moved += plan.fence.assignments.length;
      outcome.moved_slugs.push(slug);
    } catch (error) {
      unmovable(slug, group.map(r => r.id), (error instanceof Error ? error.message : String(error)).slice(0, 300));
      if (!isFenceHold(error)) outcome.write_errors += 1;
    }
  }
  return outcome;
}
