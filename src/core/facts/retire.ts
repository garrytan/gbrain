/**
 * Retire the facts extracted from a connector page whose source item changed
 * or was deleted upstream (D5, autoplan T1/T21). Selection is by provenance:
 * active facts in the source whose session is the page's extraction session or
 * whose context names the page. Each is expired with `valid_until` at the run
 * time and struck where it is fenced — on an entity page or the connector page
 * itself — with a `retired: <reason>` marker. This is not a withdrawal: a
 * re-extraction of the current content may assert the claim again.
 *
 *  - unmanaged brains (the default keyless install, and unmanaged repo
 *    brains): the existing fence-strike path, `forgetFactInFence` in its
 *    retirement mode, which strikes the fence file and row or expires a
 *    fence-less row in the database;
 *  - managed brains: each affected fenced page is re-published through the
 *    coordinator with its rows struck (one page write per page, revision
 *    checked), so the door commits the strike before the database changes.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';

export interface RetireFactsResult { retired: number; pages: string[]; failed: number }

/** The backstop session id a connector page's facts are extracted under. */
export const connectorFactsSession = (sourceId: string, slug: string) => `connector:${sourceId}:${slug}`;

interface FactRow { id: number; row_num: number | null; source_markdown_slug: string | null; entity_slug: string | null }

export async function retireFactsFromPage(engine: BrainEngine, input: { sourceId: string; slug: string; reason: string; managed: boolean; ctx?: OperationContext }): Promise<RetireFactsResult> {
  const pattern = `${input.slug.replace(/[\\%_]/g, m => `\\${m}`)} %`;
  const rows = await engine.executeRaw<FactRow>(`SELECT id,row_num,source_markdown_slug,entity_slug FROM facts
    WHERE source_id=$1 AND expired_at IS NULL AND (source_session=$2 OR context=$3 OR context LIKE $4)
    ORDER BY id`, [input.sourceId, connectorFactsSession(input.sourceId, input.slug), input.slug, pattern]);
  const result: RetireFactsResult = { retired: 0, pages: [], failed: 0 };
  if (!rows.length) return result;
  if (!input.managed) {
    const { forgetFactInFence } = await import('./forget.ts');
    for (const row of rows) {
      const out = await forgetFactInFence(engine, Number(row.id), { sourceId: input.sourceId, retired: input.reason });
      if (out.ok) result.retired++;
      else if (out.path !== 'already_expired') result.failed++;
      if (out.ok && row.source_markdown_slug && !result.pages.includes(row.source_markdown_slug)) result.pages.push(row.source_markdown_slug);
    }
    return result;
  }
  const byPage = new Map<string, number[]>();
  for (const row of rows) {
    if (row.row_num === null || !row.source_markdown_slug) { result.failed++; continue; }
    byPage.set(row.source_markdown_slug, [...byPage.get(row.source_markdown_slug) ?? [], Number(row.row_num)]);
  }
  const [{ strikeFenceRow, retiredFact }, { serializePageToMarkdown }, { submitPageMutation }] = await Promise.all([
    import('./forget.ts'), import('../markdown.ts'), import('../persistence/page-mutations.ts')]);
  const today = new Date().toISOString().slice(0, 10);
  const ctx = input.ctx ?? { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: input.sourceId,
    logger: { info: () => {}, warn: () => {}, error: () => {} } } as unknown as OperationContext;
  for (const [slug, rowNums] of byPage) {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: input.sourceId });
    if (!snapshot || isSegmentedPage(snapshot.page)) { result.failed += rowNums.length; continue; }
    let body = snapshot.page.compiled_truth ?? '';
    let struck = 0;
    for (const rowNum of rowNums) {
      const next = strikeFenceRow(body, rowNum, fact => retiredFact(fact, today, input.reason));
      if (next === null) continue;
      body = next;
      struck++;
    }
    result.failed += rowNums.length - struck;
    if (!struck) continue;
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, source_id: input.sourceId,
      content: serializePageToMarkdown({ ...snapshot.page, compiled_truth: body }, snapshot.tags), expected_revision: snapshot.revision } });
    result.retired += struck;
    result.pages.push(slug);
  }
  return result;
}
