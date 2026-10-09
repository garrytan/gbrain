/**
 * Cache identity for proactive surfaces (#5575 ENG-11).
 *
 * A cache of memory content (hot memory, the OpenClaw core lane) is valid
 * only for the trust policy it was built under. Its identity is the brain's
 * trust policy generation (eligibility/generation-schema.ts: bumped by tier
 * changes, quarantine transitions, read floor and `trust.%` config changes,
 * purges and needs_rederive rows, from any process) plus the reader's
 * effective eligibility (read floor and activation control).
 *
 * Rules for a cache:
 * - Read the generation BEFORE the content it caches. The bump commits with
 *   the change, so content read after the generation is never older than it.
 * - Revalidate the generation on every hit, before delivery.
 * - Fail closed: when the generation cannot be read (no executeRaw, a brain
 *   before the migration, any error) `readTrustGeneration` throws, and the
 *   caller delivers nothing rather than cached content.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import type { ReadEligibility } from './policy.ts';
import { proactiveEligibility, type ProactiveSurface } from './registry.ts';

/** The brain's current trust policy generation, as a decimal string. Throws when it cannot be read. */
export async function readTrustGeneration(engine: Pick<BrainEngine, 'executeRaw'>): Promise<string> {
  if (typeof engine.executeRaw !== 'function') throw new Error('trust generation unreadable: engine has no raw SQL');
  const [row] = await engine.executeRaw<{ generation: string | number | bigint }>(
    'SELECT generation::text AS generation FROM trust_policy_state WHERE id = 1');
  if (row?.generation === undefined || row.generation === null) throw new Error('trust generation unreadable: trust_policy_state has no row');
  return String(row.generation);
}

/** The eligibility part of a cache identity: effective read floor and activation control. */
export function eligibilityCacheField(eligibility: ReadEligibility | undefined): string {
  return `floor=${eligibility?.floor ?? 'none'}/activation=${eligibility?.suppressFlagged ? 'suppress' : 'allow'}`;
}

/** The whole identity: generation plus eligibility. Two reads may share a cached entry only when these are equal. */
export function trustCacheIdentity(generation: string, eligibility: ReadEligibility | undefined): string {
  return `gen=${generation}/${eligibilityCacheField(eligibility)}`;
}

/**
 * Generation (read first) plus the surface's proactive eligibility, as one
 * identity string, for caches that key a whole delivery on it (the OpenClaw
 * core lane). Throws when the generation cannot be read.
 */
export async function proactiveCacheIdentity(
  ctx: Pick<OperationContext, 'engine' | 'auth'>,
  surface: ProactiveSurface,
): Promise<{ identity: string; policy: ReadEligibility & { surface: ProactiveSurface } }> {
  const generation = await readTrustGeneration(ctx.engine);
  const policy = await proactiveEligibility(ctx, surface);
  return { identity: trustCacheIdentity(generation, policy), policy };
}
