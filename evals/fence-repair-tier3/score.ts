/**
 * Scoring for the Tier 3 fence-repair eval (#6188 T4). Pure functions.
 *
 * A repaired page MATCHES its ground truth when, for every facts and takes
 * fence in both sections, the rows hold the same non-empty cell text in the
 * same columns (whitespace collapsed; `\|` read as `|`), and everything
 * outside the fences is byte-identical. Spacing inside cells and the
 * choice of narrow versus wide layout when the extra columns are empty do
 * not count; any moved, dropped or changed text does. `exact` is the
 * stricter byte-for-byte comparison, reported alongside.
 *
 * Metrics (preregistered in gbrain-evals, docs/benchmarks/2026-10-06-fence-repair-tier3-preregistration.md,
 * amended for round 2 in 2026-10-06-fence-repair-tier3-amendment-1.md):
 * - gate-pass rate: repairable items that reached Tier 3 and whose Tier 3
 *   repair passed every gate, over repairable items that reached Tier 3.
 * - false-accept rate: of those, repaired but not matching the ground truth,
 *   over repairable items that reached Tier 3.
 * - end to end: every repairable item whatever tier settled it (a Tier 1
 *   repair, a hold before Tier 3), with wrong writes per tier.
 * - whole path: gate-pass and false-accept over every repairable item, a
 *   free-tier repair counting as repaired (scorer v2's definition), reported
 *   beside the preregistered Tier 3 rates; `declined` counts HOLD answers.
 * - held correctly: adversarial items that stayed held by any tier, over
 *   adversarial items run, with how they were held.
 * - USD per repair: ledger-priced spend on repairable items over repairs.
 * - latency p50/p95: wall time of the Tier 3 step per item that made a call.
 */
import { extractRawRows, primaryFence } from '../../src/core/fence-repair/raw-rows.ts';
import { collapse } from '../../src/core/fence-repair/schema.ts';
import type { FencePageText } from './generate-fixtures.ts';

export const SCORER_VERSION = 3;

type Section = 'compiled_truth' | 'timeline';

function fenceShape(text: string, sectionName: 'body' | 'timeline') {
  const raw = extractRawRows(text, sectionName);
  const fences = (['facts', 'takes'] as const).map(kind => {
    const fence = primaryFence(raw, kind);
    if (!fence) return { kind, rows: null as string[] | null, region: null as [number, number] | null };
    const rows = fence.rows.map(row => {
      const cells = [...row.byColumn].map(([column, cell]) => [column, collapse(cell.text)] as const).filter(([, text]) => text !== '');
      const extra = row.extra.map(cell => collapse(cell.text)).filter(Boolean);
      return JSON.stringify([Object.fromEntries(cells.sort(([a], [b]) => (a < b ? -1 : 1))), extra]);
    });
    return { kind, rows, region: [fence.begin.start, (fence.end ?? { end: text.length }).end] as [number, number] };
  });
  let outside = text;
  for (const f of fences.filter(f => f.region).sort((a, b) => b.region![0] - a.region![0])) outside = outside.slice(0, f.region![0]) + '\u0000FENCE\u0000' + outside.slice(f.region![1]);
  return { fences: fences.map(f => ({ kind: f.kind, rows: f.rows })), outside };
}

/** Cell-level comparison of a repaired page with its ground truth. */
export function compareRepair(after: FencePageText, expected: FencePageText): { cells: boolean; exact: boolean } {
  const exact = after.compiled_truth === expected.compiled_truth && (after.timeline ?? '') === (expected.timeline ?? '');
  const cells = (['compiled_truth', 'timeline'] as Section[]).every(field => {
    const name = field === 'compiled_truth' ? 'body' : 'timeline';
    const a = fenceShape(after[field] ?? '', name);
    const e = fenceShape(expected[field] ?? '', name);
    return a.outside === e.outside && JSON.stringify(a.fences) === JSON.stringify(e.fences);
  });
  return { cells, exact };
}

export interface ResultRow {
  model: string;
  run: number;
  id: string;
  set: 'repairable' | 'adversarial' | 'gate_limited';
  adversarial: 'ambiguous' | 'unrecoverable' | 'split_claim' | null;
  cls: string;
  kind: string;
  tags: string[];
  tier1: string;
  /** The tier that produced the outcome (round 2 rows; round 1 rows all reached Tier 3). */
  tier?: string | null;
  /** Model requests (fences) the page sent; more calls than this means a corrective re-ask ran. */
  requests: number;
  outcome: 'repaired' | 'held' | 'not_sent';
  reason: string | null;
  gate: string | null;
  match_cells: boolean | null;
  match_exact: boolean | null;
  calls: Array<{ latency_ms: number | null; input_tokens: number | null; output_tokens: number | null; estimate_usd: number | null; usd: number | null; stop: string | null; text: string | null }>;
  spent_usd: number;
  usd_unregistered: number | null;
  latency_ms: number;
  attempts: number;
}

/** The outcome bucket a held item reports: the gate letter, or the failure reason. */
export function heldBucket(row: Pick<ResultRow, 'outcome' | 'reason' | 'gate'>): string {
  if (row.outcome === 'repaired') return 'repaired';
  if (row.outcome === 'not_sent') return `not_sent:${row.reason}`;
  return row.gate ? `gate_${row.gate}` : row.reason ?? 'held';
}

export function quantile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** Wilson 95% interval for k successes in n trials. */
export function wilson(k: number, n: number): [number, number] | null {
  if (!n) return null;
  const z = 1.959964;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export interface ModelSummary {
  model: string;
  runs: number;
  repairable: { n: number; repaired: number; gate_pass: number; gate_pass_ci: [number, number] | null; false_accepts: number; false_accept: number; false_accept_ci: [number, number] | null;
    exact_matches: number; per_run_gate_pass: number[]; reask_used: number; reask_rescued: number; held_by: Record<string, number>; declined: number };
  whole_path: { n: number; repaired: number; gate_pass: number; false_accepts: number; false_accept: number };
  end_to_end: { n: number; repaired: number; wrong_writes: number; by_tier: Record<string, { runs: number; repaired: number; wrong_writes: number }> };
  adversarial: { n: number; held: number; held_rate: number; ambiguous_n: number; ambiguous_held: number; unrecoverable_n: number; unrecoverable_held: number;
    split_claim_n: number; split_claim_held: number; held_how: Record<string, number>; accepted_ids: string[] };
  gate_limited: { n: number; held: number; accepted_ids: string[] };
  cost: { usd_total: number; usd_repairable: number; usd_per_repair: number | null; usd_per_item: number; usd_unregistered_per_repair: number | null; input_tokens: number; output_tokens: number; calls: number };
  latency_ms: { p50: number | null; p95: number | null };
}

export function summarize(rows: readonly ResultRow[]): ModelSummary[] {
  const models = [...new Set(rows.map(r => r.model))];
  return models.map(model => {
    const mine = rows.filter(r => r.model === model);
    const allRep = mine.filter(r => r.set === 'repairable');
    const rep = allRep.filter(r => r.tier1 === 'llm');
    const adv = mine.filter(r => r.set === 'adversarial');
    const gl = mine.filter(r => r.set === 'gate_limited');
    const repaired = rep.filter(r => r.outcome === 'repaired');
    const falseAccepts = repaired.filter(r => r.match_cells === false);
    const runs = [...new Set(mine.map(r => r.run))].sort((a, b) => a - b);
    const heldBy: Record<string, number> = {};
    for (const r of rep.filter(r => r.outcome !== 'repaired')) heldBy[heldBucket(r)] = (heldBy[heldBucket(r)] ?? 0) + 1;
    const reask = rep.filter(r => r.calls.length > r.requests);
    const amb = adv.filter(r => r.adversarial === 'ambiguous');
    const unr = adv.filter(r => r.adversarial === 'unrecoverable');
    const spl = adv.filter(r => r.adversarial === 'split_claim');
    const byTier: Record<string, { runs: number; repaired: number; wrong_writes: number }> = {};
    for (const r of allRep) {
      const t = byTier[r.tier ?? 'llm'] ??= { runs: 0, repaired: 0, wrong_writes: 0 };
      t.runs++;
      if (r.outcome === 'repaired') { t.repaired++; if (r.match_cells === false) t.wrong_writes++; }
    }
    const heldHow: Record<string, number> = {};
    for (const r of adv.filter(r => r.outcome !== 'repaired')) {
      const how = r.tier === 'manual' ? 'before_tier3' : r.gate ? 'gate' : r.reason === 'llm_declined' ? 'declined' : r.reason === 'llm_empty' || r.reason === 'llm_truncated' ? 'output_budget' : r.reason ?? 'other';
      heldHow[how] = (heldHow[how] ?? 0) + 1;
    }
    const usdRep = rep.reduce((s, r) => s + r.spent_usd, 0);
    const unregistered = rep.every(r => r.usd_unregistered !== null) ? rep.reduce((s, r) => s + (r.usd_unregistered ?? 0), 0) : null;
    const allCalls = mine.flatMap(r => r.calls);
    const latencies = mine.filter(r => r.calls.length > 0).map(r => r.latency_ms);
    return {
      model, runs: runs.length,
      repairable: {
        n: rep.length, repaired: repaired.length, gate_pass: rep.length ? repaired.length / rep.length : 0, gate_pass_ci: wilson(repaired.length, rep.length),
        false_accepts: falseAccepts.length, false_accept: rep.length ? falseAccepts.length / rep.length : 0, false_accept_ci: wilson(falseAccepts.length, rep.length),
        exact_matches: repaired.filter(r => r.match_exact).length,
        per_run_gate_pass: runs.map(run => { const x = rep.filter(r => r.run === run); return x.length ? x.filter(r => r.outcome === 'repaired').length / x.length : 0; }),
        reask_used: reask.length, reask_rescued: reask.filter(r => r.outcome === 'repaired').length, held_by: heldBy,
        declined: rep.filter(r => r.reason === 'llm_declined').length,
      },
      whole_path: wholePath(allRep),
      end_to_end: { n: allRep.length, repaired: allRep.filter(r => r.outcome === 'repaired').length, wrong_writes: allRep.filter(r => r.outcome === 'repaired' && r.match_cells === false).length, by_tier: byTier },
      adversarial: {
        n: adv.length, held: adv.filter(r => r.outcome !== 'repaired').length, held_rate: adv.length ? adv.filter(r => r.outcome !== 'repaired').length / adv.length : 0,
        ambiguous_n: amb.length, ambiguous_held: amb.filter(r => r.outcome !== 'repaired').length,
        unrecoverable_n: unr.length, unrecoverable_held: unr.filter(r => r.outcome !== 'repaired').length,
        split_claim_n: spl.length, split_claim_held: spl.filter(r => r.outcome !== 'repaired').length, held_how: heldHow,
        accepted_ids: [...new Set(adv.filter(r => r.outcome === 'repaired').map(r => r.id))].sort(),
      },
      gate_limited: { n: gl.length, held: gl.filter(r => r.outcome !== 'repaired').length, accepted_ids: [...new Set(gl.filter(r => r.outcome === 'repaired').map(r => r.id))].sort() },
      cost: {
        usd_total: mine.reduce((s, r) => s + r.spent_usd, 0), usd_repairable: usdRep, usd_per_repair: repaired.length ? usdRep / repaired.length : null,
        usd_per_item: mine.length ? mine.reduce((s, r) => s + r.spent_usd, 0) / mine.length : 0,
        usd_unregistered_per_repair: unregistered !== null && repaired.length ? unregistered / repaired.length : null,
        input_tokens: allCalls.reduce((s, c) => s + (c.input_tokens ?? 0), 0), output_tokens: allCalls.reduce((s, c) => s + (c.output_tokens ?? 0), 0), calls: allCalls.length,
      },
      latency_ms: { p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95) },
    };
  });
}

function wholePath(rows: readonly ResultRow[]): ModelSummary['whole_path'] {
  const repaired = rows.filter(r => r.outcome === 'repaired').length;
  const falseAccepts = rows.filter(r => r.outcome === 'repaired' && r.match_cells === false).length;
  return { n: rows.length, repaired, gate_pass: rows.length ? repaired / rows.length : 0, false_accepts: falseAccepts, false_accept: rows.length ? falseAccepts / rows.length : 0 };
}

/** The preregistered decision rule for one model's summary (Tier 3 rates). */
export const DECISION = { minGatePass: 0.8, maxFalseAccept: 0.01 } as const;
export function meetsRule(s: ModelSummary): boolean {
  return s.repairable.gate_pass >= DECISION.minGatePass && s.repairable.false_accept <= DECISION.maxFalseAccept;
}
