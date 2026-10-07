/**
 * `gbrain repair timeline-comments` (#6184): clean timeline rows the
 * inline-citation parser filed from adjacent HTML comments (a section's
 * `<!-- AUTO:... END -->` marker, a materialized-row marker) and the
 * materialized bullets that wrote those comments back into the page.
 *
 * Per page, one revision-bound `put_page` drops every materialized bullet whose
 * line carries comment markup (gbrain wrote it; the user's own bullets are
 * left alone), then one coordinated transaction under the page lock fixes the
 * rows still carrying markup: a row whose summary is only markup is deleted, a
 * row with markup around real text is rewritten to the stripped text (or
 * deleted when that stripped tuple already exists on the page). Rewritten
 * rows are database-only afterwards and are rendered back as clean marked
 * bullets by the next writer. Preview first; a second apply finds nothing.
 */
import type { BrainEngine } from '../engine.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { TIMELINE_COMMENT_MARKUP } from '../persistence/canonical-projections.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import { maintenanceAttribution, maintenanceTransaction } from '../persistence/attribution.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { materializedMarkerHash } from '../timeline-marker.ts';
import { stripHtmlComments } from '../timeline-citations.ts';
import { repairRequestId, type RepairHandler, type RepairItem, type RepairScope, type RepairCursor } from './core.ts';

interface MarkupRow { id: number; page_id: number; source_id: string; slug: string; date: string; source: string; summary: string; detail: string }

const MARKUP_SQL = `(t.summary LIKE '%<!--%' OR t.summary LIKE '%-->%' OR t.source LIKE '%<!--%' OR t.source LIKE '%-->%'
  OR t.detail LIKE '%<!--%' OR t.detail LIKE '%-->%')`;
const clean = (text: string) => stripHtmlComments(text).replace(/\s+/g, ' ').trim();

/** The body without materialized bullets (marker, bullet, indented detail) whose bullet line carries comment markup. */
export function dropCommentBullets(body: string): string {
  const lines = body.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (materializedMarkerHash(lines[i]!) && i + 1 < lines.length && /^\s*[-*+]\s/.test(lines[i + 1]!) && TIMELINE_COMMENT_MARKUP.test(lines[i + 1]!)) {
      i++;
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1]!) && !/^[ \t]*[-*+] /.test(lines[i + 1]!)) i++;
      continue;
    }
    kept.push(lines[i]!);
  }
  return kept.join('\n');
}

async function markupRows(engine: BrainEngine, where: string, params: unknown[]): Promise<MarkupRow[]> {
  return engine.executeRaw<MarkupRow>(`SELECT t.id, t.page_id, p.source_id, p.slug, t.date::text AS date, t.source, t.summary, t.detail
    FROM timeline_entries t JOIN pages p ON p.id=t.page_id
    WHERE t.event_page_id IS NULL AND p.deleted_at IS NULL AND ${MARKUP_SQL} AND ${where} ORDER BY t.page_id, t.id`, params);
}

/** Rows of one page still carrying markup, fixed under the page lock: deleted, or rewritten to their stripped tuple. */
async function cleanRows(engine: BrainEngine, page: { id: number; slug: string; source_id: string }): Promise<number> {
  const run = async (tx: BrainEngine) => {
    await tx.lockPageKeys([{ sourceId: page.source_id, slug: page.slug }]);
    let fixed = 0;
    for (const row of await markupRows(tx, 't.page_id=$1', [page.id])) {
      const next = { source: clean(row.source), summary: clean(row.summary), detail: clean(row.detail ?? '') };
      const [twin] = next.summary ? await tx.executeRaw<{ id: number }>(`SELECT id FROM timeline_entries
        WHERE page_id=$1 AND event_page_id IS NULL AND date=$2::date AND source=$3 AND summary=$4 AND id<>$5 LIMIT 1`,
      [page.id, row.date, next.source, next.summary, row.id]) : [];
      if (!next.summary || twin) await tx.executeRaw('DELETE FROM timeline_entries WHERE id=$1', [row.id]);
      else await tx.executeRaw('UPDATE timeline_entries SET source=$2, summary=$3, detail=$4 WHERE id=$1', [row.id, next.source, next.summary, next.detail]);
      fixed++;
    }
    return fixed;
  };
  if (!await managedPersistenceEnabled(engine)) return maintenanceTransaction(engine, run);
  const attribution = await maintenanceAttribution(engine);
  return engine.transaction(tx => withCoordinatedWrite(tx, [page.source_id], () => run(tx), attribution));
}

export const timelineCommentsRepair: RepairHandler = {
  kind: 'timeline-comments',
  async plan(engine: BrainEngine, scope: RepairScope, after: RepairCursor | null) {
    const rows = await markupRows(engine, 'p.source_id=ANY($1::text[]) AND p.id>$2', [scope.source_ids, after?.id ?? 0]);
    const pages = await engine.executeRaw<{ id: number; source_id: string; slug: string; compiled_truth: string; timeline: string | null }>(
      `SELECT id, source_id, slug, compiled_truth, timeline FROM pages WHERE source_id=ANY($1::text[]) AND deleted_at IS NULL AND id>$2
         AND (compiled_truth LIKE '%gbrain:materialized%' OR timeline LIKE '%gbrain:materialized%') ORDER BY id`, [scope.source_ids, after?.id ?? 0]);
    const bullets = new Map(pages.map(p => [p.id, p] as const));
    const byPage = new Map<number, { id: number; source_id: string; slug: string; rows: MarkupRow[]; bullets: boolean; chars: number }>();
    for (const page of pages) {
      const body = `${page.compiled_truth}\n${page.timeline ?? ''}`;
      if (dropCommentBullets(body) !== body) byPage.set(page.id, { id: page.id, source_id: page.source_id, slug: page.slug, rows: [], bullets: true, chars: body.length });
    }
    for (const row of rows) {
      const entry = byPage.get(row.page_id) ?? { id: row.page_id, source_id: row.source_id, slug: row.slug, rows: [], bullets: false,
        chars: (bullets.get(row.page_id)?.compiled_truth.length ?? 0) + (bullets.get(row.page_id)?.timeline?.length ?? 0) };
      entry.rows.push(row);
      byPage.set(row.page_id, entry);
    }
    const items: RepairItem[] = [...byPage.values()].sort((a, b) => a.id - b.id).map(p => ({ cursor: { phase: 0, id: p.id }, source_id: p.source_id, slug: p.slug,
      chars: p.chars, action: [p.bullets ? 'drop comment bullets' : '', p.rows.length ? `clean ${p.rows.length} row(s)` : ''].filter(Boolean).join(', ') }));
    return { items, residuals: {
      comment_only_rows: rows.filter(r => !clean(r.summary)).length,
      comment_bearing_rows: rows.filter(r => !!clean(r.summary)).length,
      pages_with_comment_bullets: [...byPage.values()].filter(p => p.bullets).length,
    } };
  },
  async apply(ctx, item) {
    const snapshot = await ctx.engine.readPageSnapshot(item.slug, { sourceId: item.source_id });
    if (!snapshot) return false;
    const next = { compiled_truth: dropCommentBullets(snapshot.page.compiled_truth), timeline: dropCommentBullets(snapshot.page.timeline ?? '') };
    const rewrite = next.compiled_truth !== snapshot.page.compiled_truth || next.timeline !== (snapshot.page.timeline ?? '');
    if (rewrite) {
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug: item.slug, source_id: item.source_id,
        content: serializePageToMarkdown({ ...snapshot.page, ...next }, snapshot.tags), expected_revision: snapshot.revision,
        request_id: await repairRequestId(ctx, 'timeline-comments', item, snapshot.revision) } });
    }
    const fixed = await cleanRows(ctx.engine, { id: snapshot.page.id, slug: item.slug, source_id: item.source_id });
    return rewrite || fixed > 0;
  },
};
