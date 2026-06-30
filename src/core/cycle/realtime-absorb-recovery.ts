/**
 * Cycle phase `realtime_absorb_recovery`.
 *
 * Closes the durability hole in the real-time facts pipeline. When a page
 * is written, `runFactsBackstop` (queue mode) enqueues LLM extraction as
 * fire-and-forget on the in-memory `FactsQueue`. If the writing process
 * exits before that settles, `background-work` shutdown aborts the in-flight
 * chat call — the page persists but its facts are never extracted, and
 * nothing retries. The aborted/failed attempt DOES leave a durable trace:
 * `runFactsBackstop`'s queue worker writes a `facts:absorb` failure row to
 * `ingest_log` (see facts/absorb-log.ts). This phase treats those rows as a
 * durable backlog.
 *
 * Why this phase and not `conversation_facts_backfill`: the backfill only
 * recovers pages whose body segments into `Speaker (ISO): text` messages.
 * Narrative pages (e.g. a Fireflies meeting stored as an Overview + action
 * items summary) yield zero segments there and are never recovered. The
 * real-time path extracts from `compiled_truth` directly, so re-running it
 * inline recovers exactly those pages.
 *
 * Cursor-only-on-confirmed-write: a `facts:absorb` failure row stays in the
 * backlog until extraction is re-run successfully, at which point a
 * `facts:absorb-recovered` tombstone row is appended (same source_ref). A
 * per-page failure during recovery leaves the row un-tombstoned, so it is
 * retried next cycle. Re-running uses INLINE mode, which carries the 0.95
 * cosine dedup (facts/backstop.ts) — idempotent, no duplicate rows.
 *
 * Safety bounds (the autoplan review flagged exactly these for default-ON
 * LLM phases): the backlog is FAILED absorbs only (small), and the phase is
 * additionally bounded by an explicit per-cycle page cap, a cost cap via a
 * brain-wide BudgetTracker, and a walltime deadline checked between pages
 * that sits well under the autopilot job timeout (~600s). All three are
 * config-overridable.
 *
 * Config keys (defaults explicit):
 *   cycle.realtime_absorb_recovery.enabled          (true — this is the recovery net)
 *   cycle.realtime_absorb_recovery.max_pages         (25)
 *   cycle.realtime_absorb_recovery.max_cost_usd      (0.25)
 *   cycle.realtime_absorb_recovery.deadline_seconds  (240)
 */

import type { BrainEngine } from '../engine.ts';
import { BudgetTracker, BudgetExhausted } from '../budget/budget-tracker.ts';
import { withBudgetTracker } from '../ai/gateway.ts';
import { listSources } from '../sources-ops.ts';
import { runFactsBackstop } from '../facts/backstop.ts';

const CFG_PREFIX = 'cycle.realtime_absorb_recovery';

/** ingest_log source_type written by writeFactsAbsorbLog for failures. */
const ABSORB_FAILURE_TYPE = 'facts:absorb';
/** Tombstone source_type this phase appends on confirmed recovery. */
const ABSORB_RECOVERED_TYPE = 'facts:absorb-recovered';

export interface RealtimeAbsorbRecoveryPhaseOpts {
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface RealtimeAbsorbRecoveryPhaseResult {
  phase: 'realtime_absorb_recovery';
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  duration_ms: number;
  summary: string;
  details: Record<string, unknown>;
}

interface ResolvedConfig {
  enabled: boolean;
  maxPages: number;
  maxCostUsd: number;
  deadlineMs: number;
}

async function loadCfg(engine: BrainEngine): Promise<ResolvedConfig> {
  const get = (k: string) => engine.getConfig(`${CFG_PREFIX}.${k}`);
  const [enabled, maxPages, maxCost, deadline] = await Promise.all([
    get('enabled'),
    get('max_pages'),
    get('max_cost_usd'),
    get('deadline_seconds'),
  ]);

  // Truthy-string parse mirrors isFactsExtractionEnabled. Default ON: unset
  // (null) → enabled. Only an explicit false/0/no/off disables.
  const enabledFlag = (() => {
    if (enabled == null) return true;
    const v = enabled.trim().toLowerCase();
    return !['false', '0', 'no', 'off', ''].includes(v);
  })();

  const intOrDefault = (raw: string | null, fallback: number): number => {
    if (raw == null) return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const floatOrDefault = (raw: string | null, fallback: number): number => {
    if (raw == null) return fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };

  return {
    enabled: enabledFlag,
    maxPages: intOrDefault(maxPages, 25),
    maxCostUsd: floatOrDefault(maxCost, 0.25),
    deadlineMs: intOrDefault(deadline, 240) * 1000,
  };
}

/**
 * Unresolved `facts:absorb` failures for a source: the latest failure per
 * page slug that has no `facts:absorb-recovered` tombstone at-or-after it.
 * Portable SQL (PGLite + Postgres): plain NOT EXISTS + GROUP BY, no engine
 * method, so no engine-parity surface.
 */
async function loadBacklog(
  engine: BrainEngine,
  sourceId: string,
  limit: number,
): Promise<string[]> {
  const rows = await engine.executeRaw<{ source_ref: string }>(
    `SELECT f.source_ref
       FROM ingest_log f
      WHERE f.source_type = $1
        AND f.source_id = $2
        AND NOT EXISTS (
          SELECT 1 FROM ingest_log r
           WHERE r.source_type = $3
             AND r.source_id = f.source_id
             AND r.source_ref = f.source_ref
             AND r.created_at >= f.created_at
        )
      GROUP BY f.source_ref
      ORDER BY MAX(f.created_at) ASC
      LIMIT $4`,
    [ABSORB_FAILURE_TYPE, sourceId, ABSORB_RECOVERED_TYPE, limit],
  );
  return rows.map((r) => r.source_ref);
}

async function tombstone(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  summary: string,
): Promise<void> {
  await engine.logIngest({
    source_id: sourceId,
    source_type: ABSORB_RECOVERED_TYPE,
    source_ref: slug,
    pages_updated: [slug],
    summary,
  });
}

export async function runPhaseRealtimeAbsorbRecovery(
  engine: BrainEngine,
  opts: RealtimeAbsorbRecoveryPhaseOpts = {},
): Promise<RealtimeAbsorbRecoveryPhaseResult> {
  const startedAt = Date.now();
  const cfg = await loadCfg(engine);

  if (!cfg.enabled) {
    return {
      phase: 'realtime_absorb_recovery',
      status: 'skipped',
      duration_ms: 0,
      summary: 'cycle.realtime_absorb_recovery.enabled=false',
      details: {
        reason: 'disabled',
        enable_hint: 'gbrain config set cycle.realtime_absorb_recovery.enabled true',
      },
    };
  }

  // Graceful degradation: a very old brain may predate the `sources` /
  // `ingest_log` tables. Don't fail the whole cycle — skip this phase.
  let sources: Awaited<ReturnType<typeof listSources>>;
  try {
    sources = await listSources(engine);
  } catch (err) {
    return {
      phase: 'realtime_absorb_recovery',
      status: 'skipped',
      duration_ms: Date.now() - startedAt,
      summary: `sources unavailable: ${(err as Error).message.slice(0, 120)}`,
      details: { reason: 'sources_unavailable' },
    };
  }
  if (sources.length === 0) {
    return {
      phase: 'realtime_absorb_recovery',
      status: 'ok',
      duration_ms: Date.now() - startedAt,
      summary: 'no sources to process',
      details: { sources_count: 0 },
    };
  }

  let recovered = 0;
  let factsInserted = 0;
  let pagesGone = 0;
  let pagesIneligible = 0;
  let attempted = 0;
  let deadlineHit = false;
  let budgetHit = false;
  let extractionDisabled = false;
  const errors: string[] = [];

  const tracker = new BudgetTracker({
    maxCostUsd: cfg.maxCostUsd,
    label: 'realtime_absorb_recovery:brain-wide',
  });

  try {
    await withBudgetTracker(tracker, async () => {
      outer: for (const src of sources) {
        const backlog = await loadBacklog(engine, src.id, cfg.maxPages);
        for (const slug of backlog) {
          if (opts.signal?.aborted) throw new Error('aborted');
          if (Date.now() - startedAt > cfg.deadlineMs) { deadlineHit = true; break outer; }
          if (attempted >= cfg.maxPages) { break outer; }
          attempted++;

          const page = await engine.getPage(slug, { sourceId: src.id });
          if (!page) {
            // Page deleted since the failure — tombstone so we don't retry
            // a slug that can never produce facts.
            if (!opts.dryRun) await tombstone(engine, src.id, slug, 'recovered: page gone (no retry)');
            pagesGone++;
            continue;
          }
          if (opts.dryRun) { continue; }

          try {
            const res = await runFactsBackstop(
              {
                slug,
                type: page.type,
                compiled_truth: page.compiled_truth ?? '',
                frontmatter: page.frontmatter ?? {},
              },
              {
                engine,
                sourceId: src.id,
                sessionId: null,
                source: 'mcp:put_page',
                mode: 'inline',
                abortSignal: opts.signal,
              },
            );

            if (res.mode === 'inline') {
              if (res.skipped === 'extraction_disabled') {
                // Brain-wide kill switch is on. Leave the row un-tombstoned
                // (recover when re-enabled) and stop — no source will work.
                extractionDisabled = true;
                break outer;
              }
              // eligibility_failed (page type not eligible) is permanent —
              // tombstone so it leaves the backlog. inserted/dup is success.
              factsInserted += res.inserted ?? 0;
              if (res.skipped && res.skipped.startsWith('eligibility_failed')) {
                pagesIneligible++;
                await tombstone(engine, src.id, slug, `recovered: ineligible (${res.skipped})`);
              } else {
                recovered++;
                await tombstone(
                  engine,
                  src.id,
                  slug,
                  `recovered: inserted ${res.inserted}, dup ${res.duplicate}, superseded ${res.superseded}`,
                );
              }
            }
          } catch (err) {
            if (err instanceof BudgetExhausted) { budgetHit = true; break outer; }
            if ((err as Error).message === 'aborted' || opts.signal?.aborted) throw err;
            // Per-page failure: leave un-tombstoned so it retries next cycle.
            errors.push(`${slug}: ${(err as Error).message}`);
          }
        }
      }
    });
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      budgetHit = true;
    } else if ((err as Error).message === 'aborted' || opts.signal?.aborted) {
      throw err;
    } else {
      return {
        phase: 'realtime_absorb_recovery',
        status: 'fail',
        duration_ms: Date.now() - startedAt,
        summary: `recovery loop failed: ${(err as Error).message}`,
        details: { error: (err as Error).message, recovered, attempted },
      };
    }
  }

  const status: RealtimeAbsorbRecoveryPhaseResult['status'] = errors.length > 0 ? 'warn' : 'ok';
  const summary =
    `recovered ${recovered} page(s) (${factsInserted} facts), ` +
    `${pagesGone} gone, ${pagesIneligible} ineligible, ${attempted} attempted, ` +
    `~$${tracker.totalSpent.toFixed(4)}` +
    (deadlineHit ? ' [deadline]' : '') +
    (budgetHit ? ' [budget]' : '') +
    (extractionDisabled ? ' [extraction-disabled]' : '');

  return {
    phase: 'realtime_absorb_recovery',
    status,
    duration_ms: Date.now() - startedAt,
    summary,
    details: {
      sources_count: sources.length,
      recovered,
      facts_inserted: factsInserted,
      pages_gone: pagesGone,
      pages_ineligible: pagesIneligible,
      attempted,
      deadline_hit: deadlineHit,
      budget_hit: budgetHit,
      extraction_disabled: extractionDisabled,
      spent_usd: tracker.totalSpent,
      errors: errors.slice(0, 10),
      max_pages: cfg.maxPages,
      max_cost_usd: cfg.maxCostUsd,
      deadline_seconds: cfg.deadlineMs / 1000,
    },
  };
}
