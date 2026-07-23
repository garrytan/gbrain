/**
 * Exact-entity mention recall arm.
 *
 * A query about "Agy" should surface pages that link to people/agy. The
 * ordinary backlink boost does the inverse: it boosts the popular target
 * entity itself, which lets globally central people outrank the meetings
 * containing the evidence. This arm resolves explicit name-like query tokens,
 * walks inbound links, and feeds the referring pages into hybrid RRF.
 */

import type { BrainEngine } from '../engine.ts';
import type { PageType, SearchOpts, SearchResult } from '../types.ts';

const ANCHOR_STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'why', 'how', 'have', 'about',
  'with', 'from', 'into', 'their', 'there', 'this', 'that', 'sales',
  'operations', 'responsibilities', 'proposals', 'partnerships',
]);
const EVIDENCE_STOPWORDS = new Set([
  'what', 'when', 'where', 'which', 'who', 'why', 'how', 'have', 'about',
  'with', 'from', 'into', 'their', 'there', 'this', 'that', 'and', 'the',
]);

export function extractEntityAnchors(query: string): string[] {
  const tokens = query.match(/[\p{L}\p{N}][\p{L}\p{N}._'-]*/gu) ?? [];
  const out: string[] = [];
  for (const token of tokens) {
    const lower = token.toLocaleLowerCase();
    if (lower.length < 2 || ANCHOR_STOPWORDS.has(lower)) continue;
    // Names/acronyms are high-confidence anchors. Also admit the first token
    // for lowercase short lookup-style queries ("agy role").
    const nameLike = /^[\p{Lu}\d]/u.test(token) || /^[A-Z0-9]{2,}$/u.test(token);
    const shortLookup = tokens.indexOf(token) === 0 && tokens.length <= 4;
    if (!nameLike && !shortLookup) continue;
    if (!out.some((x) => x.toLocaleLowerCase() === lower)) out.push(token);
    if (out.length >= 4) break;
  }
  return out;
}

function exactEntityMatch(anchor: string, row: SearchResult): boolean {
  const a = anchor.toLocaleLowerCase();
  const title = (row.title ?? '').trim().toLocaleLowerCase();
  const tail = row.slug.split('/').pop()?.replace(/[-_]+/g, ' ').toLocaleLowerCase() ?? '';
  return title === a || tail === a;
}

export interface EntityMentionArmOpts {
  sourceId?: string;
  sourceIds?: string[];
  limit?: number;
}

export async function buildEntityMentionArm(
  engine: BrainEngine,
  query: string,
  opts: EntityMentionArmOpts = {},
): Promise<SearchResult[]> {
  const anchors = extractEntityAnchors(query);
  if (anchors.length === 0) return [];

  try {
    // Query each source independently. A federated title search may dedupe
    // identical entity slugs (people/agy) to the default source, losing the
    // source-local entity node whose inbound meeting links we need.
    const scopes =
      opts.sourceIds && opts.sourceIds.length > 0
        ? opts.sourceIds.map((sourceId) => ({ sourceId }))
        : [{ sourceId: opts.sourceId }];
    const entityRows = (
      await Promise.all(anchors.flatMap((anchor) => scopes.map((scope) =>
        engine.searchTitles(anchor, {
          limit: 8,
          detail: 'low',
          types: ['person', 'company', 'project'],
          ...scope,
        } as SearchOpts).then((rows) => rows.filter((r) => exactEntityMatch(anchor, r))),
      )))
    ).flat();

    const entities = Array.from(new Map(
      entityRows.map((r) => [`${r.source_id ?? 'default'}:${r.slug}`, r]),
    ).values());
    if (entities.length === 0) return [];

    const refs = new Map<string, { source_id: string | null; slug: string; evidence: number }>();
    const queryTerms = new Set(
      query.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u)
        .filter((x) => x.length >= 3 && !EVIDENCE_STOPWORDS.has(x)),
    );
    for (const entity of entities) {
      const sourceId = entity.source_id ?? 'default';
      // In a federated brain, canonical entities commonly live in `default`
      // while meeting referrers live in another source. A scalar source filter
      // requires both endpoints to be in that source and therefore hides the
      // cross-source inbound links. The granted sourceIds path safely spans
      // both endpoints.
      const federated =
        (opts.sourceIds && opts.sourceIds.length > 0) ||
        opts.sourceId === undefined ||
        opts.sourceId === '__all__';
      const links = await engine.getBacklinks(
        entity.slug,
        federated
          ? (opts.sourceIds ? { sourceIds: opts.sourceIds } : {})
          : { sourceId },
      );
      const entityTail = entity.slug.split('/').pop() ?? '';
      for (const link of links) {
        const haystack = `${link.context ?? ''} ${link.from_slug}`.toLocaleLowerCase();
        let evidence = 1;
        for (const term of queryTerms) if (haystack.includes(term)) evidence += 1;
        if (entityTail && link.from_slug.toLocaleLowerCase().includes(entityTail.toLocaleLowerCase())) {
          evidence += 4;
        }
        const refSourceId = federated ? null : sourceId;
        const key = `${refSourceId ?? '*'}:${link.from_slug}`;
        const prev = refs.get(key);
        if (!prev || evidence > prev.evidence) {
          refs.set(key, { source_id: refSourceId, slug: link.from_slug, evidence });
        }
      }
    }
    if (refs.size === 0) return [];

    const boundedRefs = [...refs.values()]
      .sort((a, b) => b.evidence - a.evidence || a.slug.localeCompare(b.slug))
      .slice(0, Math.max(opts.limit ?? 30, 1));
    const rows = await engine.executeRaw<{
      page_id: number;
      source_id: string;
      slug: string;
      title: string;
      type: string;
      synopsis: string | null;
      effective_date: string | null;
    }>(
      `WITH refs AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb)
           AS x(source_id text, slug text, evidence int)
       )
       SELECT p.id AS page_id, p.source_id, p.slug, p.title, p.type,
              LEFT(p.compiled_truth, 300) AS synopsis,
              COALESCE(p.effective_date, p.updated_at, p.created_at)::text AS effective_date,
              refs.evidence
         FROM refs
       JOIN pages p ON (refs.source_id IS NULL OR p.source_id = refs.source_id)
                   AND p.slug = refs.slug
        WHERE p.deleted_at IS NULL
          AND ($2::text[] IS NULL OR p.source_id = ANY($2::text[]))
        ORDER BY refs.evidence DESC,
                 COALESCE(p.effective_date, p.updated_at, p.created_at) DESC`,
      [boundedRefs, opts.sourceIds ?? null],
    );

    return rows.map((row) => ({
      slug: row.slug,
      page_id: row.page_id,
      title: row.title,
      type: row.type as PageType,
      chunk_text: row.synopsis ?? row.slug,
      chunk_source: 'compiled_truth',
      chunk_id: 0,
      chunk_index: 0,
      score: 0,
      stale: false,
      source_id: row.source_id,
      effective_date: row.effective_date,
    }));
  } catch (err) {
    if (process.env.GBRAIN_SEARCH_DEBUG === '1') {
      process.stderr.write(
        `[entity-mention-recall] ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    // Recall arms are fail-open. Keyword/vector retrieval still runs.
    return [];
  }
}
