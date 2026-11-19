/**
 * The subagent transcript and tool ledger: `subagent_messages` (one row per model turn) and
 * `subagent_tool_executions` (one row per tool call). The subagent handler, the oneshot runner, crash replay, the
 * transcript views, the read budget and the dream cycle's provenance reads all go through these members. SQL once for
 * both engines, so a store that is not SQL serves the same members (rust/docs/store/jobs-subagent.md).
 *
 * Every function takes the transaction (or the engine, for a single statement) it runs on. JSON arguments are JSON
 * text, bound through `$N::text::jsonb`: a JS string bound to a bare `::jsonb` double-encodes under postgres.js
 * (#2339), so no argument is ever a bare object here. Reads return the stored values as they are (a double-encoded
 * pre-fix row comes back as a string; the callers' own `typeof === 'string'` decode still applies), ids as numbers and
 * timestamps as `Date`s. Where a read had no ORDER BY, the order the callers never depended on is pinned (by `id`) so
 * the engines agree on it, and text sort keys are pinned to `COLLATE "C"`.
 */
import type { BrainEngine } from '../engine.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One `subagent_messages` row. */
export interface SubagentMessageRow {
  id: number;
  job_id: number;
  message_idx: number;
  role: 'user' | 'assistant';
  content_blocks: unknown;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_create: number | null;
  model: string | null;
  ended_at: Date;
}

/** A message to persist: `content_blocks` is JSON text. */
export interface SubagentMessageInsert {
  message_idx: number;
  role: 'user' | 'assistant';
  content_blocks: string;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cache_read: number | null;
  tokens_cache_create: number | null;
  model: string | null;
}

/** One `subagent_tool_executions` row. `ordinal` and `gbrain_tool_use_id` are null on legacy rows. */
export interface SubagentToolRow {
  id: number;
  job_id: number;
  message_idx: number;
  ordinal: number | null;
  tool_use_id: string;
  tool_name: string;
  input: unknown;
  status: 'pending' | 'complete' | 'failed';
  output: unknown;
  error: string | null;
  schema_version: number;
  provider_id: string | null;
  gbrain_tool_use_id: string | null;
  started_at: Date;
  ended_at: Date | null;
}

/** A tool row banked at a stable ordinal (`input` is JSON text). A null `ordinal` is a legacy row: it never conflicts. */
export interface SubagentToolInsert {
  message_idx: number;
  ordinal: number | null;
  tool_use_id: string;
  tool_name: string;
  input: string;
  status: 'pending' | 'complete';
}

/** The first observation of a gateway tool call: a `schema_version` 2 row carrying the stable id candidate. */
export interface SubagentToolStart {
  message_idx: number;
  ordinal: number;
  tool_use_id: string;
  tool_name: string;
  input: string;
  gbrain_tool_use_id: string;
  provider_id: string;
}

/** The row a settle touches: by stable id (every match), or by position (exactly one row, never a complete one). */
export type SubagentToolTarget =
  | { gbrainToolUseId: string }
  | { jobId: number; messageIdx: number; ordinal: number; toolUseId: string };

/** The tool row a failure inserts when no row exists yet for its position. */
export interface SubagentFailureFallback { tool_name: string; input: string }

export type SubagentToolOrder = 'replay' | 'id';

/** A `brain_put_page` row's outcome: its status, error and output. */
export interface SubagentWriteOutcome { status: string; error: string | null; output: unknown }

/** A oneshot ledger row: the ledger's own columns and the input fields recovery needs, as text. */
export interface SubagentOneshotLedgerRow {
  tool_use_id: string;
  ordinal: number | null;
  status: string;
  slug: string | null;
  content: string | null;
  request_id: string | null;
  skip_reason: string | null;
  batch_id: string | null;
}

type Rec = Record<string, unknown>;
const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

// ---------------------------------------------------------------- messages

/** The job's messages by `message_idx`; with `last`, only the newest one (an empty list when there is none). */
export async function listSubagentMessages(tx: Raw, jobId: number, opts?: { last?: boolean }): Promise<SubagentMessageRow[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT id, job_id, message_idx, role, content_blocks, tokens_in, tokens_out,
            tokens_cache_read, tokens_cache_create, model, ended_at
       FROM subagent_messages
      WHERE job_id = ${jobId}
      ORDER BY subagent_messages.message_idx ${trustedSql(opts?.last ? 'DESC LIMIT 1' : 'ASC')}`);
  const rows = await tx.executeRaw<Rec>(text, params);
  return rows.map(r => ({ ...r, id: num(r.id), job_id: num(r.job_id) }) as unknown as SubagentMessageRow);
}

/** How many messages the job has persisted. */
export async function countSubagentMessages(tx: Raw, jobId: number): Promise<number> {
  const [row] = await tx.executeRaw<{ n: number | string }>(`SELECT count(*)::int AS n FROM subagent_messages WHERE job_id = $1`, [jobId]);
  return Number(row?.n ?? 0);
}

/** Persists one message; a message already stored at the same `message_idx` stays as it is. */
export async function insertSubagentMessage(tx: Raw, jobId: number, m: SubagentMessageInsert): Promise<void> {
  await tx.executeRaw(
    `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks,
        tokens_in, tokens_out, tokens_cache_read, tokens_cache_create, model)
     VALUES ($1, $2, $3, $4::text::jsonb, $5, $6, $7, $8, $9)
     ON CONFLICT (job_id, message_idx) DO NOTHING`,
    [jobId, m.message_idx, m.role, m.content_blocks, m.tokens_in, m.tokens_out, m.tokens_cache_read, m.tokens_cache_create, m.model]);
}

// ---------------------------------------------------------------- tool ledger reads


/** The job's tool rows: `replay` order (`message_idx`, ordinal with legacy NULL as 0, `id`) or `id` order. */
export async function listSubagentToolExecutions(tx: Raw, jobId: number, order: SubagentToolOrder): Promise<SubagentToolRow[]> {
  const orderBy = order === 'replay'
    ? 'subagent_tool_executions.message_idx, COALESCE(subagent_tool_executions.ordinal, 0), subagent_tool_executions.id'
    : 'subagent_tool_executions.id';
  const { text, params } = renderFragment(sqlFragment`SELECT id, job_id, message_idx, ordinal, tool_use_id, tool_name, input, status, output, error, schema_version,
            provider_id, gbrain_tool_use_id::text AS gbrain_tool_use_id, started_at, ended_at
       FROM subagent_tool_executions
      WHERE job_id = ${jobId}
      ORDER BY ${trustedSql(orderBy)}`);
  const rows = await tx.executeRaw<Rec>(text, params);
  return rows.map(r => ({ ...r, id: num(r.id), job_id: num(r.job_id), ordinal: numOrNull(r.ordinal) }) as unknown as SubagentToolRow);
}

/**
 * Whether the job has a tool row of `status` (any when omitted) whose `tool_use_id` is `LIKE prefix || '%'`
 * (`toolUseIdPrefix` is a LIKE pattern prefix: `%` and `_` are wildcards).
 */
export async function hasSubagentToolExecution(tx: Raw, jobId: number, opts?: { status?: string; toolUseIdPrefix?: string }): Promise<boolean> {
  const status = opts?.status !== undefined ? sqlFragment` AND status = ${opts.status}` : sqlFragment``;
  const prefix = opts?.toolUseIdPrefix !== undefined ? sqlFragment` AND tool_use_id LIKE ${`${opts.toolUseIdPrefix}%`}` : sqlFragment``;
  const { text, params } = renderFragment(
    sqlFragment`SELECT 1 AS one FROM subagent_tool_executions WHERE job_id = ${jobId}${status}${prefix} LIMIT 1`);
  const rows = await tx.executeRaw(text, params);
  return rows.length > 0;
}

/** The `brain_put_page` rows' status, error and output, by `id`; scoped to a `tool_use_id` LIKE prefix when given. */
export async function listSubagentWriteOutcomes(tx: Raw, jobId: number, toolUseIdPrefix?: string): Promise<SubagentWriteOutcome[]> {
  const prefix = toolUseIdPrefix !== undefined ? sqlFragment` AND tool_use_id LIKE ${`${toolUseIdPrefix}%`}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT status, error, output FROM subagent_tool_executions WHERE job_id = ${jobId} AND tool_name = 'brain_put_page'${prefix} ORDER BY subagent_tool_executions.id`);
  return tx.executeRaw<SubagentWriteOutcome>(text, params);
}

/** The oneshot ledger of a job: rows whose `tool_use_id` is `LIKE prefix || '%'`, by `id`, with their input fields as text. */
export async function listSubagentOneshotLedger(tx: Raw, jobId: number, toolUseIdPrefix: string): Promise<SubagentOneshotLedgerRow[]> {
  const rows = await tx.executeRaw<Rec>(
    `SELECT tool_use_id, ordinal, status, input->>'slug' AS slug, input->>'content' AS content, input->>'request_id' AS request_id,
            input->>'skip_reason' AS skip_reason, input->>'batch_id' AS batch_id
       FROM subagent_tool_executions
      WHERE job_id = $1 AND tool_use_id LIKE $2
      ORDER BY subagent_tool_executions.id`,
    [jobId, `${toolUseIdPrefix}%`]);
  return rows.map(r => ({ ...r, ordinal: numOrNull(r.ordinal) }) as unknown as SubagentOneshotLedgerRow);
}

/** How many rows of `toolName` in `status` the jobs hold, and the bytes of their output as jsonb text (a SQL NULL output is no bytes). */
export async function summarizeSubagentToolExecutions(
  tx: Raw, jobIds: readonly number[], spec: { toolName: string; status: string },
): Promise<{ count: number; output_bytes: number }> {
  if (jobIds.length === 0) return { count: 0, output_bytes: 0 };
  const [row] = await tx.executeRaw<{ count: number | string; output_bytes: number | string | null }>(
    `SELECT count(*)::int AS count, COALESCE(sum(octet_length(output::text)), 0) AS output_bytes
       FROM subagent_tool_executions
      WHERE job_id = ANY($1::int[]) AND tool_name = $2 AND status = $3`,
    [jobIds, spec.toolName, spec.status]);
  return { count: Number(row?.count ?? 0), output_bytes: Number(row?.output_bytes ?? 0) };
}

// ---------------------------------------------------------------- dream provenance reads

/** A `brain_put_page` input's slug: the field of an object input, or of a double-encoded (jsonb string) pre-fix input. */

/** The distinct slugs the jobs' completed `brain_put_page` calls named, bytewise ascending; null (a call without a slug) last. */
export async function listSubagentPutPageSlugs(tx: Raw, jobIds: readonly number[]): Promise<Array<string | null>> {
  if (jobIds.length === 0) return [];
  const rows = await tx.executeRaw<{ slug: string | null }>(
    `SELECT slug FROM (
       SELECT DISTINCT COALESCE(input->>'slug', (input #>> '{}')::jsonb->>'slug') AS slug
         FROM subagent_tool_executions
        WHERE job_id = ANY($1::int[]) AND tool_name = 'brain_put_page' AND status = 'complete') s
      ORDER BY slug COLLATE "C"`,
    [jobIds]);
  return rows.map(r => r.slug);
}

/** Each completed `brain_put_page` call of the jobs: job, slug (null when it names none) and start time, by `id`. */
export async function listSubagentPutPageWrites(tx: Raw, jobIds: readonly number[]): Promise<Array<{ job_id: number; slug: string | null; started_at: Date }>> {
  if (jobIds.length === 0) return [];
  const rows = await tx.executeRaw<Rec>(
    `SELECT job_id, COALESCE(input->>'slug', (input #>> '{}')::jsonb->>'slug') AS slug, started_at
       FROM subagent_tool_executions
      WHERE job_id = ANY($1::int[]) AND tool_name = 'brain_put_page' AND status = 'complete'
      ORDER BY subagent_tool_executions.id`,
    [jobIds]);
  return rows.map(r => ({ ...r, job_id: num(r.job_id) }) as unknown as { job_id: number; slug: string | null; started_at: Date });
}

/** A retained `brain_put_page` call whose output says the write committed, with its job's idempotency key. */
export interface SubagentRetainedPutPage { job_id: number; job_key: string | null; input: unknown; output: unknown; started_at: Date | null }

/** The jobs' completed `brain_put_page` calls whose output state is `committed`, by `id`. */
export async function listSubagentRetainedPutPages(tx: Raw, jobIds: readonly number[]): Promise<SubagentRetainedPutPage[]> {
  if (jobIds.length === 0) return [];
  const rows = await tx.executeRaw<Rec>(
    `SELECT t.job_id, j.idempotency_key AS job_key, t.input, t.output, t.started_at
       FROM subagent_tool_executions t JOIN minion_jobs j ON j.id = t.job_id
      WHERE t.job_id = ANY($1::int[]) AND t.tool_name = 'brain_put_page' AND t.status = 'complete' AND t.output->>'state' = 'committed'
      ORDER BY t.id`,
    [jobIds]);
  return rows.map(r => ({ ...r, job_id: num(r.job_id) }) as unknown as SubagentRetainedPutPage);
}

/**
 * The pages a staging child staged: per slug the last completed `brain_put_page` whose output status is `staged`, with
 * the staged markdown (its output content, else its input content). Slugs bytewise ascending, a call without one last.
 */
export async function listSubagentStagedPages(tx: Raw, jobId: number): Promise<Array<{ slug: string | null; content: string | null }>> {
  return tx.executeRaw<{ slug: string | null; content: string | null }>(
    `SELECT DISTINCT ON ((output->>'slug') COLLATE "C") output->>'slug' AS slug, COALESCE(output->>'content', input->>'content') AS content
       FROM subagent_tool_executions
      WHERE job_id = $1 AND tool_name = 'brain_put_page' AND status = 'complete' AND output->>'status' = 'staged'
      ORDER BY (output->>'slug') COLLATE "C", subagent_tool_executions.id DESC`,
    [jobId]);
}

/**
 * The jobs' `brain_add_timeline_entry` calls whose input request id names a committed `add_timeline_entry` request of
 * `sourceId` with outcome status `ok`, by call `id`; the tool row's own status is not consulted. The request id is
 * read from the input object, or from a double-encoded input string.
 */
export async function listSubagentTimelineAppendCalls(
  tx: Raw, jobIds: readonly number[], sourceId: string,
): Promise<Array<{ request_id: string; slug: string; input: unknown }>> {
  if (jobIds.length === 0) return [];
  return tx.executeRaw<{ request_id: string; slug: string; input: unknown }>(
    `SELECT r.request_id::text AS request_id, r.slug, e.input
       FROM subagent_tool_executions e
       JOIN persistence_requests r ON r.request_id::text = COALESCE(e.input->>'request_id', (e.input #>> '{}')::jsonb->>'request_id')
      WHERE e.job_id = ANY($1::int[]) AND e.tool_name = 'brain_add_timeline_entry'
        AND r.operation = 'add_timeline_entry' AND r.source_id = $2 AND r.state = 'committed' AND r.outcome->>'status' = 'ok'
      ORDER BY e.id`,
    [jobIds, sourceId]);
}

// ---------------------------------------------------------------- tool ledger writes

/** `recordSubagentToolExecutions`' insert, with and without the legacy-row guard (constant text: no spliced SQL). */
const RECORD_TOOL_GUARDED_SQL = `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, ordinal)
       SELECT $1::bigint, $2::int, $3, $4::text, $5::text::jsonb, $6::text, $7::int
          WHERE NOT EXISTS (
            SELECT 1 FROM subagent_tool_executions
             WHERE job_id = $1 AND message_idx = $2 AND tool_use_id = $3
               AND ordinal IS NULL
          )
       ON CONFLICT (job_id, message_idx, ordinal) DO NOTHING`;
const RECORD_TOOL_SQL = `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, ordinal)
       VALUES ($1, $2, $3, $4, $5::text::jsonb, $6, $7)
       ON CONFLICT (job_id, message_idx, ordinal) DO NOTHING`;

/**
 * Banks tool rows at their stable ordinals; a row whose (`message_idx`, `ordinal`) already exists stays as it is.
 * `legacyGuard` also skips a row when a legacy (NULL ordinal) row of the same turn and `tool_use_id` exists, keeping
 * the "already recorded" meaning for rows that predate ordinal stamping (they never trip a conflict target).
 * Run it in a transaction to bank a batch atomically.
 */
export async function recordSubagentToolExecutions(tx: Raw, jobId: number, rows: readonly SubagentToolInsert[], opts?: { legacyGuard?: boolean }): Promise<void> {
  const sql = opts?.legacyGuard ? RECORD_TOOL_GUARDED_SQL : RECORD_TOOL_SQL;
  for (const r of rows) {
    await tx.executeRaw(
      sql,
      [jobId, r.message_idx, r.tool_use_id, r.tool_name, r.input, r.status, r.ordinal]);
  }
}

/**
 * Records the first observation of a gateway tool call as a pending `schema_version` 2 row and returns its stable id.
 * A row already at the (`message_idx`, `ordinal`) position is left as it is and ITS stable id comes back (null when
 * that row is a legacy one without it): a replay keeps the id its first run minted.
 */
export async function startSubagentToolExecution(tx: Raw, jobId: number, r: SubagentToolStart): Promise<string | null> {
  const [row] = await tx.executeRaw<{ gbrain_tool_use_id: string | null }>(
    `INSERT INTO subagent_tool_executions
       (job_id, message_idx, tool_use_id, tool_name, input, status, schema_version, ordinal, gbrain_tool_use_id, provider_id)
     VALUES ($1, $2, $3, $4, $5::text::jsonb, 'pending', 2, $6, $7, $8)
     ON CONFLICT (job_id, message_idx, ordinal) DO UPDATE
       SET status = subagent_tool_executions.status
     RETURNING gbrain_tool_use_id::text AS gbrain_tool_use_id`,
    [jobId, r.message_idx, r.tool_use_id, r.tool_name, r.input, r.ordinal, r.gbrain_tool_use_id, r.provider_id]);
  return row?.gbrain_tool_use_id ?? null;
}

/** The position target's row: its own ordinal first, then a legacy NULL one, never a row already complete. */

/**
 * Settles a tool row complete with `output` (JSON text). By stable id it updates every match, whatever its status; by
 * position it updates exactly one row (see `SubagentToolTarget`). Returns how many rows it settled.
 */
export async function completeSubagentToolExecution(tx: Raw, target: SubagentToolTarget, output: string): Promise<number> {
  const rows = 'gbrainToolUseId' in target
    ? await tx.executeRaw<{ id: number }>(
      `UPDATE subagent_tool_executions
          SET status = 'complete', output = $1::text::jsonb, ended_at = now()
        WHERE gbrain_tool_use_id::text = $2
        RETURNING id`,
      [output, target.gbrainToolUseId])
    : await tx.executeRaw<{ id: number }>(
      `UPDATE subagent_tool_executions
          SET status = 'complete', output = $4::text::jsonb, ended_at = now()
        WHERE id = (SELECT id FROM subagent_tool_executions
         WHERE job_id = $1 AND message_idx = $2 AND tool_use_id = $3
           AND (ordinal = $5 OR ordinal IS NULL)
           AND status <> 'complete'
         ORDER BY CASE WHEN ordinal = $5 THEN 0 ELSE 1 END, subagent_tool_executions.id
         LIMIT 1)
        RETURNING id`,
      [target.jobId, target.messageIdx, target.toolUseId, output, target.ordinal]);
  return rows.length;
}

/**
 * Settles a tool row failed with `error`, by the same targets as `completeSubagentToolExecution`. With a `fallback`
 * (positional targets), a position that had no settleable row gets one: inserted failed, or, when the position holds
 * a row of the same `tool_use_id` that is not complete, that row is failed. A complete row is never touched. Returns
 * how many rows it changed. Run it in a transaction: the update and the insert are one decision.
 */
export async function failSubagentToolExecution(tx: Raw, target: SubagentToolTarget, error: string, fallback?: SubagentFailureFallback): Promise<number> {
  if ('gbrainToolUseId' in target) {
    const rows = await tx.executeRaw<{ id: number }>(
      `UPDATE subagent_tool_executions
          SET status = 'failed', error = $1, ended_at = now()
        WHERE gbrain_tool_use_id::text = $2
        RETURNING id`,
      [error, target.gbrainToolUseId]);
    return rows.length;
  }
  const updated = await tx.executeRaw<{ id: number }>(
    `UPDATE subagent_tool_executions
        SET status = 'failed', error = $4, ended_at = now()
      WHERE id = (SELECT id FROM subagent_tool_executions
         WHERE job_id = $1 AND message_idx = $2 AND tool_use_id = $3
           AND (ordinal = $5 OR ordinal IS NULL)
           AND status <> 'complete'
         ORDER BY CASE WHEN ordinal = $5 THEN 0 ELSE 1 END, subagent_tool_executions.id
         LIMIT 1)
      RETURNING id`,
    [target.jobId, target.messageIdx, target.toolUseId, error, target.ordinal]);
  if (updated.length > 0 || !fallback) return updated.length;
  const inserted = await tx.executeRaw<{ id: number }>(
    `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, error, ended_at, ordinal)
     VALUES ($1, $2, $3, $4, $5::text::jsonb, 'failed', $6, now(), $7)
     ON CONFLICT (job_id, message_idx, ordinal) DO UPDATE
       SET status = 'failed', error = EXCLUDED.error, ended_at = now()
       WHERE subagent_tool_executions.tool_use_id = EXCLUDED.tool_use_id
         AND subagent_tool_executions.status <> 'complete'
     RETURNING id`,
    [target.jobId, target.messageIdx, target.toolUseId, fallback.tool_name, fallback.input, error, target.ordinal]);
  return inserted.length;
}
