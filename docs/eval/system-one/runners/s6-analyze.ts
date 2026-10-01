/**
 * S6 recall_needed matched pair from recorded Jev answers (ask-dataset.ts
 * output over the combined know-to-ask dataset). Threshold: searchThreshold
 * (F1) on the calibrate half, rep 0; verdict on the eval half through the
 * production reducer (reduceRecallNeeded) vs the reflex alone (off).
 *
 *   bun docs/eval/system-one/runners/s6-analyze.ts --values <jsonl> [--suppress-below 0.10] [--target f1] [--min x]
 */
import { meanItemSd, qualifyActions, reliability, searchThreshold, wilsonLowerBound } from '../../../../src/core/ai/decide/calibrate.ts';
import { marginFor } from '../../../../src/core/ai/decide/policy.ts';
import { reduceRecallNeeded, REFLEX_FIRED_SLICE } from '../../../../src/core/ai/decide/recall-needed.ts';
import { pct } from './summarize-pair.ts';

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
type V = { id: string; family: string; split: string; label: boolean; slice: string; protected: boolean; rep: number; value: number | null; latency_ms: number; input_tokens: number };
const rows: V[] = (await Bun.file(flag('--values')!).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const suppressBelow = Number(flag('--suppress-below') ?? 0.1);
const target = (flag('--target') ?? 'f1') as 'f1' | 'precision' | 'recall';
const min = flag('--min') ? Number(flag('--min')) : undefined;

const rep0 = rows.filter((r) => r.rep === 0 && r.value !== null);
const calib = rep0.filter((r) => r.split === 'calibrate');
const evalRows = rep0.filter((r) => r.split === 'eval');
const choice = searchThreshold(calib.map((r) => ({ value: r.value!, label: r.label })), target, min)!;
const repeats = new Map<string, number[]>();
for (const r of rows) if (r.value !== null && r.split === 'calibrate') repeats.set(r.id, [...(repeats.get(r.id) ?? []), r.value]);
const retestSd = meanItemSd(repeats);
const margin = marginFor(0.05, { retest_sd: retestSd, repack_sd: 0 });
const policy = { threshold: choice.threshold, suppressBelow, margin };

function arm(on: boolean, list: V[]) {
  let retrieved = 0, neededMissed = 0, falseFire = 0, needed = 0, notNeeded = 0;
  const outcomes: Record<string, number> = {};
  const harmful: Array<{ family: string; correct: boolean; slice?: string }> = [];
  for (const r of list) {
    const reflex = { fired: r.slice === REFLEX_FIRED_SLICE, identityHit: r.protected };
    const o = on ? reduceRecallNeeded(r.value!, reflex, policy) : reflex.fired ? 'reflex' : 'no_fire';
    outcomes[o] = (outcomes[o] ?? 0) + 1;
    const gotMemory = o === 'fire' || (reflex.fired && o !== 'suppress');
    if (o === 'suppress') harmful.push({ family: r.family, correct: r.label === false });
    if (r.label) { needed++; if (!gotMemory) neededMissed++; } else { notNeeded++; if (gotMemory) falseFire++; }
    if (gotMemory) retrieved++;
  }
  return { n: list.length, needed, not_needed: notNeeded, know_to_ask_failure_rate: neededMissed / needed, needed_missed: neededMissed, false_fire_rate: falseFire / notNeeded, false_fires: falseFire, retrieved, outcomes, harmful };
}
const off = arm(false, evalRows);
const on = arm(true, evalRows);
const q = qualifyActions(on.harmful, 0.9);
const flipsBase = rows.filter((r) => r.split === 'eval' && r.rep === 1 && r.value !== null);
const byId = new Map(evalRows.map((r) => [r.id, r]));
let flips = 0;
for (const r of flipsBase) {
  const a = byId.get(r.id);
  if (!a) continue;
  const reflex = { fired: r.slice === REFLEX_FIRED_SLICE, identityHit: r.protected };
  if (reduceRecallNeeded(a.value!, reflex, policy) !== reduceRecallNeeded(r.value!, reflex, policy)) flips++;
}
const lat = rep0.map((r) => r.latency_ms);
const sliceOf = (list: V[], pred: (r: V) => boolean) => ({ off: arm(false, list.filter(pred)), on: arm(true, list.filter(pred)) });
const bySource = { brainbench: sliceOf(evalRows, (r) => !r.id.startsWith('s6x-')), extra: sliceOf(evalRows, (r) => r.id.startsWith('s6x-')) };
const strip = (a: ReturnType<typeof arm>) => { const { harmful, ...rest } = a; return { ...rest, suppress_actions: harmful.length }; };
console.log(JSON.stringify({
  threshold: choice, suppress_below: suppressBelow, retest_sd: retestSd, margin, ece: reliability(calib.map((r) => ({ value: r.value!, label: r.label }))).ece,
  eval: { off: strip(off), on: strip(on) },
  by_source: { brainbench: { off: strip(bySource.brainbench.off), on: strip(bySource.brainbench.on) }, extra: { off: strip(bySource.extra.off), on: strip(bySource.extra.on) } },
  suppress_qualification: { ...q, slices: undefined, lb_if_all_correct: q.families ? wilsonLowerBound(q.families, q.families) : null },
  retest_flip_rate: { n: flipsBase.length, flips, rate: flips / Math.max(1, flipsBase.length) },
  latency_ms_per_request: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99), over_250ms: lat.filter((x) => x > 250).length / lat.length },
  mean_input_tokens: rep0.reduce((a, r) => a + r.input_tokens, 0) / rep0.length,
}, null, 2));
