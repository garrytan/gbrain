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
 *
 * Read side (`collapseHotFacts`): rows with the same fingerprint on the same
 * entity, or on different entities when the claim names one of them,
 * collapse to the newest row, which carries every entity slug of its group.
 */

import type { BrainEngine, FactRow } from '../engine.ts';
import { corpusFileSessionId } from '../context/corpus-segments.ts';
import { writeHeartbeat } from '../context/hook-heartbeat.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import { cosineSimilarity } from './classify.ts';

export const CAPTURE_LANES = ['hook:writeback', 'sweep:corpus', 'hook:compact'] as const;
export const CAPTURE_DEDUP_WINDOW_MS = 15 * 60 * 1000;
/** Shadow-mode near-duplicate threshold (measured, never a drop). */
export const NEAR_DUPLICATE_THRESHOLD = 0.92;
/** Explicit lanes keep their pre-#5888 cosine rule. */
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
 * never return `duplicate`; explicit lanes keep the 0.95 rule unchanged.
 */
export function cosineVerdict(source: string | null | undefined, score: number, claim: string, existing: string): CosineVerdict {
  if (!isCaptureLane(source)) return score >= EXPLICIT_DUPLICATE_THRESHOLD ? 'duplicate' : 'distinct';
  return score >= NEAR_DUPLICATE_THRESHOLD && !claimsDiverge(claim, existing) ? 'near_duplicate' : 'distinct';
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
}
export interface CaptureScope {
  engine: BrainEngine;
  sourceId: string;
  lane: string;
  sessionId: string | null;
  /** The source turn's own time when the lane knows it, else check time. */
  anchor: Date;
}
export interface CaptureMatch { id: number; rule: 'same_entity' | 'named_entity'; }

/** The exact-fingerprint drop rule (one bounded indexed read). */
export async function findCaptureDuplicate(scope: CaptureScope, candidate: CaptureCandidate): Promise<CaptureMatch | null> {
  const visibilities = candidate.visibility === 'world' ? ['world'] : ['world', 'private'];
  const rows = await scope.engine.executeRaw<{ id: number; entity_slug: string | null; source: string; source_session: string | null; created_at: Date | string }>(
    `SELECT id,entity_slug,source,source_session,created_at FROM facts WHERE source_id=$1 AND visibility=ANY($2::text[])
      AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint($3) AND expired_at IS NULL AND (valid_until IS NULL OR valid_until>now())
      ORDER BY created_at DESC, id DESC LIMIT ${CAPTURE_DEDUP_SCAN_LIMIT}`,
    [scope.sourceId, visibilities, candidate.fact]);
  const conversation = canonicalConversationKey(scope.sessionId);
  const recent = rows.filter(row => Math.abs(new Date(row.created_at).getTime() - scope.anchor.getTime()) <= CAPTURE_DEDUP_WINDOW_MS
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
    { embedding: candidate.embedding, embeddingModel: candidate.embeddingModel, k: 5 });
  let best: { id: number; score: number; fact: string } | null = null;
  for (const row of found) {
    if (!row.embedding || row.expired_at || candidate.visibility === 'world' && row.visibility !== 'world') continue;
    const score = cosineSimilarity(candidate.embedding, row.embedding);
    if (!best || score > best.score) best = { id: row.id, score, fact: row.fact };
  }
  return best && cosineVerdict(scope.lane, best.score, candidate.fact, best.fact) === 'near_duplicate' ? best.id : null;
}

export interface CaptureDedupResult<T> { kept: T[]; duplicateIds: number[]; nearDuplicates: number; }

/**
 * The shared pre-branch check. `resolve` maps an extracted entity reference
 * to the slug the writers will use (null when unresolved).
 */
export async function applyCaptureDedup<T extends { fact: string; entity_slug?: string | null; embedding?: Float32Array | null; embedding_model?: string | null; entity_inferred?: unknown }>(
  scope: CaptureScope, facts: T[], visibility: 'private' | 'world', resolve: (entity: string | null | undefined) => Promise<string | null>,
): Promise<CaptureDedupResult<T>> {
  const started = Date.now();
  const result: CaptureDedupResult<T> = { kept: [], duplicateIds: [], nearDuplicates: 0 };
  let failed = false;
  for (const fact of facts) {
    const candidate: CaptureCandidate = { fact: fact.fact, entitySlug: await resolve(fact.entity_slug), visibility,
      embedding: fact.embedding, embeddingModel: fact.embedding_model, entityInferred: fact.entity_inferred };
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
export async function dedupCapturedFacts<T extends { fact: string; entity_slug?: string | null; embedding?: Float32Array | null; embedding_model?: string | null; entity_inferred?: unknown }>(
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
export type CollapsedHotFact<R extends HotFactRow> = R & { entity_slugs?: string[] };

/**
 * V2 hot-memory collapse: one representative (the newest row) per
 * (fingerprint, entity) group; groups of different entities merge only when
 * the claim names one of them. Input order is preserved by representative.
 */
/** `members` (optional) receives raw row id -> emitted representative id, so delta can advance its facts keyset through raw rows. */
export async function collapseHotFacts<R extends HotFactRow>(engine: BrainEngine, sourceId: string, rows: R[], members?: Map<number, number>): Promise<CollapsedHotFact<R>[]> {
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
    const clusters = new Map<string, R[]>();
    for (const row of group) {
      const key = named ? '*' : row.entity_slug ?? '';
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
