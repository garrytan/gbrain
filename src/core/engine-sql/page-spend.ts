/**
 * The page embedding lease, the per-page spend ledgers and the reads around them, one function per BrainEngine member:
 * the statements page-embedding-lease.ts, page-embedding-budget.ts and page-spend.ts ran through executeRaw. PGLite and
 * Postgres run the same text those callers ran before; the Rust engine answers from its store (rust/docs/store/page_spend.md).
 * Each runs on the engine it is given, so a call on a transaction engine reads and writes inside that transaction.
 *
 * Lease lock contract: a lease is one `gbrain_cycle_locks` row `embed-page:<page id>`. `takePageEmbeddingLease` writes it
 * when no row exists or the row's TTL has passed, and reports whether it did; `renewPageEmbeddingLease` moves the TTL of
 * the row only while it still carries the holder's token; `releasePageEmbeddingLease` deletes the holder's row and every
 * `embed-page:` row whose TTL has passed. The holder, not the row, decides when to wait: these members never block.
 *
 * Ledgers: `page_embedding_budget` (one row per page) and `page_derivation_spend` (one row per page and family). A
 * reservation locks the row (`lockPageSpendLedger`, inserting it when absent), folds it in TypeScript and writes the
 * result (`writePageSpendReservation`), which returns the reservation window; a settle books inside that window only.
 */
import type { BrainEngine } from '../engine.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import { PAGE_INLINE_MAX_BYTES, budgetRowAppliesFilter } from '../page-size-policy.ts';
import { joinFragments, renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** Every page embedding lease id starts with this; the writer admin fingerprint leaves these rows out (admin-intent.ts). */
export const PAGE_EMBEDDING_LEASE_PREFIX = 'embed-page:';

/** A ledger row: the page's embedding budget, or one derivation family's spend on the page. */
export type PageSpendLedger = { table: 'page_embedding_budget'; pageId: number } | { table: 'page_derivation_spend'; pageId: number; family: 'facts' | 'synopsis' };

export type PageBudgetState = 'open' | 'held' | 'capped';

/** A locked ledger row. A derivation row has no state, reason, signature or cap: those read null. */
export interface PageSpendLedgerRow {
  state: PageBudgetState | null; reason: string | null; embedding_signature: string | null;
  spent_usd: number; reserved_usd: number; cap_usd: number | null; stale_reservation: boolean;
}

/**
 * What a reservation writes: the folded spend, the new reserved total, whether the open window stays (`keepWindow`),
 * and on the embedding ledger the signature (kept when null) and, for a plan, the state, reason and cap.
 */
export interface PageSpendReservationWrite {
  spent: number; reserved: number; keepWindow: boolean; signature?: string | null;
  plan?: { state: PageBudgetState; reason: string | null; capUsd: number | null };
}

/** One held or capped page with its waiting chunks (`gbrain embed --held`). */
export interface PageBudgetReport { slug: string; source_id: string; state: Exclude<PageBudgetState, 'open'>; reason: string | null;
  spent_usd: number; cap_usd: number | null; pending_chunks: number; pending_chars: number }

/** The filters of `listBudgetLimitedPageRows`; `limit: null` lists every row. */
export interface BudgetLimitedPagesOpts { state?: 'held' | 'capped'; sourceId?: string; limit: number | null }

/** A stored page a size state may apply to: its body bytes, storage, frontmatter and budget row. */
export interface PageSizeStateRow { slug: string; bytes: number; segmented: boolean; frontmatter: Record<string, unknown> | null; state: PageBudgetState | null; reason: string | null }

const RESERVED_EPSILON_USD = 1e-9;
/** A window's id: reserved_at in whole microseconds, as text (a bound timestamp parameter would lose the microseconds). */
export const RESERVATION_WINDOW_SQL = '(extract(epoch FROM reserved_at) * 1000000)::bigint::text';

/*
 * The reservation writes below spell RESERVATION_WINDOW_SQL out and set reserved_at to the open window's (`keepWindow`),
 * a new window's, or NULL when nothing is reserved. A new window's id is later than the one it replaces even on a
 * millisecond clock (PGLite), so the two never compare equal. The statements are constant text, so each keeps the
 * exact placeholders its caller sent.
 */
const RESERVE_DERIVATION_SQL = `UPDATE page_derivation_spend SET spent_usd = $3::float8,
        reserved_usd = $4::float8, reserved_at = CASE WHEN $4::float8 <= 0 THEN NULL WHEN $5::boolean THEN reserved_at ELSE GREATEST(now(), reserved_at + interval '1 millisecond') END, updated_at = now()
      WHERE page_id = $1 AND family = $2 RETURNING (extract(epoch FROM reserved_at) * 1000000)::bigint::text AS reservation_window`;
const RESERVE_BUDGET_PLAN_SQL = `UPDATE page_embedding_budget SET state = $2, reason = $3, embedding_signature = COALESCE($4, embedding_signature),
        spent_usd = $5::float8, reserved_usd = $6::float8, reserved_at = CASE WHEN $6::float8 <= 0 THEN NULL WHEN $8::boolean THEN reserved_at ELSE GREATEST(now(), reserved_at + interval '1 millisecond') END,
        cap_usd = $7::float8, updated_at = now() WHERE page_id = $1 RETURNING (extract(epoch FROM reserved_at) * 1000000)::bigint::text AS reservation_window`;
const RESERVE_BUDGET_SQL = `UPDATE page_embedding_budget SET embedding_signature = COALESCE($2, embedding_signature),
        spent_usd = $3::float8, reserved_usd = $4::float8, reserved_at = CASE WHEN $4::float8 <= 0 THEN NULL WHEN $5::boolean THEN reserved_at ELSE GREATEST(now(), reserved_at + interval '1 millisecond') END, updated_at = now()
      WHERE page_id = $1 RETURNING (extract(epoch FROM reserved_at) * 1000000)::bigint::text AS reservation_window`;
const SETTLE_BUDGET_SQL = `UPDATE page_embedding_budget SET
      reserved_usd = CASE WHEN reserved_usd - $2::float8 <= $4::float8 THEN 0 ELSE reserved_usd - $2::float8 END,
      reserved_at = CASE WHEN reserved_usd - $2::float8 <= $4::float8 THEN NULL ELSE reserved_at END,
      spent_usd = spent_usd + $3::float8, unpriced_calls = unpriced_calls + $6::int, updated_at = now()
    WHERE page_id = $1 AND (extract(epoch FROM reserved_at) * 1000000)::bigint::text = $5::text`;
const SETTLE_DERIVATION_SQL = `UPDATE page_derivation_spend SET
      reserved_usd = CASE WHEN reserved_usd - $2::float8 <= $4::float8 THEN 0 ELSE reserved_usd - $2::float8 END,
      reserved_at = CASE WHEN reserved_usd - $2::float8 <= $4::float8 THEN NULL ELSE reserved_at END,
      spent_usd = spent_usd + $3::float8, updated_at = now()
    WHERE page_id = $1 AND (extract(epoch FROM reserved_at) * 1000000)::bigint::text = $5::text AND family = $6`;

/** Writes the lease row when none exists or its TTL has passed; true when this holder now has it. */
export async function takePageEmbeddingLease(engine: Raw, id: string, holder: { pid: number; host: string }, ttlMinutes: number, token: string): Promise<boolean> {
  return (await engine.executeRaw(
    `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token)
     VALUES ($1, $2, $3, now(), now() + make_interval(mins => $4::int), now(), $5::uuid)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id, holder_pid = EXCLUDED.holder_pid, holder_host = EXCLUDED.holder_host, acquired_at = now(),
       ttl_expires_at = EXCLUDED.ttl_expires_at, last_refreshed_at = now(), acquisition_token = EXCLUDED.acquisition_token
     WHERE gbrain_cycle_locks.ttl_expires_at < now()
     RETURNING id`, [id, holder.pid, holder.host, ttlMinutes, token])).length > 0;
}

/** Moves the lease row's TTL while it still carries `token`; false when no such row is left. */
export async function renewPageEmbeddingLease(engine: Raw, id: string, token: string, ttlMinutes: number): Promise<boolean> {
  return (await engine.executeRaw(`UPDATE gbrain_cycle_locks SET ttl_expires_at = now() + make_interval(mins => $3::int), last_refreshed_at = now()
      WHERE id = $1 AND acquisition_token = $2::uuid RETURNING id`, [id, token, ttlMinutes])).length > 0;
}

/** Deletes the holder's lease row and every page embedding lease whose TTL has passed. */
export async function releasePageEmbeddingLease(engine: Raw, id: string, token: string): Promise<void> {
  await engine.executeRaw(`DELETE FROM gbrain_cycle_locks
        WHERE (id = $1 AND acquisition_token = $2::uuid) OR (id LIKE 'embed-page:%' AND ttl_expires_at < now())`, [id, token]);
}

/** Chunk indexes of the page's live rows with no vector in `column`. */
export async function listVectorlessChunkIndexes(engine: Raw, pageId: number, column: string): Promise<number[]> {
  const { text, params } = renderFragment(sqlFragment`SELECT cc.chunk_index FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = ${pageId} AND cc.${trustedSql(quoteIdentifier(column))} IS NULL AND ${trustedSql(chunkGenerationFilter('p', 'cc'))}`);
  const rows = await engine.executeRaw<{ chunk_index: number }>(text, params);
  return rows.map(row => Number(row.chunk_index));
}

/** The page's frontmatter hold marker and its budget row's state and reason; null for a missing page. */
export async function readPageEmbeddingHolds(engine: Raw, pageId: number): Promise<{ marker: string | null; state: string | null; reason: string | null } | null> {
  const [row] = await engine.executeRaw<{ marker: string | null; state: string | null; reason: string | null }>(
    `SELECT COALESCE(p.frontmatter->'transcript_archive'->>'embedding_hold', p.frontmatter->'call_import'->>'embedding_hold') AS marker, b.state, b.reason
     FROM pages p LEFT JOIN page_embedding_budget b ON b.page_id = p.id WHERE p.id = $1`, [pageId]);
  return row ?? null;
}

/** Holds the page's embedding for `reason`: `replace` sets the hold over any row, `if_absent` only writes a new row. */
export async function writePageEmbeddingHold(engine: Raw, pageId: number, reason: string, mode: 'replace' | 'if_absent'): Promise<void> {
  if (mode === 'if_absent') {
    await engine.executeRaw("INSERT INTO page_embedding_budget (page_id, state, reason) VALUES ($1, 'held', $2) ON CONFLICT (page_id) DO NOTHING", [pageId, reason]);
    return;
  }
  await engine.executeRaw(`INSERT INTO page_embedding_budget (page_id, state, reason) VALUES ($1, 'held', $2)
    ON CONFLICT (page_id) DO UPDATE SET state = 'held', reason = EXCLUDED.reason, updated_at = now()`, [pageId, reason]);
}

/** Lifts an approved hold: the page's budget row goes open with no reason. */
export async function openPageEmbeddingHold(engine: Raw, pageId: number): Promise<void> {
  await engine.executeRaw("UPDATE page_embedding_budget SET state = 'open', reason = NULL, updated_at = now() WHERE page_id = $1", [pageId]);
}

/** Inserts the ledger row when absent and reads it under a row lock (call inside a transaction); null when it is gone. */
export async function lockPageSpendLedger(engine: Raw, ledger: PageSpendLedger): Promise<PageSpendLedgerRow | null> {
  if (ledger.table === 'page_derivation_spend') {
    await engine.executeRaw('INSERT INTO page_derivation_spend (page_id, family) VALUES ($1, $2) ON CONFLICT (page_id, family) DO NOTHING', [ledger.pageId, ledger.family]);
    const [row] = await engine.executeRaw<{ spent_usd: number; reserved_usd: number; stale_reservation: boolean }>(`SELECT spent_usd, reserved_usd,
        (reserved_usd > 0 AND updated_at < now() - interval '1 hour') AS stale_reservation
      FROM page_derivation_spend WHERE page_id = $1 AND family = $2 FOR UPDATE`, [ledger.pageId, ledger.family]);
    return row ? { state: null, reason: null, embedding_signature: null, cap_usd: null, spent_usd: Number(row.spent_usd), reserved_usd: Number(row.reserved_usd),
      stale_reservation: row.stale_reservation === true } : null;
  }
  await engine.executeRaw('INSERT INTO page_embedding_budget (page_id) VALUES ($1) ON CONFLICT (page_id) DO NOTHING', [ledger.pageId]);
  const [row] = await engine.executeRaw<PageSpendLedgerRow>(`SELECT state, reason, embedding_signature, spent_usd, reserved_usd, cap_usd,
        (reserved_usd > 0 AND updated_at < now() - interval '1 hour') AS stale_reservation
      FROM page_embedding_budget WHERE page_id = $1 FOR UPDATE`, [ledger.pageId]);
  return row ? { ...row, spent_usd: Number(row.spent_usd), reserved_usd: Number(row.reserved_usd), cap_usd: row.cap_usd === null ? null : Number(row.cap_usd),
    stale_reservation: row.stale_reservation === true } : null;
}

/** Writes one folded reservation on a locked ledger row; returns its reservation window (null when nothing is reserved). */
export async function writePageSpendReservation(engine: Raw, ledger: PageSpendLedger, write: PageSpendReservationWrite): Promise<string | null> {
  let rows: Array<{ reservation_window: string | null }>;
  if (ledger.table === 'page_derivation_spend') {
    rows = await engine.executeRaw(RESERVE_DERIVATION_SQL, [ledger.pageId, ledger.family, write.spent, write.reserved, write.keepWindow]);
  } else if (write.plan) {
    rows = await engine.executeRaw(RESERVE_BUDGET_PLAN_SQL,
      [ledger.pageId, write.plan.state, write.plan.reason, write.signature ?? null, write.spent, write.reserved, write.plan.capUsd, write.keepWindow]);
  } else {
    rows = await engine.executeRaw(RESERVE_BUDGET_SQL, [ledger.pageId, write.signature ?? null, write.spent, write.reserved, write.keepWindow]);
  }
  return rows[0]?.reservation_window ?? null;
}

/** Books `bookedUsd` and drops one grant's `reservedUsd` hold, only while the window it reserved in is still open. */
export async function settlePageSpendReservation(engine: Raw, ledger: PageSpendLedger, window: string,
  reservedUsd: number, bookedUsd: number, unpriced: number): Promise<void> {
  const settled = [ledger.pageId, reservedUsd, Math.max(0, bookedUsd), RESERVED_EPSILON_USD, window];
  if (ledger.table === 'page_embedding_budget') await engine.executeRaw(SETTLE_BUDGET_SQL, [...settled, Math.trunc(unpriced)]);
  else await engine.executeRaw(SETTLE_DERIVATION_SQL, [...settled, ledger.family]);
}

/**
 * Held and capped pages whose row still applies, with their chunks waiting for a vector in `column` (segmented) or
 * not yet embedded (inline), newest row first.
 */
export async function listBudgetLimitedPageRows(engine: Raw, column: string, opts: BudgetLimitedPagesOpts): Promise<PageBudgetReport[]> {
  // #7185: an embed_skip page is never embedded, so a hold on one (a backfill rewrite that did not land) is not approvable work.
  const filters: SqlFragment[] = [sqlFragment`${trustedSql(budgetRowAppliesFilter('b', 'p'))}`, sqlFragment`p.deleted_at IS NULL`,
    sqlFragment`NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')`];
  if (opts.state) filters.push(sqlFragment`b.state = ${opts.state}`);
  if (opts.sourceId) filters.push(sqlFragment`p.source_id = ${opts.sourceId}`);
  const pending = sqlFragment`(CASE WHEN p.body_storage = 'segmented' THEN cc.${trustedSql(quoteIdentifier(column))} IS NULL ELSE cc.embedded_at IS NULL END)`;
  const live = trustedSql(chunkGenerationFilter('p', 'cc'));
  const { text, params } = renderFragment(sqlFragment`SELECT p.slug, p.source_id, b.state, b.reason, b.spent_usd, b.cap_usd,
      (SELECT count(*)::int FROM content_chunks cc WHERE cc.page_id = p.id AND ${pending} AND ${live}) AS pending_chunks,
      (SELECT COALESCE(sum(length(cc.chunk_text)), 0)::bigint FROM content_chunks cc WHERE cc.page_id = p.id AND ${pending} AND ${live}) AS pending_chars
    FROM page_embedding_budget b JOIN pages p ON p.id = b.page_id
    WHERE ${joinFragments(filters, ' AND ')} ORDER BY b.updated_at DESC, p.id LIMIT ${opts.limit}::int`);
  const rows = await engine.executeRaw<PageBudgetReport>(text, params);
  return rows.map(row => ({ ...row, spent_usd: Number(row.spent_usd), cap_usd: row.cap_usd === null ? null : Number(row.cap_usd), pending_chunks: Number(row.pending_chunks), pending_chars: Number(row.pending_chars) }));
}

/**
 * Stored pages of one source a size state may apply to (embed_skip, over the inline threshold, segmented or with a
 * budget row): the given slugs, or (null) every such page, by slug.
 */
export async function readPageSizeStateRows(engine: Raw, sourceId: string, slugs: readonly string[] | null): Promise<PageSizeStateRow[]> {
  const bytes = trustedSql(`(CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END)`);
  const bySlug = slugs ? sqlFragment` AND p.slug = ANY(${[...slugs]}::text[])` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT p.slug, ${bytes}::bigint AS bytes, p.body_storage = 'segmented' AS segmented, p.frontmatter, b.state, b.reason
       FROM pages p LEFT JOIN page_embedding_budget b ON b.page_id = p.id
      WHERE p.source_id = ${sourceId} AND p.deleted_at IS NULL${bySlug}
        AND (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip' OR ${bytes} > ${PAGE_INLINE_MAX_BYTES} OR p.body_storage = 'segmented' OR b.page_id IS NOT NULL) ORDER BY p.slug`);
  const rows = await engine.executeRaw<PageSizeStateRow>(text, params);
  return rows.map(row => ({ ...row, bytes: Number(row.bytes), segmented: row.segmented === true }));
}
