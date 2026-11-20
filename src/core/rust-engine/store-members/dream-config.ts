/**
 * The config rows of the dream breaker and the write deferrals, and the dream cycle's source incarnation read
 * (src/core/engine-sql/dream-cycle.ts). The four config members run on gbrain-store `dream_config`
 * (rust/crates/gbrain-store/src/dream_config.rs); `readDreamSourceIncarnation` reads the store's source record.
 *
 * `lockDreamMapConfigRow` takes no row lock: the store admits one write transaction at a time, as `lockSourceRow` notes.
 */
import type { DreamMapConfigRow } from '../../engine-sql/dream-cycle.ts';
import { storeCall, type StoreMember } from './common.ts';

export const ensureDreamMapConfigRow: StoreMember<[key: string], void> = async (brain, key) => {
  await storeCall({ member: 'ensureDreamMapConfigRow' }, () => brain.ensureDreamMapConfigRow({ key }));
};

export const lockDreamMapConfigRow: StoreMember<[key: string], DreamMapConfigRow | null> = (brain, key) =>
  storeCall({ member: 'lockDreamMapConfigRow' }, () => brain.lockDreamMapConfigRow({ key }));

export const writeDreamMapConfigRow: StoreMember<[key: string, value: string], void> = async (brain, key, value) => {
  await storeCall({ member: 'writeDreamMapConfigRow' }, () => brain.writeDreamMapConfigRow({ key, value }));
};

export const recordDreamBreakerReset: StoreMember<[resetsKey: string, baseKey: string], void> = async (brain, resetsKey, baseKey) => {
  await storeCall({ member: 'recordDreamBreakerReset' }, () => brain.recordDreamBreakerReset({ resetsKey, baseKey }));
};

export const readDreamSourceIncarnation: StoreMember<[sourceId: string], { incarnation: string | null } | null> = async (brain, sourceId) => {
  const row: { incarnation?: string | null } | null = await storeCall({ member: 'readDreamSourceIncarnation', sourceId }, () => brain.readSourceIncarnation(sourceId));
  return row === null ? null : { incarnation: row.incarnation ?? null };
};
