/**
 * Explicit remember(replaces) already retires the old claim immediately.
 * Nightly consolidate closes its missing validity interval at the replacement's
 * valid_from, like the existing chronological cluster chain. No winner selection,
 * model, new store, or direct SQL write. Backdated chains are left for review.
 * Publish the existing struck fence through GBrain's revision-bound page writer
 * so a later extraction cannot erase the validity stamp.
 */
import type { BrainEngine } from '../engine.ts';
import { parseFactsFence, renderFactsTable, replaceOrInsertFactsFence } from '../facts-fence.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { materializedSnapshot } from '../persistence/segmented-apply.ts';
import { maintenancePreflight, publishMaintenancePage } from '../persistence/prepared-maintenance.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { loadConfig } from '../config.ts';
import { refuseUnparsedRewrite } from '../fence-repair/refusal.ts';
import { opError } from '../ops/contract.ts';

export async function closeSupersededValidity(engine: BrainEngine, opts: {
  sourceId?: string; dryRun?: boolean; stopped?: () => boolean;
} = {}): Promise<{ stamped: number; pages: number; skipped: number; bounded: boolean }> {
  const managed = await managedPersistenceEnabled(engine);
  // Pages, not individual facts, are bounded; a page is published atomically.
  const pages = await engine.executeRaw<{ source_id: string; slug: string }>(`
    SELECT DISTINCT f.source_id, f.source_markdown_slug AS slug
    FROM facts f JOIN facts n ON n.id=f.superseded_by AND n.source_id=f.source_id
    JOIN pages p ON p.source_id=f.source_id AND p.slug=f.source_markdown_slug
    WHERE f.expired_at IS NOT NULL AND f.valid_until IS NULL
      AND f.entity_slug IS NOT DISTINCT FROM n.entity_slug
      AND n.valid_from >= f.valid_from
      AND f.visibility='world' AND n.visibility='world' AND p.deleted_at IS NULL
      AND ($1::text IS NULL OR f.source_id=$1)
    ORDER BY f.source_id, f.source_markdown_slug LIMIT 100`, [opts.sourceId ?? null]);
  const result = { stamped: 0, pages: 0, skipped: 0, bounded: pages.length === 100 };
  for (const target of pages) {
    if (opts.stopped?.()) { result.bounded = true; break; }
    const snapshot = await materializedSnapshot(engine, await engine.readPageSnapshot(target.slug, {
      sourceId: target.source_id, excludePrivate: true,
    }));
    if (!snapshot || snapshot.page.deleted_at) { result.skipped++; continue; }
    const candidates = await engine.executeRaw<{ row_num: number; fact: string; next_from: string | Date; next_row: number }>(`
      SELECT f.row_num, f.fact, n.valid_from AS next_from, n.row_num AS next_row
      FROM facts f JOIN facts n ON n.id=f.superseded_by AND n.source_id=f.source_id
      WHERE f.source_id=$1 AND f.source_markdown_slug=$2 AND n.source_markdown_slug=$2
        AND f.entity_slug IS NOT DISTINCT FROM n.entity_slug
        AND n.valid_from >= f.valid_from
        AND f.expired_at IS NOT NULL AND f.valid_until IS NULL
        AND f.visibility='world' AND n.visibility='world'
      ORDER BY f.id`, [target.source_id, target.slug]);
    let stamped = 0;
    const page = refuseUnparsedRewrite(snapshot.page, target.slug, target.source_id, () => {
      const next = { ...snapshot.page };
      for (const section of ['compiled_truth', 'timeline'] as const) {
        const body = next[section] ?? '';
        const parsed = parseFactsFence(body);
        let changed = false;
        const rows = parsed.facts.map(f => {
          const old = candidates.find(c => Number(c.row_num) === f.rowNum && c.fact === f.claim
            && Number(c.next_row) === f.supersededBy);
          if (!old || f.active || f.validUntil) return f;
          const instant = new Date(old.next_from).toISOString();
          changed = true; stamped++;
          return { ...f, validUntil: instant };
        });
        if (changed) next[section] = replaceOrInsertFactsFence(body, renderFactsTable(rows));
      }
      return next;
    });
    if (!stamped) { result.skipped++; continue; }
    if (!opts.dryRun) {
      const content = serializePageToMarkdown(page, snapshot.tags);
      const authority = managed ? await maintenancePreflight(engine, target.source_id) : null;
      const outcome = authority
        ? await publishMaintenancePage(engine, authority, target.slug, content, { expectedRevision: snapshot.revision })
        : await submitPageMutation({ engine, sourceId: target.source_id, remote: false,
            config: loadConfig() ?? { engine: engine.kind }, dryRun: false,
            logger: { info() {}, warn() {}, error() {} } }, { operation: 'put_page', params: {
              slug: target.slug, content, expected_revision: snapshot.revision,
            } });
      if (outcome && ('error' in outcome || outcome.state && outcome.state !== 'committed')) {
        throw opError('write_pending', 'Supersession validity publication has not committed.',
          'Read the maintenance receipt before rerunning consolidate; no current-state proof was issued.');
      }
    }
    result.stamped += stamped; result.pages++;
  }
  return result;
}
