/**
 * Summarize a binary-decision matched pair (S7 triage rows from
 * s7-triage-pair.ts): confusion vs labels, cost, latency percentiles, and
 * retest flip rate between two runs of the same arm.
 *
 *   bun docs/eval/system-one/runners/summarize-pair.ts --a off-1.jsonl --a2 off-2.jsonl --b on-1.jsonl --b2 on-2.jsonl [--json]
 *
 * `worth` is the decision; label true = synthesis-worthy.
 */
const args = process.argv.slice(2);
const flag = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);

type Row = { id: string; label: boolean; worth: boolean; path?: string; decide_outcome?: string | null; latency_ms: number; llm_usd: number; decide_usd: number; slice?: string };
const load = async (p?: string): Promise<Row[]> => (p ? (await Bun.file(p).text()).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

export function pct(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

function summarize(rows: Row[]) {
  const tp = rows.filter((r) => r.label && r.worth).length;
  const fn = rows.filter((r) => r.label && !r.worth).length;
  const fp = rows.filter((r) => !r.label && r.worth).length;
  const tn = rows.filter((r) => !r.label && !r.worth).length;
  const lat = rows.map((r) => r.latency_ms);
  const usd = rows.reduce((a, r) => a + r.llm_usd + r.decide_usd, 0);
  const bySource = (pred: (r: Row) => boolean) => {
    const s = rows.filter(pred);
    return { n: s.length, positives_missed: s.filter((r) => r.label && !r.worth).length, negatives_rejected: s.filter((r) => !r.label && !r.worth).length, negatives: s.filter((r) => !r.label).length, positives: s.filter((r) => r.label).length };
  };
  const paths: Record<string, number> = {};
  for (const r of rows) { const k = `${r.path ?? 'llm'}${r.decide_outcome ? `:${r.decide_outcome}` : ''}`; paths[k] = (paths[k] ?? 0) + 1; }
  return {
    n: rows.length, tp, fn, fp, tn,
    accuracy: (tp + tn) / rows.length, recall: tp / Math.max(1, tp + fn), specificity: tn / Math.max(1, tn + fp),
    sent_to_synthesis: tp + fp,
    cost_usd_total: usd, cost_usd_per_transcript: usd / rows.length,
    latency_ms: { p50: pct(lat, 0.5), p95: pct(lat, 0.95), p99: pct(lat, 0.99), mean: lat.reduce((a, b) => a + b, 0) / lat.length },
    cat35: bySource((r) => !r.id.startsWith('syn-')), synthetic_buried: bySource((r) => r.id.startsWith('syn-buried')), synthetic_routine: bySource((r) => r.id.startsWith('syn-routine')),
    paths,
  };
}

function flips(a: Row[], b: Row[]): { n: number; flips: number; rate: number } {
  const m = new Map(b.map((r) => [r.id, r.worth]));
  const shared = a.filter((r) => m.has(r.id));
  const f = shared.filter((r) => m.get(r.id) !== r.worth).length;
  return { n: shared.length, flips: f, rate: f / Math.max(1, shared.length) };
}

function discordant(a: Row[], b: Row[]) {
  const m = new Map(b.map((r) => [r.id, r]));
  const out = { b_right_a_wrong: 0, a_right_b_wrong: 0, ids_b_right: [] as string[], ids_a_right: [] as string[] };
  for (const r of a) {
    const s = m.get(r.id);
    if (!s || s.worth === r.worth) continue;
    if (s.worth === s.label) { out.b_right_a_wrong++; out.ids_b_right.push(r.id); } else { out.a_right_b_wrong++; out.ids_a_right.push(r.id); }
  }
  return out;
}

/** Exact two-sided McNemar (binomial on discordant pairs). */
function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let p = 0;
  let coef = 1;
  for (let i = 0; i <= n; i++) {
    if (i > 0) coef = (coef * (n - i + 1)) / i;
    if (i <= k) p += coef;
  }
  return Math.min(1, (2 * p) / 2 ** n);
}

if (import.meta.main) {
  const [a, a2, b, b2] = await Promise.all([load(flag('--a')), load(flag('--a2')), load(flag('--b')), load(flag('--b2'))]);
  const d = discordant(a, b);
  const report = {
    a: summarize(a), b: summarize(b),
    retest: { a: a2.length ? flips(a, a2) : null, b: b2.length ? flips(b, b2) : null, a2: a2.length ? summarize(a2) : null, b2: b2.length ? summarize(b2) : null },
    discordant: d, mcnemar_p: mcnemar(d.b_right_a_wrong, d.a_right_b_wrong),
  };
  console.log(JSON.stringify(report, null, 2));
}
