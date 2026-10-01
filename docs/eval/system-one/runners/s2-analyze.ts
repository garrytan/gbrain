/**
 * S2 intent routing from recorded Jev answers (ask-dataset.ts over the
 * LongMemEval question_type + BrainBench relational intent set). Per call
 * site: regex-classifier accuracy vs the production reducer (reduceIntent)
 * at a threshold chosen on the calibrate half, on the eval half; plus the
 * late rate and the latency cost at candidate wait bounds.
 *
 *   bun docs/eval/system-one/runners/s2-analyze.ts --values <jsonl> --dataset <jsonl>
 */
import { classifyQuery } from '../../../../src/core/search/query-intent.ts';
import { classifyIntent } from '../../../../src/core/think/intent.ts';
import { reduceIntent, type IntentCallSite } from '../../../../src/core/ai/decide/intent.ts';
import { pct } from './summarize-pair.ts';

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
type V = { id: string; split: string; label: string; rep: number; choice?: string; probabilities?: Record<string, number>; value: number | null; latency_ms: number };
const vals: V[] = (await Bun.file(flag('--values')!).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const meta = new Map<string, { state: { query: string; call_site: IntentCallSite }; slice: string }>(
  (await Bun.file(flag('--dataset')!).text()).split('\n').filter(Boolean).map((l) => { const d = JSON.parse(l); return [d.id, d]; }),
);
const regex = (v: V): string => {
  const m = meta.get(v.id)!;
  return m.state.call_site === 'think' ? classifyIntent(m.state.query) : classifyQuery(m.state.query).intent;
};
const answer = (v: V) => (v.choice ? { kind: 'choice' as const, choice: v.choice, confidence: v.value ?? 0, probabilities: v.probabilities ?? {} } : undefined);
const site = (v: V) => meta.get(v.id)!.state.call_site;

const report: Record<string, unknown> = {};
for (const cs of ['search', 'think'] as const) {
  const all = vals.filter((v) => v.rep === 0 && site(v) === cs);
  const cal = all.filter((v) => v.split === 'calibrate');
  const ev = all.filter((v) => v.split === 'eval');
  const acc = (list: V[], t: number) => list.filter((v) => reduceIntent(answer(v), regex(v), { threshold: t }, cs).label === v.label).length / list.length;
  let best = { t: 1.01, acc: acc(cal, 1.01) };
  for (let t = 0; t <= 1.0001; t += 0.01) { const a = acc(cal, t); if (a > best.acc + 1e-9) best = { t: Number(t.toFixed(2)), acc: a }; }
  const regexAcc = ev.filter((v) => regex(v) === v.label).length / ev.length;
  const jevRaw = ev.filter((v) => v.choice === v.label).length / ev.length;
  const onAcc = acc(ev, best.t);
  const overrides = ev.filter((v) => reduceIntent(answer(v), regex(v), { threshold: best.t }, cs).outcome === 'override');
  const helped = overrides.filter((v) => v.choice === v.label && regex(v) !== v.label).length;
  const hurt = overrides.filter((v) => v.choice !== v.label && regex(v) === v.label).length;
  const lat = all.map((v) => v.latency_ms);
  const late = (ms: number) => lat.filter((x) => x > ms).length / lat.length;
  const bySlice: Record<string, { n: number; regex: number; on: number }> = {};
  for (const v of ev) {
    const s = (bySlice[meta.get(v.id)!.slice] ??= { n: 0, regex: 0, on: 0 });
    s.n++; if (regex(v) === v.label) s.regex++; if (reduceIntent(answer(v), regex(v), { threshold: best.t }, cs).label === v.label) s.on++;
  }
  report[cs] = {
    n_eval: ev.length, threshold: best.t, calibrate_accuracy: best.acc, regex_accuracy: regexAcc, jev_raw_choice_accuracy: jevRaw, on_accuracy: onAcc,
    overrides: overrides.length, overrides_helped: helped, overrides_hurt: hurt, by_slice: bySlice,
    // Late answers fall back to the regex label: accuracy with the wait bound applied.
    on_accuracy_with_wait: Object.fromEntries([150, 200, 250, 300, 400].map((ms) => [ms, ev.filter((v) => (v.latency_ms > ms ? regex(v) : reduceIntent(answer(v), regex(v), { threshold: best.t }, cs).label) === v.label).length / ev.length])),
    late_rate: Object.fromEntries([150, 200, 250, 300, 400].map((ms) => [ms, late(ms)])),
    latency_ms: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99) },
  };
}
const r0 = new Map(vals.filter((v) => v.rep === 0).map((v) => [v.id, v.choice]));
const r1 = vals.filter((v) => v.rep === 1);
report.retest_choice_flips = { n: r1.length, flips: r1.filter((v) => r0.get(v.id) !== v.choice).length };
console.log(JSON.stringify(report, null, 2));
