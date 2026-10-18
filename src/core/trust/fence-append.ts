/**
 * A fence append never changes the page tier (#5575 ENG-1).
 *
 * Appending a row to a page's `## Facts` fence rewrites compiled_truth, which
 * the tier trigger (trust/schema.ts) treats as a content rewrite: an
 * agent-tier writer would lower an owner page to its own tier, and an
 * owner-tier writer would restamp an external page to its tier. The appended
 * row carries its own tier on its facts row (the writer's), and chunks show it
 * under that tier (eligibility/fence-overlay.ts), so the page keeps the tier
 * and origin it had before the append.
 *
 * The restore runs in the same transaction, after the page write: lowering
 * back needs nothing; raising back to the page's own prior tier uses the
 * promotion capability (persistence/context.ts) with that tier as the
 * ceiling, so it can never lift a page above what it already was.
 */
import type { BrainEngine } from '../engine.ts';
import { withTrustPromotion } from '../persistence/context.ts';
import { compareTrust, isTrustTier } from './tier.ts';

type Exec = Pick<BrainEngine, 'executeRaw'>;

interface StoredPageTrust { id: number; trust_tier: string; write_origin: unknown }

const sameOrigin = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const originText = (value: unknown) => value === null || value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value);

/** Runs `fn` (the page write of a fence append) and restores the page's prior trust_tier and write_origin. */
export async function withPageTierKept<T>(tx: Exec, page: { sourceId: string; slug: string }, fn: () => Promise<T>): Promise<T> {
  const [prior] = await tx.executeRaw<StoredPageTrust>(
    'SELECT id, trust_tier, write_origin FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [page.sourceId, page.slug]);
  const result = await fn();
  if (!prior || !isTrustTier(prior.trust_tier)) return result;
  const [after] = await tx.executeRaw<StoredPageTrust>('SELECT id, trust_tier, write_origin FROM pages WHERE id=$1', [prior.id]);
  if (!after || !isTrustTier(after.trust_tier) || (after.trust_tier === prior.trust_tier && sameOrigin(after.write_origin, prior.write_origin))) return result;
  const restore = () => tx.executeRaw('UPDATE pages SET trust_tier=$2, write_origin=$3::text::jsonb WHERE id=$1',
    [prior.id, prior.trust_tier, originText(prior.write_origin)]);
  if (compareTrust(prior.trust_tier, after.trust_tier) > 0) await withTrustPromotion(tx, prior.trust_tier, restore);
  else await restore();
  return result;
}
