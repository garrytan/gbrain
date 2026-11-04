import type { OperationContext } from './contract.ts';
import { pageTypesById, quotePageText, quotesStored } from '../search/transcript-quote.ts';

/**
 * GST-687: an untrusted reader gets an entry of a chat page, or one below the owner's tier, quoted like get_page's timeline.
 * `slug` names the quoted page: one page's slug, or each row's own (the chronicle reads span pages). The entry's free-text
 * `source` is quoted with it (#8384).
 */
export async function quoteTimelineRows<T extends { page_id: number; summary: string; detail?: string | null; source?: string | null; trust_tier: string | null }>(
  ctx: Pick<OperationContext, 'engine' | 'remote'>, slug: string | ((row: T) => string), rows: T[],
): Promise<Array<T | (T & { quoted: 'transcript' })>> {
  if (ctx.remote === false || rows.length === 0) return rows;
  const types = await pageTypesById(ctx.engine, rows.map(e => e.page_id));
  return rows.map(e => {
    const type = types.get(e.page_id);
    if (!quotesStored(type, e.trust_tier)) return e;
    const quote = (text: string) => quotePageText(text, typeof slug === 'string' ? slug : slug(e), type);
    return { ...e, summary: quote(e.summary), ...(e.detail ? { detail: quote(e.detail) } : {}), ...(e.source ? { source: quote(e.source) } : {}), quoted: 'transcript' as const };
  });
}
