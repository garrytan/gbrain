/**
 * The belief ledger's write path (src/core/belief/append.ts, coverage.ts) that ran through `engine.executeRaw`, now typed
 * members so a Rust brain answers them from its store (rust/docs/store/collate-belief-writes.md): the event insert and the
 * reads and writes around it (purge tombstones, the redaction register, the purge epoch), the commit marks, and the
 * coverage reads `enableBeliefLedger` makes. Every statement is the one its caller ran, except that the baseline walk's
 * `LIMIT` is a bound parameter (`$5`) instead of a number spliced into the text (the engine-sql dynamic-SQL guard).
 */

/** The engine's `executeRaw` (bound). */
export type BeliefWritesRaw = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

/** One `belief_events` row as `appendBeliefEvents` builds it: the `value` and `cause` columns are JSON text, `event_key` is hex. */
export interface BeliefEventRow {
  event_key: string; source_id: string; source_incarnation: string; page_lifetime: string | null; slug: string; subject_kind: string;
  subject_key: string; event_type: string; origin: string; trust_tier: string; writer_tier: string | null; tier_basis: string; visibility: string;
  publication_id: string; ord: number; source_time: string | null; valid_from: string | null; valid_until: string | null; value: string | null;
  value_hash: string | null; prior_hash: string | null; state_hash: string; cause: string; claim_fp: string | null; purged: boolean; redacted_fields: string[] | null;
}

/** The newest coverage event of a source's current incarnation (never `coverage.restored`). `recorded_at` is a Date or timestamptz text; `id` a number or digits. */
export interface BeliefCoverageRow { event_type: string; run: string | null; recorded_at: string | Date; id: number | string }

/** One `belief_redactions` row the register read returns. */
export interface BeliefRedactionRow { id: number; subject_key: string; field: string; purge_request: string; field_hash: string; released_hash: string | null }

/** The newest coverage event of the source at its current incarnation other than `coverage.restored`, or null. */
export async function readBeliefCoverage(raw: BeliefWritesRaw, sourceId: string, coverageKey: string): Promise<BeliefCoverageRow | null> {
  const [row] = await raw<BeliefCoverageRow>(`SELECT e.event_type, e.cause->>'run' AS run, e.recorded_at, e.id
    FROM belief_events e JOIN sources s ON s.id = e.source_id AND s.incarnation = e.source_incarnation
    WHERE e.source_id = $1 AND e.subject_kind = 'coverage' AND e.subject_key = $2 AND e.event_type <> 'coverage.restored' ORDER BY e.id DESC LIMIT 1`, [sourceId, coverageKey]);
  return row ?? null;
}

/** Whether a baseline event of the run exists at the slug. */
export async function hasBaselineEvent(raw: BeliefWritesRaw, sourceId: string, slug: string, runId: string): Promise<boolean> {
  return (await raw(`SELECT 1 FROM belief_events
  WHERE source_id = $1 AND slug = $2 AND event_type = 'baseline' AND cause->>'run' = $3 LIMIT 1`, [sourceId, slug, runId])).length > 0;
}

/** The distinct slugs a run has baselined. */
export async function countBaselinedSlugs(raw: BeliefWritesRaw, sourceId: string, runId: string): Promise<number> {
  const [done] = await raw<{ n: number }>(`SELECT count(DISTINCT slug)::int AS n FROM belief_events WHERE source_id = $1 AND event_type = 'baseline' AND cause->>'run' = $2`,
    [sourceId, runId]);
  return Number(done?.n ?? 0);
}

/** Slugs of the source after `after` (bytewise) not in `skip` that the run has not baselined: live and soft-deleted pages, then page-less database-only fact subjects, in byte order, at most `limit`. */
export async function listPendingBaselineSlugs(raw: BeliefWritesRaw, sourceId: string, runId: string, after: string, skip: readonly string[], limit: number): Promise<string[]> {
  const rows = await raw<{ slug: string }>(`SELECT slug FROM (
      SELECT p.slug FROM pages p WHERE p.source_id = $1
      UNION SELECT f.entity_slug FROM facts f WHERE f.source_id = $1 AND f.source_markdown_slug IS NULL AND f.expired_at IS NULL AND f.entity_slug IS NOT NULL
      UNION SELECT f.source_markdown_slug FROM facts f WHERE f.source_id = $1 AND f.dimension IS NOT NULL AND f.row_num IS NULL AND f.expired_at IS NULL AND f.source_markdown_slug IS NOT NULL
    ) s WHERE s.slug COLLATE "C" > $3 AND NOT (s.slug = ANY($4::text[])) AND NOT EXISTS (SELECT 1 FROM belief_events e WHERE e.source_id = $1 AND e.slug = s.slug AND e.event_type = 'baseline' AND e.cause->>'run' = $2)
    ORDER BY s.slug COLLATE "C" LIMIT $5`, [sourceId, runId, after, [...skip], Math.max(1, Math.floor(limit))]);
  return rows.map(r => r.slug);
}

/** The fingerprints among `factFps` and `takeFps` that the source's `fact_purges` and `take_purges` tombstone. */
export async function listPurgedFingerprints(raw: BeliefWritesRaw, sourceId: string, factFps: readonly string[], takeFps: readonly string[]): Promise<string[]> {
  const rows = await raw<{ fp: string }>(`SELECT fact_hash AS fp FROM fact_purges WHERE source_id = $1 AND fact_hash = ANY($2::text[])
    UNION SELECT claim_hash AS fp FROM take_purges WHERE source_id = $1 AND claim_hash = ANY($3::text[])`, [sourceId, [...factFps], [...takeFps]]);
  return rows.map(r => r.fp);
}

/** The source's redaction register rows under any of `subjectKeys` or any of `fieldHashes`. */
export async function readBeliefRedactions(raw: BeliefWritesRaw, sourceId: string, subjectKeys: readonly string[], fieldHashes: readonly string[]): Promise<BeliefRedactionRow[]> {
  const rows = await raw<BeliefRedactionRow>(`SELECT id, subject_key, field, purge_request::text AS purge_request, field_hash, released_hash
    FROM belief_redactions WHERE source_id = $1 AND (subject_key = ANY($2::text[]) OR field_hash = ANY($3::text[]))`, [sourceId, [...subjectKeys], [...fieldHashes]]);
  return rows.map(r => ({ ...r, id: Number(r.id) }));
}

/** Registers a suppression of one subject's field (a successor copy of a purged value); returns its id. */
export async function insertBeliefRedaction(raw: BeliefWritesRaw, sourceId: string, subjectKey: string, field: string, purgeRequest: string, fieldHash: string): Promise<number> {
  const [row] = await raw<{ id: number }>(`INSERT INTO belief_redactions (source_id, subject_key, field, purge_request, field_hash)
          VALUES ($1, $2, $3, $4::uuid, $5) RETURNING id`, [sourceId, subjectKey, field, purgeRequest, fieldHash]);
  return Number(row!.id);
}

/** Marks suppressions released by a publication, bound to the hash of the value that replaced them. */
export async function releaseBeliefRedactions(raw: BeliefWritesRaw, ids: readonly number[], publicationId: string, releasedHash: string): Promise<void> {
  await raw('UPDATE belief_redactions SET released_by = $2::uuid, released_hash = $3 WHERE id = ANY($1::bigint[])', [[...ids], publicationId, releasedHash]);
}

/** Inserts the rows in `ord` order; a row whose `event_key` exists is skipped. Returns how many it inserted. */
export async function insertBeliefEvents(raw: BeliefWritesRaw, rows: readonly BeliefEventRow[]): Promise<number> {
  const inserted = await raw<{ id: number }>(`INSERT INTO belief_events (event_key, source_id, source_incarnation, page_lifetime, slug, subject_kind,
      subject_key, event_type, origin, trust_tier, writer_tier, tier_basis, visibility, publication_id, ord, source_time, valid_from, valid_until,
      value, value_hash, prior_hash, state_hash, cause, claim_fp, purged, redacted_fields)
    SELECT decode(r.event_key, 'hex'), r.source_id, r.source_incarnation::uuid, r.page_lifetime::uuid, r.slug, r.subject_kind, r.subject_key, r.event_type,
      r.origin, r.trust_tier, r.writer_tier, r.tier_basis, r.visibility, r.publication_id::uuid, r.ord, r.source_time::timestamptz,
      r.valid_from::timestamptz, r.valid_until::timestamptz, r.value::jsonb, r.value_hash, r.prior_hash, r.state_hash, r.cause::jsonb, r.claim_fp,
      r.purged, r.redacted_fields
    FROM jsonb_to_recordset($1::text::jsonb) AS r(event_key text, source_id text, source_incarnation text, page_lifetime text, slug text,
      subject_kind text, subject_key text, event_type text, origin text, trust_tier text, writer_tier text, tier_basis text, visibility text,
      publication_id text, ord integer, source_time text, valid_from text, valid_until text, value text, value_hash text, prior_hash text,
      state_hash text, cause text, claim_fp text, purged boolean, redacted_fields text[])
    ORDER BY r.ord
    ON CONFLICT (event_key) DO NOTHING RETURNING id`, [JSON.stringify(rows)]);
  return inserted.length;
}

/** Records the post-commit observation of each publication that has events and is not yet marked: `clock_timestamp()` in the statement, never below the newest `recorded_at`. */
export async function recordBeliefCommitMarks(raw: BeliefWritesRaw, publicationIds: readonly string[]): Promise<void> {
  if (!publicationIds.length) return;
  await raw(`WITH t AS MATERIALIZED (SELECT clock_timestamp() AS at)
    INSERT INTO belief_commit_marks (publication_id, observed_at)
    SELECT e.publication_id, t.at FROM t, belief_events e
    WHERE e.publication_id = ANY($1::uuid[])
    GROUP BY e.publication_id, t.at HAVING max(e.recorded_at) <= t.at
    ON CONFLICT (publication_id) DO NOTHING`, [[...publicationIds]]);
}
