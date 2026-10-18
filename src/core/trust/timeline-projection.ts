/**
 * #5575 I2: timeline rows parsed from a page's own timeline (`gbrain extract`
 * timeline walks) are a deterministic projection of that page: each row takes
 * its page's stored tier, capped at operator_curated. Rows of pages with
 * different tiers commit in separate attributed maintenance transactions, so
 * a batch never mixes tiers. Each row passes the write gate at its tier (an
 * owner page never runs it): a quarantined or rejected row is skipped (timeline
 * rows have no hold store), a flagged row gets its receipt.
 */
import type { BatchOpts, BrainEngine, TimelineBatchInput } from '../engine.ts';
import type { TimelineInput } from '../types.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { derivedWriteTrust } from './taint.ts';
import { storedTrustTier, type TaintInput, type TrustTier } from './tier.ts';
import { derivedGateConfig, derivedGateInput, recordTimelineFlag, timelineRowAllowed } from './derived-gate.ts';
import { assessTimelineForGate } from '../write-gate.ts';

const CHANNEL = 'derive:timeline';

async function pageInputs(engine: BrainEngine, refs: Array<{ source_id: string; slug: string }>): Promise<Map<string, TaintInput>> {
  const rows = await engine.executeRaw<{ id: number | string; source_id: string; slug: string; trust_tier: string | null }>(
    `SELECT p.id,p.source_id,p.slug,p.trust_tier FROM pages p
      JOIN jsonb_to_recordset($1::text::jsonb) AS r(source_id text,slug text) ON p.source_id=r.source_id AND p.slug=r.slug`,
    [JSON.stringify(refs)]);
  return new Map(rows.map(row => [`${row.source_id}:${row.slug}`, { table: 'pages', id: Number(row.id), tier: storedTrustTier(row.trust_tier) }]));
}

/** addTimelineEntriesBatch, stamped per page tier. Returns the rows inserted. */
export async function addProjectedTimelineBatch(engine: BrainEngine, rows: TimelineBatchInput[], opts?: BatchOpts): Promise<number> {
  if (!rows.length) return 0;
  const key = (row: TimelineBatchInput) => `${row.source_id ?? 'default'}:${row.slug}`;
  const refs = [...new Map(rows.map(row => [key(row), { source_id: row.source_id ?? 'default', slug: row.slug }])).values()];
  const inputs = await pageInputs(engine, refs);
  const groups = new Map<TrustTier, { rows: TimelineBatchInput[]; inputs: Map<string, TaintInput> }>();
  for (const row of rows) {
    const input = inputs.get(key(row));
    const tier = input?.tier ?? 'unknown';
    let group = groups.get(tier);
    if (!group) groups.set(tier, group = { rows: [], inputs: new Map() });
    group.rows.push(row);
    if (input) group.inputs.set(key(row), input);
  }
  const cfg = await derivedGateConfig(engine);
  let inserted = 0;
  for (const group of groups.values()) {
    const trust = derivedWriteTrust({ channel: CHANNEL, inputs: [...group.inputs.values()], projection: true });
    const kept = group.rows.map(row => ({ row, assessment: assessTimelineForGate(row, derivedGateInput(trust), cfg) })).filter(r => timelineRowAllowed(r.assessment));
    if (!kept.length) continue;
    inserted += await maintenanceTransaction(engine, async tx => {
      const count = await tx.addTimelineEntriesBatch(kept.map(r => r.row), opts);
      for (const r of kept) await recordTimelineFlag(tx, r.assessment, r.row);
      return count;
    }, trust);
  }
  return inserted;
}

/** addTimelineEntry for one row of `slug`'s own timeline, stamped with the page's tier. */
export async function addProjectedTimelineEntry(engine: BrainEngine, slug: string,
  entry: TimelineInput, opts?: { sourceId?: string }): Promise<boolean> {
  const input = (await pageInputs(engine, [{ source_id: opts?.sourceId ?? 'default', slug }])).get(`${opts?.sourceId ?? 'default'}:${slug}`);
  const trust = derivedWriteTrust({ channel: CHANNEL, inputs: input ? [input] : [], projection: true });
  const assessment = assessTimelineForGate(entry, derivedGateInput(trust), await derivedGateConfig(engine));
  if (!timelineRowAllowed(assessment)) return false;
  return maintenanceTransaction(engine, async tx => {
    const added = await tx.addTimelineEntry(slug, entry, opts); // gbrain-allow-direct-insert: gbrain extract single-row fallback for timeline entries, stamped with the page tier
    if (added) await recordTimelineFlag(tx, assessment, { slug, source_id: opts?.sourceId, date: entry.date, summary: entry.summary, source: entry.source });
    return added;
  }, trust);
}
