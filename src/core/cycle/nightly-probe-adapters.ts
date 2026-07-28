/**
 * Bridge between `NightlyProbeDeps` (object-shape) and the existing CLI
 * functions (argv-shape) for `runEvalLongMemEval` + `runEvalCrossModal`.
 *
 * Per eng-D2: the existing CLI functions take argv arrays, not the object
 * shape the nightly-probe phase expects. The adapter converts; the CLI
 * functions stay unchanged.
 *
 * Per codex round-2 #1: `runEvalCrossModal --batch` only writes the summary
 * to `--output` (or its own default path). The adapter MUST pass
 * `--output summaryPath` so the file lands where the caller expects.
 *
 * Per codex round-2 #12: in-process invocation avoids the gbrain-version-
 * drift bug class. The adapter calls the CLI functions directly (not via
 * subprocess), so the workspace gbrain runs — not whatever's installed.
 */

import { readFileSync, existsSync } from 'node:fs';

/** Arguments accepted by the longmemeval adapter. */
export interface LongMemEvalProbeArgs {
  fixturePath: string;
  outputPath: string;
}

/** Arguments accepted by the cross-modal adapter. */
export interface CrossModalProbeArgs {
  batchPath: string;
  summaryPath: string;
  maxUsd: number;
  /** Explicitly match the selected fixture count; never inherit CLI limit=10. */
  limit: number;
}

/** Cross-modal batch summary shape (matches `runEvalCrossModal --batch --json`'s envelope). */
export interface CrossModalBatchSummary {
  total: number;
  pass_count: number;
  fail_count: number;
  inconclusive_count: number;
  error_count: number;
  upstream_error_count: number;
  malformed_count: number;
  est_cost_usd: number;
  verdict: string;
}

/**
 * Adapter for `runEvalLongMemEval`. Builds the argv shape the CLI expects
 * and calls it in-process.
 *
 * The CLI's first positional arg is `<dataset.jsonl>` (fixturePath).
 * `--output PATH` writes per-question rows.
 *
 * The CLI calls `process.exit(1)` on errors. The adapter doesn't trap
 * exit — the caller (nightly-quality-probe phase) wraps in try/catch and
 * treats any exit-style failure as a probe failure that doesn't crash
 * autopilot.
 */
export async function runLongMemEvalForProbe(args: LongMemEvalProbeArgs): Promise<void> {
  const { runEvalLongMemEval } = await import('../../commands/eval-longmemeval.ts');
  await runEvalLongMemEval([args.fixturePath, '--output', args.outputPath]);
}

/**
 * QA-shaped judge dimensions for the nightly probe. The batch judge's
 * DEFAULT_DIMENSIONS rubric (DEPTH / SOURCING / SPECIFICITY / …) is built
 * for rich agent responses; LongMemEval hypotheses are deliberately terse
 * factual answers ("in widget-co") that can never score ≥7 on DEPTH or
 * SOURCING — so with the default rubric the probe FAILs every night even
 * when retrieval + answering are perfectly healthy. The probe owns its
 * invocation of the eval tool and passes dimensions matching the
 * fixture's QA shape instead.
 *
 * NOTE: the `--dimensions` CLI flag splits on commas, so these dimension
 * descriptions must stay comma-free.
 */
export const PROBE_QA_DIMENSIONS: string[] = [
  // No faithfulness/grounding dimension on purpose: the judge never sees
  // the haystack, so any accurate detail beyond the terse gold label reads
  // as "invented" and correct answers fail (verified empirically — a
  // correct "before + dates" answer scored 4/10 on such a dimension).
  'CORRECTNESS — Does the hypothesis state the same fact as the expected answer? A terse direct answer is ideal.',
  'DIRECTNESS — Does it answer THIS question without hedging or padding or answering something else?',
];

export function buildCrossModalProbeArgv(args: CrossModalProbeArgs): string[] {
  // Do not add --yes: the nightly max_usd setting is a hard pre-flight guard.
  return [
    '--batch',
    args.batchPath,
    '--output',
    args.summaryPath,
    '--max-usd',
    String(args.maxUsd),
    '--limit',
    String(args.limit),
    '--dimensions',
    PROBE_QA_DIMENSIONS.join(','),
    '--json',
  ];
}

/**
 * Read the batch summary after the CLI returns.
 *
 * `eval cross-modal --batch` uses exit 1 for several paths: a scored FAIL
 * writes a summary, while some pre-flight/input failures do not. A missing
 * summary is therefore representable only for exit 1, but the caller MUST
 * treat the reason as ambiguous rather than inferring `budget_exceeded`.
 * Exit 0/2 without a summary remains an adapter/runtime error.
 */
export function readCrossModalProbeSummary(
  summaryPath: string,
  exitCode: number,
): CrossModalBatchSummary | undefined {
  if (!existsSync(summaryPath)) {
    if (exitCode === 1) return undefined;
    throw new Error(
      `nightly-probe-adapter: cross-modal --batch finished (exit ${exitCode}) but ` +
      `summary file is missing at ${summaryPath}. ` +
      `Hint: confirm the batch input JSONL is valid and writable.`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(summaryPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `nightly-probe-adapter: could not read cross-modal summary at ${summaryPath}: ` +
      `${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `nightly-probe-adapter: cross-modal summary at ${summaryPath} is malformed JSON: ` +
      `${(err as Error).message}. First 200 chars: ${raw.slice(0, 200)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(
      `nightly-probe-adapter: cross-modal summary at ${summaryPath} is not a JSON object`,
    );
  }

  // Cross-modal --batch --json wraps the summary as a top-level object;
  // pick the fields we care about and pass through. Tolerate the shape
  // being slightly larger (e.g. per-question receipts inline).
  const obj = parsed as Record<string, unknown>;
  const summary: CrossModalBatchSummary = {
    total: Number(obj.total ?? 0),
    pass_count: Number(obj.pass_count ?? 0),
    fail_count: Number(obj.fail_count ?? 0),
    inconclusive_count: Number(obj.inconclusive_count ?? 0),
    error_count: Number(obj.error_count ?? 0),
    upstream_error_count: Number(obj.upstream_error_count ?? 0),
    malformed_count: Number(obj.malformed_count ?? 0),
    est_cost_usd: Number(obj.est_cost_usd ?? 0),
    verdict: typeof obj.verdict === 'string' ? obj.verdict : 'unknown',
  };

  return summary;
}

/**
 * Adapter for `runEvalCrossModal --batch`. Threads `--output` so the summary
 * lands at the caller-controlled path, invokes the workspace CLI in-process,
 * then parses the optional exit-1 summary shape.
 */
export async function runCrossModalBatchForProbe(
  args: CrossModalProbeArgs,
): Promise<{ exitCode: number; summary?: CrossModalBatchSummary }> {
  const { runEvalCrossModal } = await import('../../commands/eval-cross-modal.ts');
  const exitCode = await runEvalCrossModal(buildCrossModalProbeArgv(args));
  return {
    exitCode,
    summary: readCrossModalProbeSummary(args.summaryPath, exitCode),
  };
}
