/**
 * gbrain eval idea-lineage <idea> — operator-facing eval for the idea_lineage
 * gather op. Runs the op against the LIVE local brain and reports an evidence-
 * coverage summary, then persists a per-run record to
 * `<repo>/.gbrain-evals/idea-lineage-results.jsonl` (never ~/.gbrain).
 *
 * Ground-truth recall (does it recover a KNOWN lineage?) is covered by the
 * synthetic-corpus suite in test/operations-idea-lineage.test.ts. This CLI is
 * the repeatable operator surface: point it at a real idea and see how much
 * multi-angle evidence the brain holds.
 *
 * This eval gathers evidence directly against the local engine, so it needs a
 * local brain — thin-client installs (no local engine) cannot run it. (The
 * idea_lineage op itself is remote/MCP-callable as of v0.42.x.)
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';
import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { operationsByName } from '../core/operations.ts';
import type { OperationContext } from '../core/operations.ts';
import { buildMetricGlossaryMeta } from '../core/eval/metric-glossary.ts';

interface RunOpts {
  idea: string;
  source?: string;
  json?: boolean;
  output?: string;
}

const EVIDENCE_BUCKETS = ['matches', 'related', 'timeline', 'takes', 'trajectory', 'contradictions'] as const;

const HELP = `Usage: gbrain eval idea-lineage <idea> [options]

Run the idea_lineage gather op against the local brain and report an
evidence-coverage summary. Persists a run record to
.gbrain-evals/idea-lineage-results.jsonl.

Examples:
  gbrain eval idea-lineage "founder-led sales"
  gbrain eval idea-lineage "compounding trust" --json

Options:
  --source ID         Scope to a single source id
  --output DIR        Override the .gbrain-evals/ output directory
  --json              JSON output for agents
  --help, -h          Show this help
`;

function parseArgs(args: string[]): RunOpts | { help: true } | { error: string } {
  const opts: Partial<RunOpts> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--source') { opts.source = args[++i]; continue; }
    if (a === '--output') { opts.output = args[++i]; continue; }
    if (a.startsWith('-')) return { error: `Unknown flag: ${a}` };
    positional.push(a);
  }
  if (positional.length !== 1) {
    return { error: 'Exactly one <idea> positional argument is required (quote multi-word ideas).' };
  }
  return { ...(opts as RunOpts), idea: positional[0] };
}

function repoRoot(): string {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
  } catch {
    return process.cwd();
  }
}

function commitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

export async function runEvalIdeaLineage(engine: BrainEngine, args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if ('help' in parsed) { console.log(HELP); return; }
  if ('error' in parsed) {
    console.error(parsed.error);
    console.error('');
    console.error(HELP);
    process.exit(1);
  }

  const cfg = loadConfig();
  if (isThinClient(cfg)) {
    console.error('`gbrain eval idea-lineage` needs a local brain (not a thin-client install) — it gathers evidence directly against the local engine.');
    process.exit(1);
  }

  const startedAt = Date.now();
  // Honor the canonical source resolution chain (--source / GBRAIN_SOURCE /
  // .gbrain-source / default), matching every other CLI command.
  const { resolveSourceId } = await import('../core/source-resolver.ts');
  const sourceId = await resolveSourceId(engine, parsed.source ?? null);
  const ctx: OperationContext = {
    engine,
    config: cfg ?? ({} as never),
    logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    dryRun: false,
    remote: false,
    sourceId,
  } as OperationContext;

  const result = await operationsByName['idea_lineage'].handler(ctx, {
    idea: parsed.idea,
    source: sourceId,
  }) as Record<string, unknown> & {
    resolved: string | null;
    disambiguation_needed: boolean;
    degraded: boolean;
  };

  // Coverage metric: fraction of evidence buckets with >=1 item.
  const counts: Record<string, number> = {};
  let populated = 0;
  for (const b of EVIDENCE_BUCKETS) {
    const n = Array.isArray(result[b]) ? (result[b] as unknown[]).length : 0;
    counts[b] = n;
    if (n > 0) populated++;
  }
  const coverage = populated / EVIDENCE_BUCKETS.length;
  const duration_ms = Date.now() - startedAt;

  const summary = {
    idea: parsed.idea,
    resolved: result.resolved,
    disambiguation_needed: result.disambiguation_needed,
    degraded: result.degraded,
    lineage_evidence_coverage: Number(coverage.toFixed(3)),
    bucket_counts: counts,
    duration_ms,
  };

  // Persist a per-run record (dedicated stream so it never pollutes the typed
  // eval-results.jsonl consumed by `eval compare` / `eval run-all`).
  const root = repoRoot();
  const outPath = parsed.output
    ? join(parsed.output, 'idea-lineage-results.jsonl')
    : join(root, '.gbrain-evals', 'idea-lineage-results.jsonl');
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    appendFileSync(outPath, JSON.stringify({ ...summary, commit: commitSha() }) + '\n', 'utf-8');
  } catch {
    // Non-fatal: a read-only repo shouldn't block the eval read-out.
  }

  if (parsed.json) {
    console.log(JSON.stringify({
      ...summary,
      _meta: { metric_glossary: buildMetricGlossaryMeta(['lineage_evidence_coverage']) },
    }, null, 2));
    return;
  }

  console.log(`Idea:     ${parsed.idea}`);
  console.log(`Resolved: ${result.resolved ?? '(no anchor — disambiguate or refine the idea)'}`);
  if (result.disambiguation_needed) console.log('Note:     multiple strong anchors — disambiguation_needed');
  if (result.degraded) console.log('Note:     semantic search unavailable (keyword-only) — confidence capped');
  console.log('');
  console.log('Evidence coverage:');
  for (const b of EVIDENCE_BUCKETS) {
    console.log(`  ${b.padEnd(16)} ${counts[b]}`);
  }
  console.log('');
  console.log(`lineage_evidence_coverage: ${summary.lineage_evidence_coverage} (${populated}/${EVIDENCE_BUCKETS.length} buckets populated)`);
  console.log(`  ↳ ${buildMetricGlossaryMeta(['lineage_evidence_coverage'])['lineage_evidence_coverage']}`);
  console.log('');
  console.log(`Run record → ${outPath}`);
}
