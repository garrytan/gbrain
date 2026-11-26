/**
 * Belief ledger writes: one SQL implementation for both engines (docs/designs/BELIEF_LEDGER.md sections 3, 5.2, 5.3, 6.5).
 *
 * The append's guards and insert (`src/core/belief/append.ts`) and the page lifetimes (`src/core/belief/lifetimes.ts`)
 * run these statements. Each one is the text its caller ran through executeRaw; the decisions (which drafts assert, which
 * suppressions apply, when a lifetime is ended or minted) stay with the callers.
 */
import { COVERAGE_KEY } from '../belief/keys.ts';
import { factFingerprintV2Sql, legacyFingerprintV2Sql } from '../facts/withdrawal-schema.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import type { SqlExecutor } from './executor.ts';
import { sqlFragment, trustedSql } from './fragment.ts';

/** One `belief_redactions` row an append can apply: never the redacted text, only its hash. */
export interface BeliefSuppression { id: number; subject_key: string; field: string; purge_request: string; field_hash: string; released_hash: string | null }
/** One open or moved page lifetime (`belief_page_lifetimes`); `page_id` is a hint only. */
export interface BeliefLifetimeRow { page_lifetime: string; source_incarnation: string; slug: string; page_id: number | null }
export interface BeliefMovedLifetimeRow { page_id: number; source_incarnation: string; page_lifetime: string }
export interface BeliefRedactionInsert { sourceId: string; subjectKey: string; field: string; purgeRequest: string; fieldHash: string }
export interface BeliefLifetimeMint { lifetime: string; sourceId: string; incarnation: string; slug: string; pageId: number }

/**
 * One `belief_events` row as the append builds it: text and JSON columns are strings (`value` and `cause` canonical
 * JSON, `event_key` hex), times are ISO strings, and `ord` is the row's position in the publication.
 */
export interface BeliefEventInsertRow {
  event_key: string; source_id: string; source_incarnation: string; page_lifetime: string | null; slug: string; subject_kind: string;
  subject_key: string; event_type: string; origin: string; trust_tier: string; writer_tier: string | null; tier_basis: string; visibility: string;
  publication_id: string; ord: number; source_time: string | null; valid_from: string | null; valid_until: string | null; value: string | null;
  value_hash: string | null; prior_hash: string | null; state_hash: string; cause: string; claim_fp: string | null; purged: boolean;
  redacted_fields: string[] | null;
}

/** The fingerprints among `factFps` and `takeFps` that a fact or take purge of the source tombstoned (subject '*' included). */
export async function readBeliefTombstones(exec: LegacyUnscopedRead, sourceId: string, factFps: readonly string[], takeFps: readonly string[]): Promise<string[]> {
  const rows = await exec.executeRaw<{ fp: string }>(`SELECT fact_hash AS fp FROM fact_purges WHERE source_id = $1 AND fact_hash = ANY($2::text[])
    UNION SELECT claim_hash AS fp FROM take_purges WHERE source_id = $1 AND claim_hash = ANY($3::text[])`,
  [sourceId, [...factFps], [...takeFps]]);
  return rows.map(r => r.fp);
}

/** A claim the ledger recorded under a fingerprint the current fold no longer gives it (belief/legacy-fingerprint.ts): its text and that fingerprint. */
export interface LegacyClaimFingerprintRow { claim: string; fingerprint: string }

/**
 * For each of `claims` whose pre-v341 Postgres fingerprint (gbrain_fact_fingerprint before fact_fingerprint_v3, which folded
 * whitespace by the locale's `[[:space:]]`) differs from the current one and names an event of `sourceId` that recorded
 * this claim (the event's fact or claim text has the claim's current fingerprint, so a new claim never joins an older,
 * different claim that shares the old fold), the claim and its pre-v341 fingerprint. A claim with none is absent.
 */
export async function readLegacyClaimFingerprints(exec: LegacyUnscopedRead, sourceId: string, claims: readonly string[]): Promise<LegacyClaimFingerprintRow[]> {
  if (!claims.length) return [];
  const rows = (await exec.run<{ c: string; v2: string }>(sqlFragment`SELECT x.c, x.v2
    FROM (SELECT c, gbrain_fact_fingerprint(c) AS fp, ${trustedSql(factFingerprintV2Sql('c'))} AS v2 FROM unnest(${[...claims]}::text[]) AS c) x
    WHERE x.v2 <> x.fp AND EXISTS (SELECT 1 FROM belief_events e WHERE e.source_id = ${sourceId} AND e.claim_fp = x.v2 AND e.value IS NOT NULL
      AND gbrain_fact_fingerprint(COALESCE(e.value->>'fact', e.value->>'claim')) = x.fp)`)).rows;
  return rows.map(r => ({ claim: r.c, fingerprint: r.v2 }));
}

/** One draft event's claim the tombstone check found no purge for under the draft's own fingerprint: its kind, that fingerprint and its text. */
export interface LegacyTombstoneProbe { kind: 'fact' | 'take'; claimFp: string; claim: string }

/**
 * The `claimFp` of each probe whose claim text a purge of the source tombstoned under the claim's current fingerprint or a
 * pre-v341 one no current fingerprint can equal (legacyFingerprintV2Sql): a purge recorded before v341 matches a draft keyed
 * by the current fingerprint, and a purge recorded after matches a draft keyed by the claim's old one. A fact probe reads
 * `fact_purges`, a take probe `take_purges`. No set order.
 */
export async function readLegacyBeliefTombstones(exec: LegacyUnscopedRead, sourceId: string, probes: readonly LegacyTombstoneProbe[]): Promise<string[]> {
  if (!probes.length) return [];
  const legacy = trustedSql(legacyFingerprintV2Sql('d.claim'));
  const rows = (await exec.run<{ fp: string }>(sqlFragment`SELECT d.fp FROM unnest(${probes.map(p => p.kind)}::text[], ${probes.map(p => p.claimFp)}::text[], ${probes.map(p => p.claim)}::text[]) AS d(kind, fp, claim)
    WHERE CASE WHEN d.kind = 'fact'
      THEN EXISTS (SELECT 1 FROM fact_purges p WHERE p.source_id = ${sourceId} AND p.fact_hash IN (gbrain_fact_fingerprint(d.claim), ${legacy}))
      ELSE EXISTS (SELECT 1 FROM take_purges p WHERE p.source_id = ${sourceId} AND p.claim_hash IN (gbrain_fact_fingerprint(d.claim), ${legacy})) END`)).rows;
  return rows.map(r => r.fp);
}

/** The newest coverage event of a source's current incarnation other than `coverage.restored`: its type, `cause->>'run'`, ISO `recorded_at` and id. */
export interface BeliefCoverageRow { event_type: string; run: string | null; recorded_at: string; id: number }

/** The source's coverage state (src/core/belief/coverage.ts `latestCoverage`), or null; a restore never starts or stops recording. */
export async function readLatestBeliefCoverage(exec: LegacyUnscopedRead, sourceId: string): Promise<BeliefCoverageRow | null> {
  const [row] = await exec.executeRaw<{ event_type: string; run: string | null; recorded_at: string | Date; id: number | string }>(`SELECT e.event_type, e.cause->>'run' AS run, e.recorded_at, e.id
    FROM belief_events e JOIN sources s ON s.id = e.source_id AND s.incarnation = e.source_incarnation
    WHERE e.source_id = $1 AND e.subject_kind = 'coverage' AND e.subject_key = $2 AND e.event_type <> 'coverage.restored' ORDER BY e.id DESC LIMIT 1`, [sourceId, COVERAGE_KEY]);
  return row ? { event_type: row.event_type, run: row.run, recorded_at: new Date(row.recorded_at).toISOString(), id: Number(row.id) } : null;
}

/** Whether `slug` of the source has a baseline event of run `runId` (any incarnation). */
export async function hasBeliefBaseline(exec: LegacyUnscopedRead, sourceId: string, slug: string, runId: string): Promise<boolean> {
  return (await exec.executeRaw(`SELECT 1 FROM belief_events
  WHERE source_id = $1 AND slug = $2 AND event_type = 'baseline' AND cause->>'run' = $3 LIMIT 1`, [sourceId, slug, runId])).length > 0;
}

/**
 * Slugs of the source still lacking a baseline of run `runId`: live and soft-deleted pages, then page-less database-only
 * fact subjects; after `after` and not in `skip`, the first `limit` in byte order (COLLATE "C", as PGLite and the Rust store sort).
 */
export async function listBeliefBaselinePending(exec: LegacyUnscopedRead, sourceId: string, runId: string, after: string, skip: readonly string[], limit: number): Promise<string[]> {
  const rows = await exec.executeRaw<{ slug: string }>(`SELECT slug FROM (
      SELECT p.slug FROM pages p WHERE p.source_id = $1
      UNION SELECT f.entity_slug FROM facts f WHERE f.source_id = $1 AND f.source_markdown_slug IS NULL AND f.expired_at IS NULL AND f.entity_slug IS NOT NULL
      UNION SELECT f.source_markdown_slug FROM facts f WHERE f.source_id = $1 AND f.dimension IS NOT NULL AND f.row_num IS NULL AND f.expired_at IS NULL AND f.source_markdown_slug IS NOT NULL
    ) s WHERE s.slug COLLATE "C" > $3 AND NOT (s.slug = ANY($4::text[])) AND NOT EXISTS (SELECT 1 FROM belief_events e WHERE e.source_id = $1 AND e.slug = s.slug AND e.event_type = 'baseline' AND e.cause->>'run' = $2)
    ORDER BY s.slug COLLATE "C" LIMIT $5`, [sourceId, runId, after, [...skip], limit]);
  return rows.map(r => r.slug);
}

/** A slug's newest event as the drift check reads it: the id, the slug's state hash after it and its ISO `recorded_at`. */
export interface BeliefNewestEventRow { id: number; state_hash: string; recorded_at: string }

/**
 * The slugs the drift scan may check in the source's incarnation: its pages (live and soft-deleted), its page-less fact
 * subjects and its open page lifetimes, the most recently touched first (a page by `updated_at`, a fact subject by its
 * newest fact, a lifetime by `started_at`) and byte order within a tie (COLLATE "C", as PGLite and the Rust store sort).
 */
export async function listBeliefDriftCandidates(exec: LegacyUnscopedRead, sourceId: string, incarnation: string): Promise<string[]> {
  const rows = await exec.executeRaw<{ slug: string }>(`SELECT slug FROM (
      SELECT p.slug, p.updated_at AS at FROM pages p WHERE p.source_id = $1
      UNION ALL SELECT f.entity_slug, max(f.created_at) FROM facts f WHERE f.source_id = $1 AND f.source_markdown_slug IS NULL AND f.entity_slug IS NOT NULL GROUP BY f.entity_slug
      UNION ALL SELECT l.slug, l.started_at FROM belief_page_lifetimes l WHERE l.source_id = $1 AND l.source_incarnation = $2::uuid AND l.ended_at IS NULL
    ) c GROUP BY slug ORDER BY max(at) DESC NULLS LAST, slug COLLATE "C"`, [sourceId, incarnation]);
  return rows.map(r => r.slug);
}

/** The newest event of `slug` in the source's incarnation other than a coverage event or a backfill, or null. */
export async function readNewestBeliefEvent(exec: LegacyUnscopedRead, sourceId: string, incarnation: string, slug: string): Promise<BeliefNewestEventRow | null> {
  const [row] = await exec.executeRaw<{ id: number | string; state_hash: string; recorded_at: string | Date }>(`SELECT id, state_hash, recorded_at FROM belief_events
    WHERE source_id = $1 AND source_incarnation = $2::uuid AND slug = $3 AND subject_kind <> 'coverage' AND origin <> 'backfill' ORDER BY id DESC LIMIT 1`, [sourceId, incarnation, slug]);
  return row ? { id: Number(row.id), state_hash: row.state_hash, recorded_at: new Date(row.recorded_at).toISOString() } : null;
}

/** How many distinct slugs of the source have a baseline event of run `runId`. */
export async function countBeliefBaselineSlugs(exec: LegacyUnscopedRead, sourceId: string, runId: string): Promise<number> {
  const [row] = await exec.executeRaw<{ n: number }>(`SELECT count(DISTINCT slug)::int AS n FROM belief_events WHERE source_id = $1 AND event_type = 'baseline' AND cause->>'run' = $2`,
    [sourceId, runId]);
  return Number(row?.n ?? 0);
}

/** The source's suppressions on any of `subjectKeys` or on a field whose text hashes to one of `fieldHashes`. No set order. */
export async function readBeliefRedactions(exec: LegacyUnscopedRead, sourceId: string, subjectKeys: readonly string[], fieldHashes: readonly string[]): Promise<BeliefSuppression[]> {
  const rows = await exec.executeRaw<BeliefSuppression>(`SELECT id, subject_key, field, purge_request::text AS purge_request, field_hash, released_hash
    FROM belief_redactions WHERE source_id = $1 AND (subject_key = ANY($2::text[]) OR field_hash = ANY($3::text[]))`,
  [sourceId, [...subjectKeys], [...fieldHashes]]);
  return rows.map(r => ({ ...r, id: Number(r.id) }));
}

/** Copies one suppression onto a successor subject (a rename, a replacement or a copied value); returns the new row's id. */
export async function insertBeliefRedaction(exec: SqlExecutor, row: BeliefRedactionInsert): Promise<number> {
  const [inserted] = await exec.executeRaw<{ id: number }>(`INSERT INTO belief_redactions (source_id, subject_key, field, purge_request, field_hash)
          VALUES ($1, $2, $3, $4::uuid, $5) RETURNING id`, [row.sourceId, row.subjectKey, row.field, row.purgeRequest, row.fieldHash]);
  return Number(inserted!.id);
}

/** An owner release: binds the suppressions `ids` to `publicationId` and the hash of the value that replaced the redacted text. */
export async function releaseBeliefRedactions(exec: SqlExecutor, ids: readonly number[], publicationId: string, releasedHash: string): Promise<void> {
  await exec.executeRaw('UPDATE belief_redactions SET released_by = $2::uuid, released_hash = $3 WHERE id = ANY($1::bigint[])',
    [[...ids], publicationId, releasedHash]);
}

/** Inserts the rows in `ord` order, skipping an event key already recorded; returns how many were inserted. */
export async function insertBeliefEvents(exec: SqlExecutor, rows: readonly BeliefEventInsertRow[]): Promise<number> {
  const inserted = await exec.executeRaw<{ id: number }>(`INSERT INTO belief_events (event_key, source_id, source_incarnation, page_lifetime, slug, subject_kind,
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

/**
 * The post-commit observation of each publication with a committed event: one clock_timestamp() for the statement, never
 * below the publication's newest recorded_at, and never replacing a mark already written.
 */
export async function markBeliefCommits(exec: SqlExecutor, publicationIds: readonly string[]): Promise<void> {
  await exec.executeRaw(`WITH t AS MATERIALIZED (SELECT clock_timestamp() AS at)
    INSERT INTO belief_commit_marks (publication_id, observed_at)
    SELECT e.publication_id, t.at FROM t, belief_events e
    WHERE e.publication_id = ANY($1::uuid[])
    GROUP BY e.publication_id, t.at HAVING max(e.recorded_at) <= t.at
    ON CONFLICT (publication_id) DO NOTHING`, [[...publicationIds]]);
}

/** The open lifetime at each (incarnation, slug) pair that has one. No set order. */
export async function readOpenBeliefLifetimes(exec: LegacyUnscopedRead, pairs: readonly { incarnation: string; slug: string }[]): Promise<BeliefLifetimeRow[]> {
  const rows = await exec.executeRaw<BeliefLifetimeRow>(`SELECT l.page_lifetime::text AS page_lifetime, l.source_incarnation::text AS source_incarnation, l.slug, l.page_id
    FROM belief_page_lifetimes l JOIN unnest($1::uuid[], $2::text[]) AS n(i, s) ON l.source_incarnation = n.i AND l.slug = n.s
    WHERE l.ended_at IS NULL`, [pairs.map(n => n.incarnation), pairs.map(n => n.slug)]);
  return rows.map(row => ({ ...row, page_id: row.page_id == null ? null : Number(row.page_id) }));
}

/** Ends the lifetime if it is still open. */
export async function endBeliefLifetime(exec: SqlExecutor, lifetime: string): Promise<void> {
  await exec.executeRaw('UPDATE belief_page_lifetimes SET ended_at = clock_timestamp() WHERE page_lifetime = $1::uuid AND ended_at IS NULL', [lifetime]);
}

/** Opens `lifetime` at the pair; when a lifetime is already open there, returns that one instead. */
export async function mintBeliefLifetime(exec: SqlExecutor, mint: BeliefLifetimeMint): Promise<string> {
  const [row] = await exec.executeRaw<{ page_lifetime: string }>(`INSERT INTO belief_page_lifetimes (page_lifetime, source_id, source_incarnation, slug, page_id)
    VALUES ($1::uuid, $2, $3::uuid, $4, $5) ON CONFLICT (source_incarnation, slug) WHERE ended_at IS NULL DO NOTHING RETURNING page_lifetime::text AS page_lifetime`,
  [mint.lifetime, mint.sourceId, mint.incarnation, mint.slug, mint.pageId]);
  if (row) return row.page_lifetime;
  const [existing] = await exec.executeRaw<{ page_lifetime: string }>(`SELECT page_lifetime::text AS page_lifetime FROM belief_page_lifetimes
    WHERE source_incarnation = $1::uuid AND slug = $2 AND ended_at IS NULL`, [mint.incarnation, mint.slug]);
  return existing!.page_lifetime;
}

/** A rename keeps the lifetime: it moves to `slug`, with `pageId` as its new hint. */
export async function renameBeliefLifetime(exec: SqlExecutor, lifetime: string, slug: string, pageId: number): Promise<void> {
  await exec.executeRaw('UPDATE belief_page_lifetimes SET slug = $2, page_id = $3 WHERE page_lifetime = $1::uuid', [lifetime, slug, pageId]);
}

/** The open lifetime of each of `pageIds` whose page still has the lifetime's slug (a page renamed since its caller read it). No set order. */
export async function readMovedBeliefLifetimes(exec: LegacyUnscopedRead, pageIds: readonly number[]): Promise<BeliefMovedLifetimeRow[]> {
  const rows = await exec.executeRaw<BeliefMovedLifetimeRow>(`SELECT l.page_id, l.source_incarnation::text AS source_incarnation,
      l.page_lifetime::text AS page_lifetime FROM belief_page_lifetimes l JOIN pages p ON p.id = l.page_id AND p.slug = l.slug
      WHERE l.page_id = ANY($1::int[]) AND l.ended_at IS NULL`, [[...pageIds]]);
  return rows.map(r => ({ ...r, page_id: Number(r.page_id) }));
}

/** One coverage event of a source (belief/coverage-report.ts coverageIntervals). */
export interface BeliefCoverageEventRow { id: number; event_type: string; recorded_at: string; value: unknown; cause: unknown; incarnation: string }

/** The coverage events of the source's current incarnation, in id order (belief/coverage-report.ts coverageIntervals and coverageAt). */
export async function readBeliefCoverageEvents(exec: Pick<SqlExecutor, 'executeRaw'>, sourceId: string): Promise<BeliefCoverageEventRow[]> {
  return exec.executeRaw<BeliefCoverageEventRow>(`SELECT e.id, e.event_type, e.recorded_at, e.value, e.cause, e.source_incarnation::text AS incarnation
    FROM belief_events e JOIN sources s ON s.id = e.source_id AND s.incarnation = e.source_incarnation
    WHERE e.source_id = $1 AND e.subject_kind = 'coverage' AND e.subject_key = $2 ORDER BY e.id`, [sourceId, COVERAGE_KEY]);
}
