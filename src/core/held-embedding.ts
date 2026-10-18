/**
 * Held embedding budgets, surfaced (#6803 part 3) and approvable on every
 * provider (#6847).
 *
 * Large pages the per-page ledger holds for approval (`upgrade_backfill`, a
 * sampled junk hit) or stopped at their cap leave the stale queue, so nothing
 * an operator runs routinely used to mention them. `readBudgetLimited` counts
 * them, with no row cap, against the active vector column and the embed
 * path's stale-input rules (a chunk without a vector or `embedded_at`, or a
 * page whose vectors came from another embedding signature): only pages with
 * such chunks count. `gbrain embed --stale` (`noteBudgetLimited`), the
 * embed-backfill job (`budgetLimitedField`) and doctor `partial_embedding`
 * (`budgetLimitedFinding`) report it through one phrase and one approve
 * Action per source (held-embedding-action.ts). It is never a failure and
 * never enters the embed-backfill stall fingerprint.
 *
 * `gbrain embed --held` (`heldEmbedArgv`): `--dry-run` lists every source
 * (exit 0) with per-page and per-source totals and one approve command per
 * source; an approval covers one source, so `--max-usd` with held pages in
 * several sources and no `--source` refuses with `invalid_params`.
 *
 * Approval (`heldApprovalUsd`): an explicit `--max-usd N` on `--slugs` /
 * `--held` is the hold approval whether or not the provider spends (a free
 * local provider has no consent Authorization to derive it from). It is refused
 * before any hold is released when embeddings are unavailable, or when a paid
 * model has no price (the run cap could not be enforced), so no per-page cap
 * is saved without a run. `--yes` never approves a hold.
 */
import type { BrainEngine } from './engine.ts';
import { cliRenderContext, renderAction, type Action, type RenderContext, type RenderedAction } from './agent-output.ts';
import { parseConsentFlags } from './consent.ts';
import { opError } from './ops/contract.ts';
import { chunkGenerationFilter } from './search/safe-chunks.ts';
import { quoteIdentifier } from './search/embedding-column.ts';
import { embeddingWriteTarget } from './page-state/projections.ts';
import { budgetRowAppliesFilter } from './page-size-policy.ts';
import { reservationCostUsd } from './budget/reservation-cost.ts';
import { estimatePageEmbedUsd, listBudgetLimitedPages } from './page-embedding-budget.ts';
import {
  approvalAmount, approvalBasis, budgetLimitedPhrase, heldApproveAction, heldPreviewCommand, renderedCommand,
  type ApprovalBasis, type BudgetLimitedCounts,
} from './held-embedding-action.ts';

export interface BudgetLimitedSource { source_id: string; held: number; capped: number; pending_chunks: number; pending_chars: number }
export interface BudgetLimited extends BudgetLimitedCounts { pending_chunks: number; by_source: BudgetLimitedSource[] }

/** Held and capped large pages that still have chunks waiting, by source (`sourceId` narrows it). */
export async function readBudgetLimited(engine: BrainEngine, opts: { sourceId?: string; signature?: string | null } = {}): Promise<BudgetLimited> {
  const column = `cc.${quoteIdentifier((await embeddingWriteTarget(engine)).column.name)}`;
  const params: unknown[] = [opts.signature ?? null];
  const bySource = opts.sourceId ? ` AND p.source_id = $${params.push(opts.sourceId)}` : '';
  const pending = `(${column} IS NULL OR (p.body_storage IS DISTINCT FROM 'segmented' AND cc.embedded_at IS NULL)
      OR ($1::text IS NOT NULL AND p.embedding_signature IS NOT NULL AND p.embedding_signature <> $1::text))`;
  const rows = await engine.executeRaw<{ source_id: string; state: 'held' | 'capped'; reason: string; pages: number; chunks: number; chars: number }>(
    `SELECT p.source_id, b.state, COALESCE(b.reason, 'awaiting_approval') AS reason, count(*)::int AS pages,
            sum(w.chunks)::bigint AS chunks, sum(w.chars)::bigint AS chars
       FROM page_embedding_budget b JOIN pages p ON p.id = b.page_id
       CROSS JOIN LATERAL (SELECT count(*)::int AS chunks, COALESCE(sum(length(cc.chunk_text)), 0)::bigint AS chars
         FROM content_chunks cc WHERE cc.page_id = p.id AND ${chunkGenerationFilter('p', 'cc')} AND ${pending}) w
      WHERE ${budgetRowAppliesFilter('b', 'p')} AND p.deleted_at IS NULL AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip') AND w.chunks > 0${bySource}
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`, params);
  const out: BudgetLimited = { held: 0, capped: 0, held_reasons: {}, pending_chunks: 0, by_source: [] };
  const sources = new Map<string, BudgetLimitedSource>();
  for (const row of rows) {
    const pages = Number(row.pages);
    const source = sources.get(row.source_id) ?? { source_id: row.source_id, held: 0, capped: 0, pending_chunks: 0, pending_chars: 0 };
    if (row.state === 'held') out.held_reasons[row.reason] = (out.held_reasons[row.reason] ?? 0) + pages;
    out[row.state] += pages;
    source[row.state] += pages;
    out.pending_chunks += Number(row.chunks);
    source.pending_chunks += Number(row.chunks);
    source.pending_chars += Number(row.chars);
    sources.set(row.source_id, source);
  }
  out.by_source = [...sources.values()].sort((a, b) => b.pending_chunks - a.pending_chunks || a.source_id.localeCompare(b.source_id));
  return out;
}

export interface BudgetLimitedReportSource extends BudgetLimitedSource { est_usd: number; max_usd: number; fix: RenderedAction }
export interface BudgetLimitedReport extends BudgetLimitedCounts {
  pending_chunks: number;
  /** `gbrain embed --held --dry-run` for every source (the rendered listing command). */
  preview_command: string;
  by_source: BudgetLimitedReportSource[];
}

/** Every source's approve Action, the one for the source with the most pending chunks first. */
function sourceActions(b: BudgetLimited, basis: ApprovalBasis): Array<{ source: BudgetLimitedSource; amount: { est_usd: number; max_usd: number }; action: Action }> {
  return b.by_source.map(source => {
    const amount = approvalAmount(source.pending_chars, basis);
    return { source, amount, action: heldApproveAction({ source_id: source.source_id, pending_chunks: source.pending_chunks, ...amount }, basis.free) };
  });
}

/** The commands an operator runs: the listing preview, then one approve per source with its cost. */
function nextSteps(actions: ReturnType<typeof sourceActions>, ctx: RenderContext, free: boolean): string {
  const approves = actions.map(({ amount, action }) => `${renderedCommand(action, ctx)} (${free ? 'costs nothing' : `estimated $${amount.est_usd.toFixed(2)}, spends at most $${amount.max_usd.toFixed(2)}`})`);
  return `Preview: ${heldPreviewCommand(undefined, ctx)}; with the user's agreement, approve one source at a time: ${approves.join('; ')}.`;
}

/** The structured report (rendered fixes), or null when no large page waits. */
export async function budgetLimitedReport(engine: BrainEngine, opts: { sourceId?: string; signature?: string | null; ctx?: RenderContext } = {}): Promise<{ report: BudgetLimitedReport; line: string; fix: Action } | null> {
  const b = await readBudgetLimited(engine, opts);
  if (b.held + b.capped === 0) return null;
  const ctx = opts.ctx ?? cliRenderContext();
  const basis = await approvalBasis();
  const actions = sourceActions(b, basis);
  const report: BudgetLimitedReport = {
    held: b.held, capped: b.capped, held_reasons: b.held_reasons, pending_chunks: b.pending_chunks,
    preview_command: heldPreviewCommand(undefined, ctx),
    by_source: actions.map(({ source, amount, action }) => ({ ...source, ...amount, fix: renderAction(action, ctx) })),
  };
  return { report, line: `${budgetLimitedPhrase(b)} ${nextSteps(actions, ctx, basis.free)}`, fix: actions[0]!.action };
}

/** `gbrain embed --stale`: attach `budget_limited` to the result and print the line (stderr under --json, nothing when quiet). */
export async function noteBudgetLimited(engine: BrainEngine, args: readonly string[], result: object, quiet: boolean): Promise<void> {
  const at = args.indexOf('--source');
  const { currentEmbeddingSignature } = await import('./embedding.ts');
  const found = await budgetLimitedReport(engine, { ...(at >= 0 && args[at + 1] ? { sourceId: args[at + 1] } : {}), signature: currentEmbeddingSignature() });
  if (!found) return;
  Object.assign(result, { budget_limited: { ...found.report, fix: renderAction(found.fix, cliRenderContext()) } });
  if (quiet) return;
  if (args.includes('--json')) process.stderr.write(`[embed] ${found.line}\n`);
  else console.log(`[embed] ${found.line}`);
}

/** The embed-backfill job result field (one source); never throws: it is bookkeeping, not a failure. */
export async function budgetLimitedField(engine: BrainEngine, sourceId: string, signature: string | null): Promise<{ budget_limited?: BudgetLimitedReport }> {
  try {
    const found = await budgetLimitedReport(engine, { sourceId, signature });
    return found ? { budget_limited: found.report } : {};
  } catch {
    return {};
  }
}

/** Doctor `partial_embedding`: the warn's message, fix (the approve for the source with the most pending chunks) and details, or null. */
export async function budgetLimitedFinding(engine: BrainEngine, signature: string | null): Promise<{ message: string; fix: Action; details: Record<string, unknown> } | null> {
  const found = await budgetLimitedReport(engine, { signature });
  if (!found) return null;
  return { message: found.line, fix: found.fix, details: { ...found.report } };
}

type HeldListing = {
  embedded: 0; skipped: 0; would_embed: number; total_chunks: number; pages_processed: 0; failures: 0; failure_samples: []; dryRun: boolean; chunkless_pages_healed: 0;
  held?: number; capped?: number; pages?: Array<{ slug: string; source_id: string; state: string; reason: string | null; pending_chunks: number; spent_usd: number; est_usd: number }>;
  sources?: BudgetLimitedReportSource[];
};
const emptyListing = (dryRun: boolean): HeldListing => ({ embedded: 0, skipped: 0, would_embed: 0, total_chunks: 0, pages_processed: 0, failures: 0, failure_samples: [], dryRun, chunkless_pages_healed: 0,
  ...(dryRun ? { held: 0, capped: 0, pages: [], sources: [] } : {}) });

/**
 * `gbrain embed --held`: list the held and capped large pages with what each
 * would cost to finish. A dry run returns the listing (every source unless
 * `--source`); otherwise the `--source S --slugs ...` argv that embeds them
 * under the user's `--max-usd`, one source per approval.
 */
export async function heldEmbedArgv(engine: BrainEngine, args: readonly string[], signature: string | null, say: (line: string) => void): Promise<{ argv: string[] } | HeldListing> {
  if (args.includes('--background')) {
    throw opError('invalid_params', '[embed] --held runs in the foreground: the per-page approval is not carried into background jobs.', 'Run it again without --background.');
  }
  const at = args.indexOf('--source');
  const sourceId = at >= 0 ? args[at + 1] : undefined;
  const dryRun = args.includes('--dry-run');
  const limited = await listBudgetLimitedPages(engine, { ...(sourceId ? { sourceId } : {}), limit: null });
  if (limited.length === 0) {
    say('[embed] No large pages are held or capped by embed.max_usd_per_page.');
    return emptyListing(dryRun);
  }
  const pages = limited.map(row => ({ slug: row.slug, source_id: row.source_id, state: row.state, reason: row.reason, pending_chunks: row.pending_chunks,
    spent_usd: row.spent_usd, est_usd: estimatePageEmbedUsd(row.pending_chars, signature) }));
  for (const row of pages) {
    say(`[embed] ${row.slug} (${row.source_id}): ${row.state}${row.reason ? ` (${row.reason})` : ''}, ${row.pending_chunks} chunk(s) without a vector, `
      + `spent $${row.spent_usd.toFixed(2)}, about $${row.est_usd.toFixed(2)} to finish`);
  }
  const sources = [...new Set(limited.map(row => row.source_id))];
  if (dryRun) {
    const found = await budgetLimitedReport(engine, { ...(sourceId ? { sourceId } : {}), signature });
    if (found) say(`[embed] ${found.line}`);
    return { ...emptyListing(true), would_embed: found?.report.pending_chunks ?? 0, total_chunks: found?.report.pending_chunks ?? 0,
      held: found?.report.held ?? 0, capped: found?.report.capped ?? 0, pages, sources: found?.report.by_source ?? [] };
  }
  if (sources.length > 1) {
    const found = await budgetLimitedReport(engine, { signature });
    const each = found ? found.report.by_source.map(s => s.fix.command).join('; ') : sources.map(id => heldPreviewCommand(id)).join('; ');
    throw opError('invalid_params',
      `[embed] Held pages span ${sources.length} sources and one approval covers one source, so --held needs --source. Run per source, each with the user's agreement: ${each}`,
      `Preview every source with ${heldPreviewCommand()}, then approve one source at a time.`);
  }
  const rest = args.filter((a, i) => a !== '--held' && a !== '--source' && args[i - 1] !== '--source');
  return { argv: [...rest, '--source', sources[0]!, '--slugs', ...limited.map(row => row.slug)] };
}

/**
 * #6847: the per-page approval an explicit `--max-usd N` carries on `--slugs` /
 * `--held` (undefined without it, and on a dry run, which releases nothing).
 * Refused before any hold is released when embeddings are unavailable, or a
 * paid model has no price.
 */
export async function heldApprovalUsd(engine: BrainEngine, args: readonly string[]): Promise<number | undefined> {
  const { maxUsd } = parseConsentFlags(args);
  if (maxUsd === null || args.includes('--dry-run')) return undefined;
  const { embedWouldSpend, embeddingProviderIsFree } = await import('./embed-consent.ts');
  const { embeddingsDisabled } = await import('./embedding-disabled.ts');
  const { getEmbeddingModel, isAvailable } = await import('./ai/gateway.ts');
  const unchanged = 'nothing ran: every hold and per-page cap is unchanged';
  if (await embedWouldSpend(engine)) {
    const model = getEmbeddingModel();
    if (reservationCostUsd(model, 'embed', 1, 0) !== null) return maxUsd;
    const { noPricingFix, noPricingGuidance, noPricingMessage } = await import('./budget/no-pricing.ts');
    const guidance = noPricingGuidance(model, 'embed');
    throw opError('no_pricing', `[embed] ${noPricingMessage(guidance, { capUsd: maxUsd })} (${unchanged}.)`, 'Register the model\'s price, then re-run the approval.',
      { why: 'A paid run under a user cap refuses an unpriced model at its first provider call, after the hold would already be released.', fix: noPricingFix(guidance) });
  }
  if (!(await embeddingsDisabled(engine)) && isAvailable('embedding') && await embeddingProviderIsFree()) return maxUsd;
  throw opError('embedding_unavailable', `[embed] Embeddings are unavailable on this brain (disabled, or the provider has no credentials), so --max-usd ${maxUsd} approves nothing; ${unchanged}.`,
    'Check the provider with gbrain doctor --only embedding_provider --json, fix it, then re-run the approval.',
    { why: 'Releasing a hold without a run that can embed would save the approval with nothing embedded.' });
}
