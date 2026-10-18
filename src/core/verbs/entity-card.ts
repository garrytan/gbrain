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

import { annotateTemporalRow, LIVENESS_EXEMPT_LINK_TYPES, temporalLinkJoinSql, TEMPORAL_LINK_SELECT_SQL, type TemporalAnnotation } from '../link-validity.ts';
import type { BrainEngine, FactRow } from '../engine.ts';
import type { TrustTier } from '../trust/tier.ts';
import type { ReadEligibility } from '../eligibility/policy.ts';
import { trustFields } from '../eligibility/labels.ts';
import { isQuarantined } from '../quarantine.ts';
import { loadPageTrust } from '../eligibility/stamp.ts';
import { loadRelationshipNotes, relationshipNoteKey } from '../link-relationship-notes.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import { slugify } from '../entities/resolve.ts';
import { exactMatchPreference } from '../entities/exact-match-preference.ts';
import { safeSynopsis } from '../context/retrieval-reflex.ts';
import { stampEvidence, markKeywordHits } from '../search/evidence.ts';
import type { Link, SearchResult } from '../types.ts';
import type { NewerMentions } from '../mentions/newer-mentions.ts';
import { linkableTypesFor, loadLinkableTypes, loadSourcePack, readMentionPolicy, type MentionPolicy, type PackTypes } from '../mentions/policy.ts';
import { readMentionCoverage, type MentionCoverage } from '../mentions/coverage.ts';
import { encodeCursor, readReferrerGroups, PAGE_DEFAULT_LIMIT, type ReferenceRow } from '../mentions/referrers.ts';
import { readRowReferences, referencesUnavailableNotice, type RecordGroupView, type ReferencesUnavailable, type RowReferences } from './entity-references.ts';
import type { Notice } from '../agent-output.ts';
import { readCardIdentity, type CardIdentity } from './entity-card-identity.ts';
import { factEntitySlugs } from '../mentions/siblings.ts';
import { boundedBodyPrefixSql, overlaidBoundedRows } from '../page-window/bounded-lead.ts';

const EDGE_CAP = 10;
const OPEN_THREADS_CAP = 3;
const OPEN_THREAD_TIMELINE_WINDOW_DAYS = 90;
const SUGGESTION_CAP = 3;
const FACT_FETCH_CAP = 100;
export const RECENT_FACTS_CAP = 5;

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
  /** #5575 A6 (additive): the trust tier and short origin of the fact or timeline row behind the thread. */
  trust_tier?: TrustTier;
  origin?: string;
}

export interface EntityCard {
  /** #6723: `source_id` is the source the page lives in; (source_id, slug) is the entity's identity. */
  entity: { slug: string; title: string; type: string | null; source_id: string };
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
  /** The newest active saved facts about this entity (also those saved under an identity sibling or its bare name, with that `entity_slug`). */
  recent_facts?: Array<{ id: string; fact: string; kind: string; valid_from: string | null; entity_slug?: string }>;
  /**
   * Current and ended state relationships of this entity, rendered for agents
   * ("now: works_at widget-co (since 2025-03-01); ended: works_at acme-example
   * (2025-03-01)"), plus a stale-summary warning when the summary still names
   * a relationship that ended. Absent when there is nothing to say.
   */
  relationship_note?: string;
  /** F3: this page's own frontmatter `status` (a string up to 40 characters), only when set. `context_pack` cards only. */
  page_status?: string;
  /** Pages dated after this page that mention it, newest first, bounded. `context_pack` cards only (mentions/newer-mentions.ts). */
  newer_mentions?: NewerMentions;
  /** Distinct pages with any inbound link (every link source, mentions included). `entity` verb only. */
  referenced_by_count?: number;
  /** Those pages grouped by pack-canonical type, newest first; capped per group and per card. `entity` verb only. */
  referenced_by?: ReferenceGroupView[];
  /**
   * The referring pages of the enrolled record types (`entity.record_types`), one group per type, newest page date first
   * (the order never says which record governs). `entity` and `context_pack` only, and only when types are enrolled.
   */
  records?: RecordGroupView[];
  /** `context_pack` cards: the same reference fields for each identity sibling, side by side, never merged. */
  sibling_records?: Array<{ slug: string; title: string } & RowReferences>;
  /** The reference count and records could not be read (deadline or failure); unread, not empty. */
  references_unavailable?: ReferencesUnavailable;
  /** Whether every page in this source has been scanned for this entity's names. `entity` verb only. */
  coverage?: MentionCoverage;
  /** Parallel to `aka`: each entry's origin (frontmatter, declared, subject) and the page that declares it. `entity` verb only. */
  aka_sources?: CardIdentity['aka_sources'];
  /** Pages naming the same subject under another title prefix, with their own aliases; never merged into this card. `entity` verb only. */
  identity_siblings?: CardIdentity['identity_siblings'];
  /** Verbatim lines of this page and its siblings that may carry other names (label lines, codes, declarations), with the page slug. `entity` verb only. */
  identity_excerpt?: CardIdentity['identity_excerpt'];
  /** Pages whose qualifying lines did not fit the excerpt budget. */
  identity_excerpt_omitted?: string[];
  /** What `aka` covers and which names to search before a history or as-of answer. `entity` verb only. */
  alias_guidance?: CardIdentity['alias_guidance'];
  /** #5575 A6 (additive): the entity page's trust tier and short write origin. */
  trust_tier?: TrustTier;
  origin?: string;
  /** #5575 ENG-15 (additive): the page is quarantined; renderers wrap its summary as external data. */
  quarantined?: true;
  /** #5575 CEO-20 (additive): the entity page carries an unconfirmed instruction-family write-gate flag. */
  unconfirmed?: true;
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
  /** #6723: the source the suggested page lives in. */
  source_id?: string;
}

export interface EntityCardResult {
  found: boolean;
  card?: EntityCard;
  suggestions?: EntitySuggestion[];
  /** On a miss with `includeReferences`: the source's mention coverage (a miss may be a not-yet-indexed name). */
  coverage?: MentionCoverage;
  /** #6723: the source of the resolved page (absent on a miss). */
  source_id?: string;
  /**
   * #6724: the full fact rows the card read (newest first, visibility and
   * eligibility already applied), for context_pack's `entity_facts`. Never part
   * of the card: the `entity` verb does not return it.
   */
  factRows?: FactRow[];
}

export interface EntityCardOpts {
  remote: boolean;
  /**
   * #6723: the sources to resolve the name in, probed in this order (home
   * first); the first source with a hit owns the card and every read behind
   * it. Absent: the positional source alone.
   */
  sources?: readonly string[];
  /**
   * Compute `referenced_by`, `referenced_by_count` and `coverage` (the `entity`
   * verb). Ambient callers (context_pack, delta) leave it off.
   */
  includeReferences?: boolean;
  /** The serving surface ceiling; on `verbs` a continuation names the starter surface. */
  surfaceCeiling?: 'verbs' | 'starter' | 'full';
  /** Receives the degraded notice when the card's references or records could not be read. */
  emitNotice?: (n: Notice) => void;
  /**
   * #5575 (ENG-8, CEO-20): the eligibility for the card's facts and timeline
   * rows. Always hides quarantined-page projections and rows awaiting
   * re-derivation; a proactive caller (context_pack, delta) passes its floor
   * and activation control.
   */
  eligibility?: ReadEligibility;
  /**
   * #5575 (ENG-8, ENG-15): leave out a page the content-quality gate
   * quarantined, as if it did not exist (no suggestion names it). Proactive
   * callers always pass it unless an authorized `include_quarantined` asked;
   * the entity verb passes it for remote callers, like get_page.
   */
  omitQuarantined?: boolean;
}

export interface CardPageRow {
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

/**
 * The per-call invariants of a name lookup: whether this caller is kept from
 * private pages (#4352: untrusted callers never resolve a `visibility:
 * private` page into a card or a near-miss suggestion; local callers are
 * unchanged), the mention policy and source pack (undefined policy: it could
 * not be read), and the pack's linkable entity types (the exact-title
 * tie-break; empty without a policy). A batch reads them once.
 */
export interface EntityLookupScope {
  excludePrivate: boolean;
  entityTypes: ReadonlySet<string>;
  policy: MentionPolicy | undefined;
  pack: PackTypes | null;
}

export async function entityLookupScope(engine: BrainEngine, sourceId: string, remote: boolean): Promise<EntityLookupScope> {
  const { resolveExcludePrivatePages } = await import('../search/private-visibility.ts');
  const excludePrivate = await resolveExcludePrivatePages(engine, remote ? undefined : false);
  const policy = await readMentionPolicy(engine).catch(() => undefined);
  const pack = await loadSourcePack(engine, sourceId);
  return { excludePrivate, entityTypes: new Set(policy ? linkableTypesFor(pack, policy) : []), policy, pack };
}

/**
 * Candidate selection for one name: `hit` with the best page row (its
 * bounded, withdrawal-overlaid `compiled_truth` prefix included) and up to SUGGESTION_CAP runners-up; `miss` with
 * keyword near-miss suggestions; `withheld` when every match is a quarantined
 * page `omitQuarantined` leaves out (no suggestion names it).
 */
export type EntityCandidates =
  | { kind: 'hit'; row: CardPageRow; runnersUp: EntitySuggestion[] }
  | { kind: 'miss'; suggestions: EntitySuggestion[] }
  | { kind: 'withheld' };

/** Resolve a trimmed, non-empty name to its candidates. Every arm is fail-soft. */
export async function selectEntityCandidates(
  engine: BrainEngine,
  sourceId: string,
  trimmed: string,
  scope: EntityLookupScope,
  opts: { omitQuarantined?: boolean; suggest?: boolean } = {},
): Promise<EntityCandidates> {
  const { privatePagesFilterFragment } = await import('../search/private-visibility.ts');
  // Predicate text lives ONCE (private-visibility.ts) — both card queries
  // below select `FROM pages` unaliased, so qualify with the table name.
  const privatePredicate = scope.excludePrivate ? ` AND ${privatePagesFilterFragment('pages')}` : '';

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
      `SELECT slug, source_id, title, type, frontmatter, ${boundedBodyPrefixSql('pages')} AS compiled_truth, updated_at,
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
        `SELECT slug, source_id, title, type, frontmatter, ${boundedBodyPrefixSql('pages')} AS compiled_truth, updated_at,
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
  const entityTypes = scope.entityTypes;
  const candidates = [...rankBySlug.entries()]
    .map(([s, rank]) => ({ slug: s, rank, row: rowBySlug.get(s) }))
    .filter((c): c is { slug: string; rank: number; row: CardPageRow } => c.row !== undefined)
    .sort((a, b) =>
      a.rank - b.rank
      || (a.rank === ARM_EXACT
        ? exactMatchPreference(a.row, exactSlugs, entityTypes) - exactMatchPreference(b.row, exactSlugs, entityTypes)
        : 0)
      || lastTouchedMs(b.row) - lastTouchedMs(a.row));

  if (opts.omitQuarantined && candidates.some(c => isQuarantined(c.row.frontmatter))) {
    const live = candidates.filter(c => !isQuarantined(c.row.frontmatter));
    if (live.length === 0) return { kind: 'withheld' };
    candidates.splice(0, candidates.length, ...live);
  }
  if (candidates.length === 0) {
    return { kind: 'miss', suggestions: opts.suggest === false ? [] : await nearMissSuggestions(engine, sourceId, trimmed, scope.excludePrivate) };
  }

  // Large pages: the hit carries a bounded, withdrawal-overlaid body prefix (its summary and lead read only that).
  const [row] = await overlaidBoundedRows(engine, [candidates[0].row]);
  return {
    kind: 'hit',
    row,
    runnersUp: candidates.slice(1, 1 + SUGGESTION_CAP).map(c => ({
      slug: c.slug,
      title: c.row.title ?? c.slug,
      // A page that resolved through the precision arms exists by definition.
      create_safety: 'exists',
      source_id: sourceId,
    })),
  };
}

/**
 * #6723: resolve a name across sources in the given order (home first, then
 * the rest of the caller's grant). The first source with a hit owns the
 * result; a source is read with its own lookup scope (pack, linkable types).
 * Without a hit anywhere, the first source's miss (its near-miss suggestions)
 * or withheld result is returned. Sources outside the list are never read.
 */
export async function selectAcrossSources(
  engine: BrainEngine,
  sources: readonly string[],
  trimmed: string,
  remote: boolean,
  opts: { omitQuarantined?: boolean; scopes?: Map<string, Promise<EntityLookupScope>> } = {},
): Promise<{ sourceId: string; scope: EntityLookupScope; selected: EntityCandidates }> {
  let first: { sourceId: string; scope: EntityLookupScope; selected: EntityCandidates } | undefined;
  for (const sourceId of sources) {
    if (opts.scopes && !opts.scopes.has(sourceId)) opts.scopes.set(sourceId, entityLookupScope(engine, sourceId, remote));
    const scope = await (opts.scopes?.get(sourceId) ?? entityLookupScope(engine, sourceId, remote));
    const selected = await selectEntityCandidates(engine, sourceId, trimmed, scope, { omitQuarantined: opts.omitQuarantined, suggest: first === undefined });
    if (selected.kind === 'hit') return { sourceId, scope, selected };
    first ??= { sourceId, scope, selected };
  }
  return first!;
}

export async function buildEntityCard(
  engine: BrainEngine,
  sourceId: string,
  name: string,
  opts: EntityCardOpts,
): Promise<EntityCardResult> {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return { found: false, suggestions: [] };

  // Covers entity, context_pack, and delta (all route through buildEntityCard).
  // #6723: the source with the hit owns the card; every read below uses it.
  const sources = opts.sources?.length ? opts.sources : [sourceId];
  const { sourceId: hitSource, scope, selected } = await selectAcrossSources(engine, sources, trimmed, opts.remote, { omitQuarantined: opts.omitQuarantined });
  if (selected.kind === 'withheld') return { found: false, suggestions: [] };
  if (selected.kind === 'miss') {
    return {
      found: false, suggestions: selected.suggestions,
      ...(opts.includeReferences ? { coverage: await readMentionCoverage(engine, [...sources]).catch(() => undefined) } : {}),
    };
  }

  const { row, runnersUp } = selected;
  const { card, facts: factRows } = await assembleCard(engine, hitSource, row, opts.remote, scope.excludePrivate, opts.eligibility ?? {});
  if (opts.includeReferences) {
    Object.assign(card, await cardReferences(engine, hitSource, row, opts, scope.excludePrivate, scope.entityTypes),
      await readCardIdentity(engine, hitSource, row, { excludePrivate: scope.excludePrivate, excludeQuarantined: opts.omitQuarantined === true, surfaceCeiling: opts.surfaceCeiling, aka: card.aka }));
    await attachCardRecords(engine, hitSource, card, opts, scope.excludePrivate);
  }
  return {
    found: true,
    card,
    source_id: hitSource,
    factRows,
    ...(runnersUp.length ? { suggestions: runnersUp } : {}),
  };
}

/**
 * The `entity` verb's reference fields: every page linking here (mentions
 * included), grouped by pack-canonical type with the continuation for a
 * truncated group, and the source's mention coverage. Fail-soft: a failed
 * read leaves the card without them rather than failing the lookup.
 */
async function cardReferences(engine: BrainEngine, sourceId: string, row: CardPageRow, opts: EntityCardOpts, excludePrivate: boolean,
  entityTypes: ReadonlySet<string>): Promise<Pick<EntityCard, 'referenced_by_count' | 'referenced_by' | 'coverage' | 'references_unavailable'>> {
  try {
    const { pack } = await loadLinkableTypes(engine, sourceId);
    const { total, groups } = await readReferrerGroups(engine, { slug: row.slug, sourceId, referrerSources: [sourceId], excludePrivate, pack,
      keepVisibility: opts.remote ? ['world'] : ['private', 'world'], eligibility: opts.eligibility });
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
    opts.emitNotice?.(referencesUnavailableNotice('read_failed'));
    return { references_unavailable: 'read_failed' };
  }
}

/** The full card's record view for the page and each identity sibling (records only: the card has its own count). */
async function attachCardRecords(engine: BrainEngine, sourceId: string, card: EntityCard, opts: EntityCardOpts, excludePrivate: boolean): Promise<void> {
  const siblings = card.identity_siblings?.pages ?? [];
  const refs = await readRowReferences(engine, sourceId, [card.entity.slug, ...siblings.map(p => p.slug)].map(slug => ({ slug, sourceId })),
    { remote: opts.remote, excludePrivate, surfaceCeiling: opts.surfaceCeiling, eligibility: opts.eligibility, surface: 'full_card', emitNotice: opts.emitNotice });
  const [own, ...rest] = refs.rows;
  if (own?.records) card.records = own.records;
  siblings.forEach((p, i) => { if (rest[i]?.records) Object.assign(p, { records: rest[i]!.records }); });
  if (!own?.references_unavailable || card.references_unavailable) return;
  card.references_unavailable = own.references_unavailable;
  if (refs.notice) opts.emitNotice?.(refs.notice);
}

async function assembleCard(
  engine: BrainEngine,
  sourceId: string,
  row: CardPageRow,
  remote: boolean,
  excludePrivate: boolean,
  eligibility: ReadEligibility,
): Promise<{ card: EntityCard; facts: FactRow[] }> {
  const pageSlug = row.slug;
  const visibility = remote ? (['world'] as ('private' | 'world')[]) : undefined;
  // Facts saved about this entity may sit under a sibling page or the bare subject slug (siblings.ts).
  const factSlugs = await factEntitySlugs(engine, sourceId, pageSlug, { excludePrivate }).catch(() => [pageSlug]);
  const { privatePagesFilterFragment, privateLinkOriginFilterFragment, privateProvenanceFilterFragment } = await import('../search/private-visibility.ts');
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
  // (getLinks) are the entity's OWN declared links — from-side scoped for the
  // trusted local caller; an untrusted caller reads them through the engine's
  // all-endpoints branch (`sourceIds`), so an edge the source policy admitted
  // into another source (#4680) never shows that source's slug on the card.
  // The referrer must also be live and, for an untrusted caller,
  // readable: the same private-page and private-origin predicates get_backlinks
  // applies, so a private or derived page never surfaces its slug, its
  // links.context sentence, or a count.
  const [aka, outLinks, inEdges, backlinkCount, timeline, facts, activeFactCount] = await Promise.all([
    readAka(engine, sourceId, pageSlug),
    engine.getLinks(pageSlug, { ...(remote ? { sourceIds: [sourceId] } : { sourceId }), excludePrivate, temporal: { status: 'all' } }).catch(() => []),
    engine
      .executeRaw<{ from_slug: string; link_type: string; context: string | null }>(
        `SELECT f.slug AS from_slug, l.link_type, l.context${TEMPORAL_LINK_SELECT_SQL}
           FROM links l
           JOIN pages f ON f.id = l.from_page_id
           JOIN pages t ON t.id = l.to_page_id
           ${temporalLinkJoinSql('l', excludePrivate)}
          WHERE t.slug = $1 AND t.source_id = $2 AND f.source_id = $2 AND f.deleted_at IS NULL
            AND COALESCE(l.link_source, '') <> 'mentions'${inboundPrivacy}
          ORDER BY l.id`,
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
    engine.getTimeline(pageSlug, { limit: 5, sourceId, excludePrivate, eligibility }).catch(() => []),
    Promise.all(factSlugs.map(slug => engine.listFactsByEntity(sourceId, slug, {
      activeOnly: true,
      limit: FACT_FETCH_CAP,
      ...(visibility ? { visibility } : {}),
      excludePrivate,
      eligibility,
    })))
      .then(lists => lists.flat().sort((a, b) => factTime(b) - factTime(a)).slice(0, FACT_FETCH_CAP))
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
          WHERE source_id = $1 AND entity_slug = ANY($2::text[])
            AND expired_at IS NULL${remote ? ` AND visibility = 'world'` : ''}${excludePrivate ? ` AND ${privateProvenanceFilterFragment('facts')}` : ''}`,
        [sourceId, factSlugs],
      )
      .then(rs => Number(rs[0]?.n ?? 0))
      .catch(() => null),
  ]);

  // Live relationships first so ended ones never push a current edge past the cap.
  const rank = ({ status, type }: EntityCardEdge) => (status === 'live' || status === 'disputed' ? 0
    : status === 'event' || status === 'reference' || !status || LIVENESS_EXEMPT_LINK_TYPES.includes(type) ? 1 : 2);
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
    ...[...outCandidates].sort((a, b) => rank(a) - rank(b)),
    ...[...inCandidates].sort((a, b) => rank(a) - rank(b)),
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
    // Zero-LLM, indexed lookup — stays inside the p99<100ms budget. A loop
    // belongs to this card when its counterparty page is THIS (source, slug):
    // a Gmail-source loop whose person page lives in `default` shows on the
    // default card, a pre-v236 row (NULL counterparty source) on its own
    // source's card (#5504). Loops carry no visibility or grant of their own
    // (summaries derive from private mail, often another source), so a
    // world-only card never reads them; open_loops serves remote callers
    // inside their grant.
    const loopRows = remote ? [] : await engine.executeRaw<{
      id: number;
      loop_type: string;
      summary: string;
      due_at: string | null;
      last_activity_at: string;
      fact_id: number | null;
    }>(
      `SELECT id, loop_type, summary, due_at, last_activity_at, fact_id
       FROM open_loops
       WHERE status = 'open' AND counterparty_slug = $1
         AND COALESCE(counterparty_source_id, source_id) = $2
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
    openThreads.push({ kind: 'commitment', text: f.fact, date: f.valid_from?.toISOString() ?? null, ...trustFields(f.trust_tier, f.write_origin) });
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
      const raw = t as unknown as { trust_tier?: unknown; write_origin?: unknown };
      openThreads.push({ kind: 'recent_event', text: t.summary, date, ...trustFields(raw.trust_tier, raw.write_origin) });
      if (openThreads.length >= OPEN_THREADS_CAP) break;
    }
  }

  const pageTrust = (await loadPageTrust(engine, [{ source_id: sourceId, slug: pageSlug }]).catch(() => null))?.byKey.get(`${sourceId}\u0000${pageSlug}`);
  return { facts, card: {
    entity: { slug: pageSlug, title: row.title ?? pageSlug, type: row.type ?? null, source_id: sourceId },
    ...(pageTrust ?? { trust_tier: 'unknown' as const, origin: 'unrecorded' }),
    ...(isQuarantined(row.frontmatter) ? { quarantined: true as const } : {}),
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
    ...(facts.length ? { recent_facts: facts.slice(0, RECENT_FACTS_CAP).map(f => ({
      id: String(f.id), fact: f.fact, kind: f.kind, valid_from: f.valid_from ? toIso(f.valid_from as Date | string) : null,
      ...(f.entity_slug && f.entity_slug !== pageSlug ? { entity_slug: f.entity_slug } : {}),
    })) } : {}),
  } };
}

/** The card's `aka`: the page's normalized aliases (page_aliases reverse lookup); empty on a pre-migration brain. */
export async function readAka(engine: BrainEngine, sourceId: string, slug: string): Promise<string[]> {
  return engine
    .executeRaw<{ alias_norm: string }>(
      `SELECT alias_norm FROM page_aliases WHERE source_id = $1 AND slug = $2 ORDER BY alias_norm`,
      [sourceId, slug],
    )
    .then(rs => rs.map(r => r.alias_norm))
    .catch(() => [] as string[]);
}

function factTime(f: FactRow): number {
  return toMs((f.valid_from ?? f.created_at ?? null) as Date | string | null);
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
      source_id: r.source_id ?? sourceId,
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
