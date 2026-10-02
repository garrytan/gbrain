/**
 * S8 grounding matched pair from recorded Jev answers (ask-dataset.ts over
 * the LLM-labelled grounding units). Off = today's mechanical checks (every
 * unit in the dataset passes them). On = the production reducer at the
 * stored calibration's threshold and margin. Labels are LLM labels
 * (label_source llm:<model>), not hand labels.
 *
 *   bun docs/eval/system-one/runners/s8-analyze.ts --values <jsonl> --dataset <jsonl> --threshold <t> --margin <m>
 */
import { wilsonLowerBound } from '../../../../src/core/ai/decide/calibrate.ts';
import { reduceGrounding } from '../../../../src/core/cycle/grounding-decide.ts';
import { pct } from './summarize-pair.ts';

const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const threshold = Number(flag('--threshold'));
const margin = Number(flag('--margin') ?? 0.05);
type V = { id: string; family: string; split: string; label: boolean; protected: boolean; rep: number; value: number | null; latency_ms: number };
const vals: V[] = (await Bun.file(flag('--values')!).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const meta = new Map<string, { origin?: string }>((await Bun.file(flag('--dataset')!).text()).split('\n').filter(Boolean).map((l) => { const d = JSON.parse(l); return [d.id, d]; }));
const out = (v: V) => reduceGrounding(v.value, v.protected ? 'weak' : 'adequate', { threshold, margin });

function score(list: V[]) {
  const q = list.filter((v) => out(v) === 'quarantine');
  const wrong = q.filter((v) => v.label).length;
  const supported = list.filter((v) => v.label).length;
  const unsupported = list.length - supported;
  const outcomes: Record<string, number> = {};
  for (const v of list) outcomes[out(v) ?? 'null'] = (outcomes[out(v) ?? 'null'] ?? 0) + 1;
  return {
    n: list.length, supported, unsupported, outcomes, quarantined: q.length,
    quarantine_precision: q.length ? (q.length - wrong) / q.length : null, quarantine_precision_lb_items: q.length ? wilsonLowerBound(q.length - wrong, q.length) : null,
    unsupported_caught: (q.length - wrong) / Math.max(1, unsupported), false_quarantine_rate: wrong / Math.max(1, supported), useful_claims_lost: wrong,
  };
}
const ev = vals.filter((v) => v.rep === 0 && v.split === 'eval' && v.value !== null);
const origin = (o: string) => ev.filter((v) => (meta.get(v.id)?.origin ?? 'dream-page') === o);
const rep1 = new Map(vals.filter((v) => v.rep === 1).map((v) => [v.id, v]));
const flips = ev.filter((v) => rep1.has(v.id) && out(v) !== out(rep1.get(v.id)!)).length;
const lat = vals.filter((v) => v.rep === 0).map((v) => v.latency_ms);
console.log(JSON.stringify({
  threshold, margin, eval_all: score(ev), eval_dream_page_units: score(origin('dream-page')), eval_perturbations: score(origin('perturbation')),
  off: { quarantined: 0, unsupported_caught: 0, false_quarantine_rate: 0 },
  retest_flip_rate: { n: ev.filter((v) => rep1.has(v.id)).length, flips },
  latency_ms_per_request: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99) },
}, null, 2));
