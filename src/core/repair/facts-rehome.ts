/**
 * `gbrain repair facts-rehome` (B-7, #6925): move facts off an entity slug that
 * has no page onto the page that slug names.
 *
 * Before the B-7 resolver fix, an extractor's `companies/acme-example` missed
 * `orgs/acme-example` (an alias hit was only accepted in the reference's own
 * directory), and the managed write paths kept the invented slug as
 * attribution, so a brain collected facts on `entity_slug` values no page
 * answers for. Readers never reach them: recall and trajectory key on the
 * page, `facts relink` only takes facts with no entity, and the phantom
 * redirect moves pages, not slugs.
 *
 * Candidates: every `entity_slug` of the scoped sources with no live page,
 * grouped per slug. Each slug is resolved with the strict resolver (identity
 * evidence only: exact page, organization directory variant, unique alias;
 * never a bare-name guess or a slugify) and classified:
 *   - rehome: one live entity page answers; its database-only facts move.
 *   - ambiguous / unverified / unresolved: listed, never moved.
 *   - fence_owned: every fact of the slug is a page's Facts table row, whose
 *     page text the repair does not rewrite; listed, never moved.
 *
 * Explicit-only and preview-bound: the preview lists every page-less slug with
 * its class and the fact ids it would move, prints a hash and saves the
 * rehome set; `--apply --expect <hash>` moves exactly that set. An apply
 * rechecks each slug in its own transaction (still page-less, target still
 * live, the same database-only fact ids) and keeps it as
 * `changed_since_preview` otherwise. A duplicate ontology observation is
 * dropped before the move (B-10). On a managed brain each slug commits as one
 * coordinated database-only write on both slugs' keys. Nothing runs on
 * upgrade, and no page is rewritten.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { resolveStrictEntityReference } from '../entities/resolve.ts';
import { dropRekeyDuplicates } from '../facts/ontology-rekey.ts';
import { RELINK_OPERATION } from '../facts/relink-publish.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { coordinatedDatabaseWrite } from '../persistence/database-write.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

export interface PagelessEntity {
  source_id: string;
  /** The page-less `entity_slug`. */
  slug: string;
  /** Database-only facts (no fence row) carrying it, in id order: the rows a rehome moves. */
  ids: number[];
  /** Facts carrying it that are a page's Facts table row; never moved. */
  fenced: number;
  class: 'rehome' | 'ambiguous' | 'unverified' | 'unresolved' | 'fence_owned';
  /** The page a rehome moves the facts to. */
  target: string | null;
}

/** Every page-less entity slug of these sources, classified, in (source, slug) order. Read-only. */
export async function classifyPagelessEntities(engine: BrainEngine, sourceIds: string[]): Promise<PagelessEntity[]> {
  const rows = await engine.executeRaw<{ source_id: string; slug: string; ids: Array<number | string> | null; fenced: number | string }>(`
    SELECT f.source_id, f.entity_slug AS slug,
           array_agg(f.id ORDER BY f.id) FILTER (WHERE f.row_num IS NULL) AS ids,
           count(*) FILTER (WHERE f.row_num IS NOT NULL) AS fenced
      FROM facts f
     WHERE f.source_id = ANY($1::text[]) AND f.entity_slug IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL)
     GROUP BY f.source_id, f.entity_slug
     ORDER BY f.source_id, f.entity_slug`, [sourceIds]);
  const out: PagelessEntity[] = [];
  for (const row of rows) {
    const ids = (row.ids ?? []).map(Number);
    const base = { source_id: row.source_id, slug: row.slug, ids, fenced: Number(row.fenced) };
    if (!ids.length) { out.push({ ...base, class: 'fence_owned', target: null }); continue; }
    const resolved = await resolveStrictEntityReference(engine, row.source_id, row.slug);
    if (resolved.slug !== null && resolved.slug !== row.slug) out.push({ ...base, class: 'rehome', target: resolved.slug });
    else out.push({ ...base, class: resolved.slug === null && (resolved.miss === 'ambiguous' || resolved.miss === 'unverified') ? resolved.miss : 'unresolved', target: null });
  }
  return out;
}

interface ApprovedEntity extends PagelessEntity { selection: string[] }
interface RehomeItem extends RepairItem { entity: PagelessEntity; hash: string; last: boolean }

function previewCommand(scope: RepairScope): string {
  return `gbrain repair facts-rehome${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}`;
}

const sourcesOf = (engine: BrainEngine, scope: RepairScope) => engine.executeRaw<{ id: string; incarnation: string }>(
  'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);

const hashOf = (scope: RepairScope, sources: unknown, entities: PagelessEntity[]) =>
  previewHash({ kind: 'facts-rehome-v1', brain_id: scope.brain_id, sources, selection: { source_ids: scope.source_ids }, entities });

function item(entity: PagelessEntity, index: number, hash: string, last: boolean): RehomeItem {
  return { cursor: { phase: 1, id: index }, source_id: entity.source_id, slug: entity.slug, chars: 0, action: 'rehome',
    change: { from: entity.slug, to: entity.target! }, entity, hash, last };
}

function detail(entity: PagelessEntity): string {
  const kept = entity.fenced ? `; ${entity.fenced} fenced fact(s) kept` : '';
  if (entity.class === 'rehome') return `${entity.ids.length} fact(s) move to ${entity.target}${kept}`;
  if (entity.class === 'fence_owned') return `${entity.fenced} fact(s), all page Facts table rows: kept as is`;
  return `${entity.ids.length} fact(s) kept: ${entity.class === 'ambiguous' ? 'more than one page answers' : entity.class === 'unverified' ? 'only a bare-name guess answers' : 'no page answers'}${kept}`;
}

export const factsRehomeRepair: RepairHandler = {
  kind: 'facts-rehome',
  publication: 'projection',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const command = previewCommand(scope);
    if (!opts?.apply) {
      const entities = await classifyPagelessEntities(engine, scope.source_ids);
      const rehome = entities.filter(e => e.class === 'rehome');
      const hash = hashOf(scope, await sourcesOf(engine, scope), entities);
      if (rehome.length) await saveApprovedSet<ApprovedEntity>(engine, { command: 'facts-rehome', hash }, rehome.map(e => ({ ...e, selection: scope.source_ids })));
      const residuals: Record<string, number> = {};
      for (const e of entities) if (e.class !== 'rehome') residuals[e.class] = (residuals[e.class] ?? 0) + 1;
      return { items: rehome.map((e, index) => item(e, index, hash, index === rehome.length - 1)), preview_hash: hash, residuals,
        listing: entities.map(e => ({ item: `${e.source_id}:${e.slug}`, class: e.class, detail: detail(e) })) };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair facts-rehome --apply moves only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`,
        'docs/guides/repair.md#explicit-only-repair-kinds');
    }
    const approved = await loadApprovedSet<ApprovedEntity>(engine, { command: 'facts-rehome', hash: opts.expect, previewCommand: command,
      emptyHash: async () => hashOf(scope, await sourcesOf(engine, scope), []) });
    if (approved.items.some(e => JSON.stringify(e.selection) !== JSON.stringify(scope.source_ids))) throw previewChangedError(opts.expect, command);
    const items = approved.items.map(({ selection: _selection, ...e }, index) => item(e, index, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { entity, hash, last } = entry as RehomeItem;
    const target = entity.target!;
    const move = async (tx: BrainEngine): Promise<boolean> => {
      const [state] = await tx.executeRaw<{ from_live: boolean; to_live: boolean; ids: Array<number | string> | null }>(`
        SELECT EXISTS (SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL) AS from_live,
               EXISTS (SELECT 1 FROM pages WHERE source_id = $1 AND slug = $3 AND deleted_at IS NULL) AS to_live,
               (SELECT array_agg(id ORDER BY id) FROM facts WHERE source_id = $1 AND entity_slug = $2 AND row_num IS NULL) AS ids`,
        [entity.source_id, entity.slug, target]);
      if (!state || state.from_live || !state.to_live || JSON.stringify((state.ids ?? []).map(Number)) !== JSON.stringify(entity.ids)) return false;
      await dropRekeyDuplicates(tx, entity.source_id, { where: 'f.entity_slug = $2 AND f.row_num IS NULL', entity: '$3::text', sms: 'f.source_markdown_slug',
        params: [entity.slug, target] });
      await tx.executeRaw('UPDATE facts SET entity_slug = $3 WHERE source_id = $1 AND entity_slug = $2 AND row_num IS NULL', [entity.source_id, entity.slug, target]);
      return true;
    };
    const managed = await coordinatedDatabaseWrite({ ...ctx, sourceId: entity.source_id }, RELINK_OPERATION, target, [entity.slug, target], tx => move(tx));
    const moved = managed ? managed.value : await maintenanceTransaction(ctx.engine, move);
    if (last) await clearApprovedSet(ctx.engine, { command: 'facts-rehome', hash });
    if (!moved) return { applied: false, outcome: 'changed_since_preview', reason: 'the slug gained a page, the target page is gone, or its facts changed since the preview' };
    return { applied: true, outcome: 'rehomed', detail: { from: entity.slug, to: target, facts: entity.ids.length } };
  },
};
