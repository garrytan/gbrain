/**
 * One fixture through the production Tier 3 path (#6188 T4).
 *
 * The fixture page becomes a database-page target (`mode: 'db'`, the shape
 * `readFenceTarget` returns for a stored page) on the eval brain's default
 * source. `analyzeFences` runs the free tiers exactly as `gbrain repair
 * fences` does; a page they leave for the model goes through `runTier3` with
 * the real daily ledger and attempt store of that brain: prompt v2 (a model
 * may answer HOLD, held as `llm_declined`), one call per fence, a corrective
 * re-ask only after a structural gate failure ((a) or (e)), gates (a)-(g) and
 * the Tier 1 fixed point. Nothing here re-implements a tier or a gate. A page the free
 * tiers repair (`proposal`) or hold (`manual`) is reported with that tier's
 * outcome, so a fence that a Tier 1 rule now handles is scored as Tier 1.
 *
 * `observeCalls` wraps the ledger to record each call's estimate and settled
 * cost; the harness adds tokens (chat usage sink) and the answer text (a
 * read-only fetch observer). Observation never changes a decision.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import type { DailyLedger } from '../../src/core/budget/daily-ledger.ts';
import { analyzeFences, runTier3, type Tier3Deps } from '../../src/core/fence-repair/repair-tiers.ts';
import { pageSha, type FenceTarget } from '../../src/core/fence-repair/repair-io.ts';
import type { Fixture, FencePageText } from './generate-fixtures.ts';

export interface LedgerCall { estimate_usd: number; usd: number | null }

export interface CaseOutcome {
  id: string;
  /** What the free tiers decided: `llm` means the page reached Tier 3. */
  tier1: 'clean' | 'proposal' | 'manual' | 'llm';
  /** The tier that produced the outcome (null for a page that already compiles). */
  tier: 'deterministic' | 'resolver' | 'llm' | 'manual' | null;
  /** Residual reasons Tier 1 left (location-only codes). */
  residual: string[];
  /** Model requests (fences) sent for this page. */
  requests: number;
  outcome: 'repaired' | 'held' | 'not_sent';
  reason: string | null;
  gate: string | null;
  rows: number[];
  spent_usd: number;
  ledger_calls: LedgerCall[];
  after: FencePageText | null;
  message: string | null;
}

export const EVAL_SOURCE = 'default';

export function fixtureTarget(f: Fixture): FenceTarget {
  const page = { compiled_truth: f.page.compiled_truth, timeline: f.page.timeline };
  return { mode: 'db', sourceId: EVAL_SOURCE, key: `slug:eval/${f.id}`, slug: `eval/${f.id}`, path: null, sourcePath: null,
    page, content: null, before: pageSha(page), snapshot: null, hold: null, ctx: { pageVisibility: f.page_visibility } };
}

/** The ledger with each reserve/settle pair recorded in call order. */
export function observeCalls(ledger: DailyLedger, calls: LedgerCall[]): DailyLedger {
  const byId = new Map<string, LedgerCall>();
  return {
    ...ledger,
    reserve: async (estimateUsd, opts) => {
      const out = await ledger.reserve(estimateUsd, opts);
      if (out.ok) {
        const call = { estimate_usd: estimateUsd, usd: null };
        byId.set(out.reservation.id, call);
        calls.push(call);
      }
      return out;
    },
    dispatch: id => ledger.dispatch(id),
    settle: async (id, actualUsd) => {
      const call = byId.get(id);
      if (call) call.usd = actualUsd;
      return ledger.settle(id, actualUsd);
    },
    release: id => { const call = byId.get(id); if (call) calls.splice(calls.indexOf(call), 1); return ledger.release(id); },
    reclaimExpired: () => ledger.reclaimExpired(),
    readDay: day => ledger.readDay(day),
  };
}

export async function runCase(engine: BrainEngine, incarnation: string, f: Fixture, deps: Tier3Deps): Promise<CaseOutcome> {
  const target = fixtureTarget(f);
  const base = { id: f.id, spent_usd: 0, ledger_calls: [] as LedgerCall[], after: null, gate: null, rows: [] as number[], message: null, requests: 0 };
  const analysis = await analyzeFences(engine, target, { pageId: null });
  if (analysis.status === 'clean') return { ...base, tier1: 'clean', tier: null, residual: [], outcome: 'not_sent', reason: 'clean' };
  if (analysis.status === 'proposal') {
    return { ...base, tier1: 'proposal', tier: analysis.tier, residual: [], outcome: 'repaired', reason: null,
      after: { compiled_truth: analysis.after.compiled_truth, timeline: analysis.after.timeline } };
  }
  if (analysis.status === 'manual') {
    return { ...base, tier1: 'manual', tier: 'manual', residual: [analysis.reason], outcome: 'held', reason: analysis.reason, gate: analysis.gate ?? null, rows: analysis.rows ?? [] };
  }
  const calls: LedgerCall[] = [];
  const result = await runTier3(target, analysis, incarnation, { ...deps, ledger: observeCalls(deps.ledger, calls) });
  const residual = [...new Set(analysis.residual.map(i => i.reason))].sort();
  if (result.ok) return { ...base, tier1: 'llm', tier: 'llm', residual, requests: analysis.requests.length, outcome: 'repaired', reason: null, spent_usd: result.spentUsd, ledger_calls: calls, after: { compiled_truth: result.after.compiled_truth, timeline: result.after.timeline } };
  return { ...base, tier1: 'llm', tier: 'llm', residual, requests: analysis.requests.length, outcome: 'held', reason: result.reason, gate: result.gate ?? null, rows: result.rows ?? [],
    spent_usd: result.spentUsd, ledger_calls: calls, message: result.message };
}
