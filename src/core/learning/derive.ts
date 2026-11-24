/**
 * Nightly learning PR 1: the learning_derive cycle phase. One pass at the end of each cycle that records a pointer in
 * learning_items (learning/schema.ts) for every new thing the brain learned or wants to ask, read from tables that
 * already record what changed. It touches no phase code and copies no text: the learned read view (read.ts) renders
 * each pointer from its live target.
 *
 *   fact_added      machine-extracted facts (facts.source names an extractor) created in the window
 *   you_wrote       facts reconciled from a Facts fence row with no source cell (fence:reconcile); shown, never counted
 *   conflict_found  pending claim_conflicts proposals created in the window; older proposals stay a count
 *   page_filled     pages enrich wrote in the window, pointing at the page version that holds the prior revision
 *   promise_found   open loops of kind commitment_owed_to_me created in the window
 *   duplicate_to_confirm  the top five person groups of the dedupe preview, by owner contact (duplicates.ts)
 *
 * On a keyless brain whose owner resolves it also counts the thin pages the owner has recent contact with
 * (keylessThinContacts) into KEYLESS_THIN_CONTACTS_KEY, so learned can say a chat key would fill them; otherwise the
 * key is cleared.
 *
 * The window starts an hour before the previous pass (learning.derive.watermark), at most seven days back. Each kind
 * inserts at most MAX_PER_KIND rows per pass; a truncated pass keeps the old watermark, so the next pass continues.
 * Idempotent on the (kind, target_table, target_id) key. Never throws: a failure is a `warn` result, so it never fails
 * the cycle. A pending or expired pointer whose target row is gone (a purge) is pruned; a decided one stays for stats.
 */

import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { hasCapability } from '../engine-capabilities.ts';
import { AUDIT_ROW_SOURCES, CONVERSATION_FACTS_SOURCE_PREFIX } from '../facts/audit-sources.ts';
import { FENCE_SOURCE_DEFAULT } from '../facts/extract-from-fence.ts';
import { ENRICHED_BY } from '../../commands/enrich.ts';
import { CLAIM_CONFLICT_SWEEP_SQL, CONFLICT_BACKLOG_SQL, KEYLESS_THIN_CONTACTS_KEY, LEARNING_KINDS, learningTablePresent, notRecordedSql, type LearningKind } from './kinds.ts';
import { rethrowCapabilityRefusal } from '../engine-capability-refusal.ts';
import { recordDuplicateQuestions } from './duplicates.ts';
import { keylessThinContacts } from '../cycle/enrich-thin.ts';

export const LEARNING_WATERMARK_KEY = 'learning.derive.watermark';
export const LEARNING_WINDOW_MAX_MS = 7 * 86_400_000;
const WINDOW_OVERLAP_MS = 3_600_000;
export const MAX_PER_KIND = 500;

const list = (values: readonly string[]) => values.map(v => `'${v}'`).join(', ');
/** Fact sources the machine extractors write: extract_facts (the facts drain writes through it) and the conversation-facts backfill. */
const MACHINE_FACT_SQL = `(f.source = 'mcp:extract_facts' OR (f.source LIKE '${CONVERSATION_FACTS_SOURCE_PREFIX}%' AND f.source NOT IN (${list(AUDIT_ROW_SOURCES)})))`;
const FENCE_FACT_SQL = `f.source = '${FENCE_SOURCE_DEFAULT}'`;
const ENRICHED_AT = `p.frontmatter->>'enriched_at'`;
const ENRICHED_AT_SQL = `CASE WHEN ${ENRICHED_AT} ~ '^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?Z$'
  THEN CASE WHEN substr(${ENRICHED_AT}, 9, 2)::int <= extract(day FROM (substr(${ENRICHED_AT}, 1, 7) || '-01')::date + interval '1 month' - interval '1 day')
  THEN (${ENRICHED_AT})::timestamptz END END`;

/** One SELECT per kind, each yielding the pointer columns. $1 = window start, $2 = row cap. */
const PRODUCERS: Array<{ kinds: LearningKind[]; select: string }> = [
  { kinds: ['fact_added', 'you_wrote'], select: `
    SELECT f.source_id, CASE WHEN ${FENCE_FACT_SQL} THEN 'you_wrote' ELSE 'fact_added' END AS kind, 'facts' AS target_table, f.id AS target_id,
           f.entity_slug AS subject_slug, f.source_id AS subject_source_id, NULL::text AS prior_revision
      FROM facts f
     WHERE f.created_at >= $1::timestamptz AND f.expired_at IS NULL AND (${FENCE_FACT_SQL} OR ${MACHINE_FACT_SQL})
       AND ${notRecordedSql("'fact_added', 'you_wrote'", 'facts', 'f.id')}
     ORDER BY f.id LIMIT $2` },
  { kinds: ['conflict_found'], select: `
    SELECT d.source_id, 'conflict_found' AS kind, 'decide_proposals' AS target_table, d.id AS target_id,
           n.entity_slug AS subject_slug, d.source_id AS subject_source_id, NULL::text AS prior_revision
      FROM decide_proposals d JOIN facts n ON n.id = d.new_fact_id AND n.source_id = d.source_id
     WHERE ${CLAIM_CONFLICT_SWEEP_SQL} AND d.status = 'pending' AND d.created_at >= $1::timestamptz
       AND EXISTS (SELECT 1 FROM sources s WHERE s.id = d.source_id)
       AND ${notRecordedSql("'conflict_found'", 'decide_proposals', 'd.id')}
     ORDER BY d.id LIMIT $2` },
  { kinds: ['page_filled'], select: `
    SELECT p.source_id, 'page_filled' AS kind, 'page_versions' AS target_table, v.id AS target_id,
           p.slug AS subject_slug, p.source_id AS subject_source_id, v.knowledge_revision::text AS prior_revision
      FROM pages p
      JOIN LATERAL (SELECT pv.id, pv.knowledge_revision FROM page_versions pv
                     WHERE pv.page_id = p.id AND pv.frontmatter->>'enriched_at' IS DISTINCT FROM p.frontmatter->>'enriched_at'
                       AND pv.snapshot_at >= ${ENRICHED_AT_SQL} - interval '5 minutes'
                     ORDER BY pv.id DESC LIMIT 1) v ON TRUE
     WHERE p.updated_at >= $1::timestamptz AND p.deleted_at IS NULL AND p.frontmatter->>'enriched_by' = '${ENRICHED_BY}'
       AND ${ENRICHED_AT_SQL} >= $1::timestamptz
       AND ${notRecordedSql("'page_filled'", 'page_versions', 'v.id')}
     ORDER BY v.id LIMIT $2` },
  { kinds: ['promise_found'], select: `
    SELECT l.source_id, 'promise_found' AS kind, 'open_loops' AS target_table, l.id AS target_id,
           l.counterparty_slug AS subject_slug, l.source_id AS subject_source_id, NULL::text AS prior_revision
      FROM open_loops l
     WHERE l.loop_type = 'commitment_owed_to_me' AND l.status = 'open' AND l.created_at >= $1::timestamptz
       AND ${notRecordedSql("'promise_found'", 'open_loops', 'l.id')}
     ORDER BY l.id LIMIT $2` },
];

const PRUNE_SQL = `DELETE FROM learning_items li WHERE li.state IN ('pending', 'expired') AND (
     (li.target_table = 'facts' AND NOT EXISTS (SELECT 1 FROM facts t WHERE t.id = li.target_id))
  OR (li.target_table = 'decide_proposals' AND NOT EXISTS (SELECT 1 FROM decide_proposals t WHERE t.id = li.target_id))
  OR (li.target_table = 'open_loops' AND NOT EXISTS (SELECT 1 FROM open_loops t WHERE t.id = li.target_id))
  OR (li.target_table = 'page_versions' AND NOT EXISTS (SELECT 1 FROM page_versions t WHERE t.id = li.target_id))
  OR (li.target_table = 'pages' AND NOT EXISTS (SELECT 1 FROM pages t WHERE t.id = li.target_id)))
  RETURNING li.id`;

/** The learning_derive phase. `runId` is the cycle's run id (src/core/cycle.ts mints one per cycle). */
export async function runPhaseLearningDerive(engine: BrainEngine, opts: { runId: string; dryRun: boolean; now?: Date; maxPerKind?: number }): Promise<PhaseResult> {
  const cap = opts.maxPerKind ?? MAX_PER_KIND;
  const skipped = (reason: string, summary: string): PhaseResult =>
    ({ phase: 'learning_derive', status: 'skipped', duration_ms: 0, summary, details: { reason, run_id: opts.runId } });
  if (!hasCapability(engine, 'raw_sql')) return skipped('engine_capability_missing', "skipped: this brain's engine has no learning ledger yet");
  try {
    if (!await learningTablePresent(engine)) return skipped('learning_table_missing', 'skipped: the learning_items table is missing (run gbrain apply-migrations)');
    const now = opts.now ?? new Date();
    const watermark = Date.parse(await engine.getConfig(LEARNING_WATERMARK_KEY) ?? '');
    const floor = now.getTime() - LEARNING_WINDOW_MAX_MS;
    const since = new Date(Number.isFinite(watermark) ? Math.max(watermark - WINDOW_OVERLAP_MS, floor) : floor).toISOString();
    const counts: Record<string, number> = Object.fromEntries(LEARNING_KINDS.filter(k => k !== 'duplicate_to_confirm').map(k => [k, 0]));
    const truncated: LearningKind[] = [];
    const failed: Array<{ kinds: LearningKind[]; error: string }> = [];
    for (const producer of PRODUCERS) {
      let rows: Array<{ kind: string }>;
      try {
        rows = opts.dryRun
          ? await engine.executeRaw<{ kind: string }>(`SELECT kind FROM (${producer.select}) c`, [since, cap])
          : await engine.executeRaw<{ kind: string }>(`INSERT INTO learning_items (run_id, source_id, kind, target_table, target_id, subject_slug, subject_source_id, prior_revision)
              SELECT $3::uuid, c.source_id, c.kind, c.target_table, c.target_id, c.subject_slug, c.subject_source_id, c.prior_revision FROM (${producer.select}) c
              ON CONFLICT (kind, target_table, target_id) DO NOTHING RETURNING kind`, [since, cap, opts.runId]);
      } catch (e) {
        rethrowCapabilityRefusal(e);
        failed.push({ kinds: producer.kinds, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      for (const r of rows) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
      if (rows.length >= cap) truncated.push(...producer.kinds);
    }
    const [backlog] = await engine.executeRaw<{ n: number | string }>(CONFLICT_BACKLOG_SQL, [null]);
    const pruned = opts.dryRun ? 0 : (await engine.executeRaw(PRUNE_SQL)).length;
    if (!opts.dryRun && truncated.length === 0 && failed.length === 0) await engine.setConfig(LEARNING_WATERMARK_KEY, now.toISOString());
    let duplicates: Awaited<ReturnType<typeof recordDuplicateQuestions>> | undefined;
    try {
      duplicates = await recordDuplicateQuestions(engine, opts);
    } catch (e) {
      rethrowCapabilityRefusal(e);
      failed.push({ kinds: ['duplicate_to_confirm'], error: e instanceof Error ? e.message : String(e) });
    }
    let thinContacts: Awaited<ReturnType<typeof keylessThinContacts>> = null;
    try {
      thinContacts = await keylessThinContacts(engine);
      if (!opts.dryRun) {
        if (thinContacts?.count) await engine.setConfig(KEYLESS_THIN_CONTACTS_KEY, JSON.stringify({ ...thinContacts, recorded_at: now.toISOString() }));
        else await engine.unsetConfig(KEYLESS_THIN_CONTACTS_KEY);
      }
    } catch (e) {
      rethrowCapabilityRefusal(e);
      console.warn('[learning_derive] the keyless thin-contact count was not updated: ' + (e instanceof Error ? e.message : String(e)));
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const conflictBacklog = Number(backlog?.n ?? 0);
    for (const f of failed) console.warn(`[learning_derive] ${f.kinds.join('/')} not recorded this pass: ${f.error}`);
    return {
      phase: 'learning_derive', status: failed.length ? 'warn' : 'ok', duration_ms: 0,
      summary: `${opts.dryRun ? 'dry-run: would record' : 'recorded'} ${total} learning item(s)${duplicates?.recorded ? ` and ${duplicates.recorded} possible duplicate person group(s) to confirm` : ''}${conflictBacklog ? `; ${conflictBacklog} older claim conflict(s) wait as a count` : ''}${failed.length ? `; not recorded: ${failed.flatMap(f => f.kinds).join(', ')}` : ''}`,
      details: { run_id: opts.runId, since, dry_run: opts.dryRun, recorded: counts, conflict_backlog: conflictBacklog, pruned, truncated, ...(duplicates ? { duplicates } : {}), ...(thinContacts ? { thin_contacts: thinContacts } : {}), ...(failed.length ? { failed } : {}) },
    };
  } catch (e) {
    rethrowCapabilityRefusal(e);
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[learning_derive] the learning ledger was not updated this pass: ${message}`);
    return { phase: 'learning_derive', status: 'warn', duration_ms: 0, summary: `learning ledger not updated: ${message}`, details: { run_id: opts.runId, error: message } };
  }
}
