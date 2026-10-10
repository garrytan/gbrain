/**
 * Report writer for the content-repair judgment eval: the per-model JSON
 * summary and the Markdown tables the README and the gbrain-evals mirror
 * carry (hard failures, true-duplicate accuracy, needs_human rate, cost),
 * plus a per-set breakdown. Pure: takes summaries, returns strings.
 */
import { DECISION, meetsRule, rank, SCORER_VERSION, type ModelSummary } from './score.ts';

export interface Report {
  scorer_version: number;
  decision_rule: typeof DECISION;
  files: string[];
  /** Ranked: qualifying first, by true-duplicate accuracy, ties to the cheaper model. */
  models: Array<ModelSummary & { meets_rule: boolean }>;
  /** The proposal for `CONTENT_REPAIR_MEASURED_MODELS`: the qualifying models in rank order. */
  measured_models: string[];
}

export function buildReport(summaries: readonly ModelSummary[], files: string[]): Report {
  const models = rank(summaries).map(s => ({ ...s, meets_rule: meetsRule(s) }));
  return { scorer_version: SCORER_VERSION, decision_rule: DECISION, files, models, measured_models: models.filter(m => m.meets_rule).map(m => m.model) };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const ci = (c: [number, number] | null) => (c ? ` [${(100 * c[0]).toFixed(1)}, ${(100 * c[1]).toFixed(1)}]` : '');
const sec = (ms: number | null) => `${((ms ?? 0) / 1000).toFixed(1)} s`;

export function renderMarkdown(report: Report): string {
  const lines = [
    '| Model | Hard failures | True-duplicate accuracy | needs_human rate | No answer | USD per pair | Latency p50 / p95 | Qualifies |',
    '|---|---|---|---|---|---|---|---|',
    ...report.models.map(m => `| \`${m.model}\` | ${m.hard_failures}/${m.n}${m.hard_failures ? ` (${Object.entries(m.hard_failure_ids).map(([id, k]) => `${id} ×${k}`).join(', ')})` : ''} | `
      + `${m.true_duplicate.merge_canonical}/${m.true_duplicate.n} (${pct(m.true_duplicate.accuracy)})${ci(m.true_duplicate.accuracy_ci)} | ${pct(m.needs_human_rate)} | ${m.no_answer.n} | $${m.cost.usd_per_pair.toFixed(4)} | `
      + `${sec(m.latency_ms.p50)} / ${sec(m.latency_ms.p95)} | ${m.meets_rule ? 'yes' : 'no'} |`),
    '',
    'Per set (pair runs; `merge` / `remove` / `human` / `none` are the model\'s answers; a hard failure is a `remove` on a true duplicate or a `merge` elsewhere, or a merge into the wrong canonical):',
    '',
    '| Model | True duplicates (merge right / wrong canonical / remove / human / none) | Stray slugs (remove / merge / human / none) | Adversarial (remove / merge / human / none) | Ambiguous (human / guessed / none) |',
    '|---|---|---|---|---|',
    ...report.models.map(m => {
      const td = m.true_duplicate; const ss = m.stray_slug; const adv = m.adversarial; const amb = m.ambiguous;
      return `| \`${m.model}\` | ${td.merge_canonical} / ${td.wrong_canonical} / ${td.by_action.remove_slug} / ${td.by_action.needs_human} / ${td.by_action.none} of ${td.n} | `
        + `${ss.by_action.remove_slug} / ${ss.by_action.merge_into} / ${ss.by_action.needs_human} / ${ss.by_action.none} of ${ss.n} | `
        + `${adv.by_action.remove_slug} / ${adv.by_action.merge_into} / ${adv.by_action.needs_human} / ${adv.by_action.none} of ${adv.n} | `
        + `${amb.by_action.needs_human} / ${amb.guesses} / ${amb.by_action.none} of ${amb.n} |`;
    }),
    '',
    `Rule: zero hard failures and true-duplicate accuracy at least ${pct(DECISION.minTrueDuplicateAccuracy)}; \`needs_human\` is always acceptable. Brackets are Wilson 95% intervals in percent. `
      + `Proposed \`CONTENT_REPAIR_MEASURED_MODELS\`: ${report.measured_models.length ? report.measured_models.map(m => `\`${m}\``).join(', ') : 'none (no model met the rule)'}.`,
  ];
  return lines.join('\n') + '\n';
}
