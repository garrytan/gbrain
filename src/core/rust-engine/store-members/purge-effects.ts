/**
 * A purge's Git effect statements (src/core/engine-sql/facts-purge.ts), served from
 * rust/crates/gbrain-store/src/persistence/purge_effects.rs: the Git effects whose commit message quotes a purged
 * claim (`listGitEffectsCarryingReason`), the Git effects of a purged page (`listPageGitEffectsForStrip`) and the
 * rewrite of one effect's data (`setPurgeEffectData`, which sends the data as JSON text, as `$2::text::jsonb` binds it).
 * Each read answers the effect id as text and the request's client id, as the SQL engines do.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listGitEffectsCarryingReason: Member<'listGitEffectsCarryingReason'> = (brain, sourceId, needle, escaped, foldedJson) =>
  storeCall({ member: 'listGitEffectsCarryingReason', sourceId }, () => brain.listGitEffectsCarryingReason({ sourceId, needle, escaped, foldedJson }));

export const listPageGitEffectsForStrip: Member<'listPageGitEffectsForStrip'> = (brain, sourceId, slug) =>
  storeCall({ member: 'listPageGitEffectsForStrip', sourceId }, () => brain.listPageGitEffectsForStrip({ sourceId, slug }));

export const setPurgeEffectData: Member<'setPurgeEffectData'> = async (brain, effectId, data) => {
  await storeCall({ member: 'setPurgeEffectData' }, () => brain.setPurgeEffectData({ effectId, data: JSON.stringify(data) }));
};
