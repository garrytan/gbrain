/**
 * Phantom redirect on a managed brain (#5280). The legacy handler edits the
 * canonical file, moves rows, soft-deletes the phantom and unlinks its file
 * outside coordination. Here the same lossless merge is two maintenance
 * requests through the coordinator:
 *
 *   1. `managed_maintenance_phantom_merge` on the canonical page publishes
 *      the canonical body with the phantom's fence rows appended and, in the
 *      same transaction, moves withdrawals, the phantom's fact rows (by id, to
 *      the row numbers written to the fence), its links and the rename alias.
 *   2. `managed_maintenance_phantom_delete` on the phantom soft-deletes it and
 *      removes its canonical file, moving any edge added since the merge.
 *
 * Both requests are keyed by their intents, so a retry after a crash between
 * them replays the merge and completes the delete.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { Page } from '../types.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { logPhantomEvent } from '../facts/phantom-audit.ts';
import { MOVE_WITHDRAWAL_SUBJECT_SQL } from '../facts/withdrawal-schema.ts';
import { recordRenameAlias } from '../page-state/rename-alias.ts';
import { preparePageMutation } from '../persistence/page-prepare.ts';
import { maintenancePreflight, submitMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { mergePhantomFenceRows, mergePhantomLinks, movePhantomFacts, phantomHasResidue, type RedirectResult } from './phantom-redirect.ts';

export async function redirectManagedPhantom(engine: BrainEngine, page: Page, canonical: string, sourceId: string): Promise<RedirectResult> {
  const authority = (await maintenancePreflight(engine, sourceId))!;
  const drift = (reason: string): RedirectResult => {
    logPhantomEvent({ phantom_slug: page.slug, outcome: 'drift', source_id: sourceId, reason });
    return { outcome: 'drift', canonical };
  };
  const target = await engine.readPageSnapshot(canonical, { sourceId });
  if (!target) return drift('canonical page unavailable on a managed brain');
  const phantom = await engine.readPageSnapshot(page.slug, { sourceId });
  // Eligibility, merge and delete all bind to this one snapshot revision.
  if (!phantom || phantom.page.id !== page.id || phantom.page.compiled_truth !== page.compiled_truth
    || await phantomHasResidue(engine, phantom.page)) return drift('phantom page changed');

  const [dbMax] = await engine.executeRaw<{ n: number | string | null }>(
    'SELECT MAX(row_num) AS n FROM facts WHERE source_id = $1 AND source_markdown_slug = $2', [sourceId, canonical]);
  const merged = mergePhantomFenceRows(target.page.compiled_truth, parseFactsFence(page.compiled_truth ?? '').facts, Number(dbMax?.n ?? 0));
  if (merged.body !== null && parseFactsFence(merged.body).warnings.length > 0) return drift('rendered fence failed re-parse');
  const outcome = await submitMaintenanceIntent(engine, authority, canonical, {
    kind: 'managed_maintenance_phantom_merge', expected_revision: target.revision,
    content: serializePageToMarkdown({ ...target.page, compiled_truth: merged.body ?? target.page.compiled_truth }, target.tags),
    phantom_slug: page.slug, phantom_page_id: page.id, phantom_revision: phantom.revision, row_map: [...merged.renumber],
  });

  // The delete is bound to the revision that was merged: an edit committed
  // since then never reached the canonical page, so the next run remerges it.
  const current = await engine.readPageSnapshot(page.slug, { sourceId });
  if (current?.page.id === page.id) {
    if (current.revision !== phantom.revision) return drift('phantom page edited after its merge; delete deferred to the next run');
    await submitMaintenanceIntent(engine, authority, page.slug, { kind: 'managed_maintenance_phantom_delete',
      expected_revision: phantom.revision, canonical_slug: canonical });
  }
  logPhantomEvent({ phantom_slug: page.slug, canonical_slug: canonical, outcome: 'redirected',
    fact_count: Number(outcome.facts_moved ?? 0), source_id: sourceId });
  return { outcome: 'redirected', canonical };
}

/** Preparer for `managed_maintenance_phantom_merge`: the canonical page publication plus the phantom's row moves. */
export async function preparePhantomMerge(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const p = row.intent!;
  const phantomSlug = String(p.phantom_slug);
  const phantomId = Number(p.phantom_page_id);
  const rowMap = new Map((p.row_map as Array<[number, number]>).map(([from, to]) => [Number(from), Number(to)]));
  const phantomUnchanged = async (db: BrainEngine) => {
    const phantom = await db.readPageSnapshot(phantomSlug, { sourceId: row.source_id });
    if (!phantom || phantom.page.id !== phantomId || phantom.revision !== p.phantom_revision || await phantomHasResidue(db, phantom.page)) {
      throw opError('revision_conflict', 'The phantom page changed before its redirect.',
        `Phantom page ${phantomSlug} in source ${row.source_id} changed before request ${row.request_id} could redirect it, so nothing was merged. Review the page; the next cycle re-evaluates it.`,
        { fix: readFix(`Shows page ${phantomSlug} as it is now, read-only.`, { argv: ['gbrain', 'get', '--source', row.source_id, '--', phantomSlug] }) });
    }
  };
  await phantomUnchanged(engine);
  const page = await preparePageMutation(engine, row, config);
  return { ...page, additionalPageKeys: [...(page.additionalPageKeys ?? []), { sourceId: row.source_id, slug: phantomSlug }],
    validate: async tx => { await page.validate?.(tx); await phantomUnchanged(tx); },
    apply: async tx => {
      // Withdrawals move first so the trigger honors them as the rows take the
      // canonical subject; moved rows then match the published fence rows.
      await tx.executeRaw(MOVE_WITHDRAWAL_SUBJECT_SQL, [row.source_id, phantomSlug, row.slug]);
      const moved = await movePhantomFacts(tx, row.source_id, phantomSlug, row.slug, rowMap);
      const outcome = await page.apply(tx);
      await mergePhantomLinks(tx, phantomId, Number(row.page_id));
      await recordRenameAlias(tx, row.source_id, phantomSlug, row.slug);
      return { ...outcome, facts_moved: moved };
    } };
}

/**
 * Preparer for `managed_maintenance_phantom_delete`: the phantom's soft delete
 * and file removal, holding the canonical key too. Edges added to the phantom
 * after the merge (they advance no revision) move in the same transaction;
 * timeline rows added since then defer the delete.
 */
export async function preparePhantomDelete(engine: BrainEngine, row: WriteRequest, config: GBrainConfig): Promise<PreparedMutation> {
  const canonicalSlug = String(row.intent!.canonical_slug);
  const noTimeline = async (db: BrainEngine) => {
    if ((await db.executeRaw('SELECT 1 FROM timeline_entries WHERE page_id=$1 LIMIT 1', [row.page_id])).length) {
      throw opError('revision_conflict', 'The phantom gained timeline rows after its merge.',
        `Phantom page ${row.slug} in source ${row.source_id} gained timeline entries after its merge, so request ${row.request_id} did not delete it. Review those entries; the next cycle re-evaluates the phantom.`,
        { fix: readFix(`Shows page ${row.slug} with its timeline, read-only.`, { argv: ['gbrain', 'get', '--source', row.source_id, '--', row.slug] }) });
    }
  };
  await noTimeline(engine);
  const page = await preparePageMutation(engine, { ...row, operation: 'delete_page' }, config);
  return { ...page, additionalPageKeys: [...(page.additionalPageKeys ?? []), { sourceId: row.source_id, slug: canonicalSlug }],
    validate: async tx => { await page.validate?.(tx); await noTimeline(tx); },
    apply: async tx => {
      const canonical = await tx.readPageSnapshot(canonicalSlug, { sourceId: row.source_id });
      if (!canonical) {
        throw opError('page_not_found', 'The redirect target disappeared before the phantom delete.',
          `Canonical page ${canonicalSlug} in source ${row.source_id} was deleted before request ${row.request_id} could redirect phantom ${row.slug} to it, so the transaction rolled back and the phantom stays. No manual step is needed; the next cycle re-evaluates it.`);
      }
      await mergePhantomLinks(tx, Number(row.page_id), canonical.page.id);
      return page.apply(tx);
    } };
}
