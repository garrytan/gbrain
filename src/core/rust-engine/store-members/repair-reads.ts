/**
 * The repair scans that order by byte (SQL in engine-sql/collate-repair-reads.ts), served from the alias and fact records
 * (rust/crates/gbrain-store/src/repair_reads.rs, rust/docs/store/repair_reads.md).
 */
import type { ClosedTieRow, DuplicateFactRow, OrphanedAliasCount, OrphanedAliasTarget, PagelessEntityFactRow } from '../../engine-sql/collate-repair-reads.ts';
import { storeCall, type StoreMember } from './common.ts';

/** Per source, the alias rows whose page row is absent, in source byte order. */
export const countOrphanedAliasRows: StoreMember<[], OrphanedAliasCount[]> = (brain) =>
  storeCall({ member: 'countOrphanedAliasRows' }, () => brain.countOrphanedAliasRows());

/** Per (source, slug) of the sources, the alias rows whose page row is absent, in byte order. */
export const listOrphanedAliasTargets: StoreMember<[sourceIds: readonly string[]], OrphanedAliasTarget[]> = (brain, sourceIds) =>
  storeCall({ member: 'listOrphanedAliasTargets' }, () => brain.listOrphanedAliasTargets([...sourceIds]));

/** How many alias rows of the sources name a soft-deleted page. */
export const countSoftDeletedAliasTargets: StoreMember<[sourceIds: readonly string[]], number> = (brain, sourceIds) =>
  storeCall({ member: 'countSoftDeletedAliasTargets' }, () => brain.countSoftDeletedAliasTargets([...sourceIds]));

/** The active facts of the sources that repeat another's fingerprint, grouped and ordered by byte. */
export const listDuplicateFactRows: StoreMember<[sourceIds: readonly string[], auditSources: readonly string[]], DuplicateFactRow[]> = (brain, sourceIds, auditSources) =>
  storeCall({ member: 'listDuplicateFactRows' }, () => brain.listDuplicateFactRows([...sourceIds], [...auditSources]));

/** The page-less entity slugs of the sources with their database-only fact ids, in (source, slug) byte order. */
export const listPagelessEntityFacts: StoreMember<[sourceIds: string[]], PagelessEntityFactRow[]> = (brain, sourceIds) =>
  storeCall({ member: 'listPagelessEntityFacts' }, () => brain.listPagelessEntityFacts([...sourceIds]));

/** The id and incarnation of each named source that exists, in id byte order. */
export const listSourceIncarnations: StoreMember<[sourceIds: string[]], Array<{ id: string; incarnation: string }>> = (brain, sourceIds) =>
  storeCall({ member: 'listSourceIncarnations' }, () => brain.listSourceIncarnations([...sourceIds]));

/** The facts closed at their own instant, with the partners that state the same claim, in (source, id) order. */
export const listClosedConsolidationTies: StoreMember<[sourceIds: readonly string[]], ClosedTieRow[]> = (brain, sourceIds) =>
  storeCall({ member: 'listClosedConsolidationTies' }, () => brain.listClosedConsolidationTies([...sourceIds]));
