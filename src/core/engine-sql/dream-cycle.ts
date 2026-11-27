/**
 * Dream-cycle statements (docs/research/rust-cli-contract-map.md, item 4.2 batch E): the retriage queue reads, the dream
 * breaker and write-deferral config map, the provenance stamp, the consolidate phase and the synthesize family. Each
 * function runs the statement its caller ran through `executeRaw`, with the same text and parameters, on the engine's
 * own `executeRaw`; only its home moved. The Postgres text and bound params are pinned byte for byte by
 * test/dream-cycle-sites-sql-pin.test.ts.
 */
import { readersSourcedFactSql } from '../access/member-facts.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { executeRawJsonb } from '../sql-query.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

// ---------------------------------------------------------------------------------------------------------------------
// Retriage queue reconciliation (src/commands/dream-retriage.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface DreamQueueCandidate { id: number; queue: string; status: string; idempotency_key: string; source_id: string }

/** Waiting, delayed and paused subagent jobs of a dream synthesis key or a private dream-inline queue. */
export async function listDreamQueueCandidates(raw: EngineRawRead): Promise<DreamQueueCandidate[]> {
  return raw<DreamQueueCandidate>(
    `SELECT id, queue, status, idempotency_key,
              COALESCE(NULLIF(data->>'source_id', ''), 'default') AS source_id
         FROM minion_jobs
        WHERE name = 'subagent'
          AND status IN ('waiting', 'delayed', 'paused')
          AND (idempotency_key LIKE 'dream:synth-v2:%' OR queue LIKE 'dream-inline-%')`,
  );
}

export interface LiveDreamCycleLock { id: string; acquired_epoch_ms: string | number | null }

/** Cycle locks that are unexpired or refreshed within `graceSecs` (the steal grace), with their acquisition time in epoch milliseconds. */
export async function listLiveDreamCycleLocks(raw: EngineRawRead, graceSecs: number): Promise<LiveDreamCycleLock[]> {
  const secs = Number(graceSecs);
  if (!Number.isFinite(secs)) throw new Error(`listLiveDreamCycleLocks: the steal grace must be a number, got ${String(graceSecs)}`);
  return raw<LiveDreamCycleLock>(
    `SELECT id, EXTRACT(EPOCH FROM acquired_at) * 1000 AS acquired_epoch_ms
         FROM gbrain_cycle_locks
        WHERE (ttl_expires_at > NOW()
               OR last_refreshed_at > NOW() - make_interval(secs => ${secs}))
          AND id LIKE 'gbrain-cycle%'`,
  );
}

/** The status of one job, or null when the job is gone (the pre-cancel re-check). */
export async function readDreamJobStatus(raw: EngineRawRead, id: number): Promise<{ status: string } | null> {
  const [row] = await raw<{ status: string }>(`SELECT status FROM minion_jobs WHERE id = $1`, [id]);
  return row ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The config map shared by the dream breaker and the write deferrals (dream-breaker.ts, dream-write-deferral.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** Creates the config row `key` holding an empty map when it does not exist yet. */
export async function ensureDreamMapConfigRow(raw: EngineRawRead, key: string): Promise<void> {
  await raw("INSERT INTO config (key, value) VALUES ($1, '{}') ON CONFLICT (key) DO NOTHING", [key]);
}

export interface DreamMapConfigRow { value: string; now: string }

/** Locks the config row `key` for the rest of the transaction; returns its value and the database clock, or null when the row is missing. */
export async function lockDreamMapConfigRow(raw: EngineRawRead, key: string): Promise<DreamMapConfigRow | null> {
  const [row] = await raw<DreamMapConfigRow>(
    `SELECT value, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now FROM config WHERE key=$1 FOR UPDATE`,
    [key]);
  return row ?? null;
}

/** Writes the config row `key`. */
export async function writeDreamMapConfigRow(raw: EngineRawRead, key: string, value: string): Promise<void> {
  await raw('UPDATE config SET value=$2 WHERE key=$1', [key, value]);
}

/** Upserts a dream breaker reset of `baseKey` into the map at `resetsKey`, dropping entries older than the 24 hour window. */
export async function recordDreamBreakerReset(raw: EngineRawRead, resetsKey: string, baseKey: string): Promise<void> {
  await raw(
    `INSERT INTO config (key, value)
       VALUES ($1, jsonb_build_object($2::text, to_char((now() + interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text)
     ON CONFLICT (key) DO UPDATE SET value = ((
       SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each_text(CASE WHEN jsonb_typeof(gbrain_try_jsonb(config.value)) = 'object' THEN gbrain_try_jsonb(config.value) ELSE '{}'::jsonb END) entry
        WHERE entry.key <> $2::text AND entry.value ~ '^[0-9]{4}-' AND entry.value::timestamptz > now() - interval '24 hours'
     ) || EXCLUDED.value::jsonb)::text`,
    [resetsKey, baseKey],
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Dream provenance (src/core/cycle/dream-provenance.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface DreamPageProvenanceStamp {
  slug: string;
  sourceId: string;
  cycleDate: string;
  /** When the child first wrote the page; a page older than this is not dream output and is left alone. Null stamps unconditionally. */
  firstWriteAt: Date | null;
  /** Drop the page's `seat` key before merging `frontmatter`. */
  clearSeat: boolean;
  /** Merged over the page's frontmatter. */
  frontmatter: Record<string, unknown>;
}

/** Stamps a dream-written page: merges `frontmatter` and keeps the FIRST cycle date in `dream_cycle_date` and `dream_created_cycle_date`. */
export async function stampDreamPageProvenance(raw: EngineRawRead, stamp: DreamPageProvenanceStamp): Promise<void> {
  await executeRawJsonb(
    { executeRaw: raw },
    `UPDATE pages
            SET frontmatter = (COALESCE(frontmatter, '{}'::jsonb) - CASE WHEN $5::boolean THEN 'seat' ELSE '' END)
                              || $6::jsonb
                              || jsonb_build_object(
                                   'dream_cycle_date',
                                   COALESCE(NULLIF(frontmatter->>'dream_created_cycle_date', ''), NULLIF(frontmatter->>'dream_cycle_date', ''), $3),
                                   'dream_created_cycle_date',
                                   COALESCE(NULLIF(frontmatter->>'dream_created_cycle_date', ''), NULLIF(frontmatter->>'dream_cycle_date', ''), $3)
                                 )
          WHERE slug = $1 AND source_id = $2
            AND ($4::timestamptz IS NULL
                 OR frontmatter->>'dream_generated' = 'true'
                 OR created_at >= $4::timestamptz)`,
    [stamp.slug, stamp.sourceId, stamp.cycleDate, stamp.firstWriteAt?.toISOString() ?? null, stamp.clearSeat],
    [stamp.frontmatter],
  );
}

/** The ids of the live page `slug` in `sourceId` (zero or one row). */
export async function listDreamPageIds(raw: EngineRawRead, slug: string, sourceId: string): Promise<Array<{ id: number }>> {
  return raw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2 AND deleted_at IS NULL', [slug, sourceId]);
}

export interface DreamProvenanceCounts { found: number; earlier: number }

/** How many dream pages carry `cycleDate` (not counting the summary page), and how many of `writtenSlugs` keep an earlier cycle's date. */
export async function countDreamProvenancePages(raw: EngineRawRead, sourceId: string, cycleDate: string, summarySlug: string, writtenSlugs: string[]): Promise<DreamProvenanceCounts | null> {
  const [row] = await raw<DreamProvenanceCounts>(
    `SELECT count(*) FILTER (WHERE frontmatter->>'dream_cycle_date' = $2 AND slug <> $3)::int AS found,
            count(*) FILTER (WHERE slug = ANY($4::text[]) AND COALESCE(frontmatter->>'dream_cycle_date', '') NOT IN ('', $2))::int AS earlier
       FROM pages
      WHERE source_id = $1 AND deleted_at IS NULL AND frontmatter->>'dream_generated' = 'true'`,
    [sourceId, cycleDate, summarySlug, writtenSlugs]);
  return row ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Write deferral receipts (src/core/cycle/dream-write-deferral.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface DreamDeferralReceipt { state: string; error_code: string | null; error_message: string | null }

/** The durable receipt of a deferred write by request row id, or null when none exists. */
export async function readDreamDeferralReceipt(raw: EngineRawRead, receiptId: string): Promise<DreamDeferralReceipt | null> {
  const [row] = await raw<DreamDeferralReceipt>(
    'SELECT state, error_code, error_message FROM persistence_requests WHERE id=$1::uuid', [receiptId]);
  return row ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The consolidate phase (src/core/cycle/phases/consolidate.ts)
// ---------------------------------------------------------------------------------------------------------------------

export interface ConsolidationClaimValue { id: number; claim_value: number | string | null }

/** The typed claim value of each fact in `ids`. */
export async function listConsolidationClaimValues(raw: EngineRawRead, ids: number[]): Promise<ConsolidationClaimValue[]> {
  return raw<ConsolidationClaimValue>('SELECT id, claim_value FROM facts WHERE id = ANY($1::bigint[])', [ids]);
}

/** Sets a consolidated fact's `valid_until`; a no-op when it already holds `validUntil`. */
export async function setConsolidatedFactValidUntil(raw: EngineRawRead, validUntil: Date, id: number): Promise<void> {
  await raw(
    // Only UPDATE when the new value would actually change. Avoids
    // touching updated_at on no-op rewrites and keeps idempotency
    // observable in the DB (zero affected rows on stable re-run).
    `UPDATE facts
         SET valid_until = $1
       WHERE id = $2
         AND (valid_until IS DISTINCT FROM $1)`,
    [validUntil, id],
  );
}

/** The ids among `ids` of facts on a page that names readers (a member page). */
export async function listReadersSourcedFactIds(raw: EngineRawRead, ids: number[]): Promise<Array<{ id: number }>> {
  const { text, params } = renderFragment(sqlFragment`SELECT id FROM facts WHERE id = ANY(${ids}::bigint[]) AND ${trustedSql(readersSourcedFactSql('facts'))}`);
  return raw<{ id: number }>(text, params);
}

/** The ids of the live page `slug` in `sourceId` (zero or one row). */
export async function findConsolidationPageIds(raw: EngineRawRead, sourceId: string, slug: string): Promise<Array<{ id: number }>> {
  return raw<{ id: number }>(
    `SELECT id FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL LIMIT 1`,
    [sourceId, slug],
  );
}

/** The highest take row number on a page, 0 when it has none. */
export async function readConsolidationTakesMaxRowNum(raw: EngineRawRead, pageId: number): Promise<number> {
  const rows = await raw<{ max: number }>(
    `SELECT COALESCE(MAX(row_num), 0)::int AS max FROM takes WHERE page_id = $1`,
    [pageId],
  );
  return rows[0]?.max ?? 0;
}

export interface ConsolidatedTake { id: number; resolved_at: Date | null }

/** The earliest consolidated take (self-held fact) of `claim` on a page, whether or not it is active (zero or one row). */
export async function findConsolidatedTakes(raw: EngineRawRead, pageId: number, claim: string): Promise<ConsolidatedTake[]> {
  return raw<ConsolidatedTake>(
    `SELECT id, resolved_at FROM takes
           WHERE page_id = $1 AND claim = $2 AND kind = 'fact' AND holder = 'self'
           ORDER BY id
           LIMIT 1`,
    [pageId, claim],
  );
}

/** Refreshes a consolidated take's source-aggregation string. */
export async function refreshConsolidatedTakeSource(raw: EngineRawRead, source: string, id: number): Promise<void> {
  await raw(`UPDATE takes SET source = $1, updated_at = now() WHERE id = $2`, [source, id]);
}

/** The ids of the take at `rowNum` on a page. */
export async function findConsolidatedTakeIds(raw: EngineRawRead, pageId: number, rowNum: number): Promise<Array<{ id: number }>> {
  return raw<{ id: number }>(
    `SELECT id FROM takes WHERE page_id = $1 AND row_num = $2`,
    [pageId, rowNum],
  );
}

export interface ConsolidationClaimShapeRow { id: number; claim_metric: string | null; claim_unit: string | null; claim_period: string | null }

/** The typed claim columns of each fact in `ids`. */
export async function listConsolidationClaimShapes(raw: EngineRawRead, ids: number[]): Promise<ConsolidationClaimShapeRow[]> {
  return raw<ConsolidationClaimShapeRow>(`SELECT id, claim_metric, claim_unit, claim_period FROM facts WHERE id = ANY($1::bigint[])`, [ids]);
}

// ---------------------------------------------------------------------------------------------------------------------
// The synthesize family (src/core/cycle/synthesize*.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** The `raw_source` of every live dream-generated page in `sourceId` that names one, distinct. */
export async function listRetainedDreamOutputSources(raw: EngineRawRead, sourceId: string): Promise<Array<{ raw_source: string }>> {
  return raw<{ raw_source: string }>(
    `SELECT DISTINCT frontmatter->>'raw_source' AS raw_source
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND frontmatter->>'dream_generated' = 'true'
        AND COALESCE(frontmatter->>'raw_source', '') <> ''`,
    [sourceId],
  );
}

/** The incarnation of `sourceId`, or null when the source is missing. */
export async function readDreamSourceIncarnation(raw: EngineRawRead, sourceId: string): Promise<{ incarnation: string | null } | null> {
  const [row] = await raw<{ incarnation: string | null }>('SELECT incarnation FROM sources WHERE id = $1', [sourceId]);
  return row ?? null;
}

export interface DreamAtomPage {
  slug: string;
  title: string;
  compiled_truth: string;
  /** #9653: the page's knowledge_revision when it was read (a held concept's rebuild refuses if it moved). */
  revision: string;
  frontmatter: { concepts?: string[]; imported_from?: string };
  private: boolean;
}

/** The live atom pages of `sourceId` that were not imported, with whether each is private. */
export async function listDreamAtomPages(raw: EngineRawRead, sourceId: string): Promise<DreamAtomPage[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT slug, title, compiled_truth, knowledge_revision::text AS revision, frontmatter, NOT (${trustedSql(privatePagesFilterFragment('pages'))}) AS private
           FROM pages
          WHERE type = 'atom'
            AND source_id = ${sourceId}
            AND deleted_at IS NULL
            AND (frontmatter->>'imported_from') IS NULL`);
  return raw<DreamAtomPage>(text, params);
}

/** The slug, title and body (compiled truth, a newline, the timeline) of each live inline page of `slugs` in `sourceId`, by slug. */
export async function listSynthesisPageBodies(raw: EngineRawRead, sourceId: string, slugs: string[]): Promise<Array<{ slug: string; title: string | null; body: string | null }>> {
  return raw<{ slug: string; title: string | null; body: string | null }>(
    `SELECT slug, title, COALESCE(compiled_truth, '') || E'\\n' || COALESCE(timeline, '') AS body FROM pages
      WHERE source_id=$1 AND slug=ANY($2::text[]) AND deleted_at IS NULL AND body_storage <> 'segmented' ORDER BY slug COLLATE "C"`, [sourceId, slugs]);
}

/** Committed-or-pending requests on the output page after the child's put_page, oldest first. */
export async function listLaterPersistenceRequests(raw: EngineRawRead, sourceId: string, incarnation: string, slug: string, sequence: number | string): Promise<WriteRequest[]> {
  return raw<WriteRequest>(
    `SELECT * FROM persistence_requests
      WHERE source_id=$1 AND source_incarnation=$2 AND slug=$3 AND sequence > $4
        AND state IN ('queued','running','recovering','committed')
      ORDER BY sequence`, [sourceId, incarnation, slug, sequence]);
}

/**
 * #6757: the committed journal row of each retained call, looked up by request id (a uuid, as the column is) within
 * the cycle's source, which `persistence_requests_request_id` serves; a text cast of the column defeats every index.
 */
export const COMMITTED_OUTPUT_REQUESTS_SQL = `SELECT row_to_json(p) AS request FROM persistence_requests p
      WHERE p.source_id=$2 AND p.request_id=ANY($1::uuid[]) AND p.source_incarnation=$3
        AND p.operation='put_page' AND p.state='committed'
      ORDER BY p.sequence DESC`;

/** The committed put_page journal rows of `requestIds` in the cycle's source and incarnation, newest first. */
export async function listCommittedOutputRequests(raw: EngineRawRead, requestIds: string[], sourceId: string, incarnation: string): Promise<Array<{ request: WriteRequest }>> {
  return raw<{ request: WriteRequest }>(COMMITTED_OUTPUT_REQUESTS_SQL, [requestIds, sourceId, incarnation]);
}

/** The database clock now, as the driver returns it (a Date, or a string on some drivers). */
export async function readDreamVerifyEpoch(raw: EngineRawRead): Promise<unknown> {
  const rows = await raw<{ now: unknown }>('SELECT now() AS now');
  return rows[0]?.now;
}

/** The creation time of each job in `ids`. */
export async function listDreamJobCreatedAt(raw: EngineRawRead, ids: number[]): Promise<Array<{ id: number | string; created_at: unknown }>> {
  return raw<{ id: number | string; created_at: unknown }>(
    'SELECT id, created_at FROM minion_jobs WHERE id = ANY($1::int[])', [ids]);
}

export interface DreamPreRunRevision { compiled_truth: string; timeline: string | null; frontmatter: unknown }

/** The first version snapshot of a page taken at or after `sinceIso` (what the page held before a run wrote it), or null when none exists. */
export async function readDreamPreRunRevision(raw: EngineRawRead, slug: string, sourceId: string, sinceIso: string): Promise<DreamPreRunRevision | null> {
  const rows = await raw<DreamPreRunRevision>(
    `SELECT pv.compiled_truth, pv.timeline, pv.frontmatter
       FROM page_versions pv JOIN pages p ON p.id = pv.page_id
      WHERE p.slug = $1 AND p.source_id = $2 AND pv.snapshot_at >= $3::timestamptz
      ORDER BY pv.snapshot_at ASC, pv.id ASC LIMIT 1`,
    [slug, sourceId, sinceIso],
  );
  return rows[0] ?? null;
}

/** The id and idempotency key of each completed job of the key `key` or one of its chunks, by id. */
export async function listCompletedSynthJobs(raw: EngineRawRead, key: string): Promise<Array<{ id: number; idempotency_key: string }>> {
  return raw<{ id: number; idempotency_key: string }>(
    "SELECT id,idempotency_key FROM minion_jobs WHERE status='completed' AND (idempotency_key=$1 OR left(idempotency_key,length($1)+2)=$1||':c') ORDER BY id", [key]);
}

/** How many jobs under `keys` still count as existing (not cancelled or dead). */
export async function countCoalescibleSynthJobs(raw: EngineRawRead, keys: string[]): Promise<number> {
  const rows = await raw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM minion_jobs
              WHERE idempotency_key = ANY($1::text[])
                AND status NOT IN ('cancelled', 'dead')`,
    [keys],
  );
  return rows[0]?.n ?? 0;
}

/** The ids of the jobs still waiting or delayed in `queue`. */
export async function listWaitingChildJobIds(raw: EngineRawRead, queue: string): Promise<Array<{ id: number }>> {
  return raw<{ id: number }>(
    `SELECT id FROM minion_jobs WHERE queue = $1 AND status IN ('waiting', 'delayed')`,
    [queue],
  );
}

export interface DreamChildJobTiming {
  created_at: Date | string; started_at: Date | string | null; finished_at: Date | string | null;
  tokens_input: number | string | null; tokens_output: number | string | null; tokens_cache_read: number | string | null;
}

/** The timestamps and token counts of each job in `ids`. */
export async function listDreamChildJobTimings(raw: EngineRawRead, ids: number[]): Promise<DreamChildJobTiming[]> {
  return raw<DreamChildJobTiming>(
    `SELECT created_at, started_at, finished_at, tokens_input, tokens_output, tokens_cache_read FROM minion_jobs WHERE id = ANY($1::bigint[])`,
    [ids],
  );
}

/** The subagent jobs of the dream synthesis keys submitted for `sourceId` in the last 24 hours, not counting cancelled ones. */
export async function countRecentDreamSynthSubmissions(raw: EngineRawRead, sourceId: string): Promise<number> {
  const rows = await raw<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM minion_jobs
      WHERE name = 'subagent'
        AND (idempotency_key LIKE 'dream:synth-v2:%' OR idempotency_key IS NULL AND data->>'__released_idempotency_key' LIKE 'dream:synth-v2:%')
        AND COALESCE(NULLIF(data->>'source_id', ''), 'default') = $1
        AND status <> 'cancelled'
        AND created_at > NOW() - INTERVAL '24 hours'`,
    [sourceId],
  );
  return rows[0]?.n ?? 0;
}
