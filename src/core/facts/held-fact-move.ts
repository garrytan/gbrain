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
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { isFenceHold, pageHasFile, planManagedPage, type UnfencedFactRow } from './unfenced-facts.ts';

export interface HeldFactMoveOutcome {
  moved: number;
  moved_slugs: string[];
  /** Held rows that stay on memory/unattributed this run, with the reason (the entity page's fence, a duplicate claim, a refusal). */
  unmovable: Array<{ code: 'held_fact_unmovable'; slug: string; fact_ids: number[]; reason: string }>;
  /** #8568: entities whose move threw (I/O, database), as opposed to holds the next run settles. */
  write_errors: number;
}

export async function moveHeldFacts(engine: BrainEngine, sourceId: string): Promise<HeldFactMoveOutcome> {
  const outcome: HeldFactMoveOutcome = { moved: 0, moved_slugs: [], unmovable: [], write_errors: 0 };
  const rows = await engine.executeRaw<UnfencedFactRow>(
    `SELECT id, source_id, entity_slug, fact, kind, visibility, notability, context, valid_from, valid_until, source, confidence,
            claim_metric, claim_value, claim_unit, claim_period, attributed_to, true AS page_exists
       FROM facts f
      WHERE f.source_id = $1 AND f.source_markdown_slug = $2 AND f.row_num IS NOT NULL AND f.expired_at IS NULL AND f.dimension IS NULL
        AND f.entity_slug IS NOT NULL AND f.entity_slug <> $2
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL)
      ORDER BY f.entity_slug, f.id`, [sourceId, UNATTRIBUTED_MEMORY_SLUG]);
  if (rows.length === 0) return outcome;
  const authority = await maintenancePreflight(engine, sourceId);
  if (!authority) return outcome;
  const groups = new Map<string, UnfencedFactRow[]>();
  for (const row of rows) groups.set(row.entity_slug!, [...groups.get(row.entity_slug!) ?? [], row]);
  const unmovable = (slug: string, ids: Array<string | number>, reason: string) => {
    if (ids.length) outcome.unmovable.push({ code: 'held_fact_unmovable', slug, fact_ids: ids.map(Number), reason });
  };
  for (const [slug, group] of groups) {
    try {
      const [page] = await engine.executeRaw<{ source_path: string | null; source_uri: string | null; visible: boolean }>(
        `SELECT p.source_path, p.source_uri, ${privatePagesFilterFragment('p')} AS visible FROM pages p WHERE p.source_id=$1 AND p.slug=$2 AND p.deleted_at IS NULL`, [sourceId, slug]);
      if (!page) continue;
      // The holding row is in Git; a move into a page kept out of Git would strike it there with no file holding the fact.
      if (!await pageHasFile(engine, sourceId, slug, page)) { unmovable(slug, group.map(r => r.id), 'entity_page_database_only'); continue; }
      // A fact moved into a page not every reader of the source can read leaves the world-readable holding page altogether.
      const plan = await planManagedPage(engine, authority, sourceId, slug, group, { note: page.visible === true ? `moved to ${slug}` : 'moved' });
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
