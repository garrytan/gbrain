/**
 * GST-363: on a brain with two or more enabled members, a remote read from a credential bound to no member is refused
 * (requester_scope_required) unless the operator marked it reads_unscoped. Suites written before that refusal pin what
 * an unbound credential reads (nothing restricted, every world page); their fixtures mark those credentials with this,
 * the same state `gbrain auth rescope --reads-unscoped --yes` writes, so the behaviour they pin is unchanged and does
 * not depend on whether the credential was minted in the same second as the brain's second member.
 */
import type { BrainEngine } from '../../src/core/engine.ts';

export async function readsUnscopedOnPurpose(engine: Pick<BrainEngine, 'executeRaw'>, id: string, kind: 'token' | 'client' = 'token'): Promise<void> {
  await engine.executeRaw(kind === 'token' ? 'UPDATE access_tokens SET reads_unscoped = now() WHERE id::text = $1' : 'UPDATE oauth_clients SET reads_unscoped = now() WHERE client_id = $1', [id]);
}
