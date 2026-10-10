/**
 * Provenance-aware ranking: a page gbrain itself generated ranks below a
 * primary record about the same entity that matches the same query, because a
 * summary is not evidence.
 *
 * Generated means a gbrain-owned marker only: frontmatter `dream_generated:
 * true` (dream synthesis output) or `type: extract_receipt`. Every such row is
 * stamped `provenance: "generated"`. It is demoted (score x GENERATED_FACTOR)
 * only when the query names an entity (search/alias-fanout.ts
 * `resolveQueryEntity`), the generated page links to that entity, and a
 * non-generated row in the same pool is the entity page or links to it. A
 * generated page recording a correction (frontmatter `supersedes` or
 * `corrects`, or a facts-fence row with a `valid_until`) is never demoted, and
 * facts saved with `remember` are not pages, so nothing here touches them.
 *
 * Runs in the identity-boost stage (hybrid/request.ts `applyIdentityBoosts`):
 * after fusion and the metadata boosts, before reranking and before the pool
 * is cut. `search.demote_generated=false` turns demotion off (rows are still
 * stamped). Fail-soft: any error leaves scores unchanged.
 */

import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { resolveQueryEntity } from './alias-fanout.ts';

export const GENERATED_FACTOR = 0.5;

const isOff = (v: string | null) => v != null && ['false', '0', 'no', 'off'].includes(v.trim().toLowerCase());

/** Whether a generated page records a correction (never demoted). */
export function recordsCorrection(frontmatter: Record<string, unknown> | null, body: string | null): boolean {
  if (frontmatter && (frontmatter.supersedes != null || frontmatter.corrects != null)) return true;
  try {
    return parseFactsFence(body ?? '').facts.some(f => !!f.validUntil);
  } catch {
    return false;
  }
}

export async function applyGeneratedDemotion(engine: BrainEngine, list: SearchResult[], query: string,
  scope: { sourceId?: string; sourceIds?: string[]; excludePrivate?: boolean }): Promise<void> {
  try {
    const ids = [...new Set(list.map(r => r.page_id).filter((id): id is number => typeof id === 'number'))];
    if (!ids.length) return;
    const generated = await engine.executeRaw<{ id: number; frontmatter: Record<string, unknown> | null; compiled_truth: string | null }>(
      `SELECT id, frontmatter, compiled_truth FROM pages
        WHERE id = ANY($1::int[]) AND (frontmatter->>'dream_generated' = 'true' OR type = 'extract_receipt')`, [ids]);
    if (!generated.length) return;
    const generatedIds = new Set(generated.map(g => Number(g.id)));
    for (const r of list) if (generatedIds.has(r.page_id)) r.provenance = 'generated';
    if (isOff(await engine.getConfig('search.demote_generated'))) return;
    const demotable = new Set(generated.filter(g => !recordsCorrection(g.frontmatter, g.compiled_truth)).map(g => Number(g.id)));
    if (!demotable.size) return;
    const entity = await resolveQueryEntity(engine, query, { ...scope, excludePrivate: scope.excludePrivate ?? true });
    if (!entity) return;
    const targets = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE deleted_at IS NULL AND (source_id, slug) IN (SELECT * FROM unnest($1::text[], $2::text[]))`,
      [entity.pages.map(p => p.source_id), entity.pages.map(p => p.slug)]);
    const targetIds = targets.map(t => Number(t.id));
    if (!targetIds.length) return;
    const linking = new Set((await engine.executeRaw<{ id: number }>(
      `SELECT DISTINCT from_page_id AS id FROM links WHERE from_page_id = ANY($1::int[]) AND to_page_id = ANY($2::int[])`,
      [ids, targetIds])).map(r => Number(r.id)));
    const primaryPresent = list.some(r => !generatedIds.has(r.page_id) && (targetIds.includes(r.page_id) || linking.has(r.page_id)));
    if (!primaryPresent) return;
    for (const r of list) {
      if (!demotable.has(r.page_id) || !linking.has(r.page_id)) continue;
      r.score *= GENERATED_FACTOR;
      r.generated_demotion = GENERATED_FACTOR;
    }
  } catch {
    /* ranking-only: never break the search */
  }
}
