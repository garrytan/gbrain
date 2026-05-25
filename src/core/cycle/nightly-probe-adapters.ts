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
}

/** Cross-modal batch summary shape (matches `runEvalCrossModal --batch --json`'s envelope). */
export interface CrossModalBatchSummary {
  pass_count: number;
  fail_count: number;
  inconclusive_count: number;
  error_count: number;
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
 * Adapter for `runEvalCrossModal --batch`. Threads `--output` so the
 * summary lands at the caller-controlled path (codex round-2 #1 fix),
 * then reads + parses the summary from that path.
 *
 * Returns `{ exitCode, summary }` shape so the caller can both surface the
 * verdict and decide what to do with non-zero exit codes (cost overrun,
 * gate failure, etc).
 *
 * Throws if `summaryPath` is missing after the run (caller misconfigured
 * the batch input) or unparseable (cross-modal wrote garbage). Both
 * cases are paste-ready in the error message.
 */
export async function runCrossModalBatchForProbe(
  args: CrossModalProbeArgs,
): Promise<{ exitCode: number; summary: CrossModalBatchSummary }> {
  const { runEvalCrossModal } = await import('../../commands/eval-cross-modal.ts');
  const exitCode = await runEvalCrossModal([
    '--batch',
    args.batchPath,
    '--output',
    args.summaryPath,
    '--max-usd',
    String(args.maxUsd),
    '--yes',
    '--json',
  ]);

  if (!existsSync(args.summaryPath)) {
    throw new Error(
      `nightly-probe-adapter: cross-modal --batch finished (exit ${exitCode}) but ` +
      `summary file is missing at ${args.summaryPath}. ` +
      `Hint: confirm the batch input JSONL is valid and writable.`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(args.summaryPath, 'utf-8');
  } catch (err) {
    throw new Error(
      `nightly-probe-adapter: could not read cross-modal summary at ${args.summaryPath}: ` +
      `${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `nightly-probe-adapter: cross-modal summary at ${args.summaryPath} is malformed JSON: ` +
      `${(err as Error).message}. First 200 chars: ${raw.slice(0, 200)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(
      `nightly-probe-adapter: cross-modal summary at ${args.summaryPath} is not a JSON object`,
    );
  }

  // Cross-modal --batch --json wraps the summary as a top-level object;
  // pick the fields we care about and pass through. Tolerate the shape
  // being slightly larger (e.g. per-question receipts inline).
  const obj = parsed as Record<string, unknown>;
  const summary: CrossModalBatchSummary = {
    pass_count: Number(obj.pass_count ?? 0),
    fail_count: Number(obj.fail_count ?? 0),
    inconclusive_count: Number(obj.inconclusive_count ?? 0),
    error_count: Number(obj.error_count ?? 0),
    est_cost_usd: Number(obj.est_cost_usd ?? 0),
    verdict: typeof obj.verdict === 'string' ? obj.verdict : 'unknown',
  };

  return { exitCode, summary };
}
