/**
 * The historical retriever (W3, docs/architecture/historical-retrieval.md section 5): lexical retrieval over the
 * history text index, bounded by a recorded-time instant T. Candidates are the index rows whose interval holds T; each
 * survivor is confirmed by page-at-time's batch read (the matched row must be the page's content interval at T, not
 * deleted, with a body); its body at T goes through the withdrawal union (withdrawals active at T or now) and, for a
 * remote caller, the sanitized projection without rows made private later or hidden by a purge (W4's rule); and one
 * scorer, which depends only on that text, ranks it. Content is bounded by T; restrictions are bounded by now.
 */
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { sanitizeRemoteBody } from '../remote-body.ts';
import { credentialSafeProjection } from '../credential-projection.ts';
import { createHash } from 'node:crypto';
import { normalizeLoweredClaim } from '../facts/withdrawal-schema.ts';
import { normalizeAlias } from '../search/alias-normalize.ts';
import { overlayCanonicalBodies } from '../page-state/snapshot.ts';
import type { PageWithdrawal } from '../page-state/types.ts';
import { cacheRowId } from '../search/query-cache.ts';
import { isTrustTier, minTrust, type TrustTier } from '../trust/tier.ts';
import { coverageAt } from './coverage-report.ts';
import { bodyClaims, bodySubjects } from './backfill.ts';
import { readPageAtTime, readPagesAtTime, type LifetimeAtTime, type PageInterval } from './page-at-time.ts';
import { fenceTakeRows, historyBodyChunks, historyIndexState, type FenceTake } from './history-index.ts';

export { historyBodyChunks } from './history-index.ts';

/** The fixed title-match term of the scorer. */
export const HISTORY_TITLE_BONUS = 0.25;

/** The evidence branches of think that do not run under known_as_of (section 6), named in the result. */
export const DISABLED_BRANCHES = ['vector', 'image', 'relational', 'reranker', 'boosts', 'semantic_cache', 'system_one', 'take_vector', 'graph', 'trajectory',
  'calibration', 'session_expansion'] as const;

export type HistoricalMutant = 'current_text' | 'current_candidates' | 'current_aliases' | 'backlink_boost' | 'semantic_cache' | 'truncate_before_exact'
  | 'no_later_private_restriction';
let mutant: HistoricalMutant | null = null;
/** Test seam for the invariance gate's forced probes (section 7, assertion 4): each must make the gate fail. */
export function __setHistoricalMutantForTests(m: HistoricalMutant | null): void { mutant = m; }

/** The query's lexemes OR-ed, so a question in prose matches on its words; null when it has none (all stop words). */
const tsquerySql = (param: string) => `(SELECT to_tsquery('simple', string_agg(quote_literal(lexeme), ' | ' ORDER BY lexeme))
  FROM unnest(to_tsvector('english', gbrain_fts_input(${param}::text))) AS u(lexeme))`;
const json = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : v;
const iso = (v: unknown) => v == null ? null : new Date(v as string).toISOString();
const byText = (a: string, b: string) => a.localeCompare(b);

/**
 * The scorer: per document, the best `ts_rank_cd` of its chunks against the query plus the title term; null when no
 * chunk matches. It uses no corpus statistics, so a document's score depends only on its own text.
 */
export async function historicalScore(engine: Pick<BrainEngine, 'executeRaw'>, query: string, docs: ReadonlyArray<{ key: string; title: string | null; chunks: readonly string[] }>): Promise<Map<string, number>> {
  const rows = docs.flatMap((d, key) => d.chunks.map(chunk => ({ key, title: d.title ?? '', chunk })));
  const out = new Map<string, number>();
  if (!rows.length) return out;
  const scored = await engine.executeRaw<{ key: number; chunk_score: number; title_hit: boolean }>(`WITH q AS (SELECT ${tsquerySql('$1')} AS q),
      d AS (SELECT * FROM jsonb_to_recordset($2::text::jsonb) AS d(key integer, title text, chunk text)),
      s AS (SELECT d.key, d.title, to_tsvector('english', gbrain_fts_input(d.chunk)) AS v FROM d)
    SELECT s.key, max(ts_rank_cd(s.v, q.q))::float8 AS chunk_score, bool_or(to_tsvector('english', gbrain_fts_input(s.title)) @@ q.q) AS title_hit
    FROM s, q WHERE q.q IS NOT NULL AND s.v @@ q.q GROUP BY s.key`, [query, JSON.stringify(rows)]);
  for (const r of scored) out.set(docs[Number(r.key)]!.key, Number(r.chunk_score) + (r.title_hit === true ? HISTORY_TITLE_BONUS : 0));
  return out;
}

export interface HistoricalScope { sourceId: string; interval: PageInterval; at: Date; remote: boolean; holders?: readonly string[]; current?: boolean; restrict?: boolean }

async function rawText(engine: BrainEngine, scope: HistoricalScope): Promise<{ compiled_truth: string; timeline: string }> {
  if (scope.current) {
    const [p] = await engine.executeRaw<{ compiled_truth: string | null; timeline: string | null }>(`SELECT p.compiled_truth, p.timeline FROM belief_page_lifetimes l
      JOIN pages p ON p.id = l.page_id WHERE l.page_lifetime = $1::uuid`, [scope.interval.lifetime]);
    return { compiled_truth: p?.compiled_truth ?? '', timeline: p?.timeline ?? '' };
  }
  return { compiled_truth: scope.interval.page?.compiled_truth ?? '', timeline: scope.interval.page?.timeline ?? '' };
}

/**
 * Withdrawals and purge tombstones of each page now (at its slug at T and its slug now): the union with those active at
 * T, since none is ever reversed. One statement for the whole list; each item's rows come back in the per-page order.
 */
async function withdrawalsFor(engine: BrainEngine, items: ReadonlyArray<{ sourceId: string; lifetime: string; slug: string }>): Promise<PageWithdrawal[][]> {
  if (!items.length) return [];
  const rows = await engine.executeRaw<PageWithdrawal & { idx: number }>(`SELECT x.idx, w.visibility, w.fact_hash, w.withdrawn_at, w.purged
    FROM jsonb_to_recordset($1::text::jsonb) AS x(idx integer, src text, lt text, sl text)
    CROSS JOIN LATERAL (
      SELECT visibility, fact_hash, min(withdrawn_at) AS withdrawn_at, false AS purged FROM fact_withdrawals
        WHERE source_id = x.src AND (subject = '*' OR subject = x.sl OR subject IN (SELECT p.slug FROM belief_page_lifetimes l JOIN pages p ON p.id = l.page_id
          WHERE l.page_lifetime = x.lt::uuid)) GROUP BY visibility, fact_hash
      UNION ALL
      SELECT visibility, fact_hash, min(purged_at), true FROM fact_purges
        WHERE source_id = x.src AND (subject = '*' OR subject = x.sl OR subject IN (SELECT p.slug FROM belief_page_lifetimes l JOIN pages p ON p.id = l.page_id
          WHERE l.page_lifetime = x.lt::uuid)) GROUP BY visibility, fact_hash) w
    ORDER BY x.idx, w.visibility, w.fact_hash, w.purged`, [JSON.stringify(items.map((x, idx) => ({ idx, src: x.sourceId, lt: x.lifetime, sl: x.slug })))]);
  const out = items.map(() => [] as PageWithdrawal[]);
  for (const r of rows) out[Number(r.idx)]!.push({ visibility: r.visibility, fact_hash: r.fact_hash, withdrawn_at: iso(r.withdrawn_at)!, ...(r.purged === true ? { purged: true } : {}) });
  return out;
}

interface Restricted { facts: Array<{ claim: string; visibility: 'private' | 'world' }>; takes: Set<string> }

/**
 * The fence subjects of each body a reader may not see now, under W4's rule (changes.ts subjectsOf): a subject whose
 * key a purge hid, for every caller; for a remote caller, a claim made private after the interval's event. One
 * fingerprint statement for the list and one ledger read per source.
 */
async function laterRestricted(engine: BrainEngine, items: ReadonlyArray<{ scope: HistoricalScope; text: string }>): Promise<Restricted[]> {
  const out: Restricted[] = items.map(() => ({ facts: [], takes: new Set<string>() }));
  const live = items.flatMap((x, i) => x.scope.restrict === false ? [] : [{ ...x, i }]);
  const claims = [...new Set(live.flatMap(x => bodyClaims(x.text)))];
  const fingerprints = new Map(claims.length ? (await engine.executeRaw<{ c: string; fp: string }>('SELECT c, gbrain_fact_fingerprint(c) AS fp FROM unnest($1::text[]) AS t(c)', [claims]))
    .map(r => [r.c, r.fp]) : []);
  const keyed: Array<(typeof live)[number] & { subjects: Awaited<ReturnType<typeof bodySubjects>>['subjects'] }> = [];
  for (const x of live) {
    const { subjects } = await bodySubjects(engine, x.scope.interval.lifetime, x.text, x.scope.interval.event.visibility, fingerprints);
    if (subjects.length) keyed.push({ ...x, subjects });
  }
  for (const group of groupBy(keyed, x => `${x.scope.sourceId}\u0000${x.scope.remote}`).values()) {
    const { sourceId, remote } = group[0]!.scope;
    const subjects = group.flatMap(x => x.subjects);
    const rows = await engine.executeRaw<{ id: number; subject_kind: string; subject_key: string | null; claim_fp: string | null }>(`SELECT e.id, e.subject_kind,
        CASE WHEN e.event_type = 'derived.hidden' THEN e.subject_key END AS subject_key, CASE WHEN e.event_type <> 'derived.hidden' THEN e.claim_fp END AS claim_fp
      FROM belief_events e WHERE e.source_id = $1 AND e.source_incarnation = (SELECT s.incarnation FROM sources s WHERE s.id = $1)
        AND (e.event_type = 'derived.hidden' AND e.subject_key = ANY($2::text[]) OR $4::boolean AND e.visibility = 'private' AND e.id > $3::bigint AND e.claim_fp = ANY($5::text[]))`,
    [sourceId, [...new Set(subjects.map(s => s.key))], Math.min(...group.map(x => x.scope.interval.event.id)), remote,
      [...new Set(subjects.map(s => s.claimFp).filter((fp): fp is string => typeof fp === 'string'))]]);
    const hidden = new Set(rows.filter(r => r.subject_key).map(r => `${r.subject_kind}\u0000${r.subject_key}`));
    for (const x of group) {
      const later = new Set(rows.filter(r => r.claim_fp && Number(r.id) > x.scope.interval.event.id).map(r => `${r.subject_kind}\u0000${r.claim_fp}`));
      for (const s of x.subjects) {
        if (!hidden.has(`${s.kind}\u0000${s.key}`) && !later.has(`${s.kind}\u0000${s.claimFp}`)) continue;
        if (s.kind === 'fact') out[x.i]!.facts.push({ claim: String(s.value.fact), visibility: s.visibility === 'private' ? 'private' : 'world' });
        else out[x.i]!.takes.add(s.key);
      }
    }
  }
  return out;
}

/** The fingerprint the withdrawal overlay looks a fence row up by (its normalized, lowered claim). */
const claimHash = (claim: string) => createHash('sha256').update(normalizeLoweredClaim(claim.toLowerCase().replace(/\s+/g, ' '))).digest('hex');

/**
 * The bodies at T a reader may see now: each T body with the withdrawal union applied, without fact rows a purge hid
 * and (for a remote caller) rows made private after T, through the projection the current gather renders for every
 * caller (sanitizeRemoteBody then credentialSafeProjection, page-window/document.ts boundedProjectedPrefix).
 */
async function historicalBodies(engine: BrainEngine, scopes: readonly HistoricalScope[]): Promise<Array<{ compiled_truth: string; timeline: string }>> {
  const raws: Array<{ compiled_truth: string; timeline: string }> = [];
  for (const scope of scopes) raws.push(await rawText(engine, scope));
  const restricted = await laterRestricted(engine, scopes.map((scope, i) => ({ scope, text: `${raws[i]!.compiled_truth}\n${raws[i]!.timeline}` })));
  const withdrawals = await withdrawalsFor(engine, scopes.map(s => ({ sourceId: s.sourceId, lifetime: s.interval.lifetime, slug: s.interval.slug })));
  const view = (t: string) => credentialSafeProjection(sanitizeRemoteBody(t));
  const out: Array<{ compiled_truth: string; timeline: string }> = [];
  for (const [i, scope] of scopes.entries()) {
    const dropped: PageWithdrawal[] = restricted[i]!.facts.map(f => ({ visibility: f.visibility, fact_hash: claimHash(f.claim), withdrawn_at: scope.at.toISOString(), purged: true }));
    const overlaid = await overlayCanonicalBodies(engine.executeRaw.bind(engine), raws[i]!.compiled_truth, raws[i]!.timeline, [...withdrawals[i]!, ...dropped]);
    out.push({ compiled_truth: view(overlaid.compiled_truth), timeline: view(overlaid.timeline) });
  }
  return out;
}

/** The body at T a reader may see now (`historicalBodies` for one scope). */
export async function historicalBody(engine: BrainEngine, scope: HistoricalScope): Promise<{ compiled_truth: string; timeline: string }> {
  return (await historicalBodies(engine, [scope]))[0]!;
}

/** The fence take rows of each body at T a reader may see now: active rows, none a purge hid, and for a remote caller only the holders it may read. */
async function historyTakeRowsOf(engine: BrainEngine, scopes: readonly HistoricalScope[]): Promise<FenceTake[][]> {
  const texts: string[] = [];
  for (const scope of scopes) { const raw = await rawText(engine, scope); texts.push(`${raw.compiled_truth}\n${raw.timeline}`); }
  const rows = scopes.map((s, i) => fenceTakeRows(s.interval.lifetime, texts[i]!));
  const open = scopes.flatMap((scope, i) => rows[i]!.length && !(scope.remote && scope.interval.event.visibility !== 'world') ? [i] : []);
  const restricted = await laterRestricted(engine, open.map(i => ({ scope: scopes[i]!, text: texts[i]! })));
  const out = scopes.map(() => [] as FenceTake[]);
  for (const [n, i] of open.entries()) {
    const scope = scopes[i]!;
    const holders = new Set(scope.holders ?? ['world']);
    out[i] = rows[i]!.filter(t => !restricted[n]!.takes.has(t.take_key) && (!scope.remote || holders.has(t.holder)));
  }
  return out;
}

/** The fence take rows of the body at T a reader may see now (`historyTakeRowsOf` for one scope). */
export async function historyTakeRows(engine: BrainEngine, scope: HistoricalScope & { body?: unknown }): Promise<FenceTake[]> {
  return (await historyTakeRowsOf(engine, [scope]))[0]!;
}

export interface HistoricalPage {
  source_id: string; slug: string; lifetime: string; revision: string | null; event_id: number; recorded_at: string; score: number; title: string | null; type: string | null;
  frontmatter: Record<string, unknown>; compiled_truth: string; timeline: string; page_id: number | null; trust_tier: TrustTier; content_date: string | null;
}
export interface HistoricalTake {
  source_id: string; page_slug: string; lifetime: string; take_key: string; holder: string; claim: string; kind: string; weight: number; row_num: number;
  since_date: string | null; score: number; trust_tier: TrustTier; revision: string | null;
}
export interface KnownAsOfBlock {
  at: string; certified: boolean; uncertified_reason: string | null; coverage_from: Record<string, string>; retrieval: 'lexical';
  disabled_branches: string[]; unproven_pages: number; bodies_unavailable: Record<string, number>;
}
export interface HistoricalResult { known_as_of: KnownAsOfBlock; pages: HistoricalPage[]; takes: HistoricalTake[] }
export interface HistoricalQuery { query: string; at: Date; sources: readonly string[]; remote: boolean; holders?: readonly string[]; limit: number; takesLimit?: number }

/**
 * Refusals before any work (section 5, step 1): a future instant; any source in scope the ledger does not cover at T
 * (the whole call refuses, naming it, so a partial answer never answers a different question); a restore gap; T before
 * a source's history index cut (`coverage_from` with reason `history_index_incomplete`).
 */
export async function assertHistoricalCoverage(engine: BrainEngine, sources: readonly string[], at: Date): Promise<Pick<KnownAsOfBlock, 'certified' | 'uncertified_reason' | 'coverage_from'>> {
  const [{ now }] = await engine.executeRaw<{ now: string }>('SELECT clock_timestamp() AS now');
  if (at.getTime() > Date.parse(iso(now)!)) {
    throw opError('invalid_params', `known_as_of ${at.toISOString()} is in the future.`, 'Pass an instant at or before now; omit known_as_of for the current evidence.');
  }
  const status = (id: string) => readFix('Lists the coverage intervals, watermark and restore gaps the read is checked against.', { argv: ['gbrain', 'beliefs', 'status', '--source', id, '--json'] });
  let certified = true;
  let reason: string | null = null;
  const coverageFrom: Record<string, string> = {};
  for (const sourceId of sources) {
    const c = await coverageAt(engine, sourceId, at);
    if (!c.ok) {
      const narrow = sources.length > 1 ? ` Narrow source_id to sources the ledger covered then (the call reads ${sources.length} sources).` : '';
      if (c.code === 'coverage_gap') throw opError('coverage_gap', c.message, `Ask about an instant before ${c.from ?? 'the gap'} or after ${c.until ?? 'it'}.${narrow}`, { reason: c.reason, fix: status(sourceId) });
      throw opError('coverage_from', `${c.message} Source ${sourceId} is not covered at ${at.toISOString()}.`,
        `Recorded history of ${sourceId} starts ${c.from ?? 'once the ledger is enabled on it'}; ask about an instant at or after it.${narrow}`, { reason: 'not_recorded', fix: status(sourceId) });
    }
    const state = await historyIndexState(engine, sourceId);
    if (!state.index_cut || at.getTime() < Date.parse(state.index_cut)) {
      throw opError('coverage_from', `The history text index of ${sourceId} covers ${state.index_cut ? `only from ${state.index_cut}` : 'no instant yet: its build has not finished its first pass'}.`,
        `Ask about an instant at or after the index cut, or have the operator build the index (preview first, then --apply).${sources.length > 1 ? ' Or narrow source_id.' : ''}`,
        { reason: 'history_index_incomplete', fix: readFix('Previews the history text index build: the intervals and bytes it would index.', { argv: ['gbrain', 'beliefs', 'history-index', '--source', sourceId, '--json'] }) });
    }
    coverageFrom[sourceId] = c.cut;
    if (!c.certified) { certified = false; reason ??= c.uncertified_reason; }
  }
  return { certified, uncertified_reason: certified ? null : reason, coverage_from: coverageFrom };
}

interface CandidateRow { id: number; source_id: string; lifetime: string; revision: string; title: string | null; opening_event: number; chunk_score: number; title_hit: boolean; rank_key: string }
interface TakeCandidate { source_id: string; lifetime: string; opening_event: number; revision: string; take_key: string; holder: string; chunk_score: number; score_key: string;
  revision_row: number; ord: number }

const liveAt = (alias: string, sources = '$2', at = '$3') => `${alias}.source_id = ANY(${sources}::text[]) AND ${alias}.known_from <= ${at}::timestamptz
  AND (${alias}.known_until IS NULL OR ${alias}.known_until > ${at}::timestamptz)
  AND NOT ${alias}.stale AND NOT ${alias}.segmented AND EXISTS (SELECT 1 FROM sources s WHERE s.id = ${alias}.source_id AND s.incarnation = ${alias}.source_incarnation)`;
const remoteNow = (alias: string) => `AND ${alias}.visibility = 'world' AND EXISTS (SELECT 1 FROM belief_page_lifetimes l JOIN pages p ON p.id = l.page_id
  WHERE l.page_lifetime = ${alias}.page_lifetime AND p.deleted_at IS NULL AND ${privatePagesFilterFragment('p')})`;

/**
 * The next `n` page candidates in index order (index score, then source and lifetime in byte order, then index row),
 * after the keyset `after` (the last row of the previous batch): each batch reads only rows below the previous one,
 * so no batch re-reads or re-sorts rows a previous batch already returned. The rank travels as Postgres's exact text
 * form of the float, so the keyset comparison is exact.
 */
async function pageCandidates(engine: BrainEngine, q: HistoricalQuery, after: CandidateRow | null, n: number): Promise<CandidateRow[]> {
  if (mutant === 'current_candidates') {
    const rows = await engine.executeRaw<CandidateRow>(`-- chunk-visibility-ok: test-only mutant (b), never reached outside __setHistoricalMutantForTests
      WITH q AS (SELECT ${tsquerySql('$1')} AS q)
      SELECT r.id, r.source_id, r.page_lifetime::text AS lifetime, r.revision::text AS revision, r.title, r.opening_event,
        max(ts_rank_cd(c.search_vector, q.q))::float8 AS chunk_score, (to_tsvector('english', gbrain_fts_input(COALESCE(r.title, ''))) @@ q.q) AS title_hit
      FROM q JOIN content_chunks c ON c.search_vector @@ q.q JOIN pages p ON p.id = c.page_id
      JOIN belief_page_lifetimes l ON l.page_id = p.id AND l.ended_at IS NULL
      JOIN belief_text_revisions r ON r.page_lifetime = l.page_lifetime AND ${liveAt('r')}
      GROUP BY r.id, q.q ORDER BY chunk_score DESC, r.page_lifetime LIMIT $4`, [q.query, [...q.sources], q.at.toISOString(), n]);
    return rows;
  }
  return engine.executeRaw<CandidateRow>(`WITH q AS (SELECT ${tsquerySql('$1')} AS q),
    cand AS (SELECT r.id, r.source_id, r.page_lifetime::text AS lifetime, r.revision::text AS revision, r.title, r.opening_event,
        max(ts_rank_cd(c.search_vector, q.q))::float8 AS chunk_score
      FROM q JOIN belief_text_chunks c ON c.search_vector @@ q.q
      JOIN belief_text_revision_chunks m ON m.text_hash = c.text_hash AND m.kind = 'body'
      JOIN belief_text_revisions r ON r.id = m.revision_row
      WHERE ${liveAt('r')} ${q.remote ? remoteNow('r') : ''}
      GROUP BY r.id, r.source_id, r.page_lifetime, r.revision, r.title, r.opening_event),
    hit AS (SELECT cand.*, (to_tsvector('english', gbrain_fts_input(COALESCE(cand.title, ''))) @@ q.q) AS title_hit FROM cand, q),
    ranked AS (SELECT hit.*, hit.chunk_score + CASE WHEN hit.title_hit THEN $5::float8 ELSE 0 END AS rank FROM hit)
    SELECT ranked.id, ranked.source_id, ranked.lifetime, ranked.revision, ranked.title, ranked.opening_event, ranked.chunk_score, ranked.title_hit, ranked.rank::text AS rank_key
    FROM ranked
    WHERE $6::text IS NULL OR ranked.rank < $6::text::float8 OR ranked.rank = $6::text::float8 AND (ranked.source_id COLLATE "C" > $7::text COLLATE "C"
      OR ranked.source_id = $7::text AND (ranked.lifetime COLLATE "C" > $8::text COLLATE "C" OR ranked.lifetime = $8::text AND ranked.id > $9::bigint))
    ORDER BY ranked.rank DESC, ranked.source_id COLLATE "C", ranked.lifetime COLLATE "C", ranked.id
    LIMIT $4`, [q.query, [...q.sources], q.at.toISOString(), n, HISTORY_TITLE_BONUS, after?.rank_key ?? null, after?.source_id ?? null, after?.lifetime ?? null, after?.id ?? null]);
}

/** The next `n` take candidates in index order after the keyset `after` (the last row of the previous batch), as `pageCandidates` pages. */
async function takeCandidates(engine: BrainEngine, q: HistoricalQuery, after: TakeCandidate | null, n: number): Promise<TakeCandidate[]> {
  return engine.executeRaw<TakeCandidate>(`WITH q AS (SELECT ${tsquerySql('$1')} AS q),
    cand AS (SELECT r.source_id, r.page_lifetime, r.opening_event, r.revision::text AS revision, m.take_key, m.holder, m.revision_row, m.ord,
        ts_rank_cd(c.search_vector, q.q)::float8 AS chunk_score
      FROM q JOIN belief_text_chunks c ON c.search_vector @@ q.q
      JOIN belief_text_revision_chunks m ON m.text_hash = c.text_hash AND m.kind = 'take'
      JOIN belief_text_revisions r ON r.id = m.revision_row
      WHERE ${liveAt('r')} ${q.remote ? `${remoteNow('r')} AND m.holder = ANY($11::text[])` : ''})
    SELECT cand.source_id, cand.page_lifetime::text AS lifetime, cand.opening_event, cand.revision, cand.take_key, cand.holder, cand.revision_row, cand.ord,
      cand.chunk_score, cand.chunk_score::text AS score_key
    FROM cand
    WHERE $5::text IS NULL OR cand.chunk_score < $5::text::float8 OR cand.chunk_score = $5::text::float8 AND (cand.source_id COLLATE "C" > $6::text COLLATE "C"
      OR cand.source_id = $6::text AND (cand.page_lifetime > $7::text::uuid OR cand.page_lifetime = $7::text::uuid AND (cand.take_key COLLATE "C" > $8::text COLLATE "C"
        OR cand.take_key = $8::text AND (cand.revision_row > $9::bigint OR cand.revision_row = $9::bigint AND cand.ord > $10::integer))))
    ORDER BY cand.chunk_score DESC, cand.source_id COLLATE "C", cand.page_lifetime, cand.take_key COLLATE "C", cand.revision_row, cand.ord
    LIMIT $4`, [q.query, [...q.sources], q.at.toISOString(), n, after?.score_key ?? null, after?.source_id ?? null, after?.lifetime ?? null, after?.take_key ?? null,
    after?.revision_row ?? null, after?.ord ?? null, ...(q.remote ? [[...(q.holders ?? ['world'])]] : [])]);
}

/** Trust at T, restricted by now: the lower of the tier on the page's newest event at or before T and its tier now. */
async function trustAt(engine: BrainEngine, at: Date, lifetimes: readonly string[]): Promise<Map<string, TrustTier>> {
  if (!lifetimes.length) return new Map();
  const rows = await engine.executeRaw<{ lifetime: string; then: string | null; now: string | null }>(`SELECT x.l AS lifetime,
      (SELECT e.trust_tier FROM belief_events e WHERE e.page_lifetime = x.l::uuid AND e.subject_kind = 'page' AND e.recorded_at <= $2::timestamptz AND e.origin <> 'backfill'
        ORDER BY e.id DESC LIMIT 1) AS then,
      (SELECT p.trust_tier FROM belief_page_lifetimes l JOIN pages p ON p.id = l.page_id WHERE l.page_lifetime = x.l::uuid) AS now
    FROM unnest($1::text[]) AS x(l)`, [[...lifetimes], at.toISOString()]);
  const tier = (v: string | null): TrustTier => v && isTrustTier(v) ? v : 'unknown';
  return new Map(rows.map(r => [r.lifetime, r.now == null ? tier(r.then) : minTrust(tier(r.then), tier(r.now))]));
}

interface Confirmed { state: LifetimeAtTime; interval: PageInterval; sourceId: string }

/** Page-at-time for candidate lifetimes, memoized per call; counts what it drops. */
function confirmer(engine: BrainEngine, q: HistoricalQuery, block: Pick<KnownAsOfBlock, 'unproven_pages' | 'bodies_unavailable'>) {
  const states = new Map<string, LifetimeAtTime>();
  const counted = new Set<string>();
  const count = (lifetime: string, f: () => void) => { if (!counted.has(lifetime)) { counted.add(lifetime); f(); } };
  return async (rows: ReadonlyArray<{ source_id: string; lifetime: string; opening_event: number }>): Promise<Map<string, Confirmed | null>> => {
    for (const [sourceId, list] of groupBy(rows.filter(r => !states.has(r.lifetime)), r => r.source_id)) {
      for (const [l, s] of await readPagesAtTime(engine, { sourceId, at: q.at, lifetimes: [...new Set(list.map(r => r.lifetime))] })) states.set(l, s);
    }
    const out = new Map<string, Confirmed | null>();
    for (const r of rows) {
      const s = states.get(r.lifetime);
      const i = s?.current;
      let ok: Confirmed | null = null;
      if (s?.unproven) count(r.lifetime, () => block.unproven_pages++);
      else if (s && i && !i.deleted && s.content_event === Number(r.opening_event)) {
        if (i.body === 'unavailable' || i.body === 'segmented' || !i.page) count(r.lifetime, () => { const k = i.body === 'segmented' ? 'segmented' : i.body_reason ?? 'unavailable'; block.bodies_unavailable[k] = (block.bodies_unavailable[k] ?? 0) + 1; });
        else ok = { state: s, interval: i, sourceId: r.source_id };
      }
      out.set(`${r.lifetime}\u0000${r.opening_event}`, ok);
    }
    return out;
  };
}

function groupBy<T>(list: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const t of list) out.set(key(t), [...out.get(key(t)) ?? [], t]);
  return out;
}

/** The scope a confirmed interval is read under, with the test seam's mutants. */
const scopeOf = (q: HistoricalQuery, c: Confirmed): HistoricalScope => ({ sourceId: c.sourceId, interval: c.interval, at: q.at, remote: q.remote, holders: q.holders,
  current: mutant === 'current_text', restrict: mutant !== 'no_later_private_restriction' });

/** For a remote caller, whether each confirmed interval may be read now (page-at-time's remoteMayRead, one statement for the list). */
async function remoteReadable(engine: BrainEngine, list: readonly Confirmed[]): Promise<boolean[]> {
  const world = (c: Confirmed) => c.state.page_id != null && c.interval.event.visibility === 'world';
  const ids = [...new Set(list.filter(world).map(c => Number(c.state.page_id)))];
  const rows = ids.length ? await engine.executeRaw<{ id: number; visible: boolean }>(`SELECT p.id, ${privatePagesFilterFragment('p')} AS visible FROM pages p
    WHERE p.id = ANY($1::bigint[]) AND p.deleted_at IS NULL`, [ids]) : [];
  const visible = new Set(rows.filter(r => r.visible === true).map(r => Number(r.id)));
  return list.map(c => world(c) && visible.has(Number(c.state.page_id)));
}

/** Confirmed pages as evidence: each body at T as the reader may see it now, trust at T and the content date of its revision, read for the whole list at once. */
async function hydratePages(engine: BrainEngine, q: HistoricalQuery, list: ReadonlyArray<{ c: Confirmed; score: number; body?: { compiled_truth: string; timeline: string } }>): Promise<HistoricalPage[]> {
  if (!list.length) return [];
  const unread = list.flatMap((x, i) => x.body ? [] : [i]);
  const read = await historicalBodies(engine, unread.map(i => scopeOf(q, list[i]!.c)));
  const bodies = list.map(x => x.body);
  for (const [n, i] of unread.entries()) bodies[i] = read[n];
  const events = [...new Set(list.map(x => x.c.state.content_event).filter(e => e != null).map(Number))];
  const dates = new Map((events.length ? await engine.executeRaw<{ opening_event: number; content_date: string | null }>(`SELECT opening_event, content_date::text AS content_date
    FROM belief_text_revisions WHERE opening_event = ANY($1::bigint[])`, [events]) : []).map(r => [Number(r.opening_event), r.content_date]));
  const trust = await trustAt(engine, q.at, [...new Set(list.map(x => x.c.interval.lifetime))]);
  return list.map(({ c, score }, i) => ({ source_id: c.sourceId, slug: c.interval.slug, lifetime: c.interval.lifetime, revision: c.interval.revision, event_id: c.interval.event.id,
    recorded_at: c.interval.event.recorded_at, score, title: c.interval.page!.title, type: c.interval.page!.type, frontmatter: c.interval.page!.frontmatter,
    compiled_truth: bodies[i]!.compiled_truth, timeline: bodies[i]!.timeline, page_id: c.state.page_id, trust_tier: trust.get(c.interval.lifetime) ?? 'unknown',
    content_date: c.state.content_event == null ? null : dates.get(Number(c.state.content_event)) ?? null }));
}

/**
 * The retriever (section 5, steps 2 to 6): pages and takes as recorded at T, ranked by the scorer on the text each
 * reader may see now. Candidates come in index order a batch at a time (keyset pages, so no batch re-reads an earlier
 * one), and each batch's reads (page at T, body, score, content date, trust) run as one statement each for the batch.
 * Truncation happens only after the exact check; index scores are upper bounds after a restriction, so fetching stops
 * only when the Kth final score is above the next unfetched index score.
 */
export async function readHistoricalCandidates(engine: BrainEngine, q: HistoricalQuery): Promise<HistoricalResult> {
  const coverage = await assertHistoricalCoverage(engine, q.sources, q.at);
  const block: KnownAsOfBlock = { at: q.at.toISOString(), ...coverage, retrieval: 'lexical', disabled_branches: [...DISABLED_BRANCHES], unproven_pages: 0, bodies_unavailable: {} };
  const confirm = confirmer(engine, q, block);
  const batch = Math.max(2 * q.limit, 10);
  const candidateKey = (r: { lifetime: string; opening_event: number }) => `${r.lifetime}\u0000${r.opening_event}`;

  const pages: HistoricalPage[] = [];
  for (let after: CandidateRow | null = null; ;) {
    const truncated = mutant === 'truncate_before_exact' || mutant === 'current_candidates';
    const rows = await pageCandidates(engine, q, after, truncated ? q.limit : batch);
    const confirmed = await confirm(rows);
    let open = rows.flatMap(r => { const c = confirmed.get(candidateKey(r)); return c && !pages.some(p => p.lifetime === r.lifetime) ? [{ r, c }] : []; });
    if (q.remote) { const ok = await remoteReadable(engine, open.map(x => x.c)); open = open.filter((_, i) => ok[i]); }
    const bodies = await historicalBodies(engine, open.map(x => scopeOf(q, x.c)));
    const scores = await historicalScore(engine, q.query, open.map((x, i) => ({ key: String(i), title: x.c.interval.page!.title,
      chunks: historyBodyChunks(bodies[i]!.compiled_truth, bodies[i]!.timeline) })));
    const scored = open.flatMap((x, i) => { const score = scores.get(String(i)); return score == null ? [] : [{ c: x.c, score, body: bodies[i]! }]; });
    pages.push(...await hydratePages(engine, q, scored.filter((x, i) => !scored.slice(0, i).some(y => y.c.interval.lifetime === x.c.interval.lifetime))));
    pages.sort((a, b) => b.score - a.score || byText(a.source_id, b.source_id) || byText(a.lifetime, b.lifetime));
    if (truncated || rows.length < batch) break;
    const last = rows.at(-1)!;
    if (pages.length >= q.limit && pages[q.limit - 1]!.score > Number(last.chunk_score) + (last.title_hit ? HISTORY_TITLE_BONUS : 0)) break;
    after = last;
  }
  pages.splice(q.limit);

  const takesLimit = q.takesLimit ?? q.limit;
  const takes: HistoricalTake[] = [];
  for (let after: TakeCandidate | null = null; ;) {
    const rows = await takeCandidates(engine, q, after, batch);
    const confirmed = await confirm(rows);
    let open = rows.flatMap(r => { const c = confirmed.get(candidateKey(r)); return c && !takes.some(t => t.lifetime === r.lifetime && t.take_key === r.take_key) ? [{ r, c }] : []; });
    if (q.remote) { const ok = await remoteReadable(engine, open.map(x => x.c)); open = open.filter((_, i) => ok[i]); }
    const fence = await historyTakeRowsOf(engine, open.map(x => scopeOf(q, x.c)));
    const found = open.flatMap((x, i) => { const row = fence[i]!.find(t => t.take_key === x.r.take_key); return row ? [{ ...x, row }] : []; });
    const scores = await historicalScore(engine, q.query, found.map((x, i) => ({ key: String(i), title: null, chunks: [x.row.claim] })));
    const scored = found.flatMap((x, i) => { const score = scores.get(String(i)); return score == null ? [] : [{ ...x, score }]; });
    const trust = await trustAt(engine, q.at, [...new Set(scored.map(x => x.r.lifetime))]);
    for (const [i, { r, c, row, score }] of scored.entries()) {
      if (scored.slice(0, i).some(y => y.r.lifetime === r.lifetime && y.r.take_key === r.take_key)) continue;
      takes.push({ source_id: c.sourceId, page_slug: c.interval.slug, lifetime: r.lifetime, take_key: r.take_key, holder: row.holder, claim: row.claim, kind: row.kind,
        weight: row.weight, row_num: row.row_num, since_date: row.since_date, score, trust_tier: trust.get(r.lifetime) ?? 'unknown', revision: c.interval.revision });
    }
    takes.sort((a, b) => b.score - a.score || byText(`${a.lifetime}\u0000${a.take_key}`, `${b.lifetime}\u0000${b.take_key}`));
    if (rows.length < batch) break;
    if (takes.length >= takesLimit && takes[takesLimit - 1]!.score > Number(rows.at(-1)!.chunk_score)) break;
    after = rows.at(-1)!;
  }
  takes.splice(takesLimit);
  return { known_as_of: block, pages, takes };
}

/** Confirms and hydrates pinned candidates (alias, anchor, window floor), skipping lifetimes already in `have` and those a remote caller may not read. */
async function hydrateExtra(engine: BrainEngine, q: HistoricalQuery, block: KnownAsOfBlock, rows: ReadonlyArray<{ source_id: string; lifetime: string; opening_event: number }>,
  have: readonly HistoricalPage[]): Promise<HistoricalPage[]> {
  if (!rows.length) return [];
  const confirmed = await confirmer(engine, q, block)(rows);
  let open = rows.flatMap(r => { const c = confirmed.get(`${r.lifetime}\u0000${r.opening_event}`); return c ? [c] : []; });
  if (q.remote) { const ok = await remoteReadable(engine, open); open = open.filter((_, i) => ok[i]); }
  const picked = open.filter((c, i) => !open.slice(0, i).some(x => x.interval.lifetime === c.interval.lifetime));
  const need = picked.filter(c => !have.some(p => p.lifetime === c.interval.lifetime));
  const hydrated = await hydratePages(engine, q, need.map(c => ({ c, score: 0 })));
  return picked.map(c => have.find(p => p.lifetime === c.interval.lifetime) ?? hydrated[need.indexOf(c)]!);
}

/** Branch 8, T-bounded: the lifetimes whose declared aliases at T include the whole query (normalized). The mutant reads today's aliases instead. */
async function aliasLifetimesAt(engine: BrainEngine, q: HistoricalQuery, text: string): Promise<Array<{ source_id: string; lifetime: string; opening_event: number }>> {
  const alias = normalizeAlias(text);
  if (!alias) return [];
  if (mutant === 'current_aliases') {
    return engine.executeRaw(`SELECT r.source_id, r.page_lifetime::text AS lifetime, r.opening_event FROM page_aliases a JOIN pages p ON p.source_id = a.source_id AND p.slug = a.slug
      JOIN belief_page_lifetimes l ON l.page_id = p.id AND l.ended_at IS NULL JOIN belief_text_revisions r ON r.page_lifetime = l.page_lifetime AND ${liveAt('r')}
      WHERE a.alias_norm = $1 ORDER BY r.source_id COLLATE "C", r.page_lifetime LIMIT 3`, [alias, [...q.sources], q.at.toISOString()]);
  }
  return engine.executeRaw(`SELECT r.source_id, r.page_lifetime::text AS lifetime, r.opening_event FROM belief_text_revisions r
    WHERE r.aliases @> ARRAY[$1::text] AND ${liveAt('r')} ${q.remote ? remoteNow('r') : ''}
    ORDER BY r.source_id COLLATE "C", r.page_lifetime LIMIT 3`, [alias, [...q.sources], q.at.toISOString()]);
}

/**
 * The evidence think and `search {known_as_of}` read: the retriever's pages, with an exact alias match of the whole
 * query at T first (branch 8). No boost, cache or current-state branch runs (section 6).
 */
export async function historicalEvidence(engine: BrainEngine, q: HistoricalQuery): Promise<HistoricalResult> {
  const result = await readHistoricalCandidates(engine, q);
  const extra = await aliasLifetimesAt(engine, q, q.query);
  if (mutant === 'semantic_cache') {
    for (const sourceId of q.sources) {
      const [row] = await engine.executeRaw<{ results: unknown }>('SELECT results FROM query_cache WHERE id = $1', [cacheRowId(q.query, sourceId)]);
      for (const hit of (json(row?.results) as Array<{ slug: string }> | undefined) ?? []) {
        extra.push(...await engine.executeRaw<{ source_id: string; lifetime: string; opening_event: number }>(`SELECT r.source_id, r.page_lifetime::text AS lifetime, r.opening_event
          FROM belief_text_revisions r WHERE r.page_lifetime = (SELECT page_lifetime FROM belief_events WHERE source_id = $4 AND slug = $1 AND page_lifetime IS NOT NULL ORDER BY id DESC LIMIT 1)
            AND ${liveAt('r')}`, [hit.slug, [sourceId], q.at.toISOString(), sourceId]));
      }
    }
  }
  const pinned = await hydrateExtra(engine, q, result.known_as_of, extra, result.pages);
  let pages = [...pinned, ...result.pages.filter(p => !pinned.some(x => x.lifetime === p.lifetime))].slice(0, q.limit);
  if (mutant === 'backlink_boost') {
    const counts = await engine.executeRaw<{ page_id: number; n: number }>('SELECT to_page_id AS page_id, count(*)::int AS n FROM links WHERE to_page_id = ANY($1::int[]) GROUP BY to_page_id',
      [pages.map(p => p.page_id).filter((v): v is number => v != null)]);
    const boost = (p: HistoricalPage) => p.score + 0.05 * (counts.find(c => Number(c.page_id) === p.page_id)?.n ?? 0);
    pages = [...pages].sort((a, b) => boost(b) - boost(a));
  }
  return { ...result, pages };
}

/**
 * Branch 14: the anchor as recorded at T. Its slug at T first, then the page at that slug today read at T (a later
 * rename), then its aliases at T. A transition of the anchor that straddles T refuses `known_as_of_unproven`.
 */
export async function anchorAtTime(engine: BrainEngine, q: HistoricalQuery, block: KnownAsOfBlock, anchor: string): Promise<HistoricalPage | null> {
  for (const sourceId of q.sources) {
    const read = await readPageAtTime(engine, { sourceId, slug: anchor, at: q.at });
    const lifetime = read.current && !read.current.deleted ? read.current.lifetime : null;
    const [today] = lifetime ? [] : await engine.executeRaw<{ lifetime: string }>(`SELECT l.page_lifetime::text AS lifetime FROM pages p
      JOIN belief_page_lifetimes l ON l.page_id = p.id AND l.ended_at IS NULL WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL`, [sourceId, anchor]);
    const target = lifetime ?? today?.lifetime;
    if (!target) continue;
    const state = (await readPagesAtTime(engine, { sourceId, at: q.at, lifetimes: [target], withBodies: false })).get(target);
    if (state?.unproven) {
      throw opError('known_as_of_unproven', `A change to ${anchor} was not yet proven committed at ${q.at.toISOString()}.`,
        'The write was in flight at that instant, so the anchor then cannot be stated either way. Ask about an instant before it, or after the write was observed committed.', { retryable: true });
    }
    if (!state?.current || state.current.deleted || state.content_event == null) continue;
    const [page] = await hydrateExtra(engine, q, block, [{ source_id: sourceId, lifetime: target, opening_event: state.content_event }], []);
    if (page) return page;
  }
  const [page] = await hydrateExtra(engine, q, block, await aliasLifetimesAt(engine, q, anchor), []);
  return page ?? null;
}

/** Branch 4's floor: up to `limit` revisions live at T whose content date falls in the window, newest first. */
export async function windowFloorAt(engine: BrainEngine, q: HistoricalQuery, block: KnownAsOfBlock, window: { after: string | null; before: string | null }, limit = 50): Promise<HistoricalPage[]> {
  const rows = await engine.executeRaw<{ source_id: string; lifetime: string; opening_event: number }>(`SELECT r.source_id, r.page_lifetime::text AS lifetime, r.opening_event
    FROM belief_text_revisions r WHERE ${liveAt('r', '$1', '$2')} ${q.remote ? remoteNow('r') : ''} AND r.content_date IS NOT NULL
      AND ($3::date IS NULL OR r.content_date >= $3::date) AND ($4::date IS NULL OR r.content_date <= $4::date)
    ORDER BY r.content_date DESC, r.source_id COLLATE "C", r.page_lifetime LIMIT $5`, [[...q.sources], q.at.toISOString(), window.after, window.before, limit]);
  return hydrateExtra(engine, q, block, rows, []);
}
