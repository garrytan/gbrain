/**
 * v0.32.7 CJK wave — post-upgrade chunker-bump cost prompt.
 *
 * When `MARKDOWN_CHUNKER_VERSION` bumps, every markdown page needs a
 * re-chunk + re-embed. Re-embed has a real OpenAI bill ($X) and wall-clock
 * cost (Y min) proportional to the brain size. On a 1386-page brain that's
 * pennies; on a 100K-page brain it's tens of dollars. Surprise OpenAI bills
 * are how trust breaks.
 *
 * Per D3=B: print a stderr line with the real-data estimate before the
 * sweep starts, give the operator 10 seconds to Ctrl-C, then proceed.
 *
 * TTY-only wait so non-TTY upgrades (CI, cron-driven, headless) don't hang.
 *
 * Codex C3 corrections in place:
 *   - Real SQL queries against `pages.chunker_version < N AND page_kind = 'markdown'`
 *     for both page count and char total. No phantom `markdown_body` column.
 *   - Pricing lookup through `src/core/embedding-pricing.ts` keyed on
 *     `provider:model` from the configured gateway, with a clear
 *     "estimate unavailable" message for unknown providers.
 */

import type { BrainEngine } from './engine.ts';
import { MARKDOWN_CHUNKER_VERSION } from './chunkers/recursive.ts';
import { lookupEmbeddingPrice, estimateCostFromChars } from './embedding-pricing.ts';

export interface ReembedEstimate {
  pendingCount: number;
  pendingChars: number;
  estimatedTokens: number;
  estimatedCostUsd: number | null;
  modelString: string;
  pricingKnown: boolean;
}

/**
 * Compute the re-embed estimate using only what's actually on the `pages`
 * table after migration v52 applied. Used by both the post-upgrade prompt
 * and tests.
 */
export async function computeReembedEstimate(
  engine: BrainEngine,
  modelString: string,
): Promise<ReembedEstimate> {
  const rows = await engine.executeRaw<{ pending_count: string | number; pending_chars: string | number | null }>(
    `SELECT COUNT(*)::bigint AS pending_count,
            COALESCE(SUM(LENGTH(compiled_truth)) + SUM(LENGTH(timeline)), 0)::bigint AS pending_chars
       FROM pages
      WHERE page_kind = 'markdown'
        AND chunker_version < $1
        AND deleted_at IS NULL`,
    [MARKDOWN_CHUNKER_VERSION],
  );
  const pendingCount = Number(rows[0]?.pending_count ?? 0);
  const pendingChars = Number(rows[0]?.pending_chars ?? 0);
  const price = lookupEmbeddingPrice(modelString);

  if (price.kind === 'known') {
    const estimatedCostUsd = estimateCostFromChars(pendingChars, price.pricePerMTok);
    return {
      pendingCount,
      pendingChars,
      estimatedTokens: Math.ceil(pendingChars / 3.5),
      estimatedCostUsd,
      modelString,
      pricingKnown: true,
    };
  }
  return {
    pendingCount,
    pendingChars,
    estimatedTokens: Math.ceil(pendingChars / 3.5),
    estimatedCostUsd: null,
    modelString,
    pricingKnown: false,
  };
}

/**
 * Format the operator-facing stderr line. Pure function so tests can pin
 * the exact wording.
 */
export function formatReembedPrompt(est: ReembedEstimate, graceSeconds: number): string {
  if (est.pendingCount === 0) {
    return `[chunker-bump] No pending markdown pages. Skipping re-embed.`;
  }
  const minEst = Math.max(1, Math.ceil(est.pendingCount / 60)); // ~60 pages/min wall-clock heuristic
  if (est.pricingKnown && est.estimatedCostUsd !== null) {
    const dollars = est.estimatedCostUsd.toFixed(2);
    return `[chunker-bump] Will re-embed ~${est.pendingCount} markdown pages via ${est.modelString}, est. ~$${dollars}, ~${minEst}min. Press Ctrl-C within ${graceSeconds}s to abort.`;
  }
  return `[chunker-bump] Will re-embed ~${est.pendingCount} markdown pages via ${est.modelString}; pricing estimate unavailable for this provider. Press Ctrl-C within ${graceSeconds}s to abort.`;
}

export interface PromptResult {
  proceeded: boolean;
  reason: 'no_pending' | 'bypassed_no_reembed' | 'tty_proceeded' | 'non_tty_proceeded';
  estimate: ReembedEstimate;
}

/**
 * Run the post-upgrade chunker-bump prompt + grace window. Returns whether
 * the caller should proceed to invoke `gbrain reindex --markdown`.
 *
 * Env overrides (codex C3 + D3=B):
 *   - GBRAIN_NO_REEMBED=1     → bail out entirely (writes a doctor warning marker).
 *   - GBRAIN_REEMBED_GRACE_SECONDS=0 → skip wait (proceed immediately).
 *   - Non-TTY (CI / cron) → skip wait, proceed.
 */
export async function runPostUpgradeReembedPrompt(
  engine: BrainEngine,
  modelString: string,
  opts: {
    /** Override for tests: pretend stdin is/isn't a TTY. */
    isTTY?: boolean;
    /** Override for tests: how long the wait window is. */
    graceSeconds?: number;
    /** Override for tests: env-var bag. Defaults to process.env. */
    env?: Record<string, string | undefined>;
    /** Override for tests: where to write. Defaults to process.stderr. */
    write?: (line: string) => void;
  } = {},
): Promise<PromptResult> {
  const env = opts.env ?? process.env;
  const writeFn = opts.write ?? ((line: string) => process.stderr.write(line + '\n'));
  const estimate = await computeReembedEstimate(engine, modelString);

  if (estimate.pendingCount === 0) {
    return { proceeded: false, reason: 'no_pending', estimate };
  }

  if (env.GBRAIN_NO_REEMBED === '1') {
    writeFn(`[chunker-bump] GBRAIN_NO_REEMBED=1 set; skipping re-embed sweep. Pending: ${estimate.pendingCount} pages. Re-run \`gbrain reindex --markdown\` when ready.`);
    return { proceeded: false, reason: 'bypassed_no_reembed', estimate };
  }

  const grace = typeof opts.graceSeconds === 'number'
    ? opts.graceSeconds
    : (() => {
        const n = parseInt(env.GBRAIN_REEMBED_GRACE_SECONDS ?? '', 10);
        return Number.isFinite(n) && n >= 0 ? n : 10;
      })();

  writeFn(formatReembedPrompt(estimate, grace));

  const isTTY = typeof opts.isTTY === 'boolean'
    ? opts.isTTY
    : Boolean(process.stdin.isTTY);

  if (!isTTY || grace === 0) {
    return { proceeded: true, reason: isTTY ? 'tty_proceeded' : 'non_tty_proceeded', estimate };
  }

  await new Promise<void>(resolveSleep => setTimeout(resolveSleep, grace * 1000));
  return { proceeded: true, reason: 'tty_proceeded', estimate };
}
