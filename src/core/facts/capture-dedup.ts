/**
 * #5888 — capture-lane duplicate policy, shared by every write path that
 * stores automatically captured facts (`hook:writeback`, `sweep:corpus`,
 * `hook:compact`) and by the hot-memory read that injects them.
 *
 * Write side (`applyCaptureDedup`, called by the backstop before its
 * managed/unmanaged branch): an extracted candidate is DROPPED only when an
 * active fact in the same source has the same `gbrain_fact_fingerprint` and
 *   - sits on the same entity (or both have none), or on a different entity
 *     whose page title or alias the claim names (subject-relative claims such
 *     as "Prefers email" captured for two people are never merged);
 *   - is visible where the candidate is (a `private` candidate compares with
 *     `world` and `private` facts, a `world` candidate only with `world`);
 *   - was written within 15 minutes of the source turn, or by a capture lane
 *     in the same conversation (no time bound inside one conversation).
 * Near duplicates (cosine >= 0.92 on the same entity, claims not differing
 * in a negation, number or date token) are never dropped: they are counted
 * in shadow mode (`near_duplicate` on the `writeback_dedup` heartbeat event)
 * so a threshold can be measured before it ever deletes anything. A failed
 * dedup read inserts the candidate (fail open) and warns with the lane.
 * Explicit lanes (`remember`, extract_facts, sync) never pass through here.
 * #7043: conversation-fact extraction reuses the exact-fingerprint rule with
 * no time bound (`anchor: null`), skipping a candidate an active fact of the
 * source already states (conversation-publication.ts).
 *
 * Read side (`collapseHotFacts`): rows with the same fingerprint on the same
 * entity, or on different entities when the claim names one of them,
 * collapse to the newest row, which carries every entity slug of its group.
 * `collapseFactReads` applies it to reads that span sources and
 * visibilities (recall, search's saved facts, #7043).
 */

import type { BrainEngine, FactAttribution, FactRow, FactVisibility } from '../engine.ts';
import { corpusFileSessionId } from '../context/corpus-segments.ts';
import { writeHeartbeat } from '../context/hook-heartbeat.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import { cosineSimilarity } from './classify.ts';

export const CAPTURE_LANES = ['hook:writeback', 'sweep:corpus', 'hook:compact'] as const;
export const CAPTURE_DEDUP_WINDOW_MS = 15 * 60 * 1000;
/** Shadow-mode near-duplicate threshold (measured, never a drop). */
export const NEAR_DUPLICATE_THRESHOLD = 0.92;
/** The bar consolidate clusters untyped facts at (#6023). Explicit-lane supersession reads the per-model threshold instead (supersession-threshold.ts). */
export const EXPLICIT_DUPLICATE_THRESHOLD = 0.95;
const CAPTURE_DEDUP_SCAN_LIMIT = 50;

export function isCaptureLane(source: string | null | undefined): boolean {
  return (CAPTURE_LANES as readonly string[]).includes(source ?? '');
}

/**
 * One key per harness conversation across the capture lanes: the corpus sweep
 * tags rows `sweep:corpus:<file>`, where the file is `<session>.txt`, a
 * checkpoint segment or a writeback turn file of that session.
 */
export function canonicalConversationKey(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  const bare = sessionId.startsWith('sweep:corpus:') ? sessionId.slice('sweep:corpus:'.length) : sessionId;
  const key = bare.endsWith('.txt') ? corpusFileSessionId(bare) : bare;
  return key || null;
}

const NEGATION_TOKENS = /\b(?:no longer|not|no|never|stopped|isn't|doesn't|won't|isnt|doesnt|wont)\b/g;
const DATE_WORDS = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|(?:mon|tues|wednes|thurs|fri|satur|sun)days?|today|tomorrow|yesterday)\b/g;
const NUMBER_TOKENS = /[$€£¥]?\d[\d,.:/-]*\s?(?:k|m|bn|b|%|percent)?\b/g;
const NUMBER_WORDS = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|million|billion|dozen|half|twice|first|second|third|last)\b/g;

function guardTokens(text: string): string {
  const t = text.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'");
  const pick = (re: RegExp) => (t.match(re) ?? []).map(s => s.replace(/\s+/g, '').replace(/[.,]+$/, ''));
  return JSON.stringify([pick(NEGATION_TOKENS).sort(), [...pick(NUMBER_TOKENS), ...pick(NUMBER_WORDS), ...pick(DATE_WORDS).map(d => d.replace(/days$/, 'day'))].sort()]);
}

/** V1 guard: true when two claims differ in a negation, number, date or amount token. */
export function claimsDiverge(a: string, b: string): boolean {
  return guardTokens(a) !== guardTokens(b);
}

export type CosineVerdict = 'duplicate' | 'near_duplicate' | 'distinct';

/**
 * The one cosine policy for every fact-write decision point. Capture lanes
 * never return `duplicate`. Explicit lanes return `duplicate` at or above
 * `explicitThreshold`, the embedding model's calibrated supersession
 * threshold (supersession-threshold.ts); null (an uncalibrated model) never
 * returns `duplicate`.
 */
export function cosineVerdict(source: string | null | undefined, score: number, claim: string, existing: string, explicitThreshold: number | null): CosineVerdict {
  if (!isCaptureLane(source)) return explicitThreshold !== null && score >= explicitThreshold ? 'duplicate' : 'distinct';
  return score >= NEAR_DUPLICATE_THRESHOLD && !claimsDiverge(claim, existing) ? 'near_duplicate' : 'distinct';
}

/** #6333 shadow floor: same-page rewordings sit at cosine 0.86–0.93 (lane C), under every calibrated dedup threshold. */
export const SAME_PAGE_REWORDING_THRESHOLD = 0.85;

/**
 * #6333 [UC2] shadow predicate, never a drop: would the deterministic rule
 * "same source-qualified provenance (lane + session + visibility), cosine at
 * or above SAME_PAGE_REWORDING_THRESHOLD, no diverging guard token" have
 * treated `claim` as a duplicate of `existing`? The backstop counts it as
 * `would_dedup_same_page` on explicit lanes only. Measured false positives
 * (Lisbon→Porto, approved→rejected, email→phone, all invisible to
 * claimsDiverge) are why the rule measures and does not act.
 */
export function wouldDedupSamePage(
  ctx: { source: string | null | undefined; sessionId: string | null | undefined; visibility: FactVisibility },
  existing: { source: string; source_session: string | null; visibility: FactVisibility; fact: string },
  score: number,
  claim: string,
): boolean {
  if (!ctx.source || !ctx.sessionId || isCaptureLane(ctx.source)) return false;
  if (existing.source !== ctx.source || existing.source_session !== ctx.sessionId || existing.visibility !== ctx.visibility) return false;
  return score >= SAME_PAGE_REWORDING_THRESHOLD && !claimsDiverge(claim, existing.fact);
}

function nameKey(text: string): string {
  return ` ${normalizeAlias(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

/** True when the claim contains one of the entity's names as whole words. */
export function claimNamesEntity(claim: string, names: readonly string[]): boolean {
  const haystack = nameKey(claim);
  return names.some(name => {
    const needle = nameKey(name);
    return needle.trim().length > 0 && haystack.includes(needle);
  });
}

/** Title + aliases of each live entity page, keyed by slug. */
export async function entityNames(engine: BrainEngine, sourceId: string, slugs: string[]): Promise<Map<string, string[]>> {
  const names = new Map<string, string[]>();
  const wanted = [...new Set(slugs)];
  if (!wanted.length) return names;
  const add = (slug: string, name: string | null) => {
    if (name) names.set(slug, [...(names.get(slug) ?? []), name]);
  };
  const pages = await engine.executeRaw<{ slug: string; title: string | null }>(
    'SELECT slug,title FROM pages WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL', [sourceId, wanted]);
  for (const page of pages) add(page.slug, page.title);
  try {
    const aliases = await engine.executeRaw<{ slug: string; alias_norm: string }>(
      'SELECT slug,alias_norm FROM page_aliases WHERE source_id=$1 AND slug=ANY($2::text[])', [sourceId, pages.map(p => p.slug)]);
    for (const alias of aliases) add(alias.slug, alias.alias_norm);
  } catch { /* pre-v110 brain: titles only */ }
  return names;
}

export interface CaptureCandidate {
  fact: string;
  entitySlug: string | null;
  visibility: 'private' | 'world';
  embedding?: Float32Array | null;
  embeddingModel?: string | null;
  entityInferred?: unknown;
  /** Speaker of the candidate; a fact another known speaker asserted never matches. */
  attributedTo?: FactAttribution | null;
}
export interface CaptureScope {
  engine: BrainEngine;
  sourceId: string;
  lane: string;
  sessionId: string | null;
  /** The source turn's own time when the lane knows it, else check time; null drops the time bound (#7043). */
  anchor: Date | null;
  /** Ignore this page's own conversation-extractor rows: a replacement is about to clear them (#7043). */
  replacingPage?: string;
}
export interface CaptureMatch { id: number; rule: 'same_entity' | 'named_entity'; }

/** The exact-fingerprint drop rule (one bounded indexed read). */
export async function findCaptureDuplicate(scope: CaptureScope, candidate: CaptureCandidate): Promise<CaptureMatch | null> {
  const visibilities = candidate.visibility === 'world' ? ['world'] : ['world', 'private'];
  const rows = await scope.engine.executeRaw<{ id: number; entity_slug: string | null; source: string; source_session: string | null; created_at: Date | string }>(
    `SELECT id,entity_slug,source,source_session,created_at FROM facts WHERE source_id=$1 AND visibility=ANY($2::text[])
      AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint($3) AND expired_at IS NULL AND (valid_until IS NULL OR valid_until>now())
      AND ($4::text IS NULL OR attributed_to IS NULL OR attributed_to=$4)
      AND ($5::text IS NULL OR source_markdown_slug IS DISTINCT FROM $5 OR source NOT LIKE 'cli:extract-conversation-facts%')
      ORDER BY created_at DESC, id DESC LIMIT ${CAPTURE_DEDUP_SCAN_LIMIT}`,
    [scope.sourceId, visibilities, candidate.fact, candidate.attributedTo ?? null, scope.replacingPage ?? null]);
  const conversation = canonicalConversationKey(scope.sessionId);
  const anchor = scope.anchor;
  const recent = anchor === null ? rows : rows.filter(row => Math.abs(new Date(row.created_at).getTime() - anchor.getTime()) <= CAPTURE_DEDUP_WINDOW_MS
    || conversation !== null && isCaptureLane(row.source) && canonicalConversationKey(row.source_session) === conversation);
  const same = recent.find(row => (row.entity_slug ?? null) === candidate.entitySlug);
  if (same) return { id: Number(same.id), rule: 'same_entity' };
  const others = recent.filter(row => row.entity_slug);
  if (!others.length) return null;
  const names = await entityNames(scope.engine, scope.sourceId, others.map(row => row.entity_slug!));
  const named = others.find(row => claimNamesEntity(candidate.fact, names.get(row.entity_slug!) ?? []));
  return named ? { id: Number(named.id), rule: 'named_entity' } : null;
}

/** Shadow mode: the id of a same-entity near duplicate, never a drop. */
export async function findNearDuplicate(scope: CaptureScope, candidate: CaptureCandidate): Promise<number | null> {
  if (!candidate.entitySlug || !candidate.embedding || candidate.entityInferred) return null;
  const found = await scope.engine.findCandidateDuplicates(scope.sourceId, candidate.entitySlug, candidate.fact,
    { embedding: candidate.embedding, embeddingModel: candidate.embeddingModel, k: 5, attributedTo: candidate.attributedTo ?? null });
  let best: { id: number; score: number; fact: string } | null = null;
  for (const row of found) {
    if (!row.embedding || row.expired_at || candidate.visibility === 'world' && row.visibility !== 'world') continue;
    const score = cosineSimilarity(candidate.embedding, row.embedding);
    if (!best || score > best.score) best = { id: row.id, score, fact: row.fact };
  }
  return best && cosineVerdict(scope.lane, best.score, candidate.fact, best.fact, null) === 'near_duplicate' ? best.id : null;
}

export interface CaptureDedupResult<T> { kept: T[]; duplicateIds: number[]; nearDuplicates: number; }

/**
 * The shared pre-branch check. `resolve` maps an extracted entity reference
 * to the slug the writers will use (null when unresolved).
 */
export async function applyCaptureDedup<T extends { fact: string; entity_slug?: string | null; embedding?: Float32Array | null; embedding_model?: string | null; entity_inferred?: unknown; attributed_to?: FactAttribution | null }>(
  scope: CaptureScope, facts: T[], visibility: 'private' | 'world', resolve: (entity: string | null | undefined) => Promise<string | null>,
): Promise<CaptureDedupResult<T>> {
  const started = Date.now();
  const result: CaptureDedupResult<T> = { kept: [], duplicateIds: [], nearDuplicates: 0 };
  let failed = false;
  for (const fact of facts) {
    const candidate: CaptureCandidate = { fact: fact.fact, entitySlug: await resolve(fact.entity_slug), visibility,
      embedding: fact.embedding, embeddingModel: fact.embedding_model, entityInferred: fact.entity_inferred, attributedTo: fact.attributed_to ?? null };
    try {
      const match = await findCaptureDuplicate(scope, candidate);
      if (match) {
        result.duplicateIds.push(match.id);
        console.warn(`[facts] capture dedup: lane=${scope.lane} dropped a duplicate of fact #${match.id} (rule=${match.rule})`);
        continue;
      }
      if (await findNearDuplicate(scope, candidate) !== null) result.nearDuplicates++;
    } catch (err) {
      failed = true;
      console.warn(`[facts] capture dedup read failed: lane=${scope.lane} inserting the candidate (${err instanceof Error ? err.message : String(err)})`);
    }
    result.kept.push(fact);
  }
  if (result.duplicateIds.length || result.nearDuplicates || failed) {
    await writeHeartbeat({ ts: new Date().toISOString(), event: 'writeback_dedup', outcome: failed ? 'degraded' : 'ok',
      reason: failed ? `${scope.lane}:read_failed` : scope.lane, duration_ms: Date.now() - started,
      duplicate: result.duplicateIds.length, near_duplicate: result.nearDuplicates }, { trim: false });
  }
  return result;
}

/**
 * The backstop's entry point: capture lanes only, slugs resolved the way both
 * writers resolve them, anchored on the turn time when the lane knows it.
 */
export async function dedupCapturedFacts<T extends { fact: string; entity_slug?: string | null; embedding?: Float32Array | null; embedding_model?: string | null; entity_inferred?: unknown; attributed_to?: FactAttribution | null }>(
  ctx: { engine: BrainEngine; sourceId: string; source: string; sessionId: string | null; turnAt?: Date },
  facts: T[], visibility: 'private' | 'world',
  resolveEntity: (engine: BrainEngine, sourceId: string, raw: string) => Promise<{ slug: string; source: string } | null>,
): Promise<{ facts: T[]; dropped: number[] }> {
  if (!isCaptureLane(ctx.source)) return { facts, dropped: [] };
  const result = await applyCaptureDedup({ engine: ctx.engine, sourceId: ctx.sourceId, lane: ctx.source, sessionId: ctx.sessionId,
    anchor: ctx.turnAt ?? new Date() }, facts, visibility, async entity => {
    const resolved = entity ? await resolveEntity(ctx.engine, ctx.sourceId, entity) : null;
    return resolved && resolved.source !== 'fallback_slugify' ? resolved.slug : null;
  });
  return { facts: result.kept, dropped: result.duplicateIds };
}

/** Folds the pre-branch drops into a writer's counts (null: every candidate was dropped). */
export function withCaptureDrops<R extends { inserted: number; duplicate: number; superseded: number; fact_ids: number[]; entity_slugs: string[] }>(
  dropped: number[], published: R | null,
): R | { inserted: number; duplicate: number; superseded: number; fact_ids: number[]; entity_slugs: string[] } {
  if (!published) return { inserted: 0, duplicate: dropped.length, superseded: 0, fact_ids: dropped, entity_slugs: [] };
  return { ...published, duplicate: published.duplicate + dropped.length, fact_ids: [...dropped, ...published.fact_ids] };
}

export type HotFactRow = FactRow & { fact_fingerprint?: string | null };
/** What the collapse reads of a row. */
export type CollapsibleFact = Pick<FactRow, 'id' | 'fact' | 'entity_slug' | 'attributed_to' | 'created_at'> & { fact_fingerprint?: string | null };
export type CollapsedHotFact<R extends CollapsibleFact> = R & { entity_slugs?: string[] };

/**
 * V2 hot-memory collapse: one representative (the newest row) per
 * (fingerprint, entity) group; groups of different entities merge only when
 * the claim names one of them. Input order is preserved by representative.
 * A group holding claims from two different known speakers (user and
 * assistant) also splits by speaker, so one never hides the other.
 */
/** `members` (optional) receives raw row id -> emitted representative id, so delta can advance its facts keyset through raw rows. */
export async function collapseHotFacts<R extends CollapsibleFact>(engine: BrainEngine, sourceId: string, rows: R[], members?: Map<number, number>): Promise<CollapsedHotFact<R>[]> {
  const byFingerprint = new Map<string, R[]>();
  for (const row of rows) {
    const key = row.fact_fingerprint ?? `id:${row.id}`;
    byFingerprint.set(key, [...(byFingerprint.get(key) ?? []), row]);
  }
  const multiEntity = [...byFingerprint.values()].filter(group => new Set(group.map(r => r.entity_slug)).size > 1);
  const names = multiEntity.length
    ? await entityNames(engine, sourceId, multiEntity.flatMap(group => group.flatMap(r => r.entity_slug ? [r.entity_slug] : []))).catch(() => new Map<string, string[]>())
    : new Map<string, string[]>();
  const clusterOf = new Map<R, R[]>();
  for (const group of byFingerprint.values()) {
    const named = group.some(r => r.entity_slug && claimNamesEntity(r.fact, names.get(r.entity_slug) ?? []));
    const speakers = new Set(group.flatMap(r => r.attributed_to ? [r.attributed_to] : []));
    const clusters = new Map<string, R[]>();
    for (const row of group) {
      const entityKey = named ? '*' : row.entity_slug ?? '';
      const key = speakers.size > 1 ? `${entityKey}\u0000${row.attributed_to ?? ''}` : entityKey;
      clusters.set(key, [...(clusters.get(key) ?? []), row]);
    }
    for (const cluster of clusters.values()) for (const row of cluster) clusterOf.set(row, cluster);
  }
  const out: CollapsedHotFact<R>[] = [];
  const emitted = new Set<R[]>();
  for (const row of rows) {
    const cluster = clusterOf.get(row)!;
    if (emitted.has(cluster)) continue;
    emitted.add(cluster);
    const newest = cluster.reduce((a, b) => b.created_at.getTime() > a.created_at.getTime() || b.created_at.getTime() === a.created_at.getTime() && b.id > a.id ? b : a);
    if (members) for (const r of cluster) members.set(r.id, newest.id);
    const slugs = [...new Set([newest.entity_slug, ...cluster.map(r => r.entity_slug)].filter((s): s is string => !!s))];
    out.push(slugs.length > 1 ? { ...newest, entity_slugs: slugs } : newest);
  }
  return out;
}

/** A row of a read that spans sources and visibilities; `created_at` may arrive as text from a raw read. */
export type FactReadRow = Omit<CollapsibleFact, 'created_at'> & { source_id: string; visibility: string; created_at: Date | string;
  expired_at?: Date | string | null; valid_until?: Date | string | null; entity_slugs?: string[]; collapsed_count?: number; collapsed_ids?: number[] };
/** `collapsed_ids`: every row id the representative stands for (internal; callers drop it from responses). */
export type CollapsedFactRead<R> = R & { entity_slugs?: string[]; collapsed_count?: number; collapsed_ids?: number[] };

/**
 * #7043: `collapseHotFacts` for recall and search. Active rows collapse only
 * within one (source, visibility), so a remote caller's already-filtered rows
 * never meet a hidden copy; expired or lapsed rows pass through unchanged.
 * Rows without `fact_fingerprint` get it from one read of their text. Order
 * is preserved by representative (the group's newest row, holding its
 * first member's place); a representative standing for several rows carries
 * `collapsed_count` and `collapsed_ids`, and `entity_slugs` when they name
 * more than one entity. A row that is already a representative counts as the
 * rows it stands for, so collapsing a merged list of two collapsed reads
 * counts each row once. A failed fingerprint read returns the rows unchanged.
 */
export async function collapseFactReads<R extends FactReadRow>(engine: BrainEngine, rows: R[]): Promise<CollapsedFactRead<R>[]> {
  const now = Date.now();
  const active = rows.filter(r => !r.expired_at && (!r.valid_until || new Date(r.valid_until).getTime() > now));
  if (active.length < 2) return rows;
  const missing = active.filter(r => !r.fact_fingerprint);
  let computed: string[] = [];
  try {
    if (missing.length) computed = (await engine.executeRaw<{ fp: string }>(
      'SELECT gbrain_fact_fingerprint(c) AS fp FROM unnest($1::text[]) WITH ORDINALITY AS t(c, n) ORDER BY n', [missing.map(r => r.fact)])).map(r => r.fp);
  } catch {
    return rows;
  }
  const fingerprints = new Map(missing.map((r, i) => [r.id, computed[i]]));
  const partitions = new Map<string, CollapsibleFact[]>();
  for (const r of active) {
    const key = `${r.source_id}\u0000${r.visibility}`;
    partitions.set(key, [...(partitions.get(key) ?? []), { id: r.id, fact: r.fact, entity_slug: r.entity_slug, attributed_to: r.attributed_to,
      created_at: new Date(r.created_at), fact_fingerprint: r.fact_fingerprint ?? fingerprints.get(r.id) ?? null }]);
  }
  const members = new Map<number, number>();
  for (const [key, part] of partitions) await collapseHotFacts(engine, key.slice(0, key.indexOf('\u0000')), part, members);
  const byId = new Map(rows.map(r => [r.id, r]));
  const groups = new Map<number, R[]>();
  for (const [id, rep] of members) groups.set(rep, [...(groups.get(rep) ?? []), byId.get(id)!]);
  const out: CollapsedFactRead<R>[] = [];
  const emitted = new Set<number>();
  for (const row of rows) {
    const rep = members.get(row.id);
    if (rep === undefined) { out.push(row); continue; }
    if (emitted.has(rep)) continue;
    emitted.add(rep);
    const group = groups.get(rep)!;
    const kept = byId.get(rep)!;
    const slugs = [...new Set([kept.entity_slug, ...group.flatMap(r => r.entity_slugs ?? [r.entity_slug])].filter((s): s is string => !!s))];
    const ids = [...new Set(group.flatMap(r => r.collapsed_ids ?? [r.id]))].sort((a, b) => a - b);
    out.push({ ...kept, ...(slugs.length > 1 ? { entity_slugs: slugs } : {}), ...(ids.length > 1 ? { collapsed_count: ids.length, collapsed_ids: ids } : {}) });
  }
  return out;
}
