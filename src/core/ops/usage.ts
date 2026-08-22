/**
 * Usage accounting op cluster (#4218, revives the #3392 shape).
 *
 * `get_usage` reads the chat_usage_log ledger (migration v140) that
 * gateway.chat() fills at its success boundary via the chat-usage sink.
 * Aggregates only — no raw rows — so the surface exposes spend/volume, never
 * content. The `coverage` block is the honesty contract: it states exactly
 * what the ledger does and does not capture so a consumer can't mistake a
 * partial ledger for total spend.
 *
 * Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';

interface UsageRow {
  model: string;
  phase: string | null;
  calls: number | string;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cache_read_tokens: number | string | null;
  cache_write_tokens: number | string | null;
  cost_usd: number | string | null;
  unpriced_calls: number | string | null;
}

const n = (v: number | string | null | undefined): number => Number(v ?? 0);

const get_usage: Operation = {
  name: 'get_usage',
  description:
    'Aggregate chat usage + cost from the chat_usage_log ledger (per-model and per-phase token counts, cache reads/writes, USD estimates) with explicit coverage fields.',
  params: {
    days: { type: 'number', description: 'Window in days (default 30, max 365).' },
  },
  // admin, not read: chat_usage_log has no source dimension, so this is the
  // one read-side surface that CANNOT route through sourceScopeOpts — a
  // source-restricted/federated read token must not see brain-wide spend
  // telemetry (models, job-phase names, USD totals). OP_AREAS already groups
  // it under admin.
  scope: 'admin',
  handler: async (ctx, p) => {
    const daysRaw = Number(p.days ?? 30);
    const days = Number.isFinite(daysRaw) ? Math.min(365, Math.max(1, Math.round(daysRaw))) : 30;

    let rows: UsageRow[] = [];
    let loggedSince: string | null = null;
    let tableMissing = false;
    try {
      rows = await ctx.engine.executeRaw<UsageRow>(
        `SELECT model,
                phase,
                count(*)::int                                        AS calls,
                sum(input_tokens)::float8                            AS input_tokens,
                sum(output_tokens)::float8                           AS output_tokens,
                sum(cache_read_tokens)::float8                       AS cache_read_tokens,
                sum(cache_write_tokens)::float8                      AS cache_write_tokens,
                sum(cost_usd)::float8                                AS cost_usd,
                count(*) FILTER (WHERE cost_usd IS NULL)::int        AS unpriced_calls
         FROM chat_usage_log
         WHERE created_at >= now() - make_interval(days => $1)
         GROUP BY model, phase
         ORDER BY sum(cost_usd) DESC NULLS LAST`,
        [days],
      );
      const since = await ctx.engine.executeRaw<{ since: string | null }>(
        `SELECT min(created_at)::text AS since FROM chat_usage_log`,
        [],
      );
      loggedSince = since[0]?.since ?? null;
    } catch {
      // Pre-v136 brain (table absent). Report empty with coverage saying so
      // rather than erroring — the op is a read surface, not a migration gate.
      tableMissing = true;
    }

    const totals = {
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      /** Sum over PRICED calls only — see coverage.unpriced_calls. */
      cost_usd: 0,
    };
    const byModel = new Map<
      string,
      {
        model: string;
        calls: number;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        cost_usd: number | null;
        unpriced_calls: number;
      }
    >();
    const byPhase = new Map<string, { phase: string; calls: number; cost_usd: number }>();
    let unpricedCalls = 0;

    for (const r of rows) {
      const calls = n(r.calls);
      const rowUnpriced = n(r.unpriced_calls);
      totals.calls += calls;
      totals.input_tokens += n(r.input_tokens);
      totals.output_tokens += n(r.output_tokens);
      totals.cache_read_tokens += n(r.cache_read_tokens);
      totals.cache_write_tokens += n(r.cache_write_tokens);
      totals.cost_usd += n(r.cost_usd);
      unpricedCalls += rowUnpriced;

      const m = byModel.get(r.model) ?? {
        model: r.model,
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: null as number | null,
        unpriced_calls: 0,
      };
      m.calls += calls;
      m.input_tokens += n(r.input_tokens);
      m.output_tokens += n(r.output_tokens);
      m.cache_read_tokens += n(r.cache_read_tokens);
      m.cache_write_tokens += n(r.cache_write_tokens);
      if (r.cost_usd != null) m.cost_usd = (m.cost_usd ?? 0) + n(r.cost_usd);
      m.unpriced_calls += rowUnpriced;
      byModel.set(r.model, m);

      const phaseKey = r.phase ?? 'direct';
      const ph = byPhase.get(phaseKey) ?? { phase: phaseKey, calls: 0, cost_usd: 0 };
      ph.calls += calls;
      ph.cost_usd += n(r.cost_usd);
      byPhase.set(phaseKey, ph);
    }

    return {
      window_days: days,
      totals: { ...totals, cost_usd: Math.round(totals.cost_usd * 1e6) / 1e6 },
      by_model: [...byModel.values()].sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0)),
      by_phase: [...byPhase.values()].sort((a, b) => b.cost_usd - a.cost_usd),
      // Explicit coverage fields (#4218): state what the ledger captures so a
      // consumer never mistakes a partial ledger for total spend.
      coverage: {
        source: 'gateway.chat',
        /** Earliest ledger row; calls before this (or pre-v136) are invisible. */
        logged_since: loggedSince,
        table_present: !tableMissing,
        priced_calls: totals.calls - unpricedCalls,
        /** Calls whose model had no CANONICAL_PRICING entry — tokens counted, dollars unknown. */
        unpriced_calls: unpricedCalls,
        not_covered: [
          'failed chat calls (budget-tracker owns pessimistic in-flight spend)',
          'subagent raw-SDK calls',
          'embeddings (embedding-pricing.ts unit)',
          'calls made before migration v140 / sink registration',
        ],
      },
    };
  },
};

export const usageOperations: Operation[] = [get_usage];
