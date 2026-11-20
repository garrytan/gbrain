/**
 * The page reads of the schema-pack conversions (SQL in engine-sql/collate-type-page-reads.ts), served from the page
 * records (rust/crates/gbrain-store/src/type_page_reads.rs, rust/docs/store/type_page_reads.md).
 */
import type { RetypeProbeOpts, TypePageBody } from '../../engine-sql/collate-type-page-reads.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

function limitOf(member: string, limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1) refuseMember(member, 'a limit that is not a whole number of at least 1');
  return limit;
}

/** The live pages of a type (in one source when given), by slug then id in byte order, up to `limit`. */
export const listTypePageBodies: StoreMember<[opts: { type: string; sourceId?: string; limit: number }], TypePageBody[]> = (brain, opts) =>
  storeCall({ member: 'listTypePageBodies' }, () => brain.listTypePageBodies({
    type: opts.type, sourceId: opts.sourceId, limit: limitOf('listTypePageBodies', opts.limit) }));

/** The live pages of a type in one source, by slug in byte order, up to `limit`. */
export const listSourceTypePageBodies: StoreMember<[opts: { type: string; sourceId: string; limit: number }], TypePageBody[]> = (brain, opts) =>
  storeCall({ member: 'listSourceTypePageBodies' }, () => brain.listSourceTypePageBodies({
    type: opts.type, sourceId: opts.sourceId, limit: limitOf('listSourceTypePageBodies', opts.limit) }));

const probeArg = (opts: RetypeProbeOpts) => ({
  fromType: opts.fromType, pathFilter: opts.pathFilter, slugFilter: opts.slugFilter, sourceId: opts.sourceId });

/** How many live pages of a type match a retype rule's filters. */
export const countRetypeCandidates: StoreMember<[opts: RetypeProbeOpts], number> = (brain, opts) =>
  storeCall({ member: 'countRetypeCandidates' }, () => brain.countRetypeCandidates(probeArg(opts)));

/** The first ten matching slugs in byte order. */
export const listRetypeSampleSlugs: StoreMember<[opts: RetypeProbeOpts], string[]> = (brain, opts) =>
  storeCall({ member: 'listRetypeSampleSlugs' }, () => brain.listRetypeSampleSlugs(probeArg(opts)));
