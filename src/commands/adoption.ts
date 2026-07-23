/**
 * gbrain adoption — review-first reporting over dream/synthesis-generated
 * pages (#2570 v1).
 *
 * v1 is strictly read-only: `gbrain adoption list` reports adoption state
 * (inbound-link classification) for pages carrying the durable #2569
 * provenance marker. Zero writes; no lifecycle state mutation.
 *
 * Usage:
 *   gbrain adoption list                        # summary + review candidates
 *   gbrain adoption list --json                 # stable JSON contract
 *   gbrain adoption list --since 30d            # window on dream_cycle_date
 *   gbrain adoption list --source-id default    # scope to one source
 *   gbrain adoption list --limit 20             # candidate cap (0 = no cap)
 */

import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import {
  buildGeneratedPagesReport,
  DEFAULT_CANDIDATE_LIMIT,
  type GeneratedPagesReport,
} from '../core/generated-report.ts';

const HELP = `Usage: gbrain adoption <subcommand> [options]

Read-only report over dream/synthesis-generated pages (durable #2569
provenance marker: dream_generated + dream_cycle_date). v1 performs
zero writes.

Subcommands:
  list              Classify generated pages by inbound-link adoption signal

Options (list):
  --json            Output the stable JSON report (schema_version field inside)
  --since <spec>    Inclusive window on dream_cycle_date: YYYY-MM-DD, "30d", "4w"
  --source-id <id>  Scope to one brain source (alias: --source; default: brain-wide)
  --limit <N>       Cap the candidates list (default ${DEFAULT_CANDIDATE_LIMIT}; 0 = no cap)
  --help, -h        Show this help

Buckets (precedence: external > generated_cluster > summary_only > none):
  external           at least one non-generated inbound origin (adoption signal)
  generated_cluster  inbound only from other generated pages
  summary_only       inbound only from dream-cycle summary index pages
  none               no classification-eligible inbound links

Auto-extracted link_source='mentions' edges never count toward adoption;
raw and eligible counts are both reported so nothing is hidden.
`;

function formatReportText(report: GeneratedPagesReport): string {
  const lines: string[] = [];
  const b = report.summary.buckets;
  const windowNote = report.window.since ? ` (since ${report.window.since})` : '';
  const scopeNote = report.source_scope ? ` [source: ${report.source_scope.join(', ')}]` : '';
  lines.push(
    `${report.summary.generated_pages_scanned} generated pages scanned${windowNote}${scopeNote}`,
  );
  lines.push(
    `  external ${b.external} · generated_cluster ${b.generated_cluster} · ` +
      `summary_only ${b.summary_only} · none ${b.none}`,
  );
  if (report.coverage.summary_linked_unstamped > 0) {
    lines.push(
      `  coverage warning: ${report.coverage.summary_linked_unstamped} summary-linked ` +
        'page(s) lack the durable marker (report under-enumerates; see #2569)',
    );
  }
  lines.push('');
  if (report.candidates.length === 0) {
    lines.push('No review candidates (every scanned page has an external inbound link).');
    return lines.join('\n');
  }
  lines.push(
    `Review candidates (${report.candidates.length} of ${report.total_candidates}` +
      `${report.candidates_truncated ? ', truncated — raise --limit' : ''}):`,
  );
  for (const c of report.candidates) {
    const src = c.source_id === 'default' ? '' : ` @${c.source_id}`;
    lines.push(
      `  [${c.bucket}] ${c.slug}${src} — ${c.title}` +
        ` (cycle ${c.dream_cycle_date}; eligible inbound ${c.inbound.eligible_edges}` +
        `, raw ${c.inbound.raw_edges})`,
    );
  }
  return lines.join('\n');
}

export async function runAdoption(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }
  const sub = args[0];
  if (sub !== 'list') {
    console.error(`Unknown subcommand: gbrain adoption ${sub}\n`);
    console.log(HELP);
    // #2084 exit-verdict ownership: raw `process.exitCode` writes are zeroed
    // by the owned flush-exit — route through setCliExitVerdict.
    setCliExitVerdict(1);
    return;
  }

  const rest = args.slice(1);
  const json = rest.includes('--json');
  let since: string | undefined;
  let sourceId: string | undefined;
  let limit: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if ((a === '--since' || a === '--source-id' || a === '--source' || a === '--limit') && i + 1 >= rest.length) {
      throw new Error(`${a} requires a value`);
    }
    if (a === '--since') since = rest[++i];
    else if (a === '--source-id' || a === '--source') sourceId = rest[++i];
    else if (a === '--limit') {
      const raw = rest[++i];
      limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 0) {
        throw new Error(`--limit: expected a non-negative integer, got "${raw}"`);
      }
    }
  }

  const report = await buildGeneratedPagesReport(engine, { since, sourceId, limit });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatReportText(report));
}
