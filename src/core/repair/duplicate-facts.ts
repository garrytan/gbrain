/**
 * `gbrain repair duplicate-facts` (#7043): retire exact copies of one active
 * fact, keeping the oldest.
 *
 * A group is the active facts of one source and visibility (and one speaker)
 * that share `gbrain_fact_fingerprint`; near duplicates (rewordings) are never
 * grouped. The oldest row (created_at, then id) is kept; every other row is
 * superseded by it: `expired_at` set and `superseded_by` pointing at the kept
 * row. It is a supersession, never a withdrawal, so the claim stays
 * rememberable and the kept row keeps its entity.
 *
 * A group whose rows sit on more than one entity (`cross_entity`) is listed
 * on its own and retired only with `--include-cross-entity`; the rest are
 * `same_entity`. A fenced copy (a `## Facts` row of its page, not a
 * conversation-extractor row) is struck in its page as `superseded by #N`
 * through a revision-bound `put_page` (the page write path on managed and
 * unmanaged sources alike) when the kept row is a fence row of the same page,
 * and its `superseded_by` is then linked as the fence names it;
 * otherwise the fence could not name the kept row, and the copy is listed as
 * `fence_kept_elsewhere` and kept. A fenced copy on a segmented page (whose
 * body this repair does not rewrite) is listed as `segmented_page` and kept,
 * in the preview and in an apply that finds the page segmented since. Database-only copies are retired in one
 * coordinated database write per group on a managed brain (one transaction
 * otherwise).
 *
 * Explicit-only and preview-bound: the preview lists every group, prints a
 * hash and saves the set; `--apply --expect <hash> --yes` retires exactly
 * that set, rechecking each row (`changed_since_preview` for one that moved).
 * Nothing runs on upgrade.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { AUDIT_ROW_SOURCES } from '../facts/audit-sources.ts';
import { RELINK_OPERATION } from '../facts/relink-publish.ts';
import { parseFactsFence, strikeFactRowInPage } from '../facts-fence.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { coordinatedDatabaseWrite } from '../persistence/database-write.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairScope } from './core.ts';

export interface DuplicateRow {
  id: number;
  entity_slug: string | null;
  /** The page whose `## Facts` fence holds the row, or null for a database-only row. */
  fence_page: string | null;
  row_num: number | null;
}

export interface DuplicateGroup {
  source_id: string;
  visibility: string;
  fingerprint: string;
  claim: string;
  class: 'same_entity' | 'cross_entity';
  kept: DuplicateRow;
  /** Copies the apply retires. */
  retire: DuplicateRow[];
  /** Fenced copies whose fence cannot name the kept row; listed, never retired. */
  held: DuplicateRow[];
  /** Fenced copies on a segmented page; listed as `segmented_page`, never retired. */
  segmented: DuplicateRow[];
}

/** Every same-fingerprint group of active facts in these sources, in (source, visibility, fingerprint) order. Read-only. */
export async function findDuplicateFacts(engine: BrainEngine, sourceIds: string[]): Promise<DuplicateGroup[]> {
  const rows = await engine.executeRaw<{ id: number | string; source_id: string; visibility: string; fp: string; fact: string; entity_slug: string | null;
    fenced: boolean; row_num: number | string | null; source_markdown_slug: string | null; speaker: string }>(`
    SELECT * FROM (
      SELECT f.id, f.source_id, f.visibility, gbrain_fact_fingerprint(f.fact) AS fp, f.fact, f.entity_slug, f.row_num, f.source_markdown_slug, f.created_at,
             COALESCE(f.attributed_to, '') AS speaker,
             (f.row_num IS NOT NULL AND f.source_markdown_slug IS NOT NULL AND COALESCE(f.source, '') NOT LIKE 'cli:%') AS fenced,
             count(*) OVER (PARTITION BY f.source_id, f.visibility, COALESCE(f.attributed_to, ''), gbrain_fact_fingerprint(f.fact)) AS n
        FROM facts f
       WHERE f.source_id = ANY($1::text[]) AND f.expired_at IS NULL AND (f.valid_until IS NULL OR f.valid_until > now())
         AND f.superseded_by IS NULL AND COALESCE(f.source, '') <> ALL($2::text[])
    ) d WHERE d.n > 1
    ORDER BY d.source_id, d.visibility, d.fp, d.speaker, d.created_at, d.id`, [sourceIds, [...AUDIT_ROW_SOURCES]]);
  const groups: DuplicateGroup[] = [];
  let key = '';
  for (const row of rows) {
    const dup: DuplicateRow = { id: Number(row.id), entity_slug: row.entity_slug, fence_page: row.fenced ? row.source_markdown_slug : null,
      row_num: row.row_num === null ? null : Number(row.row_num) };
    const rowKey = JSON.stringify([row.source_id, row.visibility, row.fp, row.speaker]);
    if (rowKey !== key) {
      key = rowKey;
      groups.push({ source_id: row.source_id, visibility: row.visibility, fingerprint: row.fp, claim: row.fact, class: 'same_entity', kept: dup, retire: [], held: [], segmented: [] });
      continue;
    }
    const group = groups[groups.length - 1]!;
    if (dup.entity_slug !== group.kept.entity_slug) group.class = 'cross_entity';
    const strikable = dup.fence_page === null || (group.kept.fence_page === dup.fence_page && group.kept.row_num !== null);
    (strikable ? group.retire : group.held).push(dup);
  }
  const fenced = groups.flatMap(g => g.retire.flatMap(r => r.fence_page ? [[g.source_id, r.fence_page]] : []));
  if (!fenced.length) return groups;
  const segmented = new Set((await engine.executeRaw<{ source_id: string; slug: string }>(`SELECT p.source_id, p.slug FROM pages p
    JOIN unnest($1::text[], $2::text[]) AS t(source_id, slug) ON p.source_id = t.source_id AND p.slug = t.slug
    WHERE p.body_storage = 'segmented' AND p.deleted_at IS NULL`, [fenced.map(f => f[0]), fenced.map(f => f[1])])).map(r => JSON.stringify([r.source_id, r.slug])));
  for (const g of groups) {
    g.segmented = g.retire.filter(r => r.fence_page && segmented.has(JSON.stringify([g.source_id, r.fence_page])));
    g.retire = g.retire.filter(r => !g.segmented.includes(r));
  }
  return groups;
}

interface ApprovedGroup extends DuplicateGroup { selection: { source_ids: string[]; include_cross_entity: boolean } }
interface GroupItem extends RepairItem { group: DuplicateGroup; hash: string; last: boolean }

function previewCommand(scope: RepairScope, includeCrossEntity: boolean): string {
  return `gbrain repair duplicate-facts${scope.source_ids.length === 1 ? ` --source ${scope.source_ids[0]}` : ''}${includeCrossEntity ? ' --include-cross-entity' : ''}`;
}

const sourcesOf = (engine: BrainEngine, scope: RepairScope) => engine.executeRaw<{ id: string; incarnation: string }>(
  'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);

const hashOf = (scope: RepairScope, includeCrossEntity: boolean, sources: unknown, groups: DuplicateGroup[]) =>
  previewHash({ kind: 'duplicate-facts-v1', brain_id: scope.brain_id, sources, selection: { source_ids: scope.source_ids, include_cross_entity: includeCrossEntity },
    groups: groups.map(({ claim: _claim, ...g }) => g) });

function item(group: DuplicateGroup, index: number, hash: string, last: boolean): GroupItem {
  return { cursor: { phase: 1, id: index }, source_id: group.source_id, slug: group.kept.fence_page ?? group.kept.entity_slug ?? `facts/${group.kept.id}`,
    chars: 0, action: `retire ${group.retire.length} copy(ies) of fact ${group.kept.id}`, group, hash, last };
}

const ids = (rows: DuplicateRow[]) => rows.map(r => `#${r.id}${r.entity_slug ? ` (${r.entity_slug})` : ''}`).join(', ');

export const duplicateFactsRepair: RepairHandler = {
  kind: 'duplicate-facts',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const includeCrossEntity = opts?.includeCrossEntity === true;
    const command = previewCommand(scope, includeCrossEntity);
    if (!opts?.apply) {
      const groups = await findDuplicateFacts(engine, scope.source_ids);
      const selected = groups.filter(g => g.retire.length && (g.class === 'same_entity' || includeCrossEntity));
      const hash = hashOf(scope, includeCrossEntity, await sourcesOf(engine, scope), groups);
      if (selected.length) await saveApprovedSet<ApprovedGroup>(engine, { command: 'duplicate-facts', hash },
        selected.map(g => ({ ...g, selection: { source_ids: scope.source_ids, include_cross_entity: includeCrossEntity } })));
      const listing: RepairListing[] = [];
      for (const g of groups) {
        const where = `${g.source_id}:${g.visibility}:fact#${g.kept.id}`;
        const keeps = `keeps fact ${g.kept.id}${g.kept.entity_slug ? ` on ${g.kept.entity_slug}` : ''}`;
        const heldCross = g.class === 'cross_entity' && !includeCrossEntity;
        if (g.retire.length) listing.push({ item: where, class: heldCross ? 'cross_entity_held' : g.class,
          detail: `${keeps}; ${heldCross ? 'would supersede' : 'supersedes'} ${ids(g.retire)}`
            + (heldCross ? '; the copies sit on other entities, pass --include-cross-entity to retire them' : '') });
        if (g.held.length) listing.push({ item: where, class: 'fence_kept_elsewhere',
          detail: `${keeps}; the fence rows of ${ids(g.held)} cannot name a fact outside their page, so they are kept (forget or edit them in their page)` });
        if (g.segmented.length) listing.push({ item: where, class: 'segmented_page',
          detail: `${keeps}; ${ids(g.segmented)} sit in the Facts table of segmented page ${g.kept.fence_page}, which this repair does not rewrite, so they are kept (forget them in their page)` });
      }
      const count = (pick: (g: DuplicateGroup) => boolean) => groups.filter(pick).length;
      return { items: selected.map((g, index) => item(g, index, hash, index === selected.length - 1)), preview_hash: hash, listing,
        residuals: { same_entity_groups: count(g => g.class === 'same_entity'), cross_entity_groups: count(g => g.class === 'cross_entity'),
          copies_to_retire: selected.reduce((n, g) => n + g.retire.length, 0),
          cross_entity_copies_held: includeCrossEntity ? 0 : groups.filter(g => g.class === 'cross_entity').reduce((n, g) => n + g.retire.length, 0),
          fence_kept_elsewhere: groups.reduce((n, g) => n + g.held.length, 0), segmented_page: groups.reduce((n, g) => n + g.segmented.length, 0) } };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair duplicate-facts --apply retires only the set a preview printed.',
        `Preview first: ${command} — show the user the listing, then run the apply command it prints: ${command} --apply --expect <preview-hash> --yes`,
        'docs/guides/repair.md#explicit-only-repair-kinds');
    }
    const approved = await loadApprovedSet<ApprovedGroup>(engine, { command: 'duplicate-facts', hash: opts.expect, previewCommand: command,
      emptyHash: async () => hashOf(scope, includeCrossEntity, await sourcesOf(engine, scope), []) });
    const selection = JSON.stringify({ source_ids: scope.source_ids, include_cross_entity: includeCrossEntity });
    if (approved.items.some(g => JSON.stringify(g.selection) !== selection)) throw previewChangedError(opts.expect, command);
    const items = approved.items.map(({ selection: _selection, ...g }, index) => item(g, index, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { group, hash, last } = entry as GroupItem;
    const { retired, segmented } = await retireGroup(ctx, entry, group);
    if (last) await clearApprovedSet(ctx.engine, { command: 'duplicate-facts', hash });
    const changed = group.retire.filter(r => !retired.includes(r.id) && !segmented.includes(r.id)).map(r => r.id);
    const reasons = [...(segmented.length ? [`kept on a segmented page: ${segmented.join(', ')}`] : []), ...(changed.length ? [`kept as changed since the preview: ${changed.join(', ')}`] : [])];
    return { applied: retired.length > 0,
      outcome: retired.length ? (reasons.length ? 'partially_superseded' : 'superseded') : changed.length ? 'changed_since_preview' : 'segmented_page',
      detail: { kept: group.kept.id, superseded: retired.length, ...(segmented.length ? { segmented_page: segmented.length } : {}) },
      ...(reasons.length ? { reason: reasons.join('; ') } : {}) };
  },
};

/** The rows still active, unsuperseded and stating the group's claim on the entity and fence row the preview saw. */
async function unchanged(db: BrainEngine, group: DuplicateGroup, rows: DuplicateRow[]): Promise<DuplicateRow[]> {
  const live = await db.executeRaw<{ id: number | string; entity_slug: string | null; row_num: number | string | null; source_markdown_slug: string | null }>(
    `SELECT id, entity_slug, row_num, source_markdown_slug FROM facts
      WHERE source_id=$1 AND id=ANY($2::bigint[]) AND visibility=$3 AND gbrain_fact_fingerprint(fact)=$4
        AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now()) AND superseded_by IS NULL`,
    [group.source_id, rows.map(r => r.id), group.visibility, group.fingerprint]);
  const byId = new Map(live.map(r => [Number(r.id), r]));
  return rows.filter(r => {
    const now = byId.get(r.id);
    return !!now && now.entity_slug === r.entity_slug && (now.row_num === null ? null : Number(now.row_num)) === r.row_num
      && (r.fence_page === null || now.source_markdown_slug === r.fence_page);
  });
}

type RepairContext = Parameters<RepairHandler['apply']>[0];

/** One database-only write of the group: a coordinated write holding `keys` on a managed brain, one transaction otherwise. */
async function databaseWrite(ctx: RepairContext, group: DuplicateGroup, keys: string[], write: (tx: BrainEngine) => Promise<number[]>): Promise<number[]> {
  const managed = await coordinatedDatabaseWrite({ ...ctx, sourceId: group.source_id }, RELINK_OPERATION, keys[0]!, keys, tx => write(tx));
  return managed ? managed.value : maintenanceTransaction(ctx.engine, write);
}

async function retireGroup(ctx: RepairContext, entry: RepairItem, group: DuplicateGroup): Promise<{ retired: number[]; segmented: number[] }> {
  const engine = ctx.engine;
  if (!(await unchanged(engine, group, [group.kept])).length) return { retired: [], segmented: [] };
  const live = await unchanged(engine, group, group.retire);
  const retired: number[] = [];
  const dbOnly = live.filter(r => r.fence_page === null);
  if (dbOnly.length) {
    retired.push(...await databaseWrite(ctx, group, [...new Set([entry.slug, ...dbOnly.map(r => r.entity_slug ?? entry.slug)])], async tx => (await tx.executeRaw<{ id: number | string }>(
      `UPDATE facts SET expired_at = now(), superseded_by = $3
        WHERE source_id = $1 AND id = ANY($2::bigint[]) AND expired_at IS NULL AND superseded_by IS NULL
          AND visibility = $4 AND gbrain_fact_fingerprint(fact) = $5
          AND EXISTS (SELECT 1 FROM facts k WHERE k.source_id = $1 AND k.id = $3 AND k.expired_at IS NULL)
        RETURNING id`, [group.source_id, dbOnly.map(r => r.id), group.kept.id, group.visibility, group.fingerprint])).map(r => Number(r.id))));
  }
  const fenced = live.filter(r => r.fence_page !== null);
  if (!fenced.length) return { retired, segmented: [] };
  const struck = await strikeFencedCopies(ctx, entry, group, fenced);
  if (struck === 'segmented') return { retired, segmented: fenced.map(r => r.id) };
  return { retired: [...retired, ...struck], segmented: [] };
}

/**
 * Fenced copies on the kept row's page: struck as `superseded by #<kept row>` in one revision-bound put_page, whose
 * projection expires them; their `superseded_by` is then linked to the kept row, as the fence's reference resolves.
 */
async function strikeFencedCopies(ctx: RepairContext, entry: RepairItem, group: DuplicateGroup, rows: DuplicateRow[]): Promise<number[] | 'segmented'> {
  const slug = group.kept.fence_page!;
  const snapshot = await ctx.engine.readPageSnapshot(slug, { sourceId: group.source_id });
  if (!snapshot) return [];
  if (isSegmentedPage(snapshot.page)) return 'segmented';
  let page = { ...snapshot.page, compiled_truth: snapshot.page.compiled_truth ?? '', timeline: snapshot.page.timeline ?? '' };
  const fence = [...parseFactsFence(page.compiled_truth).facts, ...parseFactsFence(page.timeline).facts];
  if (!fence.some(f => f.rowNum === group.kept.row_num && f.active)) return [];
  const struck = rows.filter(r => fence.some(f => f.rowNum === r.row_num && f.active));
  if (!struck.length) return [];
  for (const r of struck) page = strikeFactRowInPage(page, r.row_num!, group.kept.row_num!);
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, source_id: group.source_id,
    content: serializePageToMarkdown(page, snapshot.tags), expected_revision: snapshot.revision,
    request_id: await repairRequestId(ctx, 'duplicate-facts', entry, snapshot.revision) } });
  return databaseWrite(ctx, group, [slug], async tx => (await tx.executeRaw<{ id: number | string }>(
    `UPDATE facts SET superseded_by = $3 WHERE source_id = $1 AND id = ANY($2::bigint[]) AND expired_at IS NOT NULL AND superseded_by IS NULL
      RETURNING id`, [group.source_id, struck.map(r => r.id), group.kept.id])).map(r => Number(r.id)));
}
