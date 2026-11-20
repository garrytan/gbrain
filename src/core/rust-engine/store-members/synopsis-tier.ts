/**
 * The synopsis tier's configuration read (src/core/engine-sql/synopsis-tier.ts), served by gbrain-store
 * (rust/crates/gbrain-store/src/synopsis_tier.rs): the live sources whose own mode is per_chunk_synopsis, by id in
 * byte order, and whether a live markdown page's trusted frontmatter picks that tier. What the store keeps and how it
 * differs: rust/docs/store/synopsis-tier.md.
 */
import type { SynopsisTierSources } from '../../engine-sql/synopsis-tier.ts';
import { storeCall, type StoreMember } from './common.ts';

/** The synopsis sources by id and the frontmatter pick; the page check is skipped when `skipFrontmatter` is true. */
export const readSynopsisTierSources: StoreMember<[skipFrontmatter: boolean], SynopsisTierSources> = (brain, skipFrontmatter) =>
  storeCall({ member: 'readSynopsisTierSources' }, () => brain.readSynopsisTierSources({ skipFrontmatter: skipFrontmatter === true }));
