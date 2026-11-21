/**
 * Loop mutes (`loop_suppressions`, src/schema.sql) and the open-loop statements a mute, an unmute and the Gmail thread
 * verdict run (#5012): the statements loops-store.ts ran through `executeRaw`, with the same text and parameters, on
 * the engine's own raw path; only their home moved. loops-store.ts still lower-cases `value` and shapes the results.
 *
 * `'muted'`, `'mute_recheck'` and `'unmuted'` are `MUTED`, `MUTE_RECHECK` and `UNMUTED` in loops-store.ts, written
 * here as literals so this module needs no runtime import of the store.
 */
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

/** A mute's kind: a counterparty email or a Gmail thread id. */
export type SuppressionKind = 'sender' | 'thread';

function suppressionMatch(kind: SuppressionKind, value: string): SqlFragment {
  return kind === 'sender' ? sqlFragment`counterparty_email = ${value}` : sqlFragment`lower(thread_id) = ${value}`;
}

/** suppressionMatch over the open_loops alias `l`. */
function loopSuppressionMatch(kind: SuppressionKind, value: string): SqlFragment {
  return kind === 'sender' ? sqlFragment`l.counterparty_email = ${value}` : sqlFragment`lower(l.thread_id) = ${value}`;
}

/** Records the suppression; a row that exists stays as it is. */
export async function addLoopSuppression(exec: SqlExecutor, sourceId: string, kind: SuppressionKind, value: string): Promise<void> {
  await exec.executeRaw(
    `INSERT INTO loop_suppressions (source_id, kind, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (source_id, kind, value) DO NOTHING`,
    [sourceId, kind, value],
  );
}

/** Deletes the exact suppression row; the number of rows removed. */
export async function removeLoopSuppression(exec: SqlExecutor, sourceId: string, kind: SuppressionKind, value: string): Promise<number> {
  const rows = await exec.executeRaw<{ value: string }>(
    `DELETE FROM loop_suppressions
      WHERE source_id = $1 AND kind = $2 AND value = $3
      RETURNING value`,
    [sourceId, kind, value],
  );
  return rows.length;
}

/** Every suppression of a source. */
export async function listLoopSuppressions(exec: LegacyUnscopedRead, sourceId: string): Promise<Array<{ kind: string; value: string }>> {
  return exec.executeRaw<{ kind: string; value: string }>(
    `SELECT kind, value FROM loop_suppressions WHERE source_id = $1`,
    [sourceId],
  );
}

/** The threads with loops an unmute queued for re-check, with the greatest page slug of those loops, by thread id. */
export async function listMuteRecheckThreads(exec: LegacyUnscopedRead, sourceId: string): Promise<Array<{ thread_id: string; page_slug: string | null }>> {
  return exec.executeRaw<{ thread_id: string; page_slug: string | null }>(
    `SELECT thread_id, max(page_slug) AS page_slug FROM open_loops
      WHERE source_id = $1 AND closed_by = 'mute_recheck' AND thread_id IS NOT NULL
      GROUP BY thread_id ORDER BY thread_id`,
    [sourceId],
  );
}

/** The reply-owed loops a mute covers (open, or queued by an earlier unmute); `apply` closes them as `dropped` by `muted`. Ids ascending. */
export async function closeMutedLoops(exec: SqlExecutor, sourceId: string, kind: SuppressionKind, value: string, apply: boolean): Promise<number[]> {
  const where = sqlFragment`source_id = ${sourceId} AND loop_type = 'unanswered_inbound' AND ${suppressionMatch(kind, value)}
       AND (status = 'open' OR closed_by = 'mute_recheck')`;
  const { text, params } = renderFragment(apply
    ? sqlFragment`UPDATE open_loops SET status = 'dropped', closed_at = now(), closed_by = 'muted', updated_at = now()
        WHERE ${where} RETURNING id`
    : sqlFragment`SELECT id FROM open_loops WHERE ${where} ORDER BY id`);
  const rows = await exec.executeRaw<{ id: number }>(text, params);
  return rows.map((r) => Number(r.id)).sort((a, b) => a - b);
}

/**
 * The loops this mute closed that no other suppression of the source covers, as `{ id, thread_id }`. `apply` queues a
 * loop on a thread for re-check (`mute_recheck`); one without a thread stays closed (`unmuted`).
 */
export async function requeueMutedLoops(exec: SqlExecutor, sourceId: string, kind: SuppressionKind, value: string, apply: boolean): Promise<Array<{ id: number; thread_id: string | null }>> {
  const { text, params } = renderFragment(sqlFragment`${trustedSql(apply ? `UPDATE open_loops l SET closed_by = CASE WHEN l.thread_id IS NULL THEN 'unmuted' ELSE 'mute_recheck' END, updated_at = now()`
      : 'SELECT l.id, l.thread_id FROM open_loops l')}
      WHERE l.source_id = ${sourceId} AND l.closed_by = 'muted' AND ${loopSuppressionMatch(kind, value)}
        AND NOT EXISTS (SELECT 1 FROM loop_suppressions s
                         WHERE s.source_id = l.source_id AND NOT (s.kind = ${kind} AND s.value = ${value})
                           AND ((s.kind = 'thread' AND s.value = lower(l.thread_id))
                             OR (s.kind = 'sender' AND s.value = l.counterparty_email)))
      ${trustedSql(apply ? 'RETURNING l.id, l.thread_id' : '')}`);
  const rows = await exec.executeRaw<{ id: number; thread_id: string | null }>(text, params);
  return rows.map((r) => ({ id: Number(r.id), thread_id: r.thread_id })).sort((a, b) => a.id - b.id);
}

/** Closes a thread's thread-detector loops (open, or queued for re-check) as `done` by `closedBy`; only the types in `only` when it is not null. The number closed. */
export async function closeThreadLoops(exec: SqlExecutor, sourceId: string, threadId: string, closedBy: string, only: readonly string[] | null): Promise<number> {
  const rows = await exec.executeRaw<{ id: number }>(
    `UPDATE open_loops
       SET status = 'done', closed_at = now(), closed_by = $1, updated_at = now()
     WHERE source_id = $2 AND thread_id = $3 AND (status = 'open' OR closed_by = 'mute_recheck')
       AND detector = 'deterministic_thread'
       AND ($4::text IS NULL OR loop_type = ANY(string_to_array($4, ',')))
     RETURNING id`,
    [closedBy, sourceId, threadId, only && only.length > 0 ? only.join(',') : null],
  );
  return rows.length;
}

/** A thread's loops still queued for re-check stay closed (`unmuted`). The number settled. */
export async function settleMuteRecheck(exec: SqlExecutor, sourceId: string, threadId: string): Promise<number> {
  const rows = await exec.executeRaw<{ id: number }>(
    `UPDATE open_loops SET closed_by = 'unmuted', updated_at = now()
      WHERE source_id = $1 AND thread_id = $2 AND closed_by = 'mute_recheck' RETURNING id`,
    [sourceId, threadId],
  );
  return rows.length;
}
