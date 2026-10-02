/**
 * S9 conflict matched pair from recorded Jev answers (ask-dataset.ts over
 * the labelled fact pairs). Calibrates, on the calibrate half, the duplicate
 * threshold (reducer-consistent value: P(chosen) when duplicate is chosen,
 * else 0) and the proposal floor (P(supersede) on pairs the duplicate rule
 * did not take, labelled supersede vs not), then scores the eval half with
 * the production pair reducer against today's zero-LLM cosine rule
 * (baseline_decision stored per pair).
 *
 *   bun docs/eval/system-one/runners/s9-analyze.ts --values <jsonl> --dataset <jsonl> [--eligible-only] [--dup-threshold x --floor y]
 * (--dup-threshold/--floor apply the stored `gbrain decide calibrate` row instead of re-searching.)
 */
import { searchThreshold, wilsonLowerBound } from '../../../../src/core/ai/decide/calibrate.ts';
import { reduceConflict, supersedeProbability } from '../../../../src/core/ai/decide/conflict.ts';
import { pct } from './summarize-pair.ts';

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
type V = { id: string; family: string; split: string; rep: number; choice: string; probabilities: Record<string, number>; value: number; latency_ms: number; input_tokens: number; cost_usd: number };
const vals: V[] = (await Bun.file(flag('--values')!).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const meta = new Map<string, { slice: string; baseline_decision: string; sweep_eligible: boolean; label_source: string }>(
  (await Bun.file(flag('--dataset')!).text()).split('\n').filter(Boolean).map((l) => { const d = JSON.parse(l); return [d.id, d]; }),
);
const eligibleOnly = args.includes('--eligible-only');
const rows = vals.filter((v) => v.choice && (!eligibleOnly || meta.get(v.id)?.sweep_eligible));
const answer = (v: V) => ({ kind: 'choice' as const, choice: v.choice, confidence: v.value, probabilities: v.probabilities });
const label = (v: V) => meta.get(v.id)!.slice;

const cal = rows.filter((v) => v.rep === 0 && v.split === 'calibrate');
const dup = searchThreshold(cal.map((v) => ({ value: v.choice === 'duplicate' ? v.value : 0, label: label(v) === 'duplicate' })), 'precision', 0.9)
  ?? searchThreshold(cal.map((v) => ({ value: v.choice === 'duplicate' ? v.value : 0, label: label(v) === 'duplicate' })), 'f1')!;
const rest = cal.filter((v) => !(v.choice === 'duplicate' && v.value >= dup.threshold));
const floorChoice = searchThreshold(rest.map((v) => ({ value: supersedeProbability(answer(v)), label: label(v) === 'supersede' })), 'precision', 0.9)
  ?? searchThreshold(rest.map((v) => ({ value: supersedeProbability(answer(v)), label: label(v) === 'supersede' })), 'f1')!;

function score(outcome: (v: V) => string, list: V[]) {
  const confusion: Record<string, Record<string, number>> = {};
  for (const v of list) { const o = outcome(v); (confusion[label(v)] ??= {})[o] = (confusion[label(v)]![o] ?? 0) + 1; }
  const sup = list.filter((v) => label(v) === 'supersede');
  const proposals = list.filter((v) => ['proposal', 'supersede'].includes(outcome(v)));
  const wrong = proposals.filter((v) => label(v) !== 'supersede').length;
  const agree = list.filter((v) => { const o = outcome(v); const l = label(v); return (o === l) || (o === 'proposal' && l === 'supersede'); }).length;
  return {
    n: list.length, confusion,
    supersedes_found: sup.filter((v) => ['proposal', 'supersede'].includes(outcome(v))).length, supersede_labels: sup.length,
    proposals: proposals.length, wrong_supersedes: wrong, wrong_supersede_rate: wrong / Math.max(1, proposals.length),
    proposal_precision_lb: proposals.length ? wilsonLowerBound(proposals.length - wrong, proposals.length) : null,
    label_agreement: agree / list.length,
  };
}
const evalRows = rows.filter((v) => v.rep === 0 && v.split === 'eval');
const policy = { threshold: flag('--dup-threshold') ? Number(flag('--dup-threshold')) : dup.threshold, proposalFloor: flag('--floor') ? Number(flag('--floor')) : floorChoice.threshold };
const defaultPolicy = { threshold: policy.threshold, proposalFloor: 0.5 };
const base = (v: V) => meta.get(v.id)!.baseline_decision;
const rep1 = new Map(rows.filter((v) => v.rep === 1).map((v) => [v.id, v]));
const flips = evalRows.filter((v) => rep1.has(v.id) && reduceConflict(answer(v), policy) !== reduceConflict(answer(rep1.get(v.id)!), policy)).length;
const perFamily = new Map<string, V>();
for (const v of rows.filter((x) => x.rep === 0)) perFamily.set(v.family, v);
const lat = [...perFamily.values()].map((v) => v.latency_ms);
const costPerFact = [...perFamily.values()].reduce((a, v) => a + v.cost_usd, 0) / perFamily.size;
console.log(JSON.stringify({
  eligible_only: eligibleOnly,
  duplicate_threshold: dup, proposal_floor: floorChoice, applied_policy: policy,
  eval: { baseline_cosine_rule: score(base, evalRows), s9_calibrated: score((v) => reduceConflict(answer(v), policy), evalRows), s9_default_floor_0_5: score((v) => reduceConflict(answer(v), defaultPolicy), evalRows) },
  retest_flip_rate: { n: evalRows.filter((v) => rep1.has(v.id)).length, flips },
  latency_ms_per_request: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99) },
  cost_usd_per_swept_fact: costPerFact,
}, null, 2));
