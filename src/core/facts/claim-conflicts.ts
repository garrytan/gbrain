/**
 * The keyless claim-conflict lane (GBRA-216 PR B). Finds two active facts that
 * state different values of one typed claim for the same entity and as-of
 * bucket, and files each pair as a pending supersede proposal in the existing
 * decide_proposals queue (accept, reject and undo are facts/proposal-supersede.ts).
 *
 * A pair is two active, non-audit facts in one source with the same
 * visibility, the same non-null entity_slug, the same claim_metric, the same
 * claim_unit and claim_period (null-safe), the same as-of bucket
 * (typed-claim.ts claimBucket) and different claim_value. Points in different
 * buckets are history and are never proposed. The newer fact (valid_from, then
 * id) is proposed to supersede the older one.
 *
 * Bounded: at most max_pairs pairs per source per run, and a pair that already
 * has a proposal (any lane, any status) or a pending trust supersede_fact
 * proposal is excluded inside the bounded query, so old pairs never starve new
 * ones. Idempotent across concurrent runs: a partial unique index over this
 * lane's sweep ids (migration v279) keeps one proposal per unordered pair.
 * Writes only proposal rows; it never changes a fact. Keyless, both engines,
 * and every source runs whether or not it has a local path.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import { AUDIT_ROW_SOURCES } from './audit-sources.ts';
import { insertProposal } from '../ai/decide/proposals-store.ts';
import { claimBucketSql } from './typed-claim.ts';
import { CLAIM_CONFLICTS_MAX_PAIRS_KEY, readPhaseConfigNumber } from '../cycle/phase-config-values.ts';

export const CLAIM_CONFLICTS_MODE_KEY = 'dream.claim_conflicts.mode';
export const CLAIM_CONFLICTS_MODES = ['propose', 'off'] as const;
export const CLAIM_CONFLICTS_DEFAULT_MAX_PAIRS = 500;
export const CLAIM_CONFLICTS_SWEEP_PREFIX = 'claim_conflicts:';

export interface ClaimConflictPair {
  new_fact_id: number; old_fact_id: number; entity_slug: string; visibility: string;
  claim_metric: string; claim_unit: string | null; claim_period: string | null; bucket: string;
  new_value: number; old_value: number;
}

export interface ClaimConflictSourceResult {
  source_id: string;
  status: 'complete' | 'partial' | 'failed';
  pairs: ClaimConflictPair[];
  proposals_written: number;
  /** Pairs another run proposed between this run's read and its insert. */
  already_proposed: number;
  /** Pairs past max_pairs, left for the next run. */
  deferred: number;
  error?: string;
}

export interface ClaimConflictRun {
  status: 'complete' | 'partial' | 'failed' | 'skipped';
  detail: string;
  sweep_id: string;
  dry_run: boolean;
  max_pairs: number;
  pairs_found: number;
  proposals_written: number;
  deferred: number;
  sources: ClaimConflictSourceResult[];
  warnings: string[];
}

/** dream.claim_conflicts.mode: propose files proposals each cycle; off (the default, and any other stored value) skips the phase. */
export async function claimConflictsMode(engine: Pick<BrainEngine, 'getConfig'>): Promise<'propose' | 'off'> {
  const raw = (await engine.getConfig(CLAIM_CONFLICTS_MODE_KEY).catch(() => null))?.trim().toLowerCase();
  return raw === 'propose' ? 'propose' : 'off';
}

/** Why value is not a valid dream.claim_conflicts.mode, or null when it is. */
export function claimConflictsModeRefusal(value: string): string | null {
  return (CLAIM_CONFLICTS_MODES as readonly string[]).includes(value.trim().toLowerCase()) ? null
    : CLAIM_CONFLICTS_MODE_KEY + ' must be propose or off; got ' + JSON.stringify(value) + '. Nothing was written.';
}

const ACTIVE_CLAIMS = 'WITH f AS (\n'
  + '  SELECT id, entity_slug, visibility, claim_metric, claim_value, claim_unit, claim_period, valid_from, ' + claimBucketSql('facts') + ' AS bucket\n'
  + '    FROM facts\n'
  + '   WHERE source_id = $1 AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())\n'
  + '     AND entity_slug IS NOT NULL AND claim_metric IS NOT NULL AND claim_value IS NOT NULL AND source <> ALL($2::text[]))';
const PAIR_JOIN = 'FROM f n JOIN f o\n'
  + '    ON o.entity_slug = n.entity_slug AND o.visibility = n.visibility AND o.claim_metric = n.claim_metric\n'
  + '   AND o.claim_unit IS NOT DISTINCT FROM n.claim_unit AND o.claim_period IS NOT DISTINCT FROM n.claim_period\n'
  + '   AND o.bucket = n.bucket AND o.claim_value <> n.claim_value\n'
  + '   AND (o.valid_from < n.valid_from OR (o.valid_from = n.valid_from AND o.id < n.id))\n'
  + ' WHERE NOT EXISTS (SELECT 1 FROM decide_proposals p WHERE p.source_id = $1\n'
  + '         AND LEAST(p.new_fact_id, p.old_fact_id) = LEAST(n.id, o.id) AND GREATEST(p.new_fact_id, p.old_fact_id) = GREATEST(n.id, o.id))\n'
  + '   AND NOT EXISTS (SELECT 1 FROM trust_proposals tp WHERE tp.status = \'pending\' AND tp.action = \'supersede_fact\'\n'
  + '         AND tp.target_table = \'facts\' AND tp.related_table = \'facts\'\n'
  + '         AND ((tp.target_id = o.id AND tp.related_id = n.id) OR (tp.target_id = n.id AND tp.related_id = o.id)))';

function pairsSql(select: string, tail = ''): string {
  return ACTIVE_CLAIMS + '\nSELECT ' + select + '\n' + PAIR_JOIN + tail;
}

/** Unproposed same-bucket claim conflicts in one source, at most limit, oldest new fact first; deferred counts the rest. */
export async function findClaimConflicts(engine: BrainEngine, sourceId: string, limit: number): Promise<{ pairs: ClaimConflictPair[]; deferred: number }> {
  const rows = await engine.executeRaw<Record<string, unknown>>(pairsSql(
    'n.id AS new_fact_id, o.id AS old_fact_id, n.entity_slug, n.visibility, n.claim_metric, n.claim_unit, n.claim_period, n.bucket, n.claim_value AS new_value, o.claim_value AS old_value',
    '\n ORDER BY n.id, o.id\n LIMIT $3'), [sourceId, [...AUDIT_ROW_SOURCES], limit + 1]);
  const pairs = rows.slice(0, limit).map(r => ({
    new_fact_id: Number(r.new_fact_id), old_fact_id: Number(r.old_fact_id), entity_slug: String(r.entity_slug), visibility: String(r.visibility),
    claim_metric: String(r.claim_metric), claim_unit: (r.claim_unit as string | null) ?? null, claim_period: (r.claim_period as string | null) ?? null,
    bucket: String(r.bucket), new_value: Number(r.new_value), old_value: Number(r.old_value),
  }));
  if (rows.length <= limit) return { pairs, deferred: 0 };
  const [count] = await engine.executeRaw<{ n: number | string }>(pairsSql('COUNT(*) AS n'), [sourceId, [...AUDIT_ROW_SOURCES]]);
  return { pairs, deferred: Math.max(0, Number(count?.n ?? 0) - limit) };
}

/**
 * One run over sourceIds (default: every source that is not archived, with or
 * without a local path). dryRun finds pairs and writes nothing.
 */
export async function runClaimConflicts(engine: BrainEngine, opts: { sourceIds?: string[]; dryRun?: boolean } = {}): Promise<ClaimConflictRun> {
  const sweepId = CLAIM_CONFLICTS_SWEEP_PREFIX + randomUUID();
  const knob = await readPhaseConfigNumber(engine, CLAIM_CONFLICTS_MAX_PAIRS_KEY);
  const maxPairs = knob.value ?? CLAIM_CONFLICTS_DEFAULT_MAX_PAIRS;
  const dryRun = opts.dryRun === true;
  const sourceIds = opts.sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE NOT archived ORDER BY id')).map(r => r.id);
  const sources: ClaimConflictSourceResult[] = [];
  let pairIndex = 0;
  for (const sourceId of sourceIds) {
    try {
      const { pairs, deferred } = await findClaimConflicts(engine, sourceId, maxPairs);
      let written = 0;
      if (!dryRun) {
        for (const pair of pairs) {
          const id = await insertProposal(engine, { source_id: sourceId, sweep_id: sweepId, pair_index: pairIndex++, new_fact_id: pair.new_fact_id, old_fact_id: pair.old_fact_id,
            direction: 'new_supersedes_old', p_supersede: 1, threshold: null, proposal_floor: 1, model_resolved: null });
          if (id !== null) written++;
        }
      }
      sources.push({ source_id: sourceId, status: deferred > 0 ? 'partial' : 'complete', pairs, proposals_written: written,
        already_proposed: dryRun ? 0 : pairs.length - written, deferred });
    } catch (error) {
      sources.push({ source_id: sourceId, status: 'failed', pairs: [], proposals_written: 0, already_proposed: 0, deferred: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const pairsFound = sources.reduce((n, s) => n + s.pairs.length, 0);
  const written = sources.reduce((n, s) => n + s.proposals_written, 0);
  const deferred = sources.reduce((n, s) => n + s.deferred, 0);
  const failed = sources.filter(s => s.status === 'failed');
  const status: ClaimConflictRun['status'] = sources.length === 0 ? 'skipped' : failed.length === sources.length ? 'failed'
    : failed.length || sources.some(s => s.status === 'partial') ? 'partial' : 'complete';
  const detail = sources.length === 0 ? 'no active sources'
    : pairsFound + ' pair(s) found, ' + (dryRun ? 'none written (dry run)' : written + ' proposal(s) written') + ', ' + deferred + ' deferred by the cap (max_pairs ' + maxPairs + '), '
      + sources.length + ' source(s)' + (failed.length ? '; failed: ' + failed.map(s => s.source_id + ' (' + s.error + ')').join(', ') : '');
  return { status, detail, sweep_id: sweepId, dry_run: dryRun, max_pairs: maxPairs, pairs_found: pairsFound, proposals_written: written, deferred, sources,
    warnings: knob.warning ? [knob.warning] : [] };
}

/** Cycle adapter: off by default (dream.claim_conflicts.mode); maps the run onto the cycle's PhaseResult (duration filled by the caller). */
export async function claimConflictsCyclePhase(engine: BrainEngine | null, dryRun: boolean): Promise<PhaseResult> {
  if (!engine) return { phase: 'claim_conflicts', status: 'skipped', duration_ms: 0, summary: 'no database connected', details: { reason: 'no_database' } };
  if (await claimConflictsMode(engine) === 'off') {
    return { phase: 'claim_conflicts', status: 'skipped', duration_ms: 0, summary: 'mode off (' + CLAIM_CONFLICTS_MODE_KEY + ', default off)', details: { reason: 'mode_off' } };
  }
  const r = await runClaimConflicts(engine, { dryRun });
  const status: PhaseResult['status'] = r.status === 'complete' ? 'ok' : r.status === 'partial' ? 'warn' : r.status === 'failed' ? 'fail' : 'skipped';
  return { phase: 'claim_conflicts', status, duration_ms: 0, summary: r.detail,
    details: { pairs_found: r.pairs_found, proposals_written: r.proposals_written, deferred: r.deferred, sources: r.sources.length, sweep_id: r.sweep_id,
      ...(r.warnings.length ? { warnings: r.warnings } : {}) } };
}
