import { normalizeSlug } from '../utils.ts';
import { OperationError, type OperationContext } from './contract.ts';
import { federatedSearchScope } from './context.ts';
import { readFix } from './op-fix.ts';
import { isPrivatePage, resolveExcludePrivatePages } from '../search/private-visibility.ts';

/**
 * Rethrows a put_page failure. A revision_conflict whose expected_revision is
 * the current revision of the same slug in another source was almost certainly
 * read there and written back without its source_id, so the refusal names that
 * source and its fix re-reads the page there. Only a source and page the caller
 * may read are named (grant and page visibility, as get_page applies them);
 * otherwise the refusal is rethrown exactly as it was.
 */
export async function rethrowNamingRevisionSource(ctx: OperationContext, writeSource: string, p: Record<string, unknown>, error: unknown): Promise<never> {
  if (!(error instanceof OperationError) || error.code !== 'revision_conflict' || typeof p.slug !== 'string' || typeof p.expected_revision !== 'string') throw error;
  const slug = normalizeSlug(p.slug);
  const expected = p.expected_revision.toLowerCase();
  try {
    // The live page at this slug in every other unarchived source, in byte order of source id.
    const others = (await ctx.engine.listAllSources()).map(s => s.id).filter(id => id !== writeSource);
    const candidates = others.length === 0 ? [] : (await ctx.engine.readTextMentionPages(others, [slug]))
      .map(r => ({ source_id: r.source_id }))
      .sort((a, b) => Buffer.compare(Buffer.from(a.source_id), Buffer.from(b.source_id)));
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    for (const { source_id: other } of candidates) {
      try { federatedSearchScope(ctx, other); } catch { continue; }
      const snapshot = await ctx.engine.readPageSnapshot(slug, { sourceId: other, excludePrivate });
      if (!snapshot || snapshot.revision !== expected || (excludePrivate && isPrivatePage(snapshot.page))) continue;
      error.suggestion = `Page ${slug} is at exactly this expected_revision in source ${other}, so it was probably read there; this write went to source ${writeSource}. `
        + `Re-read it with source_id ${other}; a write to that page must carry source_id ${other} and the revision get_page returns.`;
      error.fix = readFix(`Reads page ${slug} from source ${other}, where its revision matches the one this write sent.`,
        { argv: ['gbrain', 'get', '--source', other, '--', slug], mcp: { tool: 'get_page', arguments: { slug, source_id: other, include_content: true } } });
      break;
    }
  } catch {
    // The hint is advisory: a failed lookup leaves the refusal unchanged.
  }
  throw error;
}
