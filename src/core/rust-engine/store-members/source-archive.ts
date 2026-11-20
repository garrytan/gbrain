/**
 * Source archive (BrainEngine archiveSource, restoreArchivedSource, listArchivedSourceRows, listExpiredArchivedSources,
 * listUnverifiedArchivedSourceIds, readSourceImpactCounts, listSourceOAuthClients; engine-sql/source-archive.ts), over
 * `rust/crates/gbrain-store/src/sources/archive.rs` and the client read of `jobs/oauth_clients.rs`.
 *
 * Times come back as ISO text. The store keeps no `files` table, so the impact count of files is 0. A source the store
 * keeps without a name reads with its id as the name, as the migration read does (rust/docs/store/sources.md).
 */
import type { BrainEngine } from '../../engine.ts';
import type { ArchivedSourceListRow, ArchivedSourceRow, SourceImpactCounts } from '../../engine-sql/source-archive.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const archiveSource: Member<'archiveSource'> = async (brain, sourceId, ttlHours) => {
  const row = await storeCall<(Omit<ArchivedSourceRow, 'name'> & { name: string | null }) | null>({ member: 'archiveSource', sourceId }, () => brain.archiveSource(sourceId, Math.trunc(ttlHours)));
  return row === null ? null : { ...row, name: row.name ?? row.id };
};

export const restoreArchivedSource: Member<'restoreArchivedSource'> = (brain, sourceId, federated) =>
  storeCall({ member: 'restoreArchivedSource', sourceId }, () => brain.restoreArchivedSource(sourceId, federated));

export const listArchivedSourceRows: Member<'listArchivedSourceRows'> = async (brain) => {
  const rows = await storeCall<Array<Omit<ArchivedSourceListRow, 'name'> & { name: string | null }>>({ member: 'listArchivedSourceRows' }, () => brain.listArchivedSourceRows());
  return rows.map((r) => ({ ...r, name: r.name ?? r.id }));
};

export const listExpiredArchivedSources: Member<'listExpiredArchivedSources'> = (brain) =>
  storeCall({ member: 'listExpiredArchivedSources' }, () => brain.listExpiredArchivedSources());

export const listUnverifiedArchivedSourceIds: Member<'listUnverifiedArchivedSourceIds'> = (brain) =>
  storeCall({ member: 'listUnverifiedArchivedSourceIds' }, () => brain.listUnverifiedArchivedSourceIds());

export const readSourceImpactCounts: Member<'readSourceImpactCounts'> = async (brain, sourceId) => {
  const row = await storeCall<(Omit<SourceImpactCounts, 'name'> & { name: string | null }) | null>({ member: 'readSourceImpactCounts', sourceId }, () => brain.readSourceImpactCounts(sourceId));
  return row === null ? null : { ...row, name: row.name ?? sourceId };
};

export const listSourceOAuthClients: Member<'listSourceOAuthClients'> = (brain, sourceId) =>
  storeCall({ member: 'listSourceOAuthClients', sourceId }, () => brain.listSourceOAuthClients(sourceId));
