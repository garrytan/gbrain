/**
 * Wave C 1F: the target of a `gbrain embed <slug>` / `--slugs` run, peeled from commands/embed.ts: the argument
 * parsing that finds the slugs, the approval and delegation a target page runs under, and the per-page cap check that
 * turns a stopped run into `budget_limited` (exit 11).
 */
import type { BrainEngine } from '../core/engine.ts';
import type { SpendAuthorization } from '../core/minions/spend-record.ts';
import { heldApprovalUsd } from '../core/held-embedding.ts';

/** The `--slugs` list: the arguments after it up to the next flag, so `--slugs a b --max-usd 1` never reads `1` as a slug. */
export function slugsAfter(args: readonly string[], at: number): string[] {
  const end = args.findIndex((a, i) => i > at && a.startsWith('--'));
  return args.slice(at + 1, end < 0 ? undefined : end);
}

/** Flags of `gbrain embed` that take a value, so a positional slug is never read from one (`--max-usd 5 my-page`). */
const EMBED_VALUE_FLAGS: ReadonlySet<string> = new Set(['--source', '--max-usd', '--max-cost', '--batch-size', '--priority', '--pace-max-concurrency']);

/** The positional `<slug>`: the first argument that is neither a flag nor a flag's value. */
export function embedPositionalSlug(args: readonly string[]): string | undefined {
  return args.find((a, i) => !a.startsWith('--') && !EMBED_VALUE_FLAGS.has(args[i - 1] ?? ''));
}

/**
 * How one target page embeds: the user's approval (`--max-usd N`) with its identity (the embed job's, so a retried job
 * raises the page's cap once), and `delegate` when the embed job hands a segmented page to an embed-page job queued
 * under the job's spend authorization.
 */
export interface EmbedPageTarget { approvedCapUsd?: number; approvalId?: string; delegate?: { spendAuthorization?: SpendAuthorization } }

/** The target fields of a run's options (EmbedOpts in commands/embed.ts). */
export function embedPageTarget(opts: { approvedPageCapUsd?: number; approvalId?: string; delegateSegmented?: EmbedPageTarget['delegate'] }): EmbedPageTarget {
  return { approvedCapUsd: opts.approvedPageCapUsd, approvalId: opts.approvalId, delegate: opts.delegateSegmented };
}

/** dx-r3-outside-5: the positional slug and the `--max-usd N` approval of a `<slug>` or `--slugs` run, for its `--background` job payload. */
export async function backgroundEmbedTarget(engine: BrainEngine, args: readonly string[]): Promise<{ slug?: string; approvedPageCapUsd?: number }> {
  const slug = !args.includes('--slugs') && !args.includes('--all') && !args.includes('--stale') ? embedPositionalSlug(args) : undefined;
  const approvedPageCapUsd = args.includes('--slugs') || slug !== undefined ? await heldApprovalUsd(engine, args) : undefined;
  return { ...(slug !== undefined && { slug }), ...(approvedPageCapUsd !== undefined && { approvedPageCapUsd }) };
}

/** Queue `page`'s embedding as an embed-page job under the target's approval and spend authorization; null without a worker. */
export async function delegateSegmentedPage(engine: BrainEngine, page: { id: number; source_id: string }, target: EmbedPageTarget): Promise<number | null> {
  const { submitEmbedPageJob } = await import('../core/minions/handlers/embed-page.ts');
  return submitEmbedPageJob(engine, page, { reason: 'embed', spendAuthorization: target.delegate?.spendAuthorization,
    ...(target.approvedCapUsd !== undefined && { approvedCapUsd: target.approvedCapUsd, approvalId: target.approvalId }) });
}

/** The page's per-page cap stopped this run (exit 11, `budget_limited`); a hold waiting for approval is not a budget stop. */
export async function pageCapped(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number): Promise<boolean> {
  const [row] = await engine.executeRaw<{ state: string }>('SELECT state FROM page_embedding_budget WHERE page_id = $1', [pageId]);
  return row?.state === 'capped';
}
