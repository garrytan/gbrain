/**
 * GBRA-130 A-1: the per-page failure record of managed link extraction (`pages.links_extract_failure`, migration v258).
 *
 * Only content-class failures are recorded (a transient one is retried on the next run and never counts). A page that
 * fails with the same code at the same knowledge revision and extractor generation in `LINK_HOLD_THRESHOLD_RUNS`
 * consecutive runs is held: stale extraction skips it (`stalePagesWhere` `held: 'exclude'`) and doctor's
 * `links_extraction_lag` reports it. A held page is retried when it is edited (new revision), when the extractor
 * generation changes, or after `gbrain extract --stale --retry-held` clears the records; publishing its links clears
 * its record with the watermark (`markPagesExtractedBatch`). The counting mirrors connectors/item-holds.ts. The
 * record is a derived column outside the managed writer guard's tracked set, so it is written without coordination.
 */
import type { BrainEngine } from '../engine.ts';
import type { Action } from '../agent-output.ts';
import type { ItemFailureClass } from '../item-failure.ts';
import { sanitizeForJsonb } from '../batch-rows.ts';

/** Consecutive runs failing one page the same way before it is held (as connectors/item-holds.ts HOLD_THRESHOLD_RUNS). */
export const LINK_HOLD_THRESHOLD_RUNS = 3;

export interface LinkExtractionFailure {
  slug: string;
  source_id: string;
  code: string;
  class: ItemFailureClass;
  message: string;
  /** Consecutive runs that failed this page at its revision and generation; 0 for a transient failure (never counted). */
  attempts: number;
  held: boolean;
  fix: Action;
}

/** The command that retries a page: the next plain run for a page not held, `--retry-held` for a held one. */
export function linkExtractionRetryFix(sourceId: string | undefined, held: boolean): Action {
  const scope = sourceId ? ['--source-id', sourceId] : [];
  const which = sourceId ? `source ${sourceId}'s` : 'every source\'s';
  return {
    argv: ['gbrain', 'extract', '--stale', ...scope, ...(held ? ['--retry-held'] : [])], consent: [], actor: 'agent', requires_exclusive: false,
    why: held
      ? `Clears ${which} held link-extraction failures and retries those pages now; it changes no page content. A page that fails the same way again is held again after ${LINK_HOLD_THRESHOLD_RUNS} runs.`
      : `Retries link extraction for ${which} stale pages, the failed ones included; it changes no page content.`,
    verify: { argv: ['gbrain', 'extract', '--stale', '--dry-run', '--json', ...scope] },
    docs: 'docs/guides/troubleshooting.md#symptom-table',
  };
}

/**
 * Counts one run's content failures. `revision` is the knowledge revision the run read (null when the failure came
 * before the read: the page's current revision is used). A page edited since is not recorded. Returns each recorded
 * page's run count and whether it is now held, keyed `source_id\0slug`.
 */
export async function recordLinkExtractionFailures(engine: BrainEngine, generation: string,
  failures: ReadonlyArray<{ slug: string; source_id: string; revision: string | null; code: string; message: string }>): Promise<Map<string, { attempts: number; held: boolean }>> {
  if (!failures.length) return new Map();
  const rows = await engine.executeRaw<{ slug: string; source_id: string; attempts: number; state: string }>(
    `UPDATE pages p SET links_extract_failure = (
       SELECT jsonb_build_object('state', CASE WHEN n.attempts >= $7 THEN 'held' ELSE 'failing' END, 'code', v.code, 'message', v.message,
         'revision', p.knowledge_revision::text, 'generation', $6::text, 'attempts', n.attempts,
         'first_failed_at', CASE WHEN n.attempts > 1 THEN COALESCE(p.links_extract_failure->>'first_failed_at', $8) ELSE $8 END, 'last_failed_at', $8,
         'held_at', CASE WHEN n.attempts >= $7 THEN COALESCE(p.links_extract_failure->>'held_at', $8) END)
       FROM (SELECT CASE WHEN p.links_extract_failure->>'revision' = p.knowledge_revision::text AND p.links_extract_failure->>'generation' = $6::text
         AND p.links_extract_failure->>'code' = v.code THEN COALESCE((p.links_extract_failure->>'attempts')::int, 0) + 1 ELSE 1 END AS attempts) n)
     FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[]) AS v(slug, source_id, revision, code, message)
     WHERE p.slug = v.slug AND p.source_id = v.source_id AND p.deleted_at IS NULL AND p.knowledge_revision::text = COALESCE(v.revision, p.knowledge_revision::text)
     RETURNING p.slug, p.source_id, (p.links_extract_failure->>'attempts')::int AS attempts, p.links_extract_failure->>'state' AS state`,
    [failures.map(f => f.slug), failures.map(f => f.source_id), failures.map(f => f.revision), failures.map(f => f.code),
      failures.map(f => sanitizeForJsonb(f.message)), generation, LINK_HOLD_THRESHOLD_RUNS, new Date().toISOString()]);
  return new Map(rows.map(row => [`${row.source_id}\0${row.slug}`, { attempts: Number(row.attempts), held: row.state === 'held' }]));
}

/** `--retry-held`: drops the failure records (held or still counting) of one source, or of every source. Returns the pages cleared. */
export async function clearLinkExtractionHolds(engine: BrainEngine, sourceId?: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    'UPDATE pages SET links_extract_failure = NULL WHERE links_extract_failure IS NOT NULL AND ($1::text IS NULL OR source_id = $1::text) RETURNING id', [sourceId ?? null]);
  return rows.length;
}
