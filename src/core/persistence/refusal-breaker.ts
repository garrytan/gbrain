/**
 * #6696 (A12): known-failing maintenance writes stop burning quota.
 *
 * A producer that resubmits the same write under a fresh request id after it
 * was refused (an adoption attempt counter, a caller-chosen id) mints one
 * permanent request id and one receipt per cycle. After
 * `persistence.maintenance.refusal_breaker_threshold` (default 3; 0 turns it
 * off) terminal refusals with the same error code in the last 24 hours for
 * the same request digest, the next submission is refused before admission
 * (no request id, no receipt). The digest covers the source, the slug and
 * the producer's intent, which carries the page revision it expects and, for
 * planned writes, the planner version, so any change to those (an edited
 * page, a new planner, different content) releases it at once; otherwise the
 * window is the revalidation: the oldest refusal ages out and one more
 * attempt is admitted. Reads the request journal on its slug index; keeps no
 * state of its own.
 */
import type { BrainEngine } from '../engine.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { Principal } from './model.ts';

export const REFUSAL_BREAKER_THRESHOLD_KEY = 'persistence.maintenance.refusal_breaker_threshold';
export const DEFAULT_REFUSAL_BREAKER_THRESHOLD = 3;
export const REFUSAL_BREAKER_WINDOW_HOURS = 24;

export async function readRefusalBreakerThreshold(engine: Pick<BrainEngine, 'getConfig'>): Promise<number> {
  const raw = await engine.getConfig(REFUSAL_BREAKER_THRESHOLD_KEY);
  const value = raw === null || raw === undefined || raw === '' ? DEFAULT_REFUSAL_BREAKER_THRESHOLD : Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_REFUSAL_BREAKER_THRESHOLD;
}

interface PriorRefusals { count: number; error_code: string; request_id: string; detail_origin: string | null }

/** The same-digest refusals in the window, grouped by code, largest group first. */
async function priorRefusals(engine: BrainEngine, input: { principal: Principal; sourceId: string; slug: string; digest: string }): Promise<PriorRefusals | null> {
  const [row] = await engine.executeRaw<{ count: string; error_code: string; request_id: string; detail_origin: string | null }>(`SELECT count(*)::text AS count,error_code,
      (array_agg(request_id::text ORDER BY sequence DESC))[1] AS request_id,(array_agg(error_detail->>'origin' ORDER BY sequence DESC))[1] AS detail_origin
    FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent IS NOT NULL AND NOT compacted AND digest=$3
      AND principal_kind=$4 AND principal_id=$5 AND state IN ('failed','conflict') AND error_code IS NOT NULL
      AND completed_at > now()-($6::double precision*interval '1 hour')
    GROUP BY error_code ORDER BY count(*) DESC LIMIT 1`, [input.sourceId, input.slug, input.digest, input.principal.kind, input.principal.id, REFUSAL_BREAKER_WINDOW_HOURS]);
  return row ? { count: Number(row.count), error_code: row.error_code, request_id: row.request_id, detail_origin: row.detail_origin } : null;
}

/** Refuses before admission when the breaker is open for this write; returns otherwise. */
export async function assertRefusalBreakerClosed(engine: BrainEngine, input: { principal: Principal; sourceId: string; slug: string; digest: string }): Promise<void> {
  const threshold = await readRefusalBreakerThreshold(engine);
  if (threshold <= 0) return;
  const prior = await priorRefusals(engine, input);
  if (!prior || prior.count < threshold) return;
  throw refusalBreakerError(input.sourceId, input.slug, prior, threshold);
}

function refusalBreakerError(sourceId: string, slug: string, prior: PriorRefusals, threshold: number): OperationError {
  return opError(prior.error_code as Parameters<typeof opError>[0], 'The same maintenance write was already refused repeatedly.',
    `Maintenance submitted nothing for ${slug} in '${sourceId}': the same write was refused ${prior.count} time(s) with ${prior.error_code} in the last ${REFUSAL_BREAKER_WINDOW_HOURS} hours `
    + `(${REFUSAL_BREAKER_THRESHOLD_KEY}=${threshold}), so another attempt would only add a receipt. It is tried again once the page, the planner or the write changes, `
    + `or when the oldest refusal is ${REFUSAL_BREAKER_WINDOW_HOURS} hours old. Read the last refusal with gbrain write-request -- ${prior.request_id} and fix what it names.`,
    { detail: 'refusal_breaker', docs: 'docs/guides/write-refusals.md#refusal_breaker', fix: readFix(`Reads the last refused attempt (request ${prior.request_id}), read-only.`, { argv: ['gbrain', 'write-request', '--', prior.request_id] }) });
}

export interface SuppressedWrite { source_id: string; slug: string; error_code: string; refusals: number; last_request_id: string; cause: string | null; exit: string }

/** Slugs whose maintenance writes the breaker is holding back right now, with the action that releases each (doctor `maintenance_write_drift`). */
export async function listSuppressedWrites(engine: BrainEngine, sourceId: string, limit = 20): Promise<SuppressedWrite[]> {
  const threshold = await readRefusalBreakerThreshold(engine);
  if (threshold <= 0) return [];
  const rows = await engine.executeRaw<{ slug: string; error_code: string; refusals: string; last_request_id: string; cause: string | null }>(`SELECT slug,error_code,
      count(*)::text AS refusals,(array_agg(request_id::text ORDER BY sequence DESC))[1] AS last_request_id,(array_agg(error_detail->>'origin' ORDER BY sequence DESC))[1] AS cause
    FROM persistence_requests WHERE source_id=$1 AND intent IS NOT NULL AND NOT compacted AND operation='submit_job' AND state IN ('failed','conflict')
      AND error_code IS NOT NULL AND completed_at > now()-($2::double precision*interval '1 hour')
    GROUP BY slug,digest,error_code HAVING count(*) >= $3 ORDER BY slug LIMIT $4`, [sourceId, REFUSAL_BREAKER_WINDOW_HOURS, threshold, limit]);
  return rows.map(row => ({ source_id: sourceId, slug: row.slug, error_code: row.error_code, refusals: Number(row.refusals), last_request_id: row.last_request_id, cause: row.cause,
    exit: row.cause === 'canonical_file_missing'
      ? `gbrain sources reconcile ${sourceId} ${row.slug} --brain host --preview (import the deletion or restore the file)`
      : `gbrain write-request -- ${row.last_request_id} (fix what it names; any page, planner or write change releases it)` }));
}
