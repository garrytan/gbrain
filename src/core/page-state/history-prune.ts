/**
 * #9737 `gbrain history prune`: the owner removes saved versions (`page_versions`) from the history of chosen pages,
 * so text taken out of a page stops being readable in `get_versions`, and history that scheduled jobs rewrite stops
 * growing without bound. Every write-time prune is a size policy; this one is aimed by the owner.
 *
 * Preview, then apply. `planHistoryPrune` lists exactly which versions would go (per page: how many, how many stay, the
 * oldest and newest removed, the bytes) and a `plan_hash` over the version ids. The apply recomputes the plan and
 * refuses `preview_changed` unless the hash still matches, then deletes exactly those ids, one page at a time under the
 * page lock (`pruneInlineVersionsById`). The live page is never touched: a saved version is a copy of an earlier state.
 *
 * Kept whatever the bounds say: the newest `keep` versions of each page (segmented ones count, GST-4026), versions newer than `older_than`, every
 * version of an agent_policy page (its audit trail) or of a soft-deleted page, and segmented versions (their own
 * retention, `versions.segmented_max_per_page`). Reads and writes the database only, so repo-less and repo-backed
 * brains behave the same. Trusted local CLI only: no operation exposes it.
 */
import type { BrainEngine } from '../engine.ts';
import { computePlanHash } from '../consent.ts';
import { AGENT_POLICY_TYPE } from '../policy/slugs.ts';
import { pruneInlineVersionsById } from './versions.ts';

export interface HistoryPruneSelection {
  slug?: string;
  prefix?: string;
  type?: string;
  all?: boolean;
  sourceId?: string;
  /** Keep this many newest versions of each page; a segmented version counts toward them and is never pruned. */
  keep?: number;
  /** Only versions saved more than this many hours ago. */
  olderThanHours?: number;
  /** Exactly these version ids (with a slug). */
  versionIds?: number[];
}

export interface HistoryPrunePage {
  source_id: string;
  slug: string;
  page_id: number;
  versions_total: number;
  versions_pruned: number;
  versions_kept: number;
  bytes_pruned: number;
  oldest_pruned_at: string;
  newest_pruned_at: string;
  version_ids: number[];
}

export interface HistoryPrunePlan {
  plan_hash: string;
  parameters: Record<string, unknown>;
  pages: HistoryPrunePage[];
  totals: { pages: number; versions: number; bytes: number; oldest_at: string | null; newest_at: string | null };
  /** Matching history this command never prunes, so the preview says it stays. */
  kept_by_rule: { segmented_versions: number; agent_policy_pages: number };
  /** A bare slug only: every source with a live page at that slug, whatever its history (more than one needs --source). */
  slug_sources?: string[];
}

interface Row { source_id: string; slug: string; page_id: number | string; id: number | string; snapshot_at: Date | string; bytes: number | string; total: number | string }

const iso = (v: Date | string) => new Date(v).toISOString();

function parameters(sel: HistoryPruneSelection): Record<string, unknown> {
  return { slug: sel.slug ?? null, prefix: sel.prefix ?? null, type: sel.type ?? null, all: sel.all === true, source_id: sel.sourceId ?? null,
    keep: sel.keep ?? null, older_than_hours: sel.olderThanHours ?? null, version_ids: sel.versionIds ? [...sel.versionIds].sort((a, b) => a - b) : null };
}

const PAGE_FILTER = `($1::text IS NULL OR p.source_id = $1) AND ($2::text IS NULL OR p.slug = $2)
  AND ($3::text IS NULL OR left(p.slug, length($3)) = $3) AND ($4::text IS NULL OR p.type = $4)`;

export async function planHistoryPrune(engine: BrainEngine, sel: HistoryPruneSelection): Promise<HistoryPrunePlan> {
  const filter = [sel.sourceId ?? null, sel.slug ?? null, sel.prefix ?? null, sel.type ?? null];
  const rows = await engine.executeRaw<Row>(`WITH v AS (
      SELECT pv.id, pv.page_id, pv.snapshot_at, pv.body_storage IS DISTINCT FROM 'segmented' AS inline,
             octet_length(COALESCE(pv.compiled_truth, '')) + octet_length(COALESCE(pv.timeline, '')) AS bytes,
             row_number() OVER (PARTITION BY pv.page_id ORDER BY pv.id DESC) AS rk,
             count(*) OVER (PARTITION BY pv.page_id) AS total
        FROM page_versions pv JOIN pages p ON p.id = pv.page_id
       WHERE p.deleted_at IS NULL AND p.type IS DISTINCT FROM $5 AND ${PAGE_FILTER})
    SELECT p.source_id, p.slug, v.page_id, v.id, v.snapshot_at, v.bytes, v.total
      FROM v JOIN pages p ON p.id = v.page_id
     WHERE v.inline AND ($6::int IS NULL OR v.rk > $6) AND ($7::int IS NULL OR v.snapshot_at < now() - $7::int * interval '1 hour')
       AND ($8::int[] IS NULL OR v.id = ANY($8::int[]))
     ORDER BY p.source_id, p.slug, v.id`,
  [...filter, AGENT_POLICY_TYPE, sel.keep ?? null, sel.olderThanHours ?? null, sel.versionIds ?? null]);
  const [kept] = await engine.executeRaw<{ segmented: number | string; policy: number | string }>(`SELECT
      count(*) FILTER (WHERE pv.body_storage = 'segmented' AND p.type IS DISTINCT FROM $5) AS segmented,
      count(DISTINCT p.id) FILTER (WHERE p.type = $5) AS policy
    FROM page_versions pv JOIN pages p ON p.id = pv.page_id WHERE p.deleted_at IS NULL AND ${PAGE_FILTER}`, [...filter, AGENT_POLICY_TYPE]);
  const byPage = new Map<number, HistoryPrunePage>();
  for (const row of rows) {
    const pageId = Number(row.page_id);
    const at = iso(row.snapshot_at);
    let page = byPage.get(pageId);
    if (!page) byPage.set(pageId, page = { source_id: row.source_id, slug: row.slug, page_id: pageId, versions_total: Number(row.total), versions_pruned: 0,
      versions_kept: 0, bytes_pruned: 0, oldest_pruned_at: at, newest_pruned_at: at, version_ids: [] });
    page.version_ids.push(Number(row.id));
    page.versions_pruned++;
    page.bytes_pruned += Number(row.bytes);
    if (at < page.oldest_pruned_at) page.oldest_pruned_at = at;
    if (at > page.newest_pruned_at) page.newest_pruned_at = at;
  }
  const pages = [...byPage.values()];
  for (const page of pages) page.versions_kept = page.versions_total - page.versions_pruned;
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id::text AS brain_id FROM persistence_brain WHERE singleton=1');
  const params = parameters(sel);
  const plan_hash = computePlanHash({ brain: brain?.brain_id ?? 'unknown', source: sel.sourceId ?? null, operation: 'history_prune',
    records: pages.flatMap(page => page.version_ids.map(id => ({ id: String(id), revision: `${page.page_id}:${page.source_id}:${page.slug}` }))), parameters: params, effects: ['destructive'] });
  const slugSources = sel.slug !== undefined && sel.sourceId === undefined
    ? (await engine.executeRaw<{ source_id: string }>('SELECT DISTINCT source_id FROM pages WHERE slug = $1 AND deleted_at IS NULL ORDER BY source_id', [sel.slug])).map(r => r.source_id)
    : undefined;
  const stamps = pages.flatMap(page => [page.oldest_pruned_at, page.newest_pruned_at]).sort();
  return {
    plan_hash, parameters: params, pages,
    totals: { pages: pages.length, versions: pages.reduce((n, p) => n + p.versions_pruned, 0), bytes: pages.reduce((n, p) => n + p.bytes_pruned, 0),
      oldest_at: stamps[0] ?? null, newest_at: stamps[stamps.length - 1] ?? null },
    kept_by_rule: { segmented_versions: Number(kept?.segmented ?? 0), agent_policy_pages: Number(kept?.policy ?? 0) },
    ...(slugSources ? { slug_sources: slugSources } : {}),
  };
}

/**
 * Deletes the plan's versions, one page at a time under its page lock. The caller has checked the plan hash. With
 * --keep, segmented retention may have removed some of the newest versions since the preview, so only an approved
 * version still outside the newest `keep` under the lock goes.
 */
export async function applyHistoryPrune(engine: BrainEngine, plan: HistoryPrunePlan): Promise<{ pages: number; versions: number; unchanged_pages: number }> {
  let versions = 0, pages = 0, unchanged = 0;
  for (const page of plan.pages) {
    const n = await engine.transaction(async tx => {
      await tx.lockPageKeys([{ sourceId: page.source_id, slug: page.slug }]);
      return pruneInlineVersionsById(tx, { pageId: page.page_id, sourceId: page.source_id, slug: page.slug, type: (plan.parameters.type as string | null) ?? null,
        keep: (plan.parameters.keep as number | null) ?? null }, page.version_ids);
    });
    versions += n;
    if (n) pages++;
    else unchanged++;
  }
  return { pages, versions, unchanged_pages: unchanged };
}
