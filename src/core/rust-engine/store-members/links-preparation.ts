/**
 * The alias read link preparation made through executeRaw (engine-sql/links-preparation.ts), answered from the store.
 */
import type { LiveSlugAliasRow } from '../../engine-sql/links-preparation.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readLiveSlugAliases: StoreMember<[sourceId: string, targets: readonly string[]], LiveSlugAliasRow[]> = (brain, sourceId, targets) =>
  targets.length === 0 ? Promise.resolve([]) : storeCall({ member: 'readLiveSlugAliases', sourceId }, () => brain.readLiveSlugAliases(sourceId, [...new Set(targets)]));
