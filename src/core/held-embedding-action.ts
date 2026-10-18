/**
 * The one approval for large pages that wait for embedding (#6803 part 3,
 * #6847): the phrase every surface prints, the approval amount, and the
 * Action `gbrain embed --stale`, the embed-backfill job, doctor
 * `partial_embedding`, `gbrain embed --held --dry-run` and the per-page hold
 * line in `meterPageBatch` all render.
 *
 * The approval is `--max-usd N`, which is both the run's hard cap (paid
 * providers) and the extra per-page allowance the ledger saves, so N is a
 * ceiling, never the estimate: the pending text priced at the higher of the
 * run meter's rate (the budget tracker's chars-per-token basis) and the
 * per-page ledger's, through `derivedCapUsd` (x1.5, $0.25 floor, rounded up to
 * the cent). Dense text (CJK, minified code) bills more tokens than the
 * chars-per-token basis assumes; the floor and the headroom absorb that. A
 * provider whose recipe bills nothing gets the $0.01 floor and no paid/egress
 * consent.
 *
 * Leaf module: page-embedding-budget.ts imports it, so it never imports that.
 */
import { cliRenderContext, renderAction, type Action, type RenderContext } from './agent-output.ts';
import { derivedCapUsd } from './consent.ts';
import { reservationCostUsd } from './budget/reservation-cost.ts';
import { estimateCostFromChars, lookupEmbeddingPrice } from './embedding-pricing.ts';
import { DEFAULT_CHARS_PER_TOKEN } from './ai/embed-batch-plan.ts';
import { getRecipe } from './ai/recipes/index.ts';

/** Price assumed for a model with no known rate (the conservative OpenAI large rate). */
export const UNPRICED_RATE_PER_MTOK = 0.13;
/** The approval a provider that bills nothing needs: never 0, which consent does not read as an approval. */
export const FREE_APPROVAL_USD = 0.01;
export const HELD_DOCS = 'docs/guides/memory-boundaries.md#large-pages';

/** True when the provider in `model` (`provider:model[:dims]`) is a local recipe billing $0 (ollama, llama-server, lmstudio). */
export function recipeIsFree(model: string | null | undefined): boolean {
  if (!model) return false;
  return getRecipe(model.split(':')[0] ?? '')?.touchpoints?.embedding?.cost_per_1m_tokens_usd === 0;
}

/** The per-page ledger's rate for the embedding signature: $0 for a free recipe, the known price, else the conservative fallback. */
export function ledgerPricePerMTok(signature: string | null | undefined): { rate: number; priced: boolean } {
  if (!signature) return { rate: UNPRICED_RATE_PER_MTOK, priced: false };
  if (recipeIsFree(signature)) return { rate: 0, priced: true };
  const hit = lookupEmbeddingPrice(signature.slice(0, signature.lastIndexOf(':')) || signature);
  return hit.kind === 'known' ? { rate: hit.pricePerMTok, priced: true } : { rate: UNPRICED_RATE_PER_MTOK, priced: false };
}

export interface ApprovalBasis { model: string | null; signature: string | null; free: boolean; charsPerToken: number }

/** The configured embedding model's pricing basis; an unreadable gateway reads as a paid, unknown model. */
export async function approvalBasis(): Promise<ApprovalBasis> {
  try {
    const { getEmbeddingModel } = await import('./ai/gateway.ts');
    const { currentEmbeddingSignature } = await import('./embedding.ts');
    const model = getEmbeddingModel();
    const charsPerToken = getRecipe(model.split(':')[0] ?? '')?.touchpoints?.embedding?.chars_per_token ?? DEFAULT_CHARS_PER_TOKEN;
    return { model, signature: currentEmbeddingSignature(), free: recipeIsFree(model), charsPerToken: Math.max(charsPerToken, 1) };
  } catch {
    return { model: null, signature: null, free: false, charsPerToken: DEFAULT_CHARS_PER_TOKEN };
  }
}

/** What approving `chars` of pending chunk text costs (`est_usd`) and the `--max-usd` to print (`max_usd`). */
export function approvalAmount(chars: number, basis: ApprovalBasis): { est_usd: number; max_usd: number } {
  if (basis.free) return { est_usd: 0, max_usd: FREE_APPROVAL_USD };
  const metered = basis.model ? reservationCostUsd(basis.model, 'embed', Math.ceil(chars / basis.charsPerToken), 0) : null;
  const est = Math.max(metered ?? 0, estimateCostFromChars(chars, ledgerPricePerMTok(basis.signature ?? basis.model).rate));
  return { est_usd: est, max_usd: derivedCapUsd(est) };
}

export interface HeldTarget { source_id: string; slug?: string; pending_chunks: number; est_usd: number; max_usd: number }

const previewArgv = (sourceId: string) => ['gbrain', 'embed', '--held', '--dry-run', '--source', sourceId, '--json'];

/**
 * The approve Action for one source (or one page of it, `slug`): run
 * `gbrain embed --held --source S --max-usd N`, preview and verify with the
 * same source-scoped dry run (held 0 for that source once it ran). Always
 * `ask_user`: the hold is the user's consent gate (no automatic release).
 */
export function heldApproveAction(target: HeldTarget, free: boolean): Action {
  const n = target.max_usd.toFixed(2);
  const scope = target.slug ? ['--slugs', target.slug, '--source', target.source_id] : ['--held', '--source', target.source_id];
  const what = `${target.pending_chunks} chunk(s) of ${target.slug ? `the large page ${target.slug}` : 'large pages'} in source ${target.source_id}`;
  const cost = free
    ? 'the embedding provider bills nothing, so the run costs nothing'
    : `estimated $${target.est_usd.toFixed(2)}, spends at most $${n}`;
  return {
    argv: ['gbrain', 'embed', ...scope, '--max-usd', n],
    preview_argv: previewArgv(target.source_id),
    consent: free ? [] : ['paid', 'egress'],
    actor: 'agent',
    ask_user: true,
    why: `${what} wait for embedding approval and stay keyword-only until approved (${cost}). --max-usd is both the run's cap and the per-page allowance it saves; a run stopped early keeps what it embedded, and the rest waits for the next approval.`,
    user_message: free
      ? `${what} are not indexed for meaning-based search yet. Embedding them runs on your local embedding model and costs nothing. OK to embed them?`
      : `${what} are not indexed for meaning-based search yet. Embedding them sends their text to your embedding provider: ${cost}. OK to spend it?`,
    verify: { argv: previewArgv(target.source_id) },
    requires_exclusive: false,
    docs: HELD_DOCS,
  };
}

/** The rendered shell command of an Action (routing pinned, as every printed fix is). */
export function renderedCommand(action: Action, ctx: RenderContext = cliRenderContext()): string {
  return renderAction(action, ctx).command ?? action.argv!.join(' ');
}

/**
 * `gbrain embed --held --dry-run [--source S]`, rendered. Without a source it
 * lists every source, so it opts out of routing's source pin (a pinned
 * `--source` would narrow the listing to the ambient source); the brain pin stays.
 */
export function heldPreviewCommand(sourceId?: string, ctx: RenderContext = cliRenderContext()): string {
  const argv = ['gbrain', 'embed', '--held', '--dry-run', ...(sourceId ? ['--source', sourceId] : [])];
  const routing = sourceId ? ctx.routing : ctx.routing?.brain ? { brain: ctx.routing.brain } : undefined;
  return renderedCommand({ argv, consent: [], actor: 'agent', why: 'Lists the held and capped large pages with the cost to finish; read-only.', requires_exclusive: false },
    { ...ctx, routing });
}

export interface BudgetLimitedCounts { held: number; capped: number; held_reasons: Record<string, number> }

/** The one sentence every surface prints about pages waiting for approval. */
export function budgetLimitedPhrase(b: BudgetLimitedCounts): string {
  const reasons = Object.entries(b.held_reasons);
  const parts = [
    ...(b.held ? [`${b.held} held: ${reasons.length === 1 ? reasons[0]![0] : reasons.map(([reason, n]) => `${reason} ${n}`).join(', ')}`] : []),
    ...(b.capped ? [`${b.capped} at their per-page cap`] : []),
  ];
  return `${b.held + b.capped} large page(s) have chunks waiting for embedding approval (${parts.join('; ')}); those chunks are keyword-only until approved.`;
}
