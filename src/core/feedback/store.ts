/**
 * Storage for use-attributed retrieval feedback (migration v207). One module
 * owns every statement against retrieval_events / retrieval_event_pages /
 * retrieval_event_links / retrieval_feedback / retrieval_weights; both engines
 * run the same SQL through `engine.executeRaw` with positional binds (no JSONB).
 */
import type { BrainEngine } from '../engine.ts';
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

const pageRowExists = (source: string, slug: string) => `EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = ${source} AND pg.slug = ${slug} FOR KEY SHARE)`;
const edgeEndsExist = (source: string, key: string) =>
  `${pageRowExists(source, `split_part(${key}, '|', 1)`)} AND ${pageRowExists(source, `reverse(split_part(reverse(${key}), '|', 1))`)}`;

export async function insertRetrievalEvents(engine: BrainEngine, events: RetrievalEventInput[]): Promise<void> {
  if (events.length === 0) return;
  await engine.executeRaw(
    `INSERT INTO retrieval_events (id, client_id, op)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
     ON CONFLICT (id) DO NOTHING`,
    [events.map(e => e.id), events.map(e => e.client_id), events.map(e => e.op)],
  );
  const pages = events.flatMap(e => e.pages.map(p => ({ id: e.id, ...p })));
  if (pages.length > 0) {
    await engine.executeRaw(
      `INSERT INTO retrieval_event_pages (event_id, source_id, slug, content_hash, rank, cited)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[]::boolean[])
         AS t(event_id, source_id, slug, content_hash, rank, cited)
        WHERE ${pageRowExists('t.source_id', 't.slug')}
       ON CONFLICT DO NOTHING`,
      [
        pages.map(p => p.id), pages.map(p => p.source_id), pages.map(p => p.slug),
        pages.map(p => p.content_hash), pages.map(p => p.rank), pages.map(p => (p.cited ? 'true' : 'false')),
      ],
    );
  }
  const links = events.flatMap(e => e.links.map(l => ({ id: e.id, ...l })));
  if (links.length > 0) {
    await engine.executeRaw(
      `INSERT INTO retrieval_event_links (event_id, source_id, edge_key, to_slug)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(event_id, source_id, edge_key, to_slug)
        WHERE ${pageRowExists('t.source_id', 't.to_slug')} AND ${edgeEndsExist('t.source_id', 't.edge_key')}
       ON CONFLICT DO NOTHING`,
      [links.map(l => l.id), links.map(l => l.source_id), links.map(l => l.edge_key), links.map(l => l.to_slug)],
    );
  }
}

export async function getRetrievalEvent(engine: BrainEngine, id: string): Promise<StoredEvent | null> {
  const rows = await engine.executeRaw<{ id: string; client_id: string; op: FeedbackOp; created_at: Date | string }>(
    `SELECT id, client_id, op, created_at FROM retrieval_events WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const pages = await engine.executeRaw<{ source_id: string; slug: string; content_hash: string | null; rank: number | string; cited: boolean }>(
    `SELECT source_id, slug, content_hash, rank, cited FROM retrieval_event_pages WHERE event_id = $1 ORDER BY rank`,
    [id],
  );
  const links = await engine.executeRaw<EventLink>(
    `SELECT source_id, edge_key, to_slug FROM retrieval_event_links WHERE event_id = $1 ORDER BY source_id, edge_key, to_slug`,
    [id],
  );
  return {
    id: row.id,
    client_id: row.client_id,
    op: row.op,
    created_at: new Date(row.created_at),
    pages: pages.map(p => ({ ...p, rank: Number(p.rank) })),
    links,
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
  const kinds = targets.map(t => t.kind);
  const sources = targets.map(t => t.source_id);
  const keys = targets.map(t => t.key);
  const ratings = targets.map(t => t.rating);
  const hashes = targets.map(t => t.content_hash);
  const applied = await engine.executeRaw<{ element_kind: ElementKind; source_id: string; element_key: string; weight_after: number | string }>(
    `WITH input AS (
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[])
         AS t(element_kind, source_id, element_key, rating, content_hash)
        WHERE CASE t.element_kind WHEN 'page' THEN ${pageRowExists('t.source_id', 't.element_key')}
                                  ELSE ${edgeEndsExist('t.source_id', 't.element_key')} END
     ),
     cur AS (
       SELECT i.*, COALESCE(w.weight, ${NEUTRAL_WEIGHT})::real AS w0,
              CASE WHEN w.weight IS NULL THEN ${NEUTRAL_WEIGHT}
                   WHEN i.element_kind = 'page' AND w.content_hash IS DISTINCT FROM i.content_hash
                     THEN ${NEUTRAL_WEIGHT} + (w.weight - ${NEUTRAL_WEIGHT}) / 2
                   ELSE w.weight END AS w_eff
         FROM input i
         LEFT JOIN retrieval_weights w
           ON w.source_id = i.source_id AND w.element_kind = i.element_kind AND w.element_key = i.element_key
     ),
     calc AS (
       SELECT c.*, LEAST(1, GREATEST(0, c.w_eff + $6::real * ((c.rating - 1) / 4.0 - c.w_eff)))::real AS w1
         FROM cur c
     ),
     ins AS (
       INSERT INTO retrieval_feedback
         (event_id, signal, element_kind, source_id, element_key, client_id, rating, weight_before, weight_after)
       SELECT $7, $8, element_kind, source_id, element_key, $9, rating, w_eff, w1 FROM calc
       ON CONFLICT DO NOTHING
       RETURNING element_kind, source_id, element_key, rating
     )
     INSERT INTO retrieval_weights AS rw (source_id, element_kind, element_key, weight, content_hash, updates, updated_at)
     SELECT ins.source_id, ins.element_kind, ins.element_key, calc.w1, calc.content_hash, 1, now()
       FROM ins JOIN calc ON calc.element_kind = ins.element_kind AND calc.source_id = ins.source_id AND calc.element_key = ins.element_key
     ON CONFLICT (source_id, element_kind, element_key) DO UPDATE SET
       weight = LEAST(1, GREATEST(0,
         (CASE WHEN rw.element_kind = 'page' AND rw.content_hash IS DISTINCT FROM EXCLUDED.content_hash
               THEN ${NEUTRAL_WEIGHT} + (rw.weight - ${NEUTRAL_WEIGHT}) / 2 ELSE rw.weight END)
         + $6::real * ((SELECT rating FROM ins i2 WHERE i2.source_id = EXCLUDED.source_id AND i2.element_kind = EXCLUDED.element_kind AND i2.element_key = EXCLUDED.element_key) - 1) / 4.0
         - $6::real * (CASE WHEN rw.element_kind = 'page' AND rw.content_hash IS DISTINCT FROM EXCLUDED.content_hash
               THEN ${NEUTRAL_WEIGHT} + (rw.weight - ${NEUTRAL_WEIGHT}) / 2 ELSE rw.weight END)))::real,
       content_hash = EXCLUDED.content_hash,
       updates = rw.updates + 1,
       updated_at = now()
     RETURNING rw.element_kind, rw.source_id, rw.element_key, rw.weight AS weight_after`,
    [kinds, sources, keys, ratings, hashes, alpha, eventId, signal, clientId],
  );
  const newly = new Set(applied.map(a => `${a.element_kind}|${a.source_id}|${a.element_key}`));
  const stored = await engine.executeRaw<{ element_kind: ElementKind; source_id: string; element_key: string; rating: number | string; weight_before: number | string; weight_after: number | string }>(
    `SELECT element_kind, source_id, element_key, rating, weight_before, weight_after
       FROM retrieval_feedback
      WHERE event_id = $1 AND signal = $2
        AND (element_kind, source_id, element_key) IN (
          SELECT * FROM unnest($3::text[], $4::text[], $5::text[]))`,
    [eventId, signal, kinds, sources, keys],
  );
  const finalWeights = new Map(applied.map(a => [`${a.element_kind}|${a.source_id}|${a.element_key}`, Number(a.weight_after)]));
  return stored.map(r => {
    const id = `${r.element_kind}|${r.source_id}|${r.element_key}`;
    return {
      kind: r.element_kind,
      source_id: r.source_id,
      key: r.element_key,
      rating: Number(r.rating),
      weight_before: Number(r.weight_before),
      weight_after: newly.has(id) ? (finalWeights.get(id) ?? Number(r.weight_after)) : Number(r.weight_after),
      newly_applied: newly.has(id),
    };
  });
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
/** A captured slug is the purged page's unless another source the candidate covers still has a page by that name. */
const purgedCandidateSlug = (slug: string) =>
  `${slug} = ANY($2::text[]) AND NOT EXISTS (SELECT 1 FROM pages po WHERE po.slug = ${slug} AND po.source_id = ANY(eval_candidates.source_ids) AND po.source_id <> $1)`;

export async function scrubPurgedSlugs(
  engine: Pick<BrainEngine, 'executeRaw'>,
  sourceId: string,
  slugs: readonly string[],
): Promise<Record<string, number>> {
  if (!slugs.length) return {};
  const edgeNames = (key: string) => `EXISTS (SELECT 1 FROM unnest($2::text[]) AS s(slug) WHERE starts_with(${key}, s.slug || '|') OR right(${key}, length(s.slug) + 1) = '|' || s.slug)`;
  const count = async (sql: string) => (await engine.executeRaw(sql, [sourceId, [...slugs]])).length;
  return {
    retrieval_event_pages: await count('DELETE FROM retrieval_event_pages WHERE source_id = $1 AND slug = ANY($2::text[]) RETURNING 1'),
    retrieval_event_links: await count(`DELETE FROM retrieval_event_links WHERE source_id = $1 AND (to_slug = ANY($2::text[]) OR ${edgeNames('edge_key')}) RETURNING 1`),
    retrieval_feedback: await count(`DELETE FROM retrieval_feedback WHERE source_id = $1
      AND ((element_kind = 'page' AND element_key = ANY($2::text[])) OR (element_kind = 'link' AND ${edgeNames('element_key')})) RETURNING 1`),
    retrieval_weights: await count(`DELETE FROM retrieval_weights WHERE source_id = $1
      AND ((element_kind = 'page' AND element_key = ANY($2::text[])) OR (element_kind = 'link' AND ${edgeNames('element_key')})) RETURNING 1`),
    'eval_candidates.retrieved_slugs': await count(`UPDATE eval_candidates
      SET retrieved_slugs = ARRAY(SELECT s FROM unnest(retrieved_slugs) WITH ORDINALITY AS u(s, n) WHERE NOT (${purgedCandidateSlug('u.s')}) ORDER BY n)
      WHERE $1 = ANY(source_ids) AND EXISTS (SELECT 1 FROM unnest(retrieved_slugs) AS r(s) WHERE ${purgedCandidateSlug('r.s')}) RETURNING 1`),
  };
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

export interface FeedbackStatusRow {
  events: number;
  ratings_explicit: number;
  ratings_cited: number;
  weights_total: number;
  weights_off_neutral: number;
  last_rating_at: Date | null;
  top_client_share_7d: number | null;
  lowest: Array<{ source_id: string; slug: string; weight: number; low_ratings: number }>;
  highest: Array<{ source_id: string; slug: string; weight: number }>;
}

export async function feedbackStatus(engine: BrainEngine): Promise<FeedbackStatusRow> {
  const [counts] = await engine.executeRaw<Record<string, number | string | Date | null>>(
    `SELECT
       (SELECT count(*)::int FROM retrieval_events) AS events,
       (SELECT count(*)::int FROM retrieval_feedback WHERE signal = 'explicit') AS ratings_explicit,
       (SELECT count(*)::int FROM retrieval_feedback WHERE signal = 'cited') AS ratings_cited,
       (SELECT count(*)::int FROM retrieval_weights) AS weights_total,
       (SELECT count(*)::int FROM retrieval_weights WHERE abs(weight - ${NEUTRAL_WEIGHT}) > 0.01) AS weights_off_neutral,
       (SELECT max(applied_at) FROM retrieval_feedback) AS last_rating_at,
       (SELECT max(n)::float / NULLIF(sum(n), 0) FROM (
          SELECT count(*) AS n FROM retrieval_feedback
           WHERE signal = 'explicit' AND applied_at > now() - interval '7 days'
           GROUP BY client_id) c) AS top_client_share_7d`,
  );
  const lowest = await engine.executeRaw<{ source_id: string; slug: string; weight: number | string; low_ratings: number | string }>(
    `SELECT w.source_id, w.element_key AS slug, w.weight,
            (SELECT count(*) FROM retrieval_feedback f
              WHERE f.element_kind = 'page' AND f.source_id = w.source_id
                AND f.element_key = w.element_key AND f.rating <= 2)::int AS low_ratings
       FROM retrieval_weights w
      WHERE w.element_kind = 'page' AND w.weight < ${NEUTRAL_WEIGHT}
      ORDER BY w.weight ASC, w.source_id, w.element_key LIMIT 10`,
  );
  const highest = await engine.executeRaw<{ source_id: string; slug: string; weight: number | string }>(
    `SELECT source_id, element_key AS slug, weight FROM retrieval_weights
      WHERE element_kind = 'page' AND weight > ${NEUTRAL_WEIGHT}
      ORDER BY weight DESC, source_id, element_key LIMIT 10`,
  );
  return {
    events: Number(counts?.events ?? 0),
    ratings_explicit: Number(counts?.ratings_explicit ?? 0),
    ratings_cited: Number(counts?.ratings_cited ?? 0),
    weights_total: Number(counts?.weights_total ?? 0),
    weights_off_neutral: Number(counts?.weights_off_neutral ?? 0),
    last_rating_at: counts?.last_rating_at ? new Date(counts.last_rating_at as string) : null,
    top_client_share_7d: counts?.top_client_share_7d == null ? null : Number(counts.top_client_share_7d),
    lowest: lowest.map(r => ({ ...r, weight: Number(r.weight), low_ratings: Number(r.low_ratings) })),
    highest: highest.map(r => ({ ...r, weight: Number(r.weight) })),
  };
}
