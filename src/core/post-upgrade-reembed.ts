/**
 * v0.32.7 CJK wave — post-upgrade chunker-bump cost prompt.
 *
 * When `MARKDOWN_CHUNKER_VERSION` bumps, every markdown page needs a
 * re-chunk + re-embed. Re-embed has a real OpenAI bill ($X) and wall-clock
 * cost (Y min) proportional to the brain size. On a 1386-page brain that's
 * pennies; on a 100K-page brain it's tens of dollars. Surprise OpenAI bills
 * are how trust breaks.
 *
 * Print a stderr line with the real-data estimate, then re-embed only on an
 * affirmative answer: a TTY operator must type `y`; a non-TTY upgrade (CI,
 * cron, an agent) never spends and prints the commands to run instead
 * (security wave ENG-3: no paid work without consent).
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
 * table after migration v54 applied. Used by both the post-upgrade prompt
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
export function formatReembedPrompt(est: ReembedEstimate): string {
  if (est.pendingCount === 0) {
    return `[chunker-bump] No pending markdown pages. Skipping re-embed.`;
  }
  const minEst = Math.max(1, Math.ceil(est.pendingCount / 60)); // ~60 pages/min wall-clock heuristic
  // v0.40.3.0 — chunker version bump to 3 includes the contextual retrieval
  // wrapper (Anthropic's published methodology). Re-embed picks up the
  // title-tier wrapper for balanced-mode users automatically (free at
  // runtime — pure string concat). Tokenmax users can later run
  // `gbrain config set search.mode tokenmax` to upgrade pages to per-chunk
  // Haiku synopsis via the contextual_reindex_per_chunk Minion handler.
  // Documented inline so the prompt explains WHY the re-embed is firing.
  const crNote =
    `\n[contextual retrieval] v0.40.3.0 wraps each chunk with its page ` +
    `title before embedding (Anthropic's published method).`;
  if (est.pricingKnown && est.estimatedCostUsd !== null) {
    const dollars = est.estimatedCostUsd.toFixed(2);
    return `[chunker-bump] Re-embedding ~${est.pendingCount} markdown pages via ${est.modelString} would cost est. ~$${dollars}, ~${minEst}min.${crNote}`;
  }
  return `[chunker-bump] Re-embedding ~${est.pendingCount} markdown pages via ${est.modelString} has a cost; pricing estimate unavailable for this provider.${crNote}`;
}

export interface PromptResult {
  proceeded: boolean;
  reason: 'no_pending' | 'bypassed_no_reembed' | 'consent_required' | 'tty_declined' | 'tty_consented';
  estimate: ReembedEstimate;
}

/** What to run instead when the operator has not agreed to re-embed now. */
export const REEMBED_DEFERRED_HINT = '[chunker-bump] Not re-embedding without your consent. When ready: `gbrain reindex --markdown` '
  + '(re-embeds), or `gbrain repair safe-chunks --apply --no-embed` to re-chunk without provider calls, then `gbrain embed --stale`.';

/** interaction.readLine: EOF, a 5-minute silence or no human at the terminal read as "no". */
async function askYesNo(question: string): Promise<boolean> {
  const { readLine } = await import('./interaction.ts');
  const read = await readLine({ prompt: question });
  return read.kind === 'line' && /^y(es)?$/i.test(read.text);
}

/**
 * Run the post-upgrade chunker-bump prompt. Returns whether the caller should
 * proceed to invoke `gbrain reindex --markdown`, which calls the embedding
 * provider. It proceeds only when a TTY operator answers yes; the default,
 * a non-TTY run and an unanswered prompt all decline and print
 * REEMBED_DEFERRED_HINT. `GBRAIN_NO_REEMBED=1` skips the prompt entirely.
 */
export async function runPostUpgradeReembedPrompt(
  engine: BrainEngine,
  modelString: string,
  opts: {
    /** Override for tests: pretend stdin is/isn't a TTY. */
    isTTY?: boolean;
    /** Override for tests: the yes/no answer source. Defaults to a readline prompt on stdin. */
    confirm?: (question: string) => Promise<boolean>;
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

  writeFn(formatReembedPrompt(estimate));

  const isTTY = typeof opts.isTTY === 'boolean' ? opts.isTTY : (await import('./interaction.ts')).isInteractive();
  if (!isTTY) {
    writeFn(REEMBED_DEFERRED_HINT);
    return { proceeded: false, reason: 'consent_required', estimate };
  }

  const consented = await (opts.confirm ?? askYesNo)('[chunker-bump] Re-embed now? [y/N] ');
  if (!consented) {
    writeFn(REEMBED_DEFERRED_HINT);
    return { proceeded: false, reason: 'tty_declined', estimate };
  }
  return { proceeded: true, reason: 'tty_consented', estimate };
}
