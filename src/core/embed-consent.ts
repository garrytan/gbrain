/**
 * Consent for explicit embedding backfills (agent operator contract v1, A4).
 *
 * An explicit backfill (`gbrain embed --stale|--all|--catch-up|<slug>|--facts|--images`,
 * `gbrain jobs submit embed|embed-backfill|embed-catch-up`, `gbrain features --auto-fix`)
 * spends money with the embedding provider, so a CLI handler calls
 * `requireEmbedBackfillConsent()` first: `--yes`, `--max-usd`, `spend.posture=tokenmax`
 * or a per-run preapproval authorize it; a non-interactive run without one exits 3.
 *
 * Out of scope on purpose (no silent flip): the library paths autopilot, cycles and
 * queued jobs already run unattended under their configured budget (`runEmbedCore`,
 * job handlers), and write-path embedding of new content (put_page, import, sync,
 * timeline-add) under a configured key, which is the configured feature, not a
 * separate paid action. See docs/protocol/AGENT_OPERATOR_v1.md "Consent and preapproval".
 */
import type { BrainEngine } from './engine.ts';
import type { Action } from './agent-output.ts';
import { requireConsent, type Authorization } from './consent.ts';
import { opError } from './ops/contract.ts';

/** Job names whose handler is an embedding backfill (an explicit `jobs submit` of one is paid work). */
export const EMBED_BACKFILL_JOB_NAMES: ReadonlySet<string> = new Set(['embed', 'embed-backfill', 'embed-catch-up']);

export interface EmbedBackfillScope {
  /** Every chunk is re-embedded (`--all`); otherwise only chunks without a vector (and chunkless pages). */
  all?: boolean;
  sourceId?: string;
  /** Slug lists, facts and images have no cheap pre-flight estimate. */
  unestimated?: boolean;
}

/**
 * The doctor-side fix for an embedding backlog: the catch-up drain, `paid`
 * (so `next` renders `ask_user`), with `--yes` so it runs verbatim once the
 * user agrees, and the read-only `--dry-run` preview.
 */
export function embedBackfillFix(opts: { backlog: number; verifyCheck: string }): Action {
  const run = ['gbrain', 'embed', '--stale', '--catch-up'];
  return {
    argv: [...run, '--yes'],
    preview_argv: [...run, '--dry-run'],
    consent: ['paid'],
    actor: 'agent',
    why: `${opts.backlog} chunk(s) have no embedding, so vector search cannot see them. The catch-up drain embeds them until the backlog is empty; it sends page text to the embedding provider and costs money.`,
    user_message: `${opts.backlog} piece(s) of your notes are not indexed for meaning-based search yet. Indexing them sends the text to your embedding provider and costs a little money. OK to run it?`,
    verify: { argv: ['gbrain', 'doctor', '--only', opts.verifyCheck, '--json'] },
    requires_exclusive: false,
  };
}

/** A local embedding provider whose recipe bills nothing (ollama, llama-server, lmstudio): no spend, no egress. */
export async function embeddingProviderIsFree(model?: string): Promise<boolean> {
  try {
    const { getEmbeddingModel } = await import('./ai/gateway.ts');
    const { getRecipe } = await import('./ai/recipes/index.ts');
    const provider = (model ?? getEmbeddingModel()).split(':')[0] ?? '';
    return getRecipe(provider)?.touchpoints?.embedding?.cost_per_1m_tokens_usd === 0;
  } catch {
    return false;
  }
}

/** True when an embed run would spend: embeddings on, a paid embedding provider with credentials. */
export async function embedWouldSpend(engine: BrainEngine): Promise<boolean> {
  const { embeddingsDisabled } = await import('./embedding-disabled.ts');
  if (await embeddingsDisabled(engine)) return false;
  try {
    const { isAvailable } = await import('./ai/gateway.ts');
    return isAvailable('embedding') && !(await embeddingProviderIsFree());
  } catch {
    return false;
  }
}

/** Pre-flight USD estimate of a backfill from the text it would embed; null when unknown. */
export async function estimateEmbedBackfillUsd(engine: BrainEngine, scope: EmbedBackfillScope): Promise<number | null> {
  if (scope.unestimated) return null;
  try {
    const { getEmbeddingModel } = await import('./ai/gateway.ts');
    const { estimateCostFromChars, lookupEmbeddingPrice } = await import('./embedding-pricing.ts');
    const price = lookupEmbeddingPrice(getEmbeddingModel());
    if (price.kind !== 'known') return null;
    const params = scope.sourceId ? [scope.sourceId] : [];
    const bySource = scope.sourceId ? ' AND p.source_id = $1' : '';
    const chunks = await engine.executeRaw<{ chars: number | string }>(
      `SELECT COALESCE(SUM(length(c.chunk_text)), 0)::bigint AS chars FROM content_chunks c JOIN pages p ON p.id = c.page_id
        WHERE p.deleted_at IS NULL${scope.all ? '' : ' AND c.embedding IS NULL'}${bySource}`, params);
    const chunkless = scope.all ? [] : await engine.executeRaw<{ chars: number | string }>(
      `SELECT COALESCE(SUM(length(p.compiled_truth) + length(p.timeline)), 0)::bigint AS chars FROM pages p
        WHERE p.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id = p.id)${bySource}`, params);
    const chars = Number(chunks[0]?.chars ?? 0) + Number(chunkless[0]?.chars ?? 0);
    return estimateCostFromChars(chars, price.pricePerMTok);
  } catch {
    return null;
  }
}

/**
 * CLI handlers only. Null when the run cannot spend (embeddings disabled, no
 * provider credentials); otherwise the Authorization, or throws the exit-3
 * `confirmation_required` refusal. A user cap below the estimate refuses up
 * front with `cost_cap_exceeded` (nothing runs).
 */
export async function requireEmbedBackfillConsent(engine: BrainEngine, opts: {
  command: string;
  /** The exact command that runs once approved (`--yes` is appended). */
  argv: string[];
  preview_argv?: string[];
  args: readonly string[];
  scope: EmbedBackfillScope;
}): Promise<Authorization | null> {
  if (!(await embedWouldSpend(engine))) return null;
  const est = await estimateEmbedBackfillUsd(engine, opts.scope);
  const cost = est === null ? 'its cost could not be estimated in advance' : `it is estimated at $${est.toFixed(4)}`;
  const auth = await requireConsent({
    command: opts.command,
    effects: ['paid'],
    actor: 'agent',
    what: 'Embedding backfill',
    why: `Embedding sends page text to the configured embedding provider, which bills per token; ${cost}.`,
    risk: 'Spends money with the embedding provider. Keyword search keeps working without it.',
    user_message: `Generating the missing embeddings sends your page text to the embedding provider and costs money (${est === null ? 'cost unknown in advance' : `about $${est.toFixed(4)}`}). OK to run it?`,
    argv: opts.argv,
    ...(opts.preview_argv ? { preview_argv: opts.preview_argv } : {}),
    est_usd: est,
    args: opts.args,
  }, { getConfig: (key) => engine.getConfig(key) });
  if (auth.cap_usd !== null && est !== null && est > auth.cap_usd) {
    throw opError('cost_cap_exceeded',
      `The embedding backfill is estimated at $${est.toFixed(4)}, above the $${auth.cap_usd.toFixed(2)} cap; nothing ran.`,
      'Ask the user whether to raise the cap, then re-run with a higher --max-usd.',
      { why: 'A run whose estimate exceeds its cap would stop part-way.' });
  }
  return auth;
}
