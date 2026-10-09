/**
 * MEMORY_VERBS v1 — `entity(name)` card builder (zero LLM, p99 < 100ms).
 *
 * Resolves a free-text name to ONE brain page via the Retrieval Reflex's
 * precision-biased arms (alias-first, then exact-title / exact-slug /
 * slug-suffix), then assembles a compact self-describing card from parallel
 * depth-1 indexed reads. Deliberately NOT the recursive-CTE traversal
 * (traversePaths) — the card is a latency contract, not a graph walk.
 *
 * Resolution precedence (frozen): alias > exact slug > exact title >
 * slug-suffix. Exact-title collisions prefer entity-shaped pages over
 * transcript/note containers; otherwise ties break on GREATEST(updated_at,
 * last_retrieved_at) — "last_touched" is the card's OUTPUT name, not a
 * column. Multi-hit → best match wins, runners-up land in `suggestions`.
 * Miss → `found: false` + keyword near-misses with create_safety hints. NEVER
 * throws for data reasons; each arm is guarded so a pre-page_aliases brain
 * still resolves via arm 2 (same posture as the shipped reflex).
 *
 * Privacy: `summary` runs through safeSynopsis (the get_page fence boundary);
 * facts respect visibility for remote callers (world-only).
 */

import { annotateTemporalRow, temporalLinkJoinSql, TEMPORAL_LINK_SELECT_SQL, type TemporalAnnotation } from '../link-validity.ts';
import type { BrainEngine, FactRow } from '../engine.ts';
import { loadRelationshipNotes, relationshipNoteKey } from '../link-relationship-notes.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import { slugify } from '../entities/resolve.ts';
import { safeSynopsis } from '../context/retrieval-reflex.ts';
import { stampEvidence, markKeywordHits } from '../search/evidence.ts';
import type { Link, SearchResult } from '../types.ts';
import type { NewerMentions } from '../mentions/newer-mentions.ts';
import { loadLinkableTypes } from '../mentions/policy.ts';
import { readMentionCoverage, type MentionCoverage } from '../mentions/coverage.ts';
import { encodeCursor, readReferrerGroups, PAGE_DEFAULT_LIMIT, type ReferenceRow } from '../mentions/referrers.ts';

const EDGE_CAP = 10;
const OPEN_THREADS_CAP = 3;
const OPEN_THREAD_TIMELINE_WINDOW_DAYS = 90;
const SUGGESTION_CAP = 3;
const FACT_FETCH_CAP = 100;

export interface EntityCardEdge {
  type: string;
  direction: 'out' | 'in';
  slug: string;
  context: string | null;
  /** Relationship status today: live, ended, ended_unknown_date, event, reference, … */
  status?: string;
  /** Latest stint bounds (YYYY-MM-DD) when the relationship has dated evidence. */
  since?: string | null;
  until?: string | null;
}

export interface EntityOpenThread {
  kind: 'commitment' | 'recent_event';
  text: string;
  date: string | null;
  /**
   * v0.47 open-loop engine — ADDITIVE OPTIONAL fields (legal under the
   * MEMORY_VERBS v1 freeze; absent on threads not backed by an open_loops
   * row). direction is from the account owner's perspective.
   */
  direction?: 'owed_by_me' | 'owed_to_me' | 'their_turn' | 'my_turn';
  due?: string | null;
  counterparty?: string | null;
  status?: string;
  loop_id?: number;
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
  /** Best-effort in v1: active commitment-kind facts + recent timeline entries. */
  open_threads: EntityOpenThread[];
  /** Top typed edges, mentions excluded, out-edges first. */
  edges: EntityCardEdge[];
  backlink_count: number;
  /** Exact active-fact count (indexed COUNT, not payload length); visibility-filtered for remote. */
  active_fact_count: number;
  /**
   * Current and ended state relationships of this entity, rendered for agents
   * ("now: works_at widget-co (since 2025-03-01); ended: works_at acme-example
   * (2025-03-01)"), plus a stale-summary warning when the summary still names
   * a relationship that ended. Absent when there is nothing to say.
   */
  relationship_note?: string;
  /** Pages dated after this page that mention it, newest first, bounded. `context_pack` cards only (mentions/newer-mentions.ts). */
  newer_mentions?: NewerMentions;
  /** Distinct pages with any inbound link (every link source, mentions included). `entity` verb only. */
  referenced_by_count?: number;
  /** Those pages grouped by pack-canonical type, newest first; capped per group and per card. `entity` verb only. */
  referenced_by?: ReferenceGroupView[];
  /** Whether every page in this source has been scanned for this entity's names. `entity` verb only. */
  coverage?: MentionCoverage;
}

export interface ReferenceGroupView {
  canonical_type: string;
  total: number;
  rows: Array<Omit<ReferenceRow, 'source_id'>>;
  /** The call that returns the rest of a truncated group (`requires_surface` when this connection cannot call it). */
  next?: { tool: 'get_backlinks'; arguments: Record<string, unknown>; requires_surface?: 'starter' };
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
  /** On a miss with `includeReferences`: the source's mention coverage (a miss may be a not-yet-indexed name). */
  coverage?: MentionCoverage;
}

export interface EntityCardOpts {
  remote: boolean;
  /**
   * Compute `referenced_by`, `referenced_by_count` and `coverage` (the `entity`
   * verb). Ambient callers (context_pack, delta) leave it off.
   */
  includeReferences?: boolean;
  /** The serving surface ceiling; on `verbs` a continuation names the starter surface. */
  surfaceCeiling?: 'verbs' | 'starter' | 'full';
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

/** Resolution arm rank: lower = higher confidence (frozen precedence ladder). */
const ARM_ALIAS = 0;
const ARM_EXACT = 1;
const ARM_SUFFIX = 2;

export async function buildEntityCard(
  engine: BrainEngine,
  sourceId: string,
  name: string,
  opts: EntityCardOpts,
): Promise<EntityCardResult> {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return { found: false, suggestions: [] };

  // #4352 — untrusted callers never resolve a `visibility: private` page into
  // a card (or a near-miss suggestion). Trust + config gate resolve through
  // the shared helper; local (remote:false) callers are unchanged. Covers
  // entity, context_pack, and delta (all route through buildEntityCard).
  const { resolveExcludePrivatePages, privatePagesFilterFragment } = await import('../search/private-visibility.ts');
  const excludePrivate = await resolveExcludePrivatePages(engine, opts.remote ? undefined : false);
  // Predicate text lives ONCE (private-visibility.ts) — both card queries
  // below select `FROM pages` unaliased, so qualify with the table name.
  const privatePredicate = excludePrivate ? ` AND ${privatePagesFilterFragment('pages')}` : '';

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
      `SELECT slug, source_id, title, type, frontmatter, compiled_truth, updated_at,
              GREATEST(last_retrieved_at, (SELECT r.last_retrieved_at FROM page_retrievals r WHERE r.page_id = pages.id)) AS last_retrieved_at
         FROM pages
        WHERE deleted_at IS NULL
          AND source_id = $1
          AND ( lower(title) = $2
             OR slug = ANY($3::text[])
             OR slug LIKE $4 )${privatePredicate}`,
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
        `SELECT slug, source_id, title, type, frontmatter, compiled_truth, updated_at,
              GREATEST(last_retrieved_at, (SELECT r.last_retrieved_at FROM page_retrievals r WHERE r.page_id = pages.id)) AS last_retrieved_at
           FROM pages
          WHERE deleted_at IS NULL AND source_id = $1 AND slug = ANY($2::text[])${privatePredicate}`,
        [sourceId, missing],
      );
      for (const r of extra) rowBySlug.set(r.slug, r);
    } catch {
      /* stale alias rows — drop */
    }
  }

  // Rank candidates: arm rank asc. Inside the precision arm an explicit slug
  // stays stronger than title inference; otherwise exact-title collisions
  // prefer a linkable entity page (the source pack's entity types) over
  // transcript/note containers. Recency remains the final tie-break within
  // the same match shape.
  const { types: linkable } = await loadLinkableTypes(engine, sourceId).catch(() => ({ types: [] as string[], pack: null }));
  const entityTypes = new Set(linkable);
  const candidates = [...rankBySlug.entries()]
    .map(([s, rank]) => ({ slug: s, rank, row: rowBySlug.get(s) }))
    .filter((c): c is { slug: string; rank: number; row: CardPageRow } => c.row !== undefined)
    .sort((a, b) =>
      a.rank - b.rank
      || (a.rank === ARM_EXACT
        ? exactMatchPreference(a.row, exactSlugs, entityTypes) - exactMatchPreference(b.row, exactSlugs, entityTypes)
        : 0)
      || lastTouchedMs(b.row) - lastTouchedMs(a.row));

  if (candidates.length === 0) {
    return {
      found: false, suggestions: await nearMissSuggestions(engine, sourceId, trimmed, excludePrivate),
      ...(opts.includeReferences ? { coverage: await readMentionCoverage(engine, [sourceId]).catch(() => undefined) } : {}),
    };
  }

  const best = candidates[0];
  const runnersUp: EntitySuggestion[] = candidates.slice(1, 1 + SUGGESTION_CAP).map(c => ({
    slug: c.slug,
    title: c.row.title ?? c.slug,
    // A page that resolved through the precision arms exists by definition.
    create_safety: 'exists',
  }));

  const card = await assembleCard(engine, sourceId, best.row, opts.remote, excludePrivate);
  if (opts.includeReferences) Object.assign(card, await cardReferences(engine, sourceId, best.row, opts, excludePrivate, entityTypes));
  return {
    found: true,
    card,
    ...(runnersUp.length ? { suggestions: runnersUp } : {}),
  };
}

function exactMatchPreference(row: CardPageRow, exactSlugs: string[], entityTypes: ReadonlySet<string>): number {
  if (exactSlugs.includes(row.slug)) return 0;
  return entityTypes.has(row.type ?? '') ? 1 : 2;
}

/**
 * The `entity` verb's reference fields: every page linking here (mentions
 * included), grouped by pack-canonical type with the continuation for a
 * truncated group, and the source's mention coverage. Fail-soft: a failed
 * read leaves the card without them rather than failing the lookup.
 */
async function cardReferences(engine: BrainEngine, sourceId: string, row: CardPageRow, opts: EntityCardOpts, excludePrivate: boolean,
  entityTypes: ReadonlySet<string>): Promise<Pick<EntityCard, 'referenced_by_count' | 'referenced_by' | 'coverage'>> {
  try {
    const { pack } = await loadLinkableTypes(engine, sourceId);
    const { total, groups } = await readReferrerGroups(engine, { slug: row.slug, sourceId, referrerSources: [sourceId], excludePrivate, pack,
      keepVisibility: opts.remote ? ['world'] : ['private', 'world'] });
    let coverage = await readMentionCoverage(engine, [sourceId]);
    if (coverage.state !== 'disabled' && !entityTypes.has(row.type ?? '')) coverage = { ...coverage, state: 'type_not_linkable', degraded: true };
    const referenced_by = groups.map((g): ReferenceGroupView => {
      const rows = g.rows.map(({ source_id: _s, ...rest }) => rest);
      if (g.rows.length >= g.total) return { canonical_type: g.canonical_type, total: g.total, rows };
      const last = g.rows[g.rows.length - 1];
      return { canonical_type: g.canonical_type, total: g.total, rows, next: { tool: 'get_backlinks', arguments: {
        slug: row.slug, source_id: sourceId, type: g.canonical_type, group: 'page', limit: PAGE_DEFAULT_LIMIT,
        ...(last ? { cursor: encodeCursor(last) } : {}) }, ...(opts.surfaceCeiling === 'verbs' ? { requires_surface: 'starter' as const } : {}) } };
    });
    return { referenced_by_count: total, referenced_by, coverage };
  } catch {
    return {};
  }
}

async function assembleCard(
  engine: BrainEngine,
  sourceId: string,
  row: CardPageRow,
  remote: boolean,
  excludePrivate: boolean,
): Promise<EntityCard> {
  const pageSlug = row.slug;
  const visibility = remote ? (['world'] as ('private' | 'world')[]) : undefined;
  const { privatePagesFilterFragment, privateLinkOriginFilterFragment } = await import('../search/private-visibility.ts');
  const inboundPrivacy = excludePrivate
    ? ` AND ${privatePagesFilterFragment('f')} AND ${privateLinkOriginFilterFragment('l')}`
    : '';

  // Parallel depth-1 reads — every arm individually fail-soft so a partial
  // brain (no aliases, no timeline) still returns a card.
  //
  // [ship P1.2] Incoming edges + backlink_count are SOURCE-SAFE on BOTH sides.
  // engine.getBacklinks(slug,{sourceId}) only scopes the TARGET page's source,
  // so a foreign-source page linking to a same-named entity would leak its
  // slug; engine.getBacklinkCounts counts inbound from ALL sources. We run
  // a both-sides-scoped query here (f.source_id = t.source_id = this source),
  // mentions excluded (matching the backlink-count convention). Outgoing edges
  // (getLinks) are the entity's OWN declared links — from-side scoped — so they
  // stay as-is. The referrer must also be live and, for an untrusted caller,
  // readable: the same private-page and private-origin predicates get_backlinks
  // applies, so a private or derived page never surfaces its slug, its
  // links.context sentence, or a count.
  const [aka, outLinks, inEdges, backlinkCount, timeline, facts, activeFactCount] = await Promise.all([
    engine
      .executeRaw<{ alias_norm: string }>(
        `SELECT alias_norm FROM page_aliases WHERE source_id = $1 AND slug = $2 ORDER BY alias_norm`,
        [sourceId, pageSlug],
      )
      .then(rs => rs.map(r => r.alias_norm))
      .catch(() => [] as string[]),
    engine.getLinks(pageSlug, { sourceId, excludePrivate, temporal: { status: 'all' } }).catch(() => []),
    engine
      .executeRaw<{ from_slug: string; link_type: string; context: string | null }>(
        `SELECT f.slug AS from_slug, l.link_type, l.context${TEMPORAL_LINK_SELECT_SQL}
           FROM links l
           JOIN pages f ON f.id = l.from_page_id
           JOIN pages t ON t.id = l.to_page_id
           ${temporalLinkJoinSql('l', excludePrivate)}
          WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $2 AND f.deleted_at IS NULL
            AND COALESCE(l.link_source, '') <> 'mentions'${inboundPrivacy}`,
        [pageSlug, sourceId],
      )
      .then(rs => rs.map(r => annotateTemporalRow(r)))
      .catch(() => [] as Array<{ from_slug: string; link_type: string; context: string | null } & TemporalAnnotation>),
    engine
      .executeRaw<{ n: string | number }>(
        `SELECT COUNT(*) AS n
           FROM links l
           JOIN pages f ON f.id = l.from_page_id
           JOIN pages t ON t.id = l.to_page_id
          WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $2 AND f.deleted_at IS NULL
            AND COALESCE(l.link_source, '') <> 'mentions'${inboundPrivacy}`,
        [pageSlug, sourceId],
      )
      .then(rs => Number(rs[0]?.n ?? 0))
      .catch(() => 0),
    engine.getTimeline(pageSlug, { limit: 5, sourceId, excludePrivate }).catch(() => []),
    engine
      .listFactsByEntity(sourceId, pageSlug, {
        activeOnly: true,
        limit: FACT_FETCH_CAP,
        ...(visibility ? { visibility } : {}),
      })
      .catch(() => [] as FactRow[]),
    // Exact active-fact count: the payload fetch above is capped at
    // FACT_FETCH_CAP, so facts.length silently reports the cap for bigger
    // entities. Same predicate as the fetch (active + source + caller
    // visibility), indexed COUNT instead of rows. Fail-soft to null so a
    // count failure degrades to the capped payload length, never to 0.
    engine
      .executeRaw<{ n: string | number }>(
        `SELECT COUNT(*) AS n
           FROM facts
          WHERE source_id = $1 AND entity_slug = $2
            AND expired_at IS NULL${remote ? ` AND visibility = 'world'` : ''}`,
        [sourceId, pageSlug],
      )
      .then(rs => Number(rs[0]?.n ?? 0))
      .catch(() => null),
  ]);

  // Live relationships first so ended ones never push a current edge past the cap.
  const rank = (status?: string) => (status === 'live' || status === 'disputed' ? 0 : status === 'event' || status === 'reference' || !status ? 1 : 2);
  const edgeOf = (l: { link_type: string; context?: string | null } & Partial<TemporalAnnotation>, direction: 'out' | 'in', slug: string): EntityCardEdge => {
    const last = l.stints?.[l.stints.length - 1];
    return {
      type: l.link_type, direction, slug, context: l.context || null,
      ...(l.status ? { status: l.status } : {}),
      ...(last ? { since: last.from, until: last.until } : {}),
    };
  };
  const outCandidates = (outLinks as Array<Link & Partial<TemporalAnnotation>>)
    .filter(l => l.link_source !== 'mentions')
    .map(l => edgeOf(l, 'out', l.to_slug));
  const inCandidates = inEdges.map(l => edgeOf(l as typeof l & Partial<TemporalAnnotation>, 'in', l.from_slug));
  const edges: EntityCardEdge[] = [
    ...[...outCandidates].sort((a, b) => rank(a.status) - rank(b.status)),
    ...[...inCandidates].sort((a, b) => rank(a.status) - rank(b.status)),
  ].slice(0, EDGE_CAP);
  const summary = safeSynopsis(row, { keepVisibility: remote ? ['world'] : ['private', 'world'] });
  const relationshipNote = await loadRelationshipNotes(engine, [{ slug: pageSlug, source_id: sourceId, summary }], { excludePrivate })
    .then(m => m.get(relationshipNoteKey(sourceId, pageSlug))).catch(() => undefined);

  // Open threads (best-effort v1): open-loop rows first (v0.47 — richest:
  // direction, due, loop_id), then active commitment facts NOT already
  // represented by a loop, then recent timeline entries; capped together.
  const openThreads: EntityOpenThread[] = [];
  const loopFactIds = new Set<number>();
  try {
    // Zero-LLM, indexed lookup — stays inside the p99<100ms budget.
    const loopRows = await engine.executeRaw<{
      id: number;
      loop_type: string;
      summary: string;
      due_at: string | null;
      last_activity_at: string;
      fact_id: number | null;
    }>(
      `SELECT id, loop_type, summary, due_at, last_activity_at, fact_id
       FROM open_loops
       WHERE status = 'open' AND counterparty_slug = $1 AND source_id = $2
       ORDER BY last_activity_at DESC
       LIMIT ${OPEN_THREADS_CAP}`,
      [pageSlug, sourceId],
    );
    for (const l of loopRows) {
      if (l.fact_id !== null) loopFactIds.add(Number(l.fact_id));
      const direction: EntityOpenThread['direction'] =
        l.loop_type === 'commitment_owed_by_me'
          ? 'owed_by_me'
          : l.loop_type === 'commitment_owed_to_me'
            ? 'owed_to_me'
            : l.loop_type === 'unanswered_inbound'
              ? 'my_turn'
              : 'their_turn';
      openThreads.push({
        kind: 'commitment',
        text: l.summary,
        date: typeof l.last_activity_at === 'string' ? l.last_activity_at : new Date(l.last_activity_at).toISOString(),
        direction,
        due: l.due_at ? (typeof l.due_at === 'string' ? l.due_at : new Date(l.due_at).toISOString()) : null,
        counterparty: pageSlug,
        status: 'open',
        loop_id: Number(l.id),
      });
      if (openThreads.length >= OPEN_THREADS_CAP) break;
    }
  } catch {
    /* pre-v144 brains have no open_loops table — facts path below covers it */
  }
  for (const f of facts) {
    if (openThreads.length >= OPEN_THREADS_CAP) break;
    if (f.kind !== 'commitment') continue;
    if (f.id !== undefined && loopFactIds.has(f.id)) continue; // already surfaced via its loop
    openThreads.push({ kind: 'commitment', text: f.fact, date: f.valid_from?.toISOString() ?? null });
  }
  if (openThreads.length < OPEN_THREADS_CAP) {
    const cutoff = Date.now() - OPEN_THREAD_TIMELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    for (const t of timeline) {
      // Both engines TYPE this as string, but PGLite returns a Date object at
      // runtime for the DATE column. Normalize at the public-card boundary so
      // the frozen string|null contract holds for in-process consumers too.
      const date = toIso(t.date);
      const ts = date === null ? NaN : Date.parse(date);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      openThreads.push({ kind: 'recent_event', text: t.summary, date });
      if (openThreads.length >= OPEN_THREADS_CAP) break;
    }
  }

  return {
    entity: { slug: pageSlug, title: row.title ?? pageSlug, type: row.type ?? null },
    aka,
    // v0.45.7: summary widens in lockstep with the card's fact visibility —
    // remote (world-only) keeps ['world']; a local include_private card widens.
    summary,
    last_touched: {
      updated_at: toIso(row.updated_at),
      last_retrieved_at: toIso(row.last_retrieved_at),
      last_timeline_date: timeline.length ? toIso(timeline[0].date) : null,
    },
    open_threads: openThreads,
    edges,
    backlink_count: backlinkCount,
    active_fact_count: activeFactCount ?? facts.length,
    ...(relationshipNote ? { relationship_note: relationshipNote } : {}),
  };
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
  excludePrivate = false,
): Promise<EntitySuggestion[]> {
  try {
    const raw = await engine.searchKeyword(name, { limit: SUGGESTION_CAP, sourceId, excludePrivate });
    const results = raw as SearchResult[];
    // #3783 — direct FTS path: every row is a keyword hit by construction.
    markKeywordHits(results);
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
