/**
 * #9427: the owner's one-pass review of `outside_content_fences` for imported transcripts. A transcript that
 * `gbrain transcripts ingest` imported is outside-authored text by construction, and gbrain's own conversation-facts
 * extraction indexes rows on it, so the per-page review the check asks for is one uniform decision repeated hundreds
 * of times. `gbrain transcripts accept-fences` previews every such page with a plan_hash, and an apply with that hash
 * records the owner's acceptance of each page's exact rows.
 *
 * Only imported transcripts qualify: `type: conversation`, `transcript_import` frontmatter, AND live text the importer
 * wrote (importerWroteLiveTextSql: a remote write names its own operation as the text's author). Email,
 * calendar and GitHub pages, and any page a remote writer or another local writer last wrote, stay for per-page
 * review. An acceptance binds the page id and a fingerprint of the page's indexed fence rows (fact, take and link ids),
 * and the check re-reads the provenance each run, so a new row, a removed row or a later non-importer write puts the
 * page back on the list. Tag changes, re-embedding and other maintenance change no text, so they keep a page eligible and
 * accepted (GST-4056, GST-4026); an importer rewrite with the same rows stays accepted. An acceptance records the page's
 * content_hash it was given for; a page the upgrade attributed as `legacy:` is never offered, and keeps an acceptance
 * recorded before the upgrade only for that exact content. The record is the config row `transcripts.fence_acceptance` (no operation writes config),
 * and nothing in a page or its rows changes, so repo-less and repo-backed brains behave the same.
 */
import type { BrainEngine } from '../engine.ts';
import { computePlanHash } from '../consent.ts';
import { IMPORTER_INGESTED_VIA, importerWroteLiveTextSql } from './importer-provenance.ts';

export const FENCE_ACCEPTANCE_KEY = 'transcripts.fence_acceptance';

/** A fact's or take's fields that maintenance rewrites without changing the row (the managed writer guard's physical projections). */
const PROJECTION_KEYS = `ARRAY['embedding','embedded_at','embedding_model','embedded_text_hash','last_retrieved_at','retrieval_count','write_origin',
  'write_request_id','write_principal_kind','write_principal_id','last_write_request_id','last_write_principal_kind','last_write_principal_id',
  'last_written_at','created_at','updated_at']`;

/** What the doctor check lists per page: location and counts, never a cell value. */
export interface OutsideFenceItem { source_id: string; slug: string; type: string; facts: number; world_facts: number; takes: number; links: number }
export interface OutsideFencePage extends OutsideFenceItem {
  page_id: number; fingerprint: string; imported_transcript: boolean; content_hash: string;
  /** An imported transcript whose live text the v343 backfill attributed to the importer as `legacy:` (never offered for acceptance). */
  legacy_transcript: boolean;
}
export interface FenceAcceptance { page_id: number; source_id: string; slug: string; fingerprint: string; accepted_at: string; content_hash?: string }

/** Imported pages whose body is outside-authored text and that have fence rows indexed as facts, takes or links. */
export async function listOutsideFencePages(engine: BrainEngine): Promise<OutsideFencePage[]> {
  // The fingerprint hashes each row's fields as JSON; a fixed session time zone keeps a timestamp's text the same everywhere.
  const rows = await engine.transaction(async tx => { await tx.executeRaw("SET LOCAL TimeZone = 'UTC'"); return tx.executeRaw<OutsideFencePage & { page_id: number | string }>(
    `WITH listed AS (SELECT p.id AS page_id, p.source_id, p.slug, p.type, sum(x.facts)::int AS facts, sum(x.world_facts)::int AS world_facts,
            sum(x.takes)::int AS takes, sum(x.links)::int AS links, md5(string_agg(x.k, ',' ORDER BY x.k)) AS fingerprint,
            COALESCE(max(p.content_hash), '') AS content_hash,
            bool_and(p.type = 'conversation' AND p.frontmatter ? 'transcript_import' AND ${importerWroteLiveTextSql('p', '$1')}) AS imported_transcript,
            bool_and(p.type = 'conversation' AND p.frontmatter ? 'transcript_import' AND ${importerWroteLiveTextSql('p', '$1', { legacy: true })}) AS legacy_transcript
       FROM (SELECT fp.id AS page_id, 1 AS facts, CASE WHEN f.visibility = 'world' THEN 1 ELSE 0 END AS world_facts, 0 AS takes, 0 AS links, 'f' || f.id || ':' || md5((to_jsonb(f) - ${PROJECTION_KEYS} - 'consolidated_at' - 'consolidated_into')::text) AS k
               FROM facts f JOIN pages fp ON fp.source_id = f.source_id AND fp.slug = f.source_markdown_slug
              WHERE f.row_num IS NOT NULL AND f.expired_at IS NULL
             UNION ALL SELECT t.page_id, 0, 0, 1, 0, 't' || t.id || ':' || md5((to_jsonb(t) - ${PROJECTION_KEYS})::text) FROM takes t WHERE t.active
             UNION ALL SELECT l.origin_page_id, 0, 0, 0, 1, 'l' || l.id || ':' || md5((to_jsonb(l) - 'created_at')::text) FROM links l WHERE l.origin_field = 'links_fence') x
       JOIN pages p ON p.id = x.page_id
       JOIN sources s ON s.id = p.source_id
      WHERE p.deleted_at IS NULL AND s.archived IS NOT TRUE
        AND ((s.config->>'kind' = 'google' AND p.type IN ('email', 'meeting')) OR s.config->>'kind' = 'github'
             OR p.frontmatter ? 'transcript_import')
      GROUP BY p.id, p.source_id, p.slug, p.type)
     SELECT * FROM listed
      ORDER BY source_id, slug`, [IMPORTER_INGESTED_VIA]); });
  return rows.map(row => ({ ...row, page_id: Number(row.page_id), imported_transcript: row.imported_transcript === true,
    legacy_transcript: row.legacy_transcript === true }));
}

export async function loadFenceAcceptance(engine: BrainEngine): Promise<FenceAcceptance[]> {
  try {
    const parsed = JSON.parse((await engine.getConfig(FENCE_ACCEPTANCE_KEY)) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((e): e is FenceAcceptance => !!e && typeof e === 'object'
      && Number.isSafeInteger((e as FenceAcceptance).page_id) && typeof (e as FenceAcceptance).fingerprint === 'string') : [];
  } catch { // silent-read-ok: an unreadable record accepts nothing, so every page stays listed for review
    return [];
  }
}

/**
 * An acceptance counts only for an importer-written transcript whose fence rows are exactly the ones accepted. A page the
 * upgrade attributed as `legacy:` keeps an acceptance recorded for its exact content (GST-4026's content_hash) while that
 * text stays; a hash-less acceptance never counts for one.
 */
export function isAccepted(page: OutsideFencePage, acceptance: readonly FenceAcceptance[]): boolean {
  return acceptance.some(a => a.page_id === page.page_id && a.fingerprint === page.fingerprint
    && (page.imported_transcript || (page.legacy_transcript && !!a.content_hash && a.content_hash === page.content_hash)));
}

export const fenceItem = ({ source_id, slug, type, facts, world_facts, takes, links }: OutsideFencePage): OutsideFenceItem =>
  ({ source_id, slug, type, facts, world_facts, takes, links });

export interface FenceAcceptancePlan {
  plan_hash: string;
  source_id: string | null;
  /** Imported transcripts whose current rows the apply accepts. */
  pages: Array<OutsideFenceItem & { page_id: number; fingerprint: string; content_hash: string }>;
  /** Already accepted with these exact rows. */
  already_accepted: number;
  /** Listed pages this command never accepts (not an importer-written transcript): they stay for per-page review. */
  not_eligible: OutsideFenceItem[];
}

export async function planFenceAcceptance(engine: BrainEngine, opts: { sourceId?: string } = {}): Promise<FenceAcceptancePlan> {
  const [listed, acceptance] = await Promise.all([listOutsideFencePages(engine), loadFenceAcceptance(engine)]);
  const scoped = listed.filter(p => opts.sourceId === undefined || p.source_id === opts.sourceId);
  const pages = scoped.filter(p => p.imported_transcript && !isAccepted(p, acceptance))
    .map(p => ({ ...fenceItem(p), page_id: p.page_id, fingerprint: p.fingerprint, content_hash: p.content_hash }));
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id::text AS brain_id FROM persistence_brain WHERE singleton=1');
  return {
    plan_hash: computePlanHash({ brain: brain?.brain_id ?? 'unknown', source: opts.sourceId ?? null, operation: 'transcripts_accept_fences',
      records: pages.map(p => ({ id: String(p.page_id), revision: `${p.fingerprint}:${p.content_hash}` })), parameters: { source_id: opts.sourceId ?? null }, effects: [] }),
    source_id: opts.sourceId ?? null,
    pages,
    already_accepted: scoped.filter(p => isAccepted(p, acceptance)).length,
    not_eligible: scoped.filter(p => !p.imported_transcript && !isAccepted(p, acceptance)).map(fenceItem),
  };
}

/**
 * Adds the plan's pages to the record under a row lock, so two applies never drop each other's entries; every other entry
 * is kept (an entry whose page or rows changed simply stops matching). The caller checked the hash.
 */
export async function applyFenceAcceptance(engine: BrainEngine, plan: FenceAcceptancePlan, now = new Date()): Promise<number> {
  if (!plan.pages.length) return 0;
  const planned = new Set(plan.pages.map(p => p.page_id));
  const at = now.toISOString();
  await engine.transaction(async tx => {
    await tx.executeRaw(`INSERT INTO config (key, value) VALUES ($1, '[]') ON CONFLICT (key) DO NOTHING`, [FENCE_ACCEPTANCE_KEY]);
    await tx.executeRaw(`SELECT value FROM config WHERE key = $1 FOR UPDATE`, [FENCE_ACCEPTANCE_KEY]);
    const acceptance = await loadFenceAcceptance(tx);
    await tx.setConfig(FENCE_ACCEPTANCE_KEY, JSON.stringify([
      ...acceptance.filter(a => !planned.has(a.page_id)),
      ...plan.pages.map(p => ({ page_id: p.page_id, source_id: p.source_id, slug: p.slug, fingerprint: p.fingerprint, content_hash: p.content_hash, accepted_at: at })),
    ]));
  });
  return plan.pages.length;
}
