/**
 * eval-contradictions/cost-prompt — Lane C cost-estimate prompt.
 *
 * Fires before the probe runs when PROMPT_VERSION has changed since the most
 * recent persisted run (so the operator sees the one-time re-judge cost up
 * front instead of being surprised by it inside an autopilot cycle). Pattern
 * mirrors `runPostUpgradeReembedPrompt` in post-upgrade-reembed.ts:
 *
 *   - TTY-only Ctrl-C window (default 10s; override via
 *     GBRAIN_PROBE_PROMPT_GRACE_SECONDS).
 *   - Non-TTY auto-proceeds with a stderr note (autopilot path).
 *   - GBRAIN_NO_PROBE_PROMPT=1 skips entirely.
 *
 * Independent of the runner's `--budget-usd` hard cap: this prompt informs;
 * the cap enforces. Both layers compose — operator sees the estimate, then
 * the runner halts mid-run if the live cost exceeds the cap.
 */

import type { BrainEngine } from '../engine.ts';
import { estimateUpperBoundCost } from './cost-tracker.ts';
import { PROMPT_VERSION } from './types.ts';

export interface CostPromptOpts {
  engine: BrainEngine;
  queryCount: number;
  topK: number;
  judgeModel: string;
  /** True when the user passed --yes; skip the prompt entirely. */
  yesOverride?: boolean;
  /** Override TTY detection for testing. */
  isTtyOverride?: boolean;
  /** Override stderr writer for testing. */
  stderrWriter?: (text: string) => void;
  /** Override the wait function for testing (returns 'proceed' or 'abort'). */
  waitFn?: (graceSeconds: number) => Promise<'proceed' | 'abort'>;
}

export type CostPromptResult =
  | { kind: 'proceed'; reason: 'env_skip' | 'yes_override' | 'no_version_change' | 'non_tty_auto' | 'tty_proceed' }
  | { kind: 'abort'; reason: 'tty_ctrl_c' };

/** Read the prompt_version of the most recent persisted run. */
async function readLastPromptVersion(engine: BrainEngine): Promise<string | null> {
  try {
    const rows = await engine.executeRaw<{ prompt_version: string }>(
      `SELECT prompt_version FROM eval_contradictions_runs ORDER BY ran_at DESC LIMIT 1`,
    );
    if (rows && rows.length > 0 && typeof rows[0].prompt_version === 'string') {
      return rows[0].prompt_version;
    }
  } catch {
    // Table missing (pre-v0.32 brains) or transient error — treat as null
    // (which fires the prompt on first run, the correct default).
  }
  return null;
}

/** Default TTY waiter: prints countdown and resolves on SIGINT or timeout. */
function defaultWaitFn(graceSeconds: number): Promise<'proceed' | 'abort'> {
  return new Promise((resolve) => {
    let aborted = false;
    const onSigint = () => {
      if (aborted) return;
      aborted = true;
      process.removeListener('SIGINT', onSigint);
      resolve('abort');
    };
    process.on('SIGINT', onSigint);
    setTimeout(() => {
      if (aborted) return;
      process.removeListener('SIGINT', onSigint);
      resolve('proceed');
    }, graceSeconds * 1000);
  });
}

/**
 * Public entry. Returns whether the runner should proceed. Honors the
 * --yes override, GBRAIN_NO_PROBE_PROMPT, TTY detection, and the persisted
 * last-run prompt_version comparison.
 */
export async function maybePromptForCostBeforeProbe(
  opts: CostPromptOpts,
): Promise<CostPromptResult> {
  if (opts.yesOverride) {
    return { kind: 'proceed', reason: 'yes_override' };
  }
  if (process.env.GBRAIN_NO_PROBE_PROMPT === '1') {
    return { kind: 'proceed', reason: 'env_skip' };
  }

  const lastVersion = await readLastPromptVersion(opts.engine);
  if (lastVersion === PROMPT_VERSION) {
    return { kind: 'proceed', reason: 'no_version_change' };
  }

  const stderr = opts.stderrWriter ?? ((text: string) => process.stderr.write(text));
  const isTty = opts.isTtyOverride ?? (process.stderr.isTTY === true);

  // Conservative pair-count upper bound — same formula the runner uses for
  // its own pre-flight check. Cost estimate covers the worst-case re-judge.
  const conservativePairsPerQuery = (opts.topK * (opts.topK - 1)) / 2 + opts.topK * 2;
  const estimatedCost = estimateUpperBoundCost({
    pairCount: opts.queryCount * conservativePairsPerQuery,
    queryCount: opts.queryCount,
    judgeModel: opts.judgeModel,
  });
  const banner = [
    `[contradiction probe] PROMPT_VERSION changed (${lastVersion ?? 'none'} → ${PROMPT_VERSION}).`,
    `Old verdicts in the persistent cache no longer apply; this run will re-judge from scratch.`,
    `Upper-bound estimate for ${opts.queryCount} queries × top-${opts.topK} on ${opts.judgeModel}: ~$${estimatedCost.toFixed(2)}.`,
    `(--budget-usd N hard-caps the run; default values are conservative.)`,
  ].join('\n');

  if (!isTty) {
    // Autopilot / scripted invocation: emit the estimate and proceed.
    stderr(`${banner}\nNon-TTY: proceeding automatically. Set GBRAIN_NO_PROBE_PROMPT=1 to suppress.\n`);
    return { kind: 'proceed', reason: 'non_tty_auto' };
  }

  const graceRaw = process.env.GBRAIN_PROBE_PROMPT_GRACE_SECONDS;
  const graceSeconds = graceRaw && Number.isFinite(Number(graceRaw)) && Number(graceRaw) >= 0
    ? Number(graceRaw)
    : 10;
  stderr(`${banner}\nPress Ctrl-C within ${graceSeconds}s to abort, or wait to proceed.\n`);
  const waiter = opts.waitFn ?? defaultWaitFn;
  const decision = await waiter(graceSeconds);
  if (decision === 'abort') {
    stderr(`[contradiction probe] aborted by Ctrl-C.\n`);
    return { kind: 'abort', reason: 'tty_ctrl_c' };
  }
  return { kind: 'proceed', reason: 'tty_proceed' };
}
