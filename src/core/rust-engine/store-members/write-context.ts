/**
 * The write context persistence/context.ts sets on a transaction (engine-sql/transaction-settings.ts `setWriteContext`).
 * It goes through the transaction-settings members (transactions.ts): the trust settings live in the store's write trust
 * context on the transaction's handle, the source scope and actor on the transaction in TypeScript.
 *
 * Export only BrainEngine members from this file: index.ts spreads the whole module into STORE_MEMBERS.
 */
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { TRUST_TIER_RANK } from '../../trust/tier.ts';
import { WRITE_CONTEXT_SETTINGS, type WriteContextInput, type WriteContextResult } from '../../engine-sql/transaction-settings.ts';
import { applyTransactionSettings, readTransactionSettings } from './transactions.ts';
import { readPersistenceBrainId } from './persistence-identity.ts';

/** engine-sql `trustRankSql`: a tier's rank, 0 for anything that is not a tier (including ''). */
const rank = (tier: string): number => (Object.hasOwn(TRUST_TIER_RANK, tier) ? TRUST_TIER_RANK[tier as keyof typeof TRUST_TIER_RANK] : 0);

/**
 * engine-sql/transaction-settings.ts `SET_WRITE_CONTEXT_SQL`, step for step: read the enclosing values ('' where unset)
 * and the persistence identity; with no identity set nothing. Otherwise set the source scope and the git protocol, keep
 * an enclosing actor (one with a principal kind), and when a tier is declared nest it as min(outer, inner) (an enclosing
 * tier with a lower nonzero rank stays) and take the declared origin, or keep the enclosing one when none is declared.
 */
export const setWriteContext = async function setWriteContext(this: RustEngine, brain: StoreBrain, input: WriteContextInput): Promise<WriteContextResult> {
  const previous = (await readTransactionSettings.call(this, brain, WRITE_CONTEXT_SETTINGS)).map((value) => value ?? '');
  const brainId = await readPersistenceBrainId.call(this, brain);
  if (!brainId) return { brainId: null, previous };
  const [, prevRequest, prevKind, prevId, prevTier, prevOrigin] = previous as [string, string, string, string, string, string, string];
  const keepActor = prevKind !== '';
  const names: string[] = ['gbrain.write_sources', 'gbrain.git_protocol', 'gbrain.write_request', 'gbrain.write_principal_kind', 'gbrain.write_principal_id'];
  const values: string[] = [JSON.stringify(input.sourceIds), '1',
    keepActor ? prevRequest : input.requestId ?? '', keepActor ? prevKind : input.principalKind, keepActor ? prevId : input.principalId];
  if (input.tier !== '') {
    names.push('gbrain.write_trust_tier', 'gbrain.write_origin');
    values.push(rank(prevTier) > 0 && rank(prevTier) < rank(input.tier) ? prevTier : input.tier, input.origin !== '' ? input.origin : prevOrigin);
  }
  await applyTransactionSettings.call(this, brain, names, values);
  return { brainId, previous };
};
