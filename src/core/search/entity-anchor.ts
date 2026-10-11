/**
 * Entity-anchored retrieval. Keyword and vector ranking treat every note that
 * shares a question's words alike, so once notes about an entity accumulate
 * the newest one can fall outside the window. Anchoring reads pages by their
 * relation to one entity instead: the entity page first, then pages that
 * link to it or name it as a word, newest first.
 *
 * Shared by pinned-question refresh (`retrieveEvidence`, owner reads) and the
 * `query` / `search` ops (`applyEntityAnchoring`, behind
 * `search.entity_anchoring`, default off). Detection is deterministic: a
 * current-state cue in the query and exactly one entity page whose title the
 * query mentions. No model call.
 *
 * Read safety: candidate selection reads page ids only; every row this module
 * returns to a search caller comes from `getChunkWindows`, which re-authorizes
 * each page under the caller's read scope (source, deleted, projection,
 * archived source, quarantine, private pages, safe chunks). A page that fails
 * is absent.
 */
import type { BrainEngine } from '../engine.ts';
import type { PageReadScope, SearchResult } from '../types.ts';
import { PINNED_QUESTION_MARKER } from '../questions/identity.ts';
import { isFactEntityPage } from '../entities/resolve.ts';
import { pageReadFilter } from './read-policy-sql.ts';
import { containsTokenRun, isTitleMentionedInQuery, tokenizeTitle } from './title-match.ts';
import { enforceTokenBudget } from './token-budget.ts';

export const ENTITY_ANCHORING_KEY = 'search.entity_anchoring';
/** Anchored pages read per entity (the entity page is extra). */
export const MAX_ANCHORED = 10;

export interface AnchoredPage { id: number; slug: string }

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The entity page (when live) and up to `limit` pages that link to it or name it, newest first. */
export async function entityAnchoredPages(engine: BrainEngine, sourceId: string, entitySlug: string, limit = MAX_ANCHORED): Promise<{ entity: AnchoredPage | null; pages: AnchoredPage[] }> {
  const [entity] = await engine.executeRaw<{ id: number; title: string | null }>(
    'SELECT id, title FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, entitySlug]);
  const names = [...new Set([entitySlug.split('/').pop()!, ...(entity?.title ? [entity.title] : [])].filter(n => n.length >= 3))];
  const pattern = `\\m(${names.map(escapeRegex).join('|')})\\M`;
  const rows = await engine.executeRaw<{ id: number; slug: string }>(
    `SELECT p.id, p.slug FROM pages p WHERE p.source_id = $1 AND p.deleted_at IS NULL AND p.slug <> $2
       AND p.type NOT IN ('question', 'synthesis') AND NOT (p.frontmatter ? '${PINNED_QUESTION_MARKER}')
       AND (p.compiled_truth ~* $3 OR ($4::integer IS NOT NULL AND EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id AND l.to_page_id = $4::integer)))
     ORDER BY COALESCE(p.effective_date, p.updated_at) DESC, p.id DESC LIMIT ${limit}`,
    [sourceId, entitySlug, pattern, entity?.id ?? null]);
  return { entity: entity ? { id: Number(entity.id), slug: entitySlug } : null, pages: rows.map(r => ({ id: Number(r.id), slug: r.slug })) };
}

/** The newest pages under a slug prefix (question and synthesis pages excluded). */
export async function prefixAnchoredPages(engine: BrainEngine, sourceId: string, prefix: string, limit = MAX_ANCHORED): Promise<AnchoredPage[]> {
  const rows = await engine.executeRaw<{ id: number; slug: string }>(
    `SELECT id, slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE $2
       AND type NOT IN ('question', 'synthesis') AND NOT (frontmatter ? '${PINNED_QUESTION_MARKER}')
     ORDER BY COALESCE(effective_date, updated_at) DESC, id DESC LIMIT ${limit}`,
    [sourceId, `${prefix.replace(/[\\%_]/g, '\\$&')}%`]);
  return rows.map(r => ({ id: Number(r.id), slug: r.slug }));
}

/** Asks for the present state of something: "now", "currently", "latest", "these days" and similar. */
const CURRENT_STATE_CUE = /\b(now|nowadays|currently|current|latest|most recent(ly)?|newest|today|these days|at the moment|at present|presently|still|anymore|any more|as of (today|now))\b/i;

export function asksForCurrentState(query: string): boolean {
  return CURRENT_STATE_CUE.test(query);
}

interface EntityCandidate { id: number; slug: string; title: string; type: string | null; source_id: string }

/**
 * The one entity page (person, company, organization, project, deal,
 * concept...) whose title the query mentions as a token run, readable under
 * `scope`. A title contained in a longer matched title is the same mention
 * ("Acme" inside "Acme Labs"). Zero or several entities: null.
 */
export async function namedEntity(engine: BrainEngine, query: string, scope: PageReadScope): Promise<EntityCandidate | null> {
  const params: unknown[] = [query.toLowerCase()];
  const filter = pageReadFilter('p', scope, params, true);
  // The title match runs first over bare rows; the read filter (page visibility subqueries) then sees only the matches.
  const rows = await engine.executeRaw<EntityCandidate>(
    `WITH titled AS MATERIALIZED (SELECT id FROM pages WHERE title IS NOT NULL AND length(title) >= 3 AND strpos($1, lower(title)) > 0)
     SELECT p.id, p.slug, p.title, p.type, p.source_id FROM pages p
     WHERE p.id IN (SELECT id FROM titled) AND ${filter}
     ORDER BY p.source_id, p.slug LIMIT 50`, params);
  const matches = rows.filter(r => isFactEntityPage(r.slug, r.type) && isTitleMentionedInQuery(query, r.title));
  const outer = matches.filter(m => !matches.some(o => o !== m && o.title.length > m.title.length && containsTokenRun(tokenizeTitle(o.title), tokenizeTitle(m.title))));
  return outer.length === 1 ? { ...outer[0]!, id: Number(outer[0]!.id) } : null;
}

export interface EntityAnchorOpts extends PageReadScope {
  /** Search token budget the caller asked for; the anchored set is re-packed to it. */
  tokenBudget?: number;
}

export interface EntityAnchorResult { results: SearchResult[]; entity: string | null; anchored: number }

/**
 * Entity-anchored ordering for an entity-scoped current-state query: the
 * entity page, then pages that link to it or name it, newest first, ahead of
 * the organic rows. A page already in the organic set keeps its row (moved
 * up, other chunks of it dropped); a missing page is read through
 * `getChunkWindows` under the caller's scope. Anchored rows take at most half
 * of the row count, the row count never grows, and the token budget is
 * re-applied. Not entity-scoped, nothing readable, or any error: the organic
 * results unchanged.
 */
export async function applyEntityAnchoring(engine: BrainEngine, query: string, results: SearchResult[], opts: EntityAnchorOpts): Promise<EntityAnchorResult> {
  const unchanged = { results, entity: null, anchored: 0 };
  if (!asksForCurrentState(query)) return unchanged;
  try {
    const entity = await namedEntity(engine, query, opts);
    if (!entity) return unchanged;
    const { pages } = await entityAnchoredPages(engine, entity.source_id, entity.slug);
    const rowCount = results.length > 0 ? results.length : MAX_ANCHORED;
    const slots = Math.max(1, Math.ceil(rowCount / 2));
    const ordered = [{ id: entity.id, slug: entity.slug }, ...pages];
    const windows = await engine.getChunkWindows(
      ordered.map((p, i) => ({ page_id: p.id, from_index: 0, to_index: 0, priority: i })),
      { sourceId: entity.source_id, excludePrivate: opts.excludePrivate, requireSafeChunks: opts.requireSafeChunks, chunkSources: ['compiled_truth'], maxRows: ordered.length });
    const byId = new Map(windows.map(w => [w.page_id, w]));
    const titles = new Map((await engine.executeRaw<{ id: number; title: string }>(
      'SELECT id, title FROM pages WHERE id = ANY($1::int[])', [ordered.map(p => p.id)])).map(r => [Number(r.id), r.title]));
    const anchored: SearchResult[] = [];
    for (const p of ordered) {
      if (anchored.length >= slots) break;
      const organic = results.find(r => r.page_id === p.id);
      const window = byId.get(p.id);
      if (!window) continue;
      if (organic) { anchored.push({ ...organic, entity_anchored: p.id === entity.id ? 'entity' : 'linked' }); continue; }
      const chunk = window.chunks[0];
      if (!chunk) continue;
      anchored.push({
        page_id: p.id, slug: window.slug, title: titles.get(p.id) ?? window.slug, type: window.type as SearchResult['type'], source_id: window.source_id,
        chunk_text: chunk.chunk_text, chunk_index: chunk.chunk_index, chunk_id: chunk.id, chunk_source: chunk.chunk_source as SearchResult['chunk_source'],
        score: 0, stale: false, entity_anchored: p.id === entity.id ? 'entity' : 'linked',
      } as SearchResult);
    }
    if (anchored.length === 0) return unchanged;
    const anchoredIds = new Set(anchored.map(r => r.page_id));
    const top = results.reduce((m, r) => (Number.isFinite(r.score) && r.score > m ? r.score : m), 0) || 1;
    anchored.forEach((r, i) => { r.score = top + (anchored.length - i) * 1e-6; r.base_score ??= r.score; });
    const merged = [...anchored, ...results.filter(r => !anchoredIds.has(r.page_id))].slice(0, rowCount);
    const budgeted = opts.tokenBudget ? enforceTokenBudget(merged, opts.tokenBudget).results : merged;
    return { results: budgeted, entity: `${entity.source_id}:${entity.slug}`, anchored: budgeted.filter(r => r.entity_anchored).length };
  } catch {
    return unchanged;
  }
}

/**
 * The `query` / `search` op seam: plain queries only (no offset, type, date,
 * language or symbol filter), and only with `search.entity_anchoring` on. The
 * op's `token_budget` is re-applied unless an evidence plan owns the budget.
 */
export async function anchorOpResults(engine: BrainEngine, p: Record<string, unknown>, query: string, results: SearchResult[],
  scope: PageReadScope & { filtered: boolean; evidencePlan: boolean }): Promise<SearchResult[]> {
  if (p.offset || scope.filtered || p.since || p.until || p.lang || p.symbol_kind || p.near_symbol || !await entityAnchoringEnabled(engine)) return results;
  const tokenBudget = !scope.evidencePlan && typeof p.token_budget === 'number' ? p.token_budget : undefined;
  return (await applyEntityAnchoring(engine, query, results, {
    sourceId: scope.sourceId, sourceIds: scope.sourceIds, excludePrivate: scope.excludePrivate, requireSafeChunks: scope.requireSafeChunks, tokenBudget,
  })).results;
}

/** `search.entity_anchoring` is on ('true' | 'on' | '1' | 'yes'); off by default and on any read error. */
export async function entityAnchoringEnabled(engine: { getConfig(key: string): Promise<string | null> }): Promise<boolean> {
  try {
    const raw = (await engine.getConfig(ENTITY_ANCHORING_KEY))?.trim().toLowerCase();
    return raw === 'true' || raw === 'on' || raw === '1' || raw === 'yes';
  } catch {
    return false;
  }
}
