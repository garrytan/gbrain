/**
 * The page reads of who-can-read and the reconcile-links walk (BrainEngine readPageAccessRows,
 * listMarkdownPageSlugs; SQL in engine-sql/collate-command-reads.ts), served
 * from the page records (rust/crates/gbrain-store/src/collate_command_reads.rs). Every list is in byte order, as the
 * statements' `COLLATE "C"` orders them. What each member answers: rust/docs/store/collate-command-reads.md.
 */
import type { PageAccessRow } from '../../engine-sql/collate-command-reads.ts';
import { storeCall, type StoreMember } from './common.ts';

export const readPageAccessRows: StoreMember<[slug: string, sourceId?: string], PageAccessRow[]> = async (brain, slug, sourceId) => {
  const rows = await storeCall({ member: 'readPageAccessRows', slug, ...(sourceId ? { sourceId } : {}) }, () => brain.readPageAccessRows(slug, sourceId ?? null)) as PageAccessRow[];
  return rows.map(r => ({ slug: r.slug, source_id: r.source_id, type: r.type ?? null, frontmatter: r.frontmatter, folder_rule_ids: r.folder_rule_ids ?? null }));
};

export const listMarkdownPageSlugs: StoreMember<[sourceId: string], string[]> = async (brain, sourceId) =>
  await storeCall({ member: 'listMarkdownPageSlugs', sourceId }, () => brain.listMarkdownPageSlugs(sourceId)) as string[];
