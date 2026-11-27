/**
 * The retrieval feedback statements feedback/store.ts ran through executeRaw (the event log, its read, and a rating
 * batch), as typed members: PGLite and Postgres send the same text as before (the page-exists filters and the neutral
 * weight, 0.5, were composed from constants; each is written out here), and a Rust brain answers from its store
 * (rust/docs/store/retrieval-feedback.md). The status read is readFeedbackStatus (engine-sql/doctor-acc.ts).
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/**
 * The statements of feedback/store.ts insertRetrievalEvents, getRetrievalEvent and applyRatings, as they ran.
 */
export const RETRIEVAL_FEEDBACK_SQL = {
  events: `INSERT INTO retrieval_events (id, client_id, op)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
     ON CONFLICT (id) DO NOTHING`,
  pages: `INSERT INTO retrieval_event_pages (event_id, source_id, slug, content_hash, rank, cited)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[]::boolean[])
         AS t(event_id, source_id, slug, content_hash, rank, cited)
        WHERE EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = t.source_id AND pg.slug = t.slug FOR KEY SHARE)
       ON CONFLICT DO NOTHING`,
  links: `INSERT INTO retrieval_event_links (event_id, source_id, edge_key, to_slug)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS t(event_id, source_id, edge_key, to_slug)
        WHERE EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = t.source_id AND pg.slug = t.to_slug FOR KEY SHARE) AND EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = t.source_id AND pg.slug = split_part(t.edge_key, '|', 1) FOR KEY SHARE) AND EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = t.source_id AND pg.slug = reverse(split_part(reverse(t.edge_key), '|', 1)) FOR KEY SHARE)
       ON CONFLICT DO NOTHING`,
  readEvent: `SELECT id, client_id, op, created_at FROM retrieval_events WHERE id = $1`,
  readPages: `SELECT source_id, slug, content_hash, rank, cited FROM retrieval_event_pages WHERE event_id = $1 ORDER BY rank`,
  readLinks: `SELECT source_id, edge_key, to_slug FROM retrieval_event_links WHERE event_id = $1 ORDER BY source_id COLLATE "C", edge_key COLLATE "C", to_slug COLLATE "C"`,
  apply: `WITH input AS (
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::text[])
         AS t(element_kind, source_id, element_key, rating, content_hash)
        WHERE CASE t.element_kind WHEN 'page' THEN EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = t.source_id AND pg.slug = t.element_key FOR KEY SHARE)
                                  ELSE EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = t.source_id AND pg.slug = split_part(t.element_key, '|', 1) FOR KEY SHARE) AND EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = t.source_id AND pg.slug = reverse(split_part(reverse(t.element_key), '|', 1)) FOR KEY SHARE) END
     ),
     cur AS (
       SELECT i.*, COALESCE(w.weight, 0.5)::real AS w0,
              CASE WHEN w.weight IS NULL THEN 0.5
                   WHEN i.element_kind = 'page' AND w.content_hash IS DISTINCT FROM i.content_hash
                     THEN 0.5 + (w.weight - 0.5) / 2
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
               THEN 0.5 + (rw.weight - 0.5) / 2 ELSE rw.weight END)
         + $6::real * ((SELECT rating FROM ins i2 WHERE i2.source_id = EXCLUDED.source_id AND i2.element_kind = EXCLUDED.element_kind AND i2.element_key = EXCLUDED.element_key) - 1) / 4.0
         - $6::real * (CASE WHEN rw.element_kind = 'page' AND rw.content_hash IS DISTINCT FROM EXCLUDED.content_hash
               THEN 0.5 + (rw.weight - 0.5) / 2 ELSE rw.weight END)))::real,
       content_hash = EXCLUDED.content_hash,
       updates = rw.updates + 1,
       updated_at = now()
     RETURNING rw.element_kind, rw.source_id, rw.element_key, rw.weight AS weight_after`,
  stored: `SELECT element_kind, source_id, element_key, rating, weight_before, weight_after
       FROM retrieval_feedback
      WHERE event_id = $1 AND signal = $2
        AND (element_kind, source_id, element_key) IN (
          SELECT * FROM unnest($3::text[], $4::text[], $5::text[]))`,
} as const;

/** One retrieval event with the pages it returned and the links it used (feedback/store.ts RetrievalEventInput). */
export interface RetrievalEventInsert {
  id: string;
  client_id: string;
  op: string;
  pages: Array<{ source_id: string; slug: string; content_hash: string | null; rank: number; cited: boolean }>;
  links: Array<{ source_id: string; edge_key: string; to_slug: string }>;
}

/** One stored retrieval event: its row, its pages by rank and its links by byte of source, edge key and target. */
export interface RetrievalEventRead {
  id: string;
  client_id: string;
  op: string;
  created_at: Date | string;
  pages: Array<{ source_id: string; slug: string; content_hash: string | null; rank: number; cited: boolean }>;
  links: Array<{ source_id: string; edge_key: string; to_slug: string }>;
}

/** One rating batch (feedback/store.ts applyRatings arguments). */
export interface RetrievalRatingBatch {
  eventId: string;
  clientId: string;
  signal: string;
  alpha: number;
  targets: Array<{ kind: string; source_id: string; key: string; rating: number; content_hash: string | null }>;
}

/** One rating the batch holds: the weight it moved and whether this call moved it. */
export interface AppliedRatingRow {
  kind: string;
  source_id: string;
  key: string;
  rating: number;
  weight_before: number;
  weight_after: number;
  newly_applied: boolean;
}

/** Records retrieval events, the pages and links each returned; a page or link whose page row is gone is skipped, a repeat is ignored. */
export async function insertRetrievalEvents(tx: Raw, events: RetrievalEventInsert[]): Promise<void> {
  if (events.length === 0) return;
  await tx.executeRaw(RETRIEVAL_FEEDBACK_SQL.events, [events.map(e => e.id), events.map(e => e.client_id), events.map(e => e.op)]);
  const pages = events.flatMap(e => e.pages.map(p => ({ id: e.id, ...p })));
  if (pages.length > 0) {
    await tx.executeRaw(RETRIEVAL_FEEDBACK_SQL.pages, [
      pages.map(p => p.id), pages.map(p => p.source_id), pages.map(p => p.slug),
      pages.map(p => p.content_hash), pages.map(p => p.rank), pages.map(p => (p.cited ? 'true' : 'false')),
    ]);
  }
  const links = events.flatMap(e => e.links.map(l => ({ id: e.id, ...l })));
  if (links.length > 0) {
    await tx.executeRaw(RETRIEVAL_FEEDBACK_SQL.links, [links.map(l => l.id), links.map(l => l.source_id), links.map(l => l.edge_key), links.map(l => l.to_slug)]);
  }
}

/** A page's learned feedback weight (`readPageFeedbackWeights`): null when no weight row exists. */
export interface PageFeedbackWeightRow { id: number; content_hash: string | null; weight: number | null }

/**
 * The search feedback stage's weight read (search/feedback-boost.ts): for each of `pageIds` that names a page row (a
 * soft-deleted page included), its content hash and its learned page weight, halved toward neutral (0.5) when the
 * page changed since it was rated; null without a weight row. The rows come in no set order. The text is the one
 * feedback-boost.ts sent (pinned in test/engine-sql-caller-raw-sql-pins.test.ts).
 */
export async function readPageFeedbackWeights(tx: Raw, pageIds: readonly number[]): Promise<PageFeedbackWeightRow[]> {
  if (!pageIds.length) return [];
  const rows = await tx.executeRaw<{ id: number | string; content_hash: string | null; weight: number | string | null }>(
    `SELECT p.id, p.content_hash,
            CASE WHEN w.weight IS NULL THEN NULL
                 WHEN p.content_hash IS DISTINCT FROM w.content_hash
                   THEN 0.5 + (w.weight - 0.5) / 2
                 ELSE w.weight END AS weight
       FROM pages p
       LEFT JOIN retrieval_weights w
         ON w.source_id = p.source_id AND w.element_kind = 'page' AND w.element_key = p.slug
      WHERE p.id = ANY($1::int[])`,
    [[...pageIds]],
  );
  return rows.map(r => ({ id: Number(r.id), content_hash: r.content_hash, weight: r.weight == null ? null : Number(r.weight) }));
}

/** One retrieval event with its pages by rank and its links by byte, or null. */
export async function readRetrievalEvent(tx: Raw, id: string): Promise<RetrievalEventRead | null> {
  const rows = await tx.executeRaw<{ id: string; client_id: string; op: string; created_at: Date | string }>(RETRIEVAL_FEEDBACK_SQL.readEvent, [id]);
  const row = rows[0];
  if (!row) return null;
  const pages = await tx.executeRaw<{ source_id: string; slug: string; content_hash: string | null; rank: number | string; cited: boolean }>(RETRIEVAL_FEEDBACK_SQL.readPages, [id]);
  const links = await tx.executeRaw<{ source_id: string; edge_key: string; to_slug: string }>(RETRIEVAL_FEEDBACK_SQL.readLinks, [id]);
  return { ...row, pages: pages.map(p => ({ ...p, rank: Number(p.rank) })), links };
}

/** Applies one batch of ratings; the weight of a rating this call newly stored moves, a repeat reads back what it stored. */
export async function applyRetrievalRatings(tx: Raw, args: RetrievalRatingBatch): Promise<AppliedRatingRow[]> {
  const { eventId, clientId, signal, alpha } = args;
  const targets = args.targets;
  if (targets.length === 0) return [];
  const kinds = targets.map(t => t.kind);
  const sources = targets.map(t => t.source_id);
  const keys = targets.map(t => t.key);
  const applied = await tx.executeRaw<{ element_kind: string; source_id: string; element_key: string; weight_after: number | string }>(
    RETRIEVAL_FEEDBACK_SQL.apply,
    [kinds, sources, keys, targets.map(t => t.rating), targets.map(t => t.content_hash), alpha, eventId, signal, clientId],
  );
  const newly = new Set(applied.map(a => `${a.element_kind}|${a.source_id}|${a.element_key}`));
  const stored = await tx.executeRaw<{ element_kind: string; source_id: string; element_key: string; rating: number | string; weight_before: number | string; weight_after: number | string }>(
    RETRIEVAL_FEEDBACK_SQL.stored, [eventId, signal, kinds, sources, keys]);
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
