/**
 * The no-op embedding settle pass: one SQL implementation for both engines (Rust engine persistence, embed-configured
 * lane).
 *
 * `src/core/persistence/embedding-noop-settle.ts` settles, in bulk, queued page embedding effects whose chunks already
 * carry current vectors. It sent five statements through `executeRaw`: the due probe, the newest effect id, the locked
 * window, the candidate read and the settle update. Each is the text it has always sent, byte for byte, except the
 * candidate read: it names the write column, so it is a fragment and renderFragment numbers its values where they are
 * read ($1 the window, $2 the page ids, $3 the host, $4 the signature, $5 the model) instead of the caller's
 * hand-numbered $4, $5, $1, $2, $3. The values are the same. `refreshFenceClear('e')` and the protocol predicate are
 * written out; test/persistence-journal-statements.test.ts pins every statement against the caller's original builder.
 * Decisions stay with the caller: it guards each candidate's source and keeps the cursor.
 *
 * `exec` is the engine itself, a transaction's clone included, so each statement reaches the connection it reached
 * before.
 */
import { quoteIdentifier } from '../search/embedding-column.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** The engine a settle statement runs on: its own `executeRaw`. */
export interface NoopSettleExec { executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> }

/** `probeNoopEmbeddingSettle`: $1 the cursor (effect id text). An unattempted queued embedding effect past it. */
export const NOOP_SETTLE_DUE_SQL = `SELECT 1 FROM persistence_effects e WHERE e.id>$1::bigint AND e.kind='embedding' AND e.state='queued'
    AND e.attempts=0 AND e.recovery IS NULL ORDER BY e.id LIMIT 1`;

/** `lockNoopEmbeddingWindow`: the newest effect id, read before the window. */
export const NOOP_SETTLE_NEWEST_SQL = 'SELECT COALESCE(max(id),0)::text AS newest FROM persistence_effects';

/** `lockNoopEmbeddingWindow`: $1 the cursor, $2 the window size. The next unattempted embedding effects by id, locked. */
export const NOOP_SETTLE_WINDOW_SQL = `SELECT e.id::text AS id, (e.data->>'page_id')::int AS page_id
      FROM persistence_effects e WHERE e.id>$1::bigint AND e.kind='embedding' AND e.state='queued' AND e.attempts=0 AND e.recovery IS NULL
      ORDER BY e.id LIMIT $2 FOR UPDATE SKIP LOCKED`;

/** `refreshFenceClear('e')` (worktree-refresh-schema.ts): no refresh fence holds the effect's worktree. */
const EFFECT_FENCE_CLEAR_SQL = `NOT EXISTS (SELECT 1 FROM persistence_worktree_refreshes fence WHERE fence.worktree_id=e.worktree_id
        AND fence.state IN ('fenced','merged','recovery_required'))`;

/** `settleNoopEmbeddingRows`: $1 the effect ids. The runner's claim and completion of a no-op effect, in one update. */
export const NOOP_SETTLE_UPDATE_SQL = `UPDATE persistence_effects SET state='committed', error_code=NULL, attempts=attempts+1,
        data=data-'retry_slugs'-'target_failures'-'failing_target', execution_token=NULL, claim_expires_at=NULL, claim_owner=NULL, outcome='{}'::jsonb, updated_at=now()
      WHERE id=ANY($1::text[]::bigint[]) AND state='queued' AND recovery IS NULL AND set_config('gbrain.persistence_protocol','2',true)='2' RETURNING id, request_id`;

/** One effect of the locked window: its id as text and the page it names (null when its data names none). */
export interface NoopSettleWindowRow { id: string; page_id: number | null }
/** `lockNoopEmbeddingWindow`: the newest effect id and the locked window. */
export interface NoopSettleWindow { newest: string; rows: NoopSettleWindowRow[] }
/** `readNoopEmbeddingCandidates`: the window, its pages and the completion test's inputs. */
export interface NoopSettleCandidateSpec {
  hostId: string;
  signature: string;
  /** The model every chunk's vector must carry (`IS NOT DISTINCT FROM`). */
  expectedModel: string | null;
  /** The write column (`embeddingWriteTarget`), registry-resolved. */
  column: string;
  window: readonly string[];
  pageIds: readonly number[];
}
/** A window effect the runner would find nothing to embed for, before its source guard. */
export interface NoopSettleCandidate { id: string; kind: string; source_id: string; source_incarnation: string; worktree_id: string | null }
/** A settled effect and its request. */
export interface NoopSettledRow { id: string | number; request_id: string }

/** Whether an unattempted queued embedding effect lies past `from`: one indexed read, no transaction. */
export async function probeNoopEmbeddingSettle(exec: NoopSettleExec, from: string): Promise<boolean> {
  return (await exec.executeRaw(NOOP_SETTLE_DUE_SQL, [from])).length > 0;
}

/** The newest effect id, then the next `limit` unattempted embedding effects past `from`, locked (skip locked). */
export async function lockNoopEmbeddingWindow(exec: NoopSettleExec, spec: { from: string; limit: number }): Promise<NoopSettleWindow> {
  // An aggregate always returns its one row; '0' only covers a driver stub that returns none.
  const newest = (await exec.executeRaw<{ newest: string }>(NOOP_SETTLE_NEWEST_SQL))[0]?.newest ?? '0';
  const rows = await exec.executeRaw<NoopSettleWindowRow>(NOOP_SETTLE_WINDOW_SQL, [spec.from, spec.limit]);
  return { newest, rows };
}

/**
 * The window effects the runner would find nothing to embed for: a plain page effect due now and claimable by this
 * host, no recovery on its worktree, no uncommitted withdrawal mirror, its page live at the effect's revision with its
 * text projection sealed there and stamped with `signature`, and every chunk carrying a vector of its current text
 * from `expectedModel`. Share-locks those pages.
 */
export async function readNoopEmbeddingCandidates(exec: NoopSettleExec, spec: NoopSettleCandidateSpec): Promise<NoopSettleCandidate[]> {
  const vector = trustedSql(quoteIdentifier(spec.column));
  const fence = trustedSql(EFFECT_FENCE_CLEAR_SQL);
  // chunk-visibility-ok: every row of the page, staged or retired included, must pass the completion test, so a row a reader would not see only leaves the effect for the runner.
  const { text, params } = renderFragment(sqlFragment`SELECT e.id::text AS id, e.kind, e.source_id, e.source_incarnation, e.worktree_id
      FROM persistence_effects e
      JOIN pages p ON p.id=(e.data->>'page_id')::int AND p.source_id=e.source_id
      WHERE e.id=ANY(${[...spec.window]}::text[]::bigint[]) AND p.id=ANY(${[...spec.pageIds]}::int[]) AND e.next_attempt_at<=now()
        AND NOT (e.data ? 'targets') AND NOT (e.data ? 'source_scan') AND NOT (e.data ? 'retry_slugs') AND NOT (e.data ? 'parked')
        AND (e.worktree_id IS NULL OR (EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=e.worktree_id AND w.owner_host_id=${spec.hostId}::uuid)
          AND ${fence}))
        AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror
          WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state<>'committed')
        AND p.deleted_at IS NULL AND p.knowledge_revision=e.revision AND p.text_projection_revision=p.knowledge_revision
        AND p.embedding_signature=${spec.signature}
        AND NOT EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id=p.id AND NOT (cc.${vector} IS NOT NULL
          AND cc.embedded_at IS NOT NULL AND cc.embedded_text_hash IS NOT DISTINCT FROM md5(cc.chunk_text) AND cc.model IS NOT DISTINCT FROM ${spec.expectedModel}))
      ORDER BY e.id
      FOR SHARE OF p`);
  return exec.executeRaw<NoopSettleCandidate>(text, params);
}

/** Settles these effects as the runner's claim and completion of a no-op leave them; the settled ids and requests. */
export async function settleNoopEmbeddingRows(exec: NoopSettleExec, ids: readonly string[]): Promise<NoopSettledRow[]> {
  return exec.executeRaw<NoopSettledRow>(NOOP_SETTLE_UPDATE_SQL, [[...ids]]);
}
