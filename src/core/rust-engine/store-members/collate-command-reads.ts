/**
 * The page reads of the member-disable pages check, who-can-read and the reconcile-links walk (BrainEngine
 * listLivePagesNamingReader, readPageAccessRows, listMarkdownPageSlugs; SQL in engine-sql/collate-command-reads.ts), served
 * from the page records (rust/crates/gbrain-store/src/collate_command_reads.rs). Every list is in byte order, as the
 * statements' `COLLATE "C"` orders them. What each member answers: rust/docs/store/collate-command-reads.md.
 */
import type { LivePageNamingReaderRow, PageAccessRow } from '../../engine-sql/collate-command-reads.ts';
import { LIVE_PAGES_NAMING_READER_LIMIT } from '../../engine-sql/collate-command-reads.ts';
import { storeCall, type StoreMember } from './common.ts';

export const listLivePagesNamingReader: StoreMember<[principal: string], LivePageNamingReaderRow[]> = async (brain, principal) => {
  const rows = await storeCall({ member: 'listLivePagesNamingReader' }, () => brain.listLivePagesNamingReader(principal, LIVE_PAGES_NAMING_READER_LIMIT)) as LivePageNamingReaderRow[];
  return rows.map(r => ({ source_id: r.source_id, slug: r.slug }));
};

export const readPageAccessRows: StoreMember<[slug: string, sourceId?: string], PageAccessRow[]> = async (brain, slug, sourceId) => {
  const rows = await storeCall({ member: 'readPageAccessRows', slug, ...(sourceId ? { sourceId } : {}) }, () => brain.readPageAccessRows(slug, sourceId ?? null)) as PageAccessRow[];
  return rows.map(r => ({ slug: r.slug, source_id: r.source_id, type: r.type ?? null, frontmatter: r.frontmatter, folder_rule_ids: r.folder_rule_ids ?? null }));
};

export const listMarkdownPageSlugs: StoreMember<[sourceId: string], string[]> = async (brain, sourceId) =>
  await storeCall({ member: 'listMarkdownPageSlugs', sourceId }, () => brain.listMarkdownPageSlugs(sourceId)) as string[];
