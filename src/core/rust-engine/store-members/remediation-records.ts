/**
 * The reindex spend read and the remediation impact log write of engine-sql/remediation-records.ts
 * (rust/docs/store/remediation-records.md).
 *
 * readReindexSpendInputs is served by the store's chunk_queries family from the page records: the live markdown pages
 * whose chunker version is below the fence or whose contextual retrieval mode is unset, and their body characters.
 *
 * insertImpactLogRow refuses by name, before any work: the store keeps no `migration_impact_log`. Adding its records is
 * a store format change, which waits until after the shadow tag. The remediation run reports the step
 * `impact_log: not_recorded` and keeps the job's status (onboard/impact-capture.ts).
 */
import type { ImpactLogRow, ReindexSpendInputs } from '../../engine-sql/remediation-records.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

export const readReindexSpendInputs: StoreMember<[chunkerVersion: number, type: string | null], ReindexSpendInputs> =
  async (brain, chunkerVersion, type) => {
    if (!Number.isSafeInteger(chunkerVersion)) refuseMember('readReindexSpendInputs', 'a chunker version that is not an integer');
    return storeCall({ member: 'readReindexSpendInputs' }, () => brain.readReindexSpendInputs({ chunkerVersion, type: type ?? null }));
  };

export const insertImpactLogRow: StoreMember<[row: ImpactLogRow], void> = async () =>
  refuseMember('insertImpactLogRow', 'the store keeps no migration impact log; its records wait for a store format change after the shadow tag');
