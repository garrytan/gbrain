/**
 * Caller pins for engine-sql/page-spend.ts: each member sends Postgres and PGLite the exact statement and parameters
 * its caller sent before the statement moved behind a typed member (page-embedding-lease.ts, page-embedding-budget.ts
 * and page-spend.ts at b5a4695f92). The expected texts below are those callers' own expressions, copied verbatim, so a
 * drift in either direction fails here. Four sites changed form, each pinned below with its new text:
 * - planPageEmbedding's junk hold on the row it just locked sent `UPDATE ... SET state = 'held'`, and now sends
 *   holdPageEmbedding's upsert, which writes the same row;
 * - the budget settle binds the unpriced call count as `$6::int` where it spliced the integer into the text;
 * - the held-page list and the size-state read are composed with sqlFragment, so their placeholders are numbered in
 *   order of use (the values and their order follow).
 */
import { describe, expect, test } from 'bun:test';
import * as ps from '../src/core/engine-sql/page-spend.ts';
import { PAGE_INLINE_MAX_BYTES, budgetRowAppliesFilter } from '../src/core/page-size-policy.ts';
import { quoteIdentifier } from '../src/core/search/embedding-column.ts';
import { chunkGenerationFilter } from '../src/core/search/safe-chunks.ts';

/** A recording executor: every statement and its parameters, answering `rows`. */
function recorder(rows: Record<string, unknown>[] = []) {
  const sent: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const tx = { executeRaw: async (sql: string, params?: unknown[]) => { sent.push({ sql, params }); return rows; } } as never;
  return { tx, sent };
}

async function sends(run: (tx: never) => Promise<unknown>, rows?: Record<string, unknown>[]) {
  const { tx, sent } = recorder(rows);
  await run(tx);
  return sent;
}

const RESERVATION_WINDOW_SQL = '(extract(epoch FROM reserved_at) * 1000000)::bigint::text';
const RESERVED_AT_SQL = (total: string, keep: string) =>
  `reserved_at = CASE WHEN ${total} <= 0 THEN NULL WHEN ${keep} THEN reserved_at ELSE GREATEST(now(), reserved_at + interval '1 millisecond') END`;
const TOKEN = '00000000-0000-4000-8000-00000000000a';

describe('engine-sql/page-spend sends each caller its old statement', () => {
  test('the window fragment and the lease prefix are the callers\' own', () => {
    expect(ps.RESERVATION_WINDOW_SQL).toBe(RESERVATION_WINDOW_SQL);
    expect(ps.PAGE_EMBEDDING_LEASE_PREFIX).toBe('embed-page:');
  });

  test('page-embedding-lease.ts: the take, the renewal, the release and the vectorless read', async () => {
    const take = await sends(tx => ps.takePageEmbeddingLease(tx, 'embed-page:7', { pid: 41, host: 'h' }, 10, TOKEN), [{ id: 'embed-page:7' }]);
    expect(take).toEqual([{ sql: `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token)
     VALUES ($1, $2, $3, now(), now() + make_interval(mins => $4::int), now(), $5::uuid)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id, holder_pid = EXCLUDED.holder_pid, holder_host = EXCLUDED.holder_host, acquired_at = now(),
       ttl_expires_at = EXCLUDED.ttl_expires_at, last_refreshed_at = now(), acquisition_token = EXCLUDED.acquisition_token
     WHERE gbrain_cycle_locks.ttl_expires_at < now()
     RETURNING id`, params: ['embed-page:7', 41, 'h', 10, TOKEN] }]);
    const { tx: busy } = recorder([]);
    expect(await ps.takePageEmbeddingLease(busy, 'embed-page:7', { pid: 41, host: 'h' }, 10, TOKEN)).toBe(false);
    const { tx: held } = recorder([{ id: 'embed-page:7' }]);
    expect(await ps.takePageEmbeddingLease(held, 'embed-page:7', { pid: 41, host: 'h' }, 10, TOKEN)).toBe(true);
    expect(await sends(tx => ps.renewPageEmbeddingLease(tx, 'embed-page:7', TOKEN, 10))).toEqual([{
      sql: `UPDATE gbrain_cycle_locks SET ttl_expires_at = now() + make_interval(mins => $3::int), last_refreshed_at = now()
      WHERE id = $1 AND acquisition_token = $2::uuid RETURNING id`, params: ['embed-page:7', TOKEN, 10] }]);
    expect(await sends(tx => ps.releasePageEmbeddingLease(tx, 'embed-page:7', TOKEN))).toEqual([{ sql: `DELETE FROM gbrain_cycle_locks
        WHERE (id = $1 AND acquisition_token = $2::uuid) OR (id LIKE 'embed-page:%' AND ttl_expires_at < now())`, params: ['embed-page:7', TOKEN] }]);
    const { tx, sent } = recorder([{ chunk_index: '2' }, { chunk_index: 5 }]);
    expect(await ps.listVectorlessChunkIndexes(tx, 7, 'embedding')).toEqual([2, 5]);
    expect(sent).toEqual([{ sql: `SELECT cc.chunk_index FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = $1 AND cc.${quoteIdentifier('embedding')} IS NULL AND ${chunkGenerationFilter('p', 'cc')}`, params: [7] }]);
  });

  test('page-embedding-budget.ts: the hold read, the holds and the approval', async () => {
    expect(await sends(tx => ps.readPageEmbeddingHolds(tx, 7))).toEqual([{
      sql: `SELECT COALESCE(p.frontmatter->'transcript_archive'->>'embedding_hold', p.frontmatter->'call_import'->>'embedding_hold') AS marker, b.state, b.reason
     FROM pages p LEFT JOIN page_embedding_budget b ON b.page_id = p.id WHERE p.id = $1`, params: [7] }]);
    const { tx: none } = recorder([]);
    expect(await ps.readPageEmbeddingHolds(none, 7)).toBeNull();
    expect(await sends(tx => ps.writePageEmbeddingHold(tx, 7, 'call_import', 'replace'))).toEqual([{
      sql: `INSERT INTO page_embedding_budget (page_id, state, reason) VALUES ($1, 'held', $2)
    ON CONFLICT (page_id) DO UPDATE SET state = 'held', reason = EXCLUDED.reason, updated_at = now()`, params: [7, 'call_import'] }]);
    expect(await sends(tx => ps.writePageEmbeddingHold(tx, 7, 'call_import', 'if_absent'))).toEqual([{
      sql: "INSERT INTO page_embedding_budget (page_id, state, reason) VALUES ($1, 'held', $2) ON CONFLICT (page_id) DO NOTHING", params: [7, 'call_import'] }]);
    expect(await sends(tx => ps.openPageEmbeddingHold(tx, 7))).toEqual([{
      sql: "UPDATE page_embedding_budget SET state = 'open', reason = NULL, updated_at = now() WHERE page_id = $1", params: [7] }]);
  });

  test('page-embedding-budget.ts and page-spend.ts: the ledger lock on each table', async () => {
    const row = { state: 'open', reason: null, embedding_signature: 's', spent_usd: '0.5', reserved_usd: '0.25', cap_usd: '2', stale_reservation: true };
    const { tx, sent } = recorder([row]);
    expect(await ps.lockPageSpendLedger(tx, { table: 'page_embedding_budget', pageId: 7 })).toEqual({
      state: 'open', reason: null, embedding_signature: 's', spent_usd: 0.5, reserved_usd: 0.25, cap_usd: 2, stale_reservation: true });
    expect(sent).toEqual([
      { sql: 'INSERT INTO page_embedding_budget (page_id) VALUES ($1) ON CONFLICT (page_id) DO NOTHING', params: [7] },
      { sql: `SELECT state, reason, embedding_signature, spent_usd, reserved_usd, cap_usd,
        (reserved_usd > 0 AND updated_at < now() - interval '1 hour') AS stale_reservation
      FROM page_embedding_budget WHERE page_id = $1 FOR UPDATE`, params: [7] }]);
    const derived = recorder([{ spent_usd: '1', reserved_usd: '0', stale_reservation: false }]);
    expect(await ps.lockPageSpendLedger(derived.tx, { table: 'page_derivation_spend', pageId: 7, family: 'facts' })).toEqual({
      state: null, reason: null, embedding_signature: null, cap_usd: null, spent_usd: 1, reserved_usd: 0, stale_reservation: false });
    expect(derived.sent).toEqual([
      { sql: 'INSERT INTO page_derivation_spend (page_id, family) VALUES ($1, $2) ON CONFLICT (page_id, family) DO NOTHING', params: [7, 'facts'] },
      { sql: `SELECT spent_usd, reserved_usd,
        (reserved_usd > 0 AND updated_at < now() - interval '1 hour') AS stale_reservation
      FROM page_derivation_spend WHERE page_id = $1 AND family = $2 FOR UPDATE`, params: [7, 'facts'] }]);
    const { tx: gone } = recorder([]);
    expect(await ps.lockPageSpendLedger(gone, { table: 'page_embedding_budget', pageId: 7 })).toBeNull();
  });

  test('the reservation writes: the plan, the budget reservation and the derivation reservation', async () => {
    const plan = await sends(tx => ps.writePageSpendReservation(tx, { table: 'page_embedding_budget', pageId: 7 },
      { spent: 0.5, reserved: 0.25, keepWindow: true, signature: 's', plan: { state: 'capped', reason: 'cap_reached', capUsd: 2 } }));
    expect(plan).toEqual([{ sql: `UPDATE page_embedding_budget SET state = $2, reason = $3, embedding_signature = COALESCE($4, embedding_signature),
        spent_usd = $5::float8, reserved_usd = $6::float8, ${RESERVED_AT_SQL('$6::float8', '$8::boolean')},
        cap_usd = $7::float8, updated_at = now() WHERE page_id = $1 RETURNING ${RESERVATION_WINDOW_SQL} AS reservation_window`,
    params: [7, 'capped', 'cap_reached', 's', 0.5, 0.25, 2, true] }]);
    const budget = await sends(tx => ps.writePageSpendReservation(tx, { table: 'page_embedding_budget', pageId: 7 },
      { spent: 0.5, reserved: 0.25, keepWindow: false }));
    expect(budget).toEqual([{ sql: `UPDATE page_embedding_budget SET embedding_signature = COALESCE($2, embedding_signature),
        spent_usd = $3::float8, reserved_usd = $4::float8, ${RESERVED_AT_SQL('$4::float8', '$5::boolean')}, updated_at = now()
      WHERE page_id = $1 RETURNING ${RESERVATION_WINDOW_SQL} AS reservation_window`, params: [7, null, 0.5, 0.25, false] }]);
    const { tx, sent } = recorder([{ reservation_window: '1800000000000000' }]);
    expect(await ps.writePageSpendReservation(tx, { table: 'page_derivation_spend', pageId: 7, family: 'synopsis' },
      { spent: 1, reserved: 0.5, keepWindow: true })).toBe('1800000000000000');
    expect(sent).toEqual([{ sql: `UPDATE page_derivation_spend SET spent_usd = $3::float8,
        reserved_usd = $4::float8, ${RESERVED_AT_SQL('$4::float8', '$5::boolean')}, updated_at = now()
      WHERE page_id = $1 AND family = $2 RETURNING ${RESERVATION_WINDOW_SQL} AS reservation_window`, params: [7, 'synopsis', 1, 0.5, true] }]);
    const { tx: gone } = recorder([]);
    expect(await ps.writePageSpendReservation(gone, { table: 'page_embedding_budget', pageId: 7 }, { spent: 0, reserved: 0, keepWindow: false })).toBeNull();
  });

  test('page-spend.ts: the settle on each table', async () => {
    const budget = await sends(tx => ps.settlePageSpendReservation(tx, { table: 'page_embedding_budget', pageId: 7 }, 'w', 0.25, -1, 2.7));
    expect(budget).toEqual([{ sql: `UPDATE page_embedding_budget SET
      reserved_usd = CASE WHEN reserved_usd - $2::float8 <= $4::float8 THEN 0 ELSE reserved_usd - $2::float8 END,
      reserved_at = CASE WHEN reserved_usd - $2::float8 <= $4::float8 THEN NULL ELSE reserved_at END,
      spent_usd = spent_usd + $3::float8, unpriced_calls = unpriced_calls + $6::int, updated_at = now()
    WHERE page_id = $1 AND ${RESERVATION_WINDOW_SQL} = $5::text`, params: [7, 0.25, 0, 1e-9, 'w', 2] }]);
    const derived = await sends(tx => ps.settlePageSpendReservation(tx, { table: 'page_derivation_spend', pageId: 7, family: 'facts' }, 'w', 0.25, 0.1, 0));
    expect(derived).toEqual([{ sql: `UPDATE page_derivation_spend SET
      reserved_usd = CASE WHEN reserved_usd - $2::float8 <= $4::float8 THEN 0 ELSE reserved_usd - $2::float8 END,
      reserved_at = CASE WHEN reserved_usd - $2::float8 <= $4::float8 THEN NULL ELSE reserved_at END,
      spent_usd = spent_usd + $3::float8, updated_at = now()
    WHERE page_id = $1 AND ${RESERVATION_WINDOW_SQL} = $5::text AND family = $6`, params: [7, 0.25, 0.1, 1e-9, 'w', 'facts'] }]);
  });

  test('page-embedding-budget.ts: the held-page list', async () => {
    const pending = `(CASE WHEN p.body_storage = 'segmented' THEN cc.${quoteIdentifier('embedding')} IS NULL ELSE cc.embedded_at IS NULL END)`;
    const sql = (filters: string[]) => `SELECT p.slug, p.source_id, b.state, b.reason, b.spent_usd, b.cap_usd,
      (SELECT count(*)::int FROM content_chunks cc WHERE cc.page_id = p.id AND ${pending} AND ${chunkGenerationFilter('p', 'cc')}) AS pending_chunks,
      (SELECT COALESCE(sum(length(cc.chunk_text)), 0)::bigint FROM content_chunks cc WHERE cc.page_id = p.id AND ${pending} AND ${chunkGenerationFilter('p', 'cc')}) AS pending_chars
    FROM page_embedding_budget b JOIN pages p ON p.id = b.page_id
    WHERE ${filters.join(' AND ')} ORDER BY b.updated_at DESC, p.id LIMIT $${filters.length - 2}::int`;
    const base = [budgetRowAppliesFilter('b', 'p'), 'p.deleted_at IS NULL', `NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')`];
    const row = { slug: 'a', source_id: 'default', state: 'held' as const, reason: 'r', spent_usd: '0.5', cap_usd: null, pending_chunks: '3', pending_chars: '40' };
    const { tx, sent } = recorder([row]);
    expect(await ps.listBudgetLimitedPageRows(tx, 'embedding', { limit: 1000 })).toEqual([
      { ...row, spent_usd: 0.5, cap_usd: null, pending_chunks: 3, pending_chars: 40 }]);
    expect(sent).toEqual([{ sql: sql(base), params: [1000] }]);
    expect(await sends(t => ps.listBudgetLimitedPageRows(t, 'embedding', { state: 'capped', sourceId: 'src', limit: null }))).toEqual([
      { sql: sql([...base, 'b.state = $1', 'p.source_id = $2']), params: ['capped', 'src', null] }]);
  });

  test('page-embedding-budget.ts: the size-state rows, by slug or for the whole source', async () => {
    const bytes = `(CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END)`;
    const sql = (slugs: boolean) => `SELECT p.slug, ${bytes}::bigint AS bytes, p.body_storage = 'segmented' AS segmented, p.frontmatter, b.state, b.reason
       FROM pages p LEFT JOIN page_embedding_budget b ON b.page_id = p.id
      WHERE p.source_id = $1 AND p.deleted_at IS NULL${slugs ? ' AND p.slug = ANY($2::text[])' : ''}
        AND (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip' OR ${bytes} > $${slugs ? 3 : 2} OR p.body_storage = 'segmented' OR b.page_id IS NOT NULL) ORDER BY p.slug`;
    const { tx, sent } = recorder([{ slug: 'a', bytes: '12', segmented: true, frontmatter: {}, state: null, reason: null }]);
    expect(await ps.readPageSizeStateRows(tx, 'default', ['a'])).toEqual([{ slug: 'a', bytes: 12, segmented: true, frontmatter: {}, state: null, reason: null }]);
    expect(sent).toEqual([{ sql: sql(true), params: ['default', ['a'], PAGE_INLINE_MAX_BYTES] }]);
    expect(await sends(t => ps.readPageSizeStateRows(t, 'default', null))).toEqual([{ sql: sql(false), params: ['default', PAGE_INLINE_MAX_BYTES] }]);
  });
});
