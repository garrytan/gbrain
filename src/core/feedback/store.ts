/**
 * Storage for use-attributed retrieval feedback (migration v207): every read and
 * write of retrieval_events / retrieval_event_pages / retrieval_event_links /
 * retrieval_feedback / retrieval_weights. The event log, its read and a rating
 * batch are typed engine members (engine-sql/retrieval-feedback.ts), which a
 * Rust brain serves; the rest run through `engine.executeRaw` with positional
 * binds (no JSONB).
 */
import type { BrainEngine } from '../engine.ts';
import type { FeedbackStatusRow } from '../engine-sql/doctor-acc.ts';
import type { EvalCandidateInput } from '../types.ts';

export type FeedbackOp = 'query' | 'search' | 'think' | 'synthesize' | 'recall';
export type FeedbackSignal = 'explicit' | 'cited';
export type ElementKind = 'page' | 'link';

export const NEUTRAL_WEIGHT = 0.5;

export interface EventPage {
  source_id: string;
  slug: string;
  content_hash: string | null;
  rank: number;
  cited: boolean;
}

export interface EventLink {
  source_id: string;
  edge_key: string;
  to_slug: string;
}

export interface RetrievalEventInput {
  id: string;
  client_id: string;
  op: FeedbackOp;
  pages: EventPage[];
  links: EventLink[];
}

export interface StoredEvent {
  id: string;
  client_id: string;
  op: FeedbackOp;
  created_at: Date;
  pages: EventPage[];
  links: EventLink[];
}

export interface RatingTarget {
  kind: ElementKind;
  source_id: string;
  key: string;
  rating: number;
  content_hash: string | null;
}

export interface AppliedRating {
  kind: ElementKind;
  source_id: string;
  key: string;
  rating: number;
  weight_before: number;
  weight_after: number;
  newly_applied: boolean;
}


export async function insertRetrievalEvents(engine: BrainEngine, events: RetrievalEventInput[]): Promise<void> {
  if (events.length === 0) return;
  // engine-sql/retrieval-feedback.ts: the event rows, then the pages and links whose page rows exist (FOR KEY SHARE).
  await engine.insertRetrievalEvents(events);
}

export async function getRetrievalEvent(engine: BrainEngine, id: string): Promise<StoredEvent | null> {
  const row = await engine.readRetrievalEvent(id);
  if (!row) return null;
  return {
    id: row.id,
    client_id: row.client_id,
    op: row.op as FeedbackOp,
    created_at: new Date(row.created_at),
    pages: row.pages.map(p => ({ ...p, rank: Number(p.rank) })),
    links: row.links,
  };
}

/** Current content_hash of each (source_id, slug); missing or deleted pages are absent. */
export async function currentPageHashes(
  engine: BrainEngine,
  refs: Array<{ source_id: string; slug: string }>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (refs.length === 0) return out;
  const rows = await engine.executeRaw<{ source_id: string; slug: string; content_hash: string | null }>(
    `SELECT p.source_id, p.slug, p.content_hash
       FROM pages p
       JOIN unnest($1::text[], $2::text[]) AS r(source_id, slug) ON p.source_id = r.source_id AND p.slug = r.slug
      WHERE p.deleted_at IS NULL`,
    [refs.map(r => r.source_id), refs.map(r => r.slug)],
  );
  for (const r of rows) out.set(`${r.source_id}:${r.slug}`, r.content_hash);
  return out;
}

/**
 * Apply one batch of ratings atomically. Each element's feedback row is
 * inserted first (idempotent on the primary key); only newly inserted rows
 * move the weight, inside the same statement, so concurrent raters are
 * ordered by the weight row's lock and a retry never compounds.
 */
export async function applyRatings(
  engine: BrainEngine,
  args: { eventId: string; clientId: string; signal: FeedbackSignal; alpha: number; targets: RatingTarget[] },
): Promise<AppliedRating[]> {
  const { eventId, clientId, signal, alpha } = args;
  const seen = new Set<string>();
  const targets = args.targets.filter(t => {
    const id = `${t.kind}|${t.source_id}|${t.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (targets.length === 0) return [];
  // engine-sql/retrieval-feedback.ts: one statement stores each new rating and moves its weight, a second reads the batch back.
  return (await engine.applyRetrievalRatings({
    eventId, clientId, signal, alpha,
    targets: targets.map(t => ({ kind: t.kind, source_id: t.source_id, key: t.key, rating: t.rating, content_hash: t.content_hash })),
  })).map(r => ({ ...r, kind: r.kind as ElementKind }));
}

/**
 * Learned weights for the given elements. A page edited since its weight was
 * learned reads at half its learned deviation from neutral; missing rows are
 * absent (callers treat them as neutral).
 */
export async function readWeights(
  engine: BrainEngine,
  kind: ElementKind,
  refs: Array<{ source_id: string; key: string }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (refs.length === 0) return out;
  const pageJoin = kind === 'page'
    ? `LEFT JOIN pages p ON p.source_id = w.source_id AND p.slug = w.element_key AND p.deleted_at IS NULL`
    : '';
  const effective = kind === 'page'
    ? `CASE WHEN p.content_hash IS DISTINCT FROM w.content_hash
            THEN ${NEUTRAL_WEIGHT} + (w.weight - ${NEUTRAL_WEIGHT}) / 2 ELSE w.weight END`
    : 'w.weight';
  const rows = await engine.executeRaw<{ source_id: string; element_key: string; weight: number | string }>(
    `SELECT w.source_id, w.element_key, ${effective} AS weight
       FROM retrieval_weights w
       JOIN unnest($2::text[], $3::text[]) AS r(source_id, element_key)
         ON w.source_id = r.source_id AND w.element_key = r.element_key
       ${pageJoin}
      WHERE w.element_kind = $1`,
    [kind, refs.map(r => r.source_id), refs.map(r => r.key)],
  );
  for (const r of rows) out.set(`${r.source_id}:${r.element_key}`, Number(r.weight));
  return out;
}

export async function countRecentRatingCalls(engine: BrainEngine, clientId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `SELECT count(DISTINCT (event_id, applied_at))::int AS n
       FROM retrieval_feedback
      WHERE client_id = $1 AND signal = 'explicit' AND applied_at > now() - interval '1 hour'`,
    [clientId],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function pruneRetrievalFeedback(engine: BrainEngine, retentionDays: number): Promise<{ events: number; weights: number }> {
  const events = await engine.executeRaw<{ n: number | string }>(
    `WITH d AS (DELETE FROM retrieval_events WHERE created_at < now() - ($1::int * interval '1 day') RETURNING 1)
     SELECT count(*)::int AS n FROM d`,
    [retentionDays],
  );
  const weights = await engine.executeRaw<{ n: number | string }>(
    `WITH d AS (
       DELETE FROM retrieval_weights w
        WHERE (w.element_kind = 'page' AND NOT EXISTS (
                 SELECT 1 FROM pages p WHERE p.source_id = w.source_id AND p.slug = w.element_key))
           OR (w.element_kind = 'link' AND NOT EXISTS (
                 SELECT 1 FROM links l
                   JOIN pages fp ON fp.id = l.from_page_id
                   JOIN pages tp ON tp.id = l.to_page_id
                  WHERE fp.source_id = w.source_id
                    AND fp.slug || '|' || l.link_type || '|' || tp.slug = w.element_key))
       RETURNING 1)
     SELECT count(*)::int AS n FROM d`,
  );
  return { events: Number(events[0]?.n ?? 0), weights: Number(weights[0]?.n ?? 0) };
}

/**
 * #8821: a hard-deleted page's slug leaves its source's retrieval logs, ratings and weights (as a page key or either
 * end of a `from|type|to` edge key) and the captured eval candidates whose results came from that source. Runs inside
 * the purge's transaction; returns rows touched per store, keyed as the purge receipt names them.
 */
export async function scrubPurgedSlugs(
  engine: Pick<BrainEngine, 'deletePurgedFeedbackRows'>,
  sourceId: string,
  slugs: readonly string[],
): Promise<Record<string, number>> {
  if (!slugs.length) return {};
  // A captured slug is the purged page's unless another source the candidate covers still has a page by that name (engine-sql/purge-stores.ts).
  return { ...await engine.deletePurgedFeedbackRows(sourceId, slugs) };
}

/**
 * #9068: insert one captured eval candidate with only the slugs a page of its sources (any source when it names none)
 * still holds, in retrieval order. Each probe takes the feedback writers' key-share lock on the page row, so a capture
 * deferred past its query's response either commits before a purge takes the row, and the purge's scrub strips it, or
 * waits for the purge and drops the slug. A facts-arm result (`facts/<id>`, facts-arm.ts) names a fact, not a page:
 * it stays while that fact row does. Both engines run this statement.
 */
export async function insertEvalCandidate(engine: Pick<BrainEngine, 'executeRaw'>, input: EvalCandidateInput): Promise<number> {
  const rows = await engine.executeRaw<{ id: number | string }>(
    `INSERT INTO eval_candidates (
       tool_name, query, retrieved_slugs, retrieved_chunk_ids, source_ids,
       expand_enabled, detail, detail_resolved, vector_enabled, expansion_applied,
       latency_ms, remote, job_id, subagent_id, embedding_column
     ) VALUES ($1, $2,
       ARRAY(SELECT u.s FROM unnest($3::text[]) WITH ORDINALITY AS u(s, n)
              WHERE EXISTS (SELECT 1 FROM pages pg WHERE pg.slug = u.s
                              AND (cardinality($5::text[]) = 0 OR pg.source_id = ANY($5::text[])) FOR KEY SHARE)
                 OR CASE WHEN u.s ~ '^facts/[0-9]{1,18}$' THEN EXISTS (SELECT 1 FROM facts f WHERE f.id = substr(u.s, 7)::bigint
                              AND (cardinality($5::text[]) = 0 OR f.source_id = ANY($5::text[]))) ELSE false END
              ORDER BY u.n),
       $4::int[], $5::text[], $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     RETURNING id`,
    [input.tool_name, input.query, input.retrieved_slugs, input.retrieved_chunk_ids, input.source_ids, input.expand_enabled, input.detail,
      input.detail_resolved, input.vector_enabled, input.expansion_applied, input.latency_ms, input.remote, input.job_id, input.subagent_id,
      input.embedding_column ?? null],
  );
  return Number(rows[0]!.id);
}

export async function resetRetrievalWeights(
  engine: BrainEngine,
  opts: { sourceId?: string; slug?: string },
): Promise<number> {
  const rows = await engine.executeRaw<{ n: number | string }>(
    `WITH d AS (
       DELETE FROM retrieval_weights
        WHERE ($1::text IS NULL OR source_id = $1)
          AND ($2::text IS NULL OR (element_kind = 'page' AND element_key = $2)
                               OR (element_kind = 'link' AND (element_key LIKE $2 || '|%' OR element_key LIKE '%|' || $2)))
       RETURNING 1)
     SELECT count(*)::int AS n FROM d`,
    [opts.sourceId ?? null, opts.slug ?? null],
  );
  return Number(rows[0]?.n ?? 0);
}

export type { FeedbackStatusRow };

export function feedbackStatus(engine: BrainEngine): Promise<FeedbackStatusRow> {
  return engine.readFeedbackStatus();
}
