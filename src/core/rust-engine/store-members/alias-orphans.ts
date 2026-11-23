/**
 * Alias rows whose target page is not live (BrainEngine listAliasTargets and deleteOrphanedAliases, the statements of
 * engine-sql/alias-orphans.ts). The store keeps alias rows past a hard delete of their page, as PGLite does, so both
 * members run real store code (rust/crates/gbrain-store/src/aliases/orphans.rs).
 */
import type { AliasTarget } from '../../engine-sql/alias-orphans.ts';
import { storeCall, type StoreMember } from './common.ts';

export const listAliasTargets: StoreMember<[sourceIds: readonly string[] | null], AliasTarget[]> = async (brain, sourceIds) =>
  await storeCall({ member: 'listAliasTargets' }, () => brain.listAliasTargets(sourceIds === null ? null : [...sourceIds])) as AliasTarget[];

export const deleteOrphanedAliases: StoreMember<[sourceId: string, slug: string], number> = async (brain, sourceId, slug) =>
  Number(await storeCall({ member: 'deleteOrphanedAliases', slug, sourceId }, () => brain.deleteOrphanedAliases(sourceId, slug)));
