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
 * - Fail closed: when the generation cannot be read (no
 *   `readTrustGeneration` member, a brain before the migration, no
 *   `trust_policy_state` row, any error) `readTrustGeneration` throws, and the
 *   caller delivers nothing rather than cached content.
 *
 * The read is the BrainEngine member `readTrustGeneration`
 * (engine-sql/trust-withdrawals.ts). The Rust store keeps no
 * `trust_policy_state` row: it answers its commit sequence, which moves on
 * every commit, a superset of the trigger events above, so a cache keyed on
 * it rebuilds after any write and never serves content a trust change made
 * wrong.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import type { ReadEligibility } from './policy.ts';
import { proactiveEligibility, type ProactiveSurface } from './registry.ts';

/** The brain's current trust policy generation, as a decimal string. Throws when it cannot be read. */
export async function readTrustGeneration(engine: Partial<Pick<BrainEngine, 'readTrustGeneration'>>): Promise<string> {
  if (typeof engine.readTrustGeneration !== 'function') throw new Error('trust generation unreadable: engine has no readTrustGeneration member');
  return engine.readTrustGeneration();
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
