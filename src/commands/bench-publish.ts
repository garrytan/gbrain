/**
 * gbrain bench publish — turn a captured-run NDJSON into a baseline file (v0.41).
 *
 * The LOOP-closing verb. Without `bench publish`, the eval gate has nothing
 * to gate against except hand-curated fixtures. This verb takes the output
 * of `gbrain eval export` and writes a `*.baseline.ndjson` file with:
 *   - line 1: metadata header (label, thresholds, source_hash, baseline_mean_latency_ms)
 *   - lines 2..N: raw captured rows with `query_hash` stamped on each
 *
 * Strict posture (per CEO D4 + eng D5):
 *   - Empty input → exit 1 with "no rows to publish (empty input)".
 *   - Duplicate (tool_name, source_ids, query_hash) rows → exit 1 listing the
 *     first 5 dupes + paste-ready dedup hint. source_ids in the dedup key
 *     per eng-D5 (multi-source brains).
 *   - --to path exists → exit 2 (USAGE) unless --force.
 *
 * NOT streaming. Real baselines are <10K rows (codex round-1 #8 — streaming
 * + sort + hash all together is impossible). In-memory read + sort + write.
 *
 * Usage:
 *   gbrain bench publish --from <captured.ndjson> --to <X.baseline.ndjson>
 *     [--threshold-jaccard FLOAT] [--threshold-top1 FLOAT]
 *     [--threshold-latency-multiplier FLOAT] [--label STRING]
 *     [--force] [--json]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { EvalCandidateInput } from '../core/types.ts';
import {
  BASELINE_FILE_SCHEMA_VERSION,
  DEFAULT_THRESHOLDS,
  computeQueryHash,
  computeSourceHash,
  serializeBaselineFile,
  type BaselineFile,
  type BaselineMetadata,
  type BaselineRow,
  type BaselineThresholds,
} from '../core/bench/baseline-file.ts';
import { createAuditWriter } from '../core/audit/audit-writer.ts';

interface PublishOpts {
  help?: boolean;
  from?: string;
  to?: string;
  label?: string;
  force?: boolean;
  json?: boolean;
  thresholds: Partial<BaselineThresholds>;
}

interface BenchPublishAuditEvent {
  ts: string;
  label: string;
  source_hash: string;
  row_count: number;
  output_path: string;
  thresholds: BaselineThresholds;
  success: boolean;
  failure_reason?: string;
}

const auditWriter = createAuditWriter<BenchPublishAuditEvent>({
  featureName: 'bench-publish',
  errorLabel: 'bench-publish-audit',
  errorTrailer: '; continuing',
});

function parseArgs(args: string[]): PublishOpts {
  const opts: PublishOpts = { thresholds: {} };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--from':
        opts.from = next;
        i++;
        break;
      case '--to':
        opts.to = next;
        i++;
        break;
      case '--label':
        opts.label = next;
        i++;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--threshold-jaccard':
        opts.thresholds.jaccard = Number(next);
        i++;
        break;
      case '--threshold-top1':
        opts.thresholds.top1 = Number(next);
        i++;
        break;
      case '--threshold-latency-multiplier':
        opts.thresholds.latency_multiplier = Number(next);
        i++;
        break;
      default:
        // Unknown arg; will fail below.
        break;
    }
  }
  return opts;
}

function printHelp(): void {
  console.log(`gbrain bench publish — write a baseline file from captured queries

Usage:
  gbrain bench publish --from <captured.ndjson> --to <X.baseline.ndjson> [flags]

Required:
  --from FILE                    Input NDJSON from \`gbrain eval export\`
  --to FILE                      Output baseline path (recommend .baseline.ndjson extension)

Optional:
  --label STRING                 Human-readable label (default: derived from --to filename)
  --force                        Overwrite --to if it exists
  --json                         Print JSON envelope to stdout
  --threshold-jaccard FLOAT      Embedded jaccard threshold (default: ${DEFAULT_THRESHOLDS.jaccard})
  --threshold-top1 FLOAT         Embedded top-1 threshold (default: ${DEFAULT_THRESHOLDS.top1})
  --threshold-latency-multiplier FLOAT
                                 Embedded latency multiplier (default: ${DEFAULT_THRESHOLDS.latency_multiplier})
  -h, --help                     Show this help

Exit codes:
  0   Baseline written
  1   Input validation failure (empty, duplicates, parse error, write failure)
  2   Usage error (missing flag, --to exists without --force)

Examples:
  # Publish your own personal baseline
  gbrain eval export --limit 200 --tool query > /tmp/captured.ndjson
  gbrain bench publish --from /tmp/captured.ndjson --to ~/.gbrain/baselines/personal.baseline.ndjson --label "personal-2026-05"

  # Gate against it later
  gbrain eval gate --baseline ~/.gbrain/baselines/personal.baseline.ndjson
`);
}

/** Parse one input NDJSON line into a candidate row. Throws with line context on failure. */
function parseInputRow(line: string, lineNo: number): EvalCandidateInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new Error(`Line ${lineNo}: malformed JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`Line ${lineNo} is not a JSON object`);
  }
  const row = parsed as Partial<EvalCandidateInput> & Record<string, unknown>;
  // schema_version is optional on input (some test/synthetic inputs omit it).
  // Strict shape check on the actual fields we use.
  if (row.tool_name !== 'query' && row.tool_name !== 'search') {
    throw new Error(`Line ${lineNo} missing or invalid tool_name (must be 'query' or 'search')`);
  }
  if (typeof row.query !== 'string') {
    throw new Error(`Line ${lineNo} missing query`);
  }
  if (!Array.isArray(row.retrieved_slugs)) {
    throw new Error(`Line ${lineNo} missing retrieved_slugs`);
  }
  if (!Array.isArray(row.source_ids)) {
    throw new Error(`Line ${lineNo} missing source_ids`);
  }
  if (typeof row.latency_ms !== 'number') {
    throw new Error(`Line ${lineNo} missing latency_ms`);
  }
  return row as EvalCandidateInput;
}

/** Per eng-D5: dedup key includes source_ids so multi-source brains don't collapse. */
function dedupKey(row: BaselineRow): string {
  const sources = [...row.source_ids].sort().join(',');
  return `${row.tool_name}|${sources}|${row.query_hash}`;
}

/**
 * Programmatic entrypoint. Returns the BaselineFile structure without
 * writing to disk. Throws on validation failures with paste-ready messages.
 */
export function buildBaselineFromInput(
  input: EvalCandidateInput[],
  opts: { label: string; thresholds?: Partial<BaselineThresholds>; publishedAt?: Date },
): BaselineFile {
  if (input.length === 0) {
    throw new Error('no rows to publish (empty input)');
  }

  const rows: BaselineRow[] = input.map(r => ({
    ...r,
    query_hash: computeQueryHash(r.query),
  }));

  // Dedup check before anything else (eng-D5 strict posture).
  const seen = new Map<string, BaselineRow[]>();
  for (const row of rows) {
    const key = dedupKey(row);
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key)!.push(row);
  }
  const dupes = [...seen.entries()].filter(([, rs]) => rs.length > 1);
  if (dupes.length > 0) {
    const first5 = dupes.slice(0, 5).map(([key, rs]) => {
      const sample = rs[0]!;
      return `  ${key}  (query="${sample.query.slice(0, 60)}", ${rs.length} copies)`;
    }).join('\n');
    throw new Error(
      `Found ${dupes.length} duplicate (tool_name, source_ids, query_hash) key(s). First ${Math.min(5, dupes.length)}:\n${first5}\n\n` +
      `Hint: dedupe your captured rows before publishing, e.g.\n` +
      `  jq -c -s 'group_by(.tool_name + "|" + (.source_ids|sort|join(",")) + "|" + .query) | map(.[0]) | .[]' /tmp/captured.ndjson > /tmp/deduped.ndjson`,
    );
  }

  const thresholds: BaselineThresholds = {
    jaccard: opts.thresholds?.jaccard ?? DEFAULT_THRESHOLDS.jaccard,
    top1: opts.thresholds?.top1 ?? DEFAULT_THRESHOLDS.top1,
    latency_multiplier: opts.thresholds?.latency_multiplier ?? DEFAULT_THRESHOLDS.latency_multiplier,
  };

  const baselineMeanLatencyMs = rows.reduce((s, r) => s + r.latency_ms, 0) / rows.length;

  const metadata: BaselineMetadata = {
    schema_version: BASELINE_FILE_SCHEMA_VERSION,
    _kind: 'baseline_metadata',
    label: opts.label,
    published_at: (opts.publishedAt ?? new Date()).toISOString(),
    source_hash: computeSourceHash(rows),
    thresholds,
    row_count: rows.length,
    baseline_mean_latency_ms: baselineMeanLatencyMs,
  };

  return { metadata, rows };
}

/** Derive a default label from the output path basename (sans extension). */
function deriveLabel(toPath: string): string {
  const base = toPath.split('/').pop() ?? toPath;
  return base.replace(/\.baseline\.ndjson$/, '').replace(/\.ndjson$/, '');
}

/** Read + parse the input NDJSON. Throws with line context on failure. */
function readInputNdjson(path: string): EvalCandidateInput[] {
  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n');
  const rows: EvalCandidateInput[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    rows.push(parseInputRow(line, i + 1));
  }
  return rows;
}

export async function runBenchPublish(args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }

  // USAGE checks (exit 2)
  if (!opts.from) {
    console.error('Error: --from FILE is required\n');
    printHelp();
    process.exit(2);
  }
  if (!opts.to) {
    console.error('Error: --to FILE is required\n');
    printHelp();
    process.exit(2);
  }
  if (!existsSync(opts.from)) {
    console.error(`Error: --from file not found: ${opts.from}`);
    process.exit(1);
  }
  if (existsSync(opts.to) && !opts.force) {
    console.error(`Error: --to path already exists: ${opts.to}\nUse --force to overwrite.`);
    process.exit(2);
  }

  const label = opts.label ?? deriveLabel(opts.to);
  const outputPath = resolvePath(opts.to);

  let input: EvalCandidateInput[];
  try {
    input = readInputNdjson(opts.from);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`Error: ${msg}`);
    auditWriter.log({
      label,
      source_hash: '',
      row_count: 0,
      output_path: outputPath,
      thresholds: { ...DEFAULT_THRESHOLDS, ...opts.thresholds },
      success: false,
      failure_reason: msg,
    });
    process.exit(1);
  }

  let file: BaselineFile;
  try {
    file = buildBaselineFromInput(input, {
      label,
      thresholds: opts.thresholds,
    });
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`Error: ${msg}`);
    auditWriter.log({
      label,
      source_hash: '',
      row_count: input.length,
      output_path: outputPath,
      thresholds: { ...DEFAULT_THRESHOLDS, ...opts.thresholds },
      success: false,
      failure_reason: msg,
    });
    process.exit(1);
  }

  const serialized = serializeBaselineFile(file);

  try {
    writeFileSync(outputPath, serialized);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`Error: could not write baseline to ${outputPath}: ${msg}`);
    auditWriter.log({
      label,
      source_hash: file.metadata.source_hash,
      row_count: file.rows.length,
      output_path: outputPath,
      thresholds: file.metadata.thresholds,
      success: false,
      failure_reason: msg,
    });
    process.exit(1);
  }

  auditWriter.log({
    label,
    source_hash: file.metadata.source_hash,
    row_count: file.rows.length,
    output_path: outputPath,
    thresholds: file.metadata.thresholds,
    success: true,
  });

  if (opts.json) {
    console.log(JSON.stringify({
      schema_version: 1,
      output_path: outputPath,
      label: file.metadata.label,
      source_hash: file.metadata.source_hash,
      row_count: file.rows.length,
      baseline_mean_latency_ms: file.metadata.baseline_mean_latency_ms,
      thresholds: file.metadata.thresholds,
    }, null, 2));
  } else {
    console.log(`Wrote ${outputPath}`);
    console.log(`  Label:    ${file.metadata.label}`);
    console.log(`  Rows:     ${file.rows.length}`);
    console.log(`  Hash:     ${file.metadata.source_hash.slice(0, 16)}…`);
    console.log(`  Latency:  ${file.metadata.baseline_mean_latency_ms.toFixed(0)}ms baseline mean`);
    console.log(`  Gate:     jaccard>=${file.metadata.thresholds.jaccard} top1>=${file.metadata.thresholds.top1} latency<=${file.metadata.thresholds.latency_multiplier}x`);
  }
}
