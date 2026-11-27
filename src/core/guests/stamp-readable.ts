/**
 * Guest notes, slice 4 (GBRA-504): which guest pages a caller may see marked. A guest mark names the note's sender,
 * group, audience and date, so it rides only on a page the caller's own read policy admits, the decision get_page
 * makes for that caller (ops/pages.ts): the source scope federatedSearchScope grants (an explicit source checked
 * against the grant and the explicit-read set), then member access and privacy (privatePagesFilterForCaller in SQL and
 * isPrivatePageForCaller after it) whenever resolveExcludePrivatePages applies them. A soft-deleted page is decided by
 * the same rules, as get_page include_deleted reads it. A reference the caller cannot read gets no stamp at all, so a
 * stored object that names a guest note (a raw-data payload, a frontmatter value, a page id) reads back nothing.
 */
import type { OperationContext } from '../ops/contract.ts';
import { federatedSearchScope } from '../ops/context.ts';
import { currentCallerAccess, isPrivatePageForCaller, resolveExcludePrivatePages } from '../search/private-visibility.ts';
import { refKey, type PageRef } from '../access/page-items.ts';

function sourceAdmitted(ctx: OperationContext, source: string): boolean {
  try {
    const scope = federatedSearchScope(ctx, source);
    return scope.sourceIds ? scope.sourceIds.includes(source) : scope.sourceId === source;
  } catch {
    return false;
  }
}

/**
 * The refKeys (access/page-items.ts) among `refs` the caller may read, from one batched query. The trusted local CLI
 * reads every page, except under an --as preview, which applies the member's policy like a remote read.
 */
export async function readableGuestRefs(ctx: OperationContext, refs: readonly PageRef[]): Promise<Set<string>> {
  if (ctx.remote === false && !currentCallerAccess().applyRemoteReadPolicy) return new Set(refs.map(refKey));
  const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
  const ids = refs.flatMap(r => (r.kind === 'page_id' ? [r.id] : []));
  const named = refs.flatMap(r => (r.kind === 'page' ? [r] : []));
  const rows = await ctx.engine.readGuestRefPages(ids, named.map(r => ({ source_id: r.source_id, slug: r.slug })), excludePrivate);
  const readable = new Set<string>();
  for (const row of rows) {
    if (!sourceAdmitted(ctx, row.source_id) || (excludePrivate && isPrivatePageForCaller(row))) continue;
    readable.add(refKey({ kind: 'page', source_id: row.source_id, slug: row.slug }));
    readable.add(refKey({ kind: 'page_id', id: Number(row.id) }));
  }
  return readable;
}
