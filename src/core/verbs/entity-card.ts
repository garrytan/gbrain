/**
 * MEMORY_VERBS v1 — `entity(name)` card builder (zero LLM, p99 < 100ms).
 *
 * Resolves a free-text name to ONE brain page via the Retrieval Reflex's
 * precision-biased arms (alias-first, then exact-title / exact-slug /
 * slug-suffix), then assembles a compact self-describing card from parallel
 * depth-1 indexed reads. Deliberately NOT the recursive-CTE traversal
 * (traversePaths) — the card is a latency contract, not a graph walk.
 *
 * Resolution precedence (frozen): alias > exact title > slug-suffix; ties
 * break on GREATEST(updated_at, last_retrieved_at) — "last_touched" is the
 * card's OUTPUT name, not a column. Multi-hit → best match wins, runners-up
 * land in `suggestions`. Miss → `found: false` + keyword near-misses with
 * create_safety hints. NEVER throws for data reasons; each arm is guarded so
 * a pre-page_aliases brain still resolves via arm 2 (same posture as the
 * shipped reflex).
 *
 * Privacy: `summary` runs through safeSynopsis (the get_page fence boundary);
 * fact-derived threads/counts respect visibility for remote callers
 * (world-only), and structured/timeline threads require an explicit world
 * marker before they cross the remote boundary.
 */

import type { BrainEngine } from '../engine.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import { slugify } from '../entities/resolve.ts';
import { safeSynopsis } from '../context/retrieval-reflex.ts';
import { stampEvidence } from '../search/evidence.ts';
import type { SearchResult } from '../types.ts';

const EDGE_CAP = 10;
const OPEN_THREADS_CAP = 3;
const OPEN_THREAD_TIMELINE_WINDOW_DAYS = 90;
const SUGGESTION_CAP = 3;
const OPEN_THREAD_MARKER = '[open-thread] ';
const OPEN_THREAD_WORLD_MARKER = '[open-thread:world] ';

export interface EntityCardEdge {
  type: string;
  direction: 'out' | 'in';
  slug: string;
  context: string | null;
}

export interface EntityOpenThread {
  kind: 'commitment' | 'recent_event';
  text: string;
  date: string | null;
}

export interface EntityCard {
  entity: { slug: string; title: string; type: string | null };
  /** page_aliases reverse lookup (normalized forms). Empty on pre-migration brains. */
  aka: string[];
  /** Privacy-safe synopsis — same fence boundary as get_page. */
  summary: string;
  last_touched: {
    updated_at: string | null;
    last_retrieved_at: string | null;
    last_timeline_date: string | null;
  };
  /** Explicitly-open structured entries or marked facts/timeline entries. */
  open_threads: EntityOpenThread[];
  /** Top typed edges, mentions excluded, out-edges first. */
  edges: EntityCardEdge[];
  backlink_count: number;
  /** Exact active-fact count, visibility-filtered for remote callers. */
  active_fact_count: number;
}

export interface EntitySuggestion {
  slug: string;
  title: string;
  create_safety: string;
}

export interface EntityCardResult {
  found: boolean;
  card?: EntityCard;
  suggestions?: EntitySuggestion[];
}

interface CardPageRow {
  slug: string;
  // v0.43 merge: retrieval-reflex's exported PageRow (safeSynopsis's param)
  // now requires source_id (federated push-context wave #2095). The card row
  // carries it too so it remains assignable.
  source_id: string;
  title: string;
  type: string | null;
  frontmatter: Record<string, unknown> | null;
  compiled_truth: string | null;
  updated_at: Date | string | null;
  last_retrieved_at: Date | string | null;
}

interface MarkedCommitmentRow {
  fact: string;
  valid_from: Date | string | null;
}

/** Resolution arm rank: lower = higher confidence (frozen precedence ladder). */
const ARM_ALIAS = 0;
const ARM_EXACT = 1;
const ARM_SUFFIX = 2;

export async function buildEntityCard(
  engine: BrainEngine,
  sourceId: string,
  name: string,
  opts: { remote: boolean },
): Promise<EntityCardResult> {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return { found: false, suggestions: [] };

  const norm = normalizeAlias(trimmed);
  const titleLc = trimmed.toLowerCase();
  // Two exact-slug candidates: the slugified form for free-text names AND the
  // raw input — a caller passing an already-namespaced slug
  // ("people/alice-example") must hit exactly (slugify flattens the slash).
  const slug = slugify(trimmed);
  const exactSlugs = [...new Set([slug, trimmed].filter(Boolean))];

  // Candidate slugs with their best arm rank.
  const rankBySlug = new Map<string, number>();
  const consider = (s: string, rank: number) => {
    if (!s) return;
    const prev = rankBySlug.get(s);
    if (prev === undefined || rank < prev) rankBySlug.set(s, rank);
  };

  // Arm 1 — alias-first. Guarded: pre-migration brains lack page_aliases.
  if (norm) {
    try {
      const aliasMap = await engine.resolveAliases([norm], { sourceId });
      for (const hit of aliasMap.get(norm) ?? []) consider(hit.slug, ARM_ALIAS);
    } catch {
      /* no page_aliases table — degrade to arm 2 [E3] */
    }
  }

  // Arm 2 — exact title / exact slug / slug-suffix, with the columns the
  // card's tie-break needs. Guarded like the reflex.
  let rows: CardPageRow[] = [];
  try {
    rows = await engine.executeRaw<CardPageRow>(
      `SELECT slug, source_id, title, type, frontmatter, compiled_truth, updated_at, last_retrieved_at
         FROM pages
        WHERE deleted_at IS NULL
          AND source_id = $1
          AND ( lower(title) = $2
             OR slug = ANY($3::text[])
             OR slug LIKE $4 )`,
      [sourceId, titleLc, exactSlugs, `%/${slug || trimmed}`],
    );
  } catch {
    rows = [];
  }
  const rowBySlug = new Map<string, CardPageRow>();
  for (const r of rows) {
    rowBySlug.set(r.slug, r);
    const isExact = (r.title ?? '').toLowerCase() === titleLc || exactSlugs.includes(r.slug);
    consider(r.slug, isExact ? ARM_EXACT : ARM_SUFFIX);
  }

  // Hydrate alias-resolved slugs that arm 2 didn't fetch.
  const missing = [...rankBySlug.keys()].filter(s => !rowBySlug.has(s));
  if (missing.length) {
    try {
      const extra = await engine.executeRaw<CardPageRow>(
        `SELECT slug, source_id, title, type, frontmatter, compiled_truth, updated_at, last_retrieved_at
           FROM pages
          WHERE deleted_at IS NULL AND source_id = $1 AND slug = ANY($2::text[])`,
        [sourceId, missing],
      );
      for (const r of extra) rowBySlug.set(r.slug, r);
    } catch {
      /* stale alias rows — drop */
    }
  }

  // Rank candidates: arm rank asc, then GREATEST(updated_at, last_retrieved_at) desc.
  const candidates = [...rankBySlug.entries()]
    .map(([s, rank]) => ({ slug: s, rank, row: rowBySlug.get(s) }))
    .filter((c): c is { slug: string; rank: number; row: CardPageRow } => c.row !== undefined)
    .sort((a, b) => a.rank - b.rank || lastTouchedMs(b.row) - lastTouchedMs(a.row));

  if (candidates.length === 0) {
    return { found: false, suggestions: await nearMissSuggestions(engine, sourceId, trimmed) };
  }

  const best = candidates[0];
  const runnersUp: EntitySuggestion[] = candidates.slice(1, 1 + SUGGESTION_CAP).map(c => ({
    slug: c.slug,
    title: c.row.title ?? c.slug,
    // A page that resolved through the precision arms exists by definition.
    create_safety: 'exists',
  }));

  const card = await assembleCard(engine, sourceId, best.row, opts.remote);
  return {
    found: true,
    card,
    ...(runnersUp.length ? { suggestions: runnersUp } : {}),
  };
}

async function assembleCard(
  engine: BrainEngine,
  sourceId: string,
  row: CardPageRow,
  remote: boolean,
): Promise<EntityCard> {
  const pageSlug = row.slug;

  // Parallel depth-1 reads — every arm individually fail-soft so a partial
  // brain (no aliases, no timeline) still returns a card.
  //
  // [ship P1.2] Incoming edges + backlink_count are SOURCE-SAFE on BOTH sides.
  // engine.getBacklinks(slug,{sourceId}) only scopes the TARGET page's source,
  // so a foreign-source page linking to a same-named entity would leak its
  // slug; engine.getBacklinkCounts has no source param at all. We instead run
  // a both-sides-scoped query here (f.source_id = t.source_id = this source),
  // mentions excluded (matching the backlink-count convention). Outgoing edges
  // (getLinks) are the entity's OWN declared links — from-side scoped — so they
  // stay as-is.
  const visibleFactClause = remote ? `AND visibility = 'world'` : '';
  const [aka, outLinks, inEdges, backlinkCount, timeline, markedCommitments, activeFactCount] = await Promise.all([
    engine
      .executeRaw<{ alias_norm: string }>(
        `SELECT alias_norm FROM page_aliases WHERE source_id = $1 AND slug = $2 ORDER BY alias_norm`,
        [sourceId, pageSlug],
      )
      .then(rs => rs.map(r => r.alias_norm))
      .catch(() => [] as string[]),
    engine.getLinks(pageSlug, { sourceId }).catch(() => []),
    engine
      .executeRaw<{ from_slug: string; link_type: string; context: string | null }>(
        `SELECT f.slug AS from_slug, l.link_type, l.context
           FROM links l
           JOIN pages f ON f.id = l.from_page_id
           JOIN pages t ON t.id = l.to_page_id
          WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $2
            AND COALESCE(l.link_source, '') <> 'mentions'`,
        [pageSlug, sourceId],
      )
      .catch(() => [] as Array<{ from_slug: string; link_type: string; context: string | null }>),
    engine
      .executeRaw<{ n: string | number }>(
        `SELECT COUNT(*) AS n
           FROM links l
           JOIN pages f ON f.id = l.from_page_id
           JOIN pages t ON t.id = l.to_page_id
          WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $2
            AND COALESCE(l.link_source, '') <> 'mentions'`,
        [pageSlug, sourceId],
      )
      .then(rs => Number(rs[0]?.n ?? 0))
      .catch(() => 0),
    engine.getTimeline(pageSlug, { limit: 5, sourceId }).catch(() => []),
    engine
      .executeRaw<MarkedCommitmentRow>(
        `SELECT fact, valid_from
           FROM facts
          WHERE source_id = $1 AND entity_slug = $2
            AND expired_at IS NULL AND kind = 'commitment'
            ${visibleFactClause}
            AND (fact LIKE '${OPEN_THREAD_MARKER}%' OR fact LIKE '${OPEN_THREAD_WORLD_MARKER}%')
          ORDER BY valid_from DESC, id DESC
          LIMIT $3`,
        [sourceId, pageSlug, OPEN_THREADS_CAP],
      )
      .catch(() => [] as MarkedCommitmentRow[]),
    engine
      .executeRaw<{ n: string | number }>(
        `SELECT COUNT(*) AS n
           FROM facts
          WHERE source_id = $1 AND entity_slug = $2
            AND expired_at IS NULL
            ${visibleFactClause}`,
        [sourceId, pageSlug],
      )
      .then(rs => Number(rs[0]?.n ?? 0))
      .catch(() => 0),
  ]);

  const edges: EntityCardEdge[] = [];
  for (const l of outLinks) {
    if (l.link_source === 'mentions') continue;
    edges.push({ type: l.link_type, direction: 'out', slug: l.to_slug, context: l.context || null });
    if (edges.length >= EDGE_CAP) break;
  }
  if (edges.length < EDGE_CAP) {
    for (const l of inEdges) {
      edges.push({ type: l.link_type, direction: 'in', slug: l.from_slug, context: l.context || null });
      if (edges.length >= EDGE_CAP) break;
    }
  }

  // Open threads fail closed. A commitment or recent event does not imply
  // unresolved work: the card admits only an explicit structured
  // frontmatter entry or the exact marker documented by MEMORY_VERBS v1.
  // Remote callers additionally need an explicit world signal unless the
  // underlying fact row already passed the world-visibility predicate above.
  const openThreads = structuredOpenThreads(row.frontmatter, remote);
  for (const f of markedCommitments) {
    if (openThreads.length >= OPEN_THREADS_CAP) break;
    const text = stripOpenThreadMarker(f.fact, { remote, factVisibilityScoped: true });
    if (!text) continue;
    openThreads.push({ kind: 'commitment', text, date: toIso(f.valid_from) });
  }
  if (openThreads.length < OPEN_THREADS_CAP) {
    const cutoff = Date.now() - OPEN_THREAD_TIMELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    for (const t of timeline) {
      // Both engines type this as string, but PGLite can return a Date object
      // at runtime for a DATE column. Normalize at the public-card boundary.
      const date = toIso(t.date);
      const ts = date === null ? NaN : Date.parse(date);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const text = stripOpenThreadMarker(t.summary, { remote, factVisibilityScoped: false });
      if (!text) continue;
      openThreads.push({ kind: 'recent_event', text, date });
      if (openThreads.length >= OPEN_THREADS_CAP) break;
    }
  }

  return {
    entity: { slug: pageSlug, title: row.title ?? pageSlug, type: row.type ?? null },
    aka,
    // v0.45.7: summary widens in lockstep with the card's fact visibility —
    // remote (world-only) keeps ['world']; a local include_private card widens.
    summary: safeSynopsis(row, { keepVisibility: remote ? ['world'] : ['private', 'world'] }),
    last_touched: {
      updated_at: toIso(row.updated_at),
      last_retrieved_at: toIso(row.last_retrieved_at),
      last_timeline_date: timeline.length ? toIso(timeline[0].date) : null,
    },
    open_threads: openThreads,
    edges,
    backlink_count: backlinkCount,
    active_fact_count: activeFactCount,
  };
}

/**
 * Structured open-thread evidence lives under frontmatter.open_threads.
 * Object rows must say status:'open' (or open:true); remote callers only see
 * rows explicitly marked visibility:'world'. Other shapes fail closed.
 */
function structuredOpenThreads(
  frontmatter: Record<string, unknown> | null,
  remote: boolean,
): EntityOpenThread[] {
  const raw = frontmatter?.open_threads;
  if (!Array.isArray(raw)) return [];

  const out: EntityOpenThread[] = [];
  for (const item of raw) {
    if (out.length >= OPEN_THREADS_CAP) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;

    const entry = item as Record<string, unknown>;
    const explicitlyOpen = entry.status === 'open'
      ? entry.open !== false
      : entry.status === undefined && entry.open === true;
    if (!explicitlyOpen) continue;
    if (remote && entry.visibility !== 'world') continue;

    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    if (!text) continue;
    if (entry.kind !== undefined && entry.kind !== 'commitment' && entry.kind !== 'recent_event') continue;
    const kind = entry.kind === 'recent_event' ? 'recent_event' : 'commitment';
    const date = typeof entry.date === 'string' && Number.isFinite(Date.parse(entry.date))
      ? entry.date
      : null;
    out.push({ kind, text, date });
  }
  return out;
}

/** Exact, prefix-only marker parser. Marker syntax never rides the response. */
function stripOpenThreadMarker(
  value: string,
  opts: { remote: boolean; factVisibilityScoped: boolean },
): string | null {
  const world = value.startsWith(OPEN_THREAD_WORLD_MARKER);
  const local = value.startsWith(OPEN_THREAD_MARKER);
  if (!world && !local) return null;
  if (opts.remote && !opts.factVisibilityScoped && !world) return null;
  const text = value.slice(world ? OPEN_THREAD_WORLD_MARKER.length : OPEN_THREAD_MARKER.length).trim();
  return text || null;
}

/**
 * Near-miss suggestions on a total miss (E5 delight): keyword search top-N
 * with evidence-derived create_safety so a typo'd name becomes a next move
 * instead of a dead end. Zero LLM; fail-soft to [].
 */
async function nearMissSuggestions(
  engine: BrainEngine,
  sourceId: string,
  name: string,
): Promise<EntitySuggestion[]> {
  try {
    const raw = await engine.searchKeyword(name, { limit: SUGGESTION_CAP, sourceId });
    const results = raw as SearchResult[];
    stampEvidence(results);
    return results.map(r => ({
      slug: r.slug,
      title: r.title ?? r.slug,
      create_safety: r.create_safety ?? 'unknown',
    }));
  } catch {
    return [];
  }
}

function lastTouchedMs(row: CardPageRow): number {
  const u = toMs(row.updated_at);
  const l = toMs(row.last_retrieved_at);
  return Math.max(u, l);
}

function toMs(v: Date | string | null): number {
  if (v == null) return 0;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

function toIso(v: Date | string | null): string | null {
  const ms = toMs(v);
  return ms > 0 ? new Date(ms).toISOString() : null;
}
