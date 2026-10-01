/**
 * Judge-agreement math for `gbrain decide judge-agreement` (eval-only; Jev as
 * a judge beside an existing LLM judge, no runtime substitution): the 2x2
 * confusion matrix, raw agreement, Cohen's kappa with a large-sample 95% CI,
 * per-slice results and latency percentiles. Pure: no I/O, no provider.
 *
 * The reference labels are the existing judge's verdicts (an LLM), so the
 * report measures agreement between two judges, never accuracy against
 * human labels.
 */

export interface AgreementPair {
  /** The existing judge's verdict (the reference). */
  reference: boolean;
  /** Jev's verdict: p >= threshold. */
  predicted: boolean;
  slice?: string;
}

/** Rows = reference, columns = Jev. */
export interface Confusion {
  both_yes: number;
  reference_yes_jev_no: number;
  reference_no_jev_yes: number;
  both_no: number;
}

export interface Agreement {
  n: number;
  raw_agreement: number | null;
  /** Cohen's kappa; null when undefined (n = 0, or both judges constant on the same label). */
  kappa: number | null;
  /** Large-sample 95% CI: kappa ± 1.96 * sqrt(po(1-po) / (n(1-pe)^2)), clamped to [-1, 1]. */
  kappa_ci95: [number, number] | null;
  confusion: Confusion;
}

export function confusionOf(pairs: readonly AgreementPair[]): Confusion {
  const c: Confusion = { both_yes: 0, reference_yes_jev_no: 0, reference_no_jev_yes: 0, both_no: 0 };
  for (const p of pairs) {
    if (p.reference && p.predicted) c.both_yes++;
    else if (p.reference) c.reference_yes_jev_no++;
    else if (p.predicted) c.reference_no_jev_yes++;
    else c.both_no++;
  }
  return c;
}

const round = (x: number): number => Number(x.toFixed(4));

export function agreement(pairs: readonly AgreementPair[]): Agreement {
  const c = confusionOf(pairs);
  const n = pairs.length;
  if (n === 0) return { n, raw_agreement: null, kappa: null, kappa_ci95: null, confusion: c };
  const po = (c.both_yes + c.both_no) / n;
  const refYes = (c.both_yes + c.reference_yes_jev_no) / n;
  const jevYes = (c.both_yes + c.reference_no_jev_yes) / n;
  const pe = refYes * jevYes + (1 - refYes) * (1 - jevYes);
  if (pe >= 1) return { n, raw_agreement: round(po), kappa: null, kappa_ci95: null, confusion: c };
  const kappa = (po - pe) / (1 - pe);
  const se = Math.sqrt((po * (1 - po)) / (n * (1 - pe) ** 2));
  const clamp = (x: number) => Math.max(-1, Math.min(1, x));
  return { n, raw_agreement: round(po), kappa: round(kappa), kappa_ci95: [round(clamp(kappa - 1.96 * se)), round(clamp(kappa + 1.96 * se))], confusion: c };
}

/** Agreement per slice (question_type for LongMemEval), slices sorted by name. */
export function agreementBySlice(pairs: readonly AgreementPair[]): Record<string, Agreement> {
  const groups = new Map<string, AgreementPair[]>();
  for (const p of pairs) {
    if (p.slice === undefined) continue;
    groups.set(p.slice, [...(groups.get(p.slice) ?? []), p]);
  }
  return Object.fromEntries([...groups.keys()].sort().map((k) => [k, agreement(groups.get(k)!)]));
}

/** Nearest-rank percentile of `values` (q in (0, 1]); null when empty. */
export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}
