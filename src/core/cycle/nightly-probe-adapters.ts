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
import { loadConfig } from '../config.ts';
import { buildGatewayConfig } from '../ai/build-gateway-config.ts';
import { configureGateway, requireConfig } from '../ai/gateway.ts';

/**
 * The adapter is normally called from autopilot after connectEngine has
 * configured the gateway. Direct in-process callers (including recovery
 * probes) do not pass through cli.ts's no-DB LongMemEval bootstrap, however.
 * Initialize only when absent so an autopilot process keeps its richer merged
 * DB+file configuration.
 */
function ensureProbeGatewayConfigured(): void {
  try {
    requireConfig();
    return;
  } catch {
    const config = loadConfig() ?? ({} as NonNullable<ReturnType<typeof loadConfig>>);
    configureGateway(buildGatewayConfig(config));
  }
}

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
  /** Optional explicit judge route; defaults to the configured chat model. */
  judgeModel?: string;
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
  ensureProbeGatewayConfigured();
  const { runEvalLongMemEval } = await import('../../commands/eval-longmemeval.ts');
  // LongMemEval has two independent chat lanes: answer generation and the
  // trajectory claim extractor. Its generic CLI defaults intentionally target
  // the benchmark's historical Sonnet/Haiku pair, but a nightly installation
  // probe must exercise the provider this installation actually configured.
  // Route BOTH lanes explicitly; otherwise a MiniMax/OpenAI-only installation
  // still fails in the hidden extractor with "Anthropic chat requires...".
  const probeModel = loadConfig()?.chat_model;
  // Match the production max-recall posture while honoring the installation's
  // explicit lack of a reranker credential. Without --no-reranker the
  // ephemeral benchmark brain falls back to tokenmax's ZeroEntropy default,
  // creating auth failures unrelated to retrieval quality.
  await runEvalLongMemEval([
    args.fixturePath,
    '--output', args.outputPath,
    '--mode', 'tokenmax',
    '--no-reranker',
    '--by-type',
    ...(probeModel ? ['--model', probeModel] : []),
  ], probeModel ? { extractorModel: probeModel } : {});
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

export async function runCrossModalBatchForProbe(
  args: CrossModalProbeArgs,
): Promise<{ exitCode: number; summary: CrossModalBatchSummary }> {
  const { runEvalCrossModal } = await import('../../commands/eval-cross-modal.ts');
  // The general cross-modal command intentionally defaults to three frontier
  // providers. A nightly installation probe must instead use a route this
  // installation actually configured; otherwise missing OpenAI/Google keys
  // make every run inconclusive even when the active provider is healthy.
  // Repeating the configured model across three slots preserves the runner's
  // parse/aggregation checks while making provider reachability truthful.
  const judgeModel = args.judgeModel ?? loadConfig()?.chat_model;
  const slotArgs = judgeModel
    ? [
        '--slot-a-model', judgeModel,
        '--slot-b-model', judgeModel,
        '--slot-c-model', judgeModel,
      ]
    : [];
  const exitCode = await runEvalCrossModal([
    '--batch',
    args.batchPath,
    '--output',
    args.summaryPath,
    '--max-usd',
    String(args.maxUsd),
    '--dimensions',
    PROBE_QA_DIMENSIONS.join(','),
    ...slotArgs,
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
