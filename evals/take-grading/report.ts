/**
 * The JSON report and Markdown tables for the W6 take-grading eval.
 */
import { rank, type ModelSummary } from './score.ts';

export interface Report {
  generated_from: string[];
  models: ModelSummary[];
  measured_models: string[];
}

export function buildReport(summaries: ModelSummary[], files: string[]): Report {
  const ranked = rank(summaries);
  return { generated_from: files, models: ranked, measured_models: ranked.filter(s => s.qualifies && s.split === 'counted').map(s => s.model) };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function renderMarkdown(report: Report): string {
  const lines: string[] = [];
  lines.push('| Model | Split | Applied | Wrong applied | Upper 95% | Qualifies | Coverage | Abstention | No answer | USD per call | p50 / p95 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of report.models) {
    lines.push(`| \`${s.model}\` | ${s.split} | ${s.applied} | ${s.wrong} | ${pct(s.wrong_upper)} | ${s.qualifies ? 'yes' : 'no'} | ${pct(s.coverage)} | ${pct(s.abstention)} | ${s.no_answer} | $${s.usd_per_call.toFixed(4)} | ${(s.latency_p50_ms / 1000).toFixed(1)} s / ${(s.latency_p95_ms / 1000).toFixed(1)} s |`);
  }
  for (const s of report.models) {
    lines.push('', `### \`${s.model}\` (${s.split})`, '', '| Set | n | Applied | Wrong | Verdicts |', '|---|---|---|---|---|');
    for (const [set, v] of Object.entries(s.by_set)) {
      lines.push(`| ${set} | ${v.n} | ${v.applied} | ${v.wrong} | ${Object.entries(v.verdicts).map(([k, n]) => `${k} ${n}`).join(', ')} |`);
    }
    lines.push('', `Exploratory: on world_counterfactual, ${s.world_leak.applied} of ${s.world_leak.n} applied, ${s.world_leak.follows_world} following the real outcome over the brain's evidence. Partial fixtures: ${Object.entries(s.partial).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}.`);
    if (s.wrong_ids.length) lines.push('', `Wrong applied: ${s.wrong_ids.join(', ')}.`);
  }
  lines.push('', `Proposed GRADE_TAKES_MEASURED_MODELS: ${report.measured_models.length ? report.measured_models.map(m => `\`${m}\``).join(', ') : 'none (no model qualifies on the counted split)'}.`);
  return lines.join('\n') + '\n';
}
