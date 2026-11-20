/**
 * The phantom-redirect pass's root-page walk (BrainEngine listRootPageSlugsAfter; SQL in
 * engine-sql/collate-phantom-redirect.ts), served from the page records
 * (rust/crates/gbrain-store/src/phantom_redirect.rs). What it answers: rust/docs/store/collate-phantom-redirect.md.
 */
import { storeCall, type StoreMember } from './common.ts';

export const listRootPageSlugsAfter: StoreMember<[sourceId: string, after: string, exclude: readonly string[], limit: number], string[]> = async (brain, sourceId, after, exclude, limit) =>
  await storeCall({ member: 'listRootPageSlugsAfter', sourceId }, () => brain.listRootPageSlugsAfter(sourceId, after, [...exclude], limit)) as string[];
