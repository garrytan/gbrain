/**
 * W7 forecast-journal gate: pure statistics (Spearman rank correlation with
 * average ranks for ties, set F1, the median) and the preregistered decision
 * rule. No brain, no I/O.
 */
export const RHO_MIN = 0.8;
export const SET_F1_MIN = 0.95;

function ranks(xs: readonly number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    for (let m = i; m <= j; m++) out[order[m]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

export function spearman(xs: readonly number[], ys: readonly number[]): number {
  if (xs.length !== ys.length || xs.length < 2) throw new Error('spearman needs two equal-length series of at least 2');
  const rx = ranks(xs), ry = ranks(ys);
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < rx.length; i++) { num += (rx[i]! - mx) * (ry[i]! - my); dx += (rx[i]! - mx) ** 2; dy += (ry[i]! - my) ** 2; }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

/** F1 of a predicted set against a gold set; two empty sets score 1. */
export function setF1(gold: ReadonlySet<string>, predicted: ReadonlySet<string>): number {
  if (gold.size === 0 && predicted.size === 0) return 1;
  const hit = [...predicted].filter(x => gold.has(x)).length;
  return hit === 0 ? 0 : (2 * hit) / (gold.size + predicted.size);
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface GateResult {
  rho_shrunk: number[]; rho_raw: number[]; median_rho_shrunk: number; median_rho_raw: number; share_rho_shrunk_at_least_min: number;
  set_f1_macro: number; denominator_mismatches: string[]; low_n_mismatches: string[]; labelling_mismatches: string[];
  remote_probes: Array<{ probe: string; pass: boolean; detail: string }>;
}

/** The preregistered rule: every criterion must hold. */
export function decide(g: GateResult): { pass: boolean; failed: string[] } {
  const failed: string[] = [];
  if (!(g.median_rho_shrunk >= RHO_MIN)) failed.push(`median Spearman rho (shrunk accuracy vs true skill) ${g.median_rho_shrunk.toFixed(3)} < ${RHO_MIN}`);
  if (!(g.set_f1_macro >= SET_F1_MIN)) failed.push(`who-was-right set-F1 ${g.set_f1_macro.toFixed(3)} < ${SET_F1_MIN}`);
  if (g.denominator_mismatches.length) failed.push(`${g.denominator_mismatches.length} denominator mismatch(es)`);
  if (g.low_n_mismatches.length) failed.push(`${g.low_n_mismatches.length} low_n mismatch(es)`);
  if (g.labelling_mismatches.length) failed.push(`${g.labelling_mismatches.length} prediction-time labelling mismatch(es)`);
  const probes = g.remote_probes.filter(p => !p.pass);
  if (probes.length) failed.push(`remote probe(s) failed: ${probes.map(p => p.probe).join(', ')}`);
  return { pass: failed.length === 0, failed };
}
