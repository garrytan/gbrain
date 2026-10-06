import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import type { ParsedPage } from '../import-file.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { stableJson } from '../persistence/digest.ts';
import { assertPageRevision, type PageSnapshot } from './types.ts';

/** Imported bytes are prepared outside transactions; publication still needs CAS. */
export async function assertImportBase(tx: BrainEngine, slug: string, sourceId: string, existing: Page | null, reusedEmbeddings = false): Promise<void> {
  await tx.lockPageKeys([{ sourceId, slug }]);
  const current = await tx.getPage(slug, { sourceId, includeDeleted: true });
  if ((current?.id ?? null) !== (existing?.id ?? null)) {
    throw opError('page_identity_changed', 'The imported page was deleted or recreated during preparation.',
      `Page ${slug} in source ${sourceId} was deleted or recreated while its import was prepared, so the import did not write it. Read the page that holds the slug now, then import the file again.`,
      { fix: readFix(`Shows which page holds ${slug} now and its revision.`, { argv: ['gbrain', 'get', '--source', sourceId, '--', slug], mcp: { tool: 'get_page', arguments: { slug, source_id: sourceId } } }) });
  }
  assertPageRevision(current ? { revision: current.knowledge_revision! } : null, existing ? { expectedRevision: existing.knowledge_revision } : {});
  if (reusedEmbeddings && (current?.contextual_retrieval_mode ?? null) !== (existing?.contextual_retrieval_mode ?? null)) {
    throw opError('revision_conflict', 'The contextual retrieval mode changed while this import prepared reusable embeddings; nothing was written.',
      `Page ${slug} in source ${sourceId} changed embedding mode without changing its canonical revision. Read the current page, then retry the import so it builds vectors for that mode.`,
      { fix: readFix('Reads the current page before retrying the import.', { argv: ['gbrain', 'get', '--source', sourceId, '--', slug], mcp: { tool: 'get_page', arguments: { slug, source_id: sourceId } } }) });
  }
}
const canonicalFields = (p: Page | ParsedPage) => ({ type: p.type, title: p.title, compiled_truth: p.compiled_truth,
  timeline: p.timeline ?? '', frontmatter: p.frontmatter });

/** Content hashes omit volatile metadata; a prepared no-op must compare all canonical fields. */
export function sameCanonicalImport(existing: PageSnapshot | null, parsed: ParsedPage): boolean {
  if (!existing) return false;
  const tags = [...new Set([...existing.tags, ...parsed.tags])].sort();
  return stableJson(canonicalFields(existing.page)) === stableJson(canonicalFields(parsed)) && stableJson([...existing.tags].sort()) === stableJson(tags);
}

/**
 * #5158: the stored content_hash digests frontmatter in insertion order, so a
 * file whose keys were only reordered hashes differently. This key-sorted
 * comparison of every canonical field and the exact tag set recognizes it as
 * unchanged without touching the stored hash formula.
 */
export async function sameContentAnyKeyOrder(engine: Pick<BrainEngine, 'getTags'>, existing: Page, existingTags: string[] | null,
  parsed: ParsedPage, sourceId: string): Promise<boolean> {
  if (existing.deleted_at || existing.type !== parsed.type || existing.title !== parsed.title
    || existing.compiled_truth !== parsed.compiled_truth || (existing.timeline ?? '') !== (parsed.timeline ?? '')) return false;
  if (stableJson(canonicalFields(existing)) !== stableJson(canonicalFields(parsed))) return false;
  const tags = existingTags ?? await engine.getTags(existing.slug, { sourceId });
  return stableJson([...tags].sort()) === stableJson([...parsed.tags].sort());
}
