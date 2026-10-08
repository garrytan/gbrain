/**
 * Consent for the paid markdown reindex (wave 12 W4.5).
 *
 * `gbrain reindex --markdown` re-chunks every page whose chunker version or
 * contextual-retrieval state lags and re-embeds it, which bills the embedding
 * provider per token (and, under a contextual-retrieval mode that writes
 * per-chunk synopses, a chat model per chunk). It used to start without
 * asking. One gate, `requireReindexConsent`, now runs inside `runReindex`
 * for every caller: the CLI (`--yes`, `--max-usd`, a TTY prompt, a per-run
 * preapproval or `spend.posture=tokenmax`; otherwise exit 3), the `reindex`
 * Minion job handler (authorized only by the spend record stored on the job
 * at submit time, never by a prompt in the worker) and `jobs submit reindex`.
 * `--dry-run`, `--no-embed` and a keyless or free-provider brain spend
 * nothing and never ask.
 */
import type { BrainEngine } from './engine.ts';
import { requireConsent, type Authorization } from './consent.ts';
import { opError } from './ops/contract.ts';
import { MARKDOWN_CHUNKER_VERSION } from './chunkers/recursive.ts';

export interface ReindexSpendPlan {
  /** Pages the run would re-embed (after `--limit`). */
  pages: number;
  /** Embedding cost estimate for those pages; null when the model has no known price. */
  est_usd: number | null;
}

/** Pre-flight estimate from the text of the pages the run would re-embed (the `countPending` predicate, embedding on). */
export async function estimateReindexSpend(engine: BrainEngine, opts: { type: string | null; target: number }): Promise<ReindexSpendPlan> {
  try {
    const { getEmbeddingModel } = await import('./ai/gateway.ts');
    const { estimateCostFromChars, lookupEmbeddingPrice } = await import('./embedding-pricing.ts');
    const price = lookupEmbeddingPrice(getEmbeddingModel());
    if (price.kind !== 'known') return { pages: opts.target, est_usd: null };
    const rows = await engine.executeRaw<{ n: string | number; chars: string | number | null }>(
      `SELECT COUNT(*)::bigint AS n, COALESCE(SUM(LENGTH(compiled_truth) + LENGTH(timeline)), 0)::bigint AS chars
         FROM pages
        WHERE page_kind = 'markdown' AND (chunker_version < $1 OR contextual_retrieval_mode IS NULL)
          AND deleted_at IS NULL AND ($2::text IS NULL OR type = $2)`,
      [MARKDOWN_CHUNKER_VERSION, opts.type]);
    const pending = Number(rows[0]?.n ?? 0);
    const chars = Number(rows[0]?.chars ?? 0) * (pending > 0 ? Math.min(1, opts.target / pending) : 1);
    return { pages: opts.target, est_usd: estimateCostFromChars(chars, price.pricePerMTok) };
  } catch {
    return { pages: opts.target, est_usd: null };
  }
}

/**
 * Null when the run cannot spend (embedding disabled, no credentials, a free
 * local provider); otherwise the Authorization, or throws the exit-3
 * `confirmation_required` refusal (`isConsentRefusal`) carrying the page
 * count and estimate. `interactive: false` (the job handler) never prompts.
 * A user cap below the estimate refuses up front with `cost_cap_exceeded`.
 */
export async function requireReindexConsent(engine: BrainEngine, opts: {
  args: readonly string[];
  type: string | null;
  target: number;
  interactive?: boolean;
  /** The approved command without `--yes` (default `gbrain reindex <args>`), and its free preview. */
  argv?: string[];
  preview_argv?: string[];
}): Promise<{ auth: Authorization; plan: ReindexSpendPlan } | null> {
  const { embedWouldSpend } = await import('./embed-consent.ts');
  if (opts.target <= 0 || !(await embedWouldSpend(engine))) return null;
  const plan = await estimateReindexSpend(engine, opts);
  const cost = plan.est_usd === null ? 'cost unknown in advance' : `about $${plan.est_usd.toFixed(2)}`;
  const base = ['gbrain', 'reindex', ...opts.args.filter((a) => a !== '--yes' && a !== '--json')];
  const plain: string[] = [];
  for (let i = 0; i < opts.args.length; i++) {
    const a = opts.args[i]!;
    if (a === '--yes' || a === '--json' || a.startsWith('--max-usd=') || a.startsWith('--max-cost=')) continue;
    if (a === '--max-usd' || a === '--max-cost') { i++; continue; }
    plain.push(a);
  }
  const auth = await requireConsent({
    command: 'reindex',
    effects: ['paid'],
    actor: 'agent',
    what: `Re-embed ${plan.pages} markdown page(s)`,
    why: `Re-chunking a page re-embeds it with the configured embedding provider, which bills per token (${cost} for ${plan.pages} page(s)); a contextual-retrieval mode that writes per-chunk synopses also calls a chat model per chunk.`,
    risk: 'Spends money with the embedding provider (and the chat provider under per-chunk contextual retrieval). Search keeps working on the old chunks until the reindex runs.',
    user_message: `Rebuilding the search index re-embeds ${plan.pages} page(s) and costs money (${cost}). OK to run it?`,
    argv: opts.argv ?? base,
    preview_argv: opts.preview_argv ?? ['gbrain', 'reindex', ...plain, '--dry-run'],
    est_usd: plan.est_usd,
    args: opts.args,
  }, { getConfig: (key) => engine.getConfig(key), ...(opts.interactive === false ? { interactive: false } : {}) });
  if (auth.cap_usd !== null && plan.est_usd !== null && plan.est_usd > auth.cap_usd) {
    throw opError('cost_cap_exceeded',
      `The reindex of ${plan.pages} page(s) is estimated at $${plan.est_usd.toFixed(2)}, above the $${auth.cap_usd.toFixed(2)} cap; nothing ran.`,
      'Ask the user whether to raise the cap, then re-run with a higher --max-usd, or narrow the run with --limit or --type.',
      { why: 'A run whose estimate exceeds its cap would stop part-way.' });
  }
  return { auth, plan };
}
