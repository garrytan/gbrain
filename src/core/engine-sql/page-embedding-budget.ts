/**
 * The page embedding ledger (`page_embedding_budget`, migration v246) on the paid path: the statements
 * planPageEmbedding (page-embedding-budget.ts, which owns the policy) always sent through `executeRaw`, now one copy
 * for both engines. The point read of the holds and the ledger row, the hold record, the approval that opens a small
 * page's hold, the grant under the row lock and the settle inside the grant's reservation window.
 *
 * The grant runs in one transaction: insert the row, lock it, refuse a held page, hold a junk page, then take the
 * newest stale chunks whose cost fits what the cap leaves and reserve their cost. The junk verdict is the caller's
 * (it reads the page's text); a grant on an open page asks for it (`needs_junk`) when the caller did not send one.
 */
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { settleLedgerReservation } from '../page-spend.ts';

export type PageEmbeddingBudgetState = 'open' | 'held' | 'capped';

/** The page's hold marker (frontmatter) and its ledger row; every ledger field is null when the page has no row. */
export interface PageEmbeddingBudgetRow {
  marker: string | null;
  state: PageEmbeddingBudgetState | null;
  reason: string | null;
  embedding_signature: string | null;
  spent_usd: number | null;
  reserved_usd: number | null;
  cap_usd: number | null;
  unpriced_calls: number | null;
  /** The open reservation window's id (reserved_at in microseconds, as text), null when nothing is reserved. */
  reservation_window: string | null;
}

/** What one grant asks for. `junk: null` means the caller has not assessed the page. */
export interface PageEmbeddingReserveInput {
  approved: boolean;
  approvedCapUsd: number | null;
  /** The configured per-page cap (`embed.max_usd_per_page`); Infinity when it is off. */
  configuredCapUsd: number;
  signature: string | null;
  /** Each stale chunk and its estimated cost; the newest (highest index) are granted first. */
  chunks: ReadonlyArray<{ chunkIndex: number; costUsd: number }>;
  junk: { reason: string | null } | null;
}

export type PageEmbeddingReservation =
  | { kind: 'unmetered' }
  | { kind: 'held'; reason: string }
  | { kind: 'needs_junk' }
  | { kind: 'grant'; chunkIndexes: number[]; reservedUsd: number; deferred: number; capUsd: number; window: string | null };

const READ_SQL = `SELECT COALESCE(p.frontmatter->'transcript_archive'->>'embedding_hold', p.frontmatter->'call_import'->>'embedding_hold') AS marker, b.state, b.reason,
       b.embedding_signature, b.spent_usd, b.reserved_usd, b.cap_usd, b.unpriced_calls, (extract(epoch FROM b.reserved_at) * 1000000)::bigint::text AS reservation_window
     FROM pages p LEFT JOIN page_embedding_budget b ON b.page_id = p.id WHERE p.id = $1`;

const EMPTY: PageEmbeddingBudgetRow = {
  marker: null, state: null, reason: null, embedding_signature: null, spent_usd: null, reserved_usd: null, cap_usd: null,
  unpriced_calls: null, reservation_window: null,
};

const num = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);

/** The page's hold marker and ledger row (a tombstone included); all null for a missing page. */
export async function readPageEmbeddingBudget(exec: LegacyUnscopedRead, pageId: number): Promise<PageEmbeddingBudgetRow> {
  const [row] = await exec.executeRaw<PageEmbeddingBudgetRow>(READ_SQL, [pageId]);
  if (!row) return { ...EMPTY };
  return {
    marker: row.marker ?? null, state: row.state ?? null, reason: row.reason ?? null, embedding_signature: row.embedding_signature ?? null,
    spent_usd: num(row.spent_usd), reserved_usd: num(row.reserved_usd), cap_usd: num(row.cap_usd), unpriced_calls: num(row.unpriced_calls),
    reservation_window: row.reservation_window ?? null,
  };
}

/** Records a hold for a page that has no ledger row yet; a page with a row keeps it. */
export async function recordPageEmbeddingHold(exec: SqlExecutor, pageId: number, reason: string): Promise<void> {
  await exec.executeRaw("INSERT INTO page_embedding_budget (page_id, state, reason) VALUES ($1, 'held', $2) ON CONFLICT (page_id) DO NOTHING", [pageId, reason]);
}

/** Opens the page's hold (the user's approval of a small page). */
export async function openPageEmbeddingHold(exec: SqlExecutor, pageId: number): Promise<void> {
  await exec.executeRaw("UPDATE page_embedding_budget SET state = 'open', reason = NULL, updated_at = now() WHERE page_id = $1", [pageId]);
}

interface LockedRow { state: PageEmbeddingBudgetState; reason: string | null; embedding_signature: string | null; spent_usd: number; reserved_usd: number; stale_reservation: boolean; cap_usd: number | null }

/** The ledger arithmetic of one grant on the locked row: shared by the SQL engines and pinned for the Rust store. */
export function planGrant(row: LockedRow, input: PageEmbeddingReserveInput): {
  chunkIndexes: number[]; reservedUsd: number; deferred: number; capUsd: number; spent: number; reserved: number; openWindow: boolean;
  state: PageEmbeddingBudgetState; capWritten: number | null;
} {
  const sameLedger = !row.embedding_signature || !input.signature || row.embedding_signature === input.signature;
  const spent = sameLedger ? Number(row.spent_usd) + (row.stale_reservation ? Number(row.reserved_usd) : 0) : 0;
  let reserved = sameLedger && !row.stale_reservation ? Number(row.reserved_usd) : 0;
  const stored = row.cap_usd === null ? input.configuredCapUsd : Number(row.cap_usd);
  const capUsd = input.approved ? Math.max(stored, spent + reserved + (input.approvedCapUsd ?? 0)) : stored;
  const remaining = Math.max(0, capUsd - spent - reserved);
  const chunkIndexes: number[] = [];
  let reservedUsd = 0;
  for (const chunk of [...input.chunks].sort((a, b) => b.chunkIndex - a.chunkIndex)) {
    if (reservedUsd + chunk.costUsd > remaining) break;
    reservedUsd += chunk.costUsd;
    chunkIndexes.push(chunk.chunkIndex);
  }
  const deferred = input.chunks.length - chunkIndexes.length;
  const openWindow = reserved > 0;
  reserved += reservedUsd;
  return {
    chunkIndexes, reservedUsd, deferred, capUsd, spent, reserved, openWindow, state: deferred > 0 ? 'capped' : 'open',
    capWritten: input.approved && Number.isFinite(capUsd) ? capUsd : row.cap_usd,
  };
}

/** One grant under the ledger row's lock (module docs). */
export async function reservePageEmbedding(exec: SqlExecutor, pageId: number, input: PageEmbeddingReserveInput): Promise<PageEmbeddingReservation> {
  return exec.transaction(async tx => {
    await tx.executeRaw('INSERT INTO page_embedding_budget (page_id) VALUES ($1) ON CONFLICT (page_id) DO NOTHING', [pageId]);
    const [row] = await tx.executeRaw<LockedRow>(`SELECT state, reason, embedding_signature, spent_usd, reserved_usd, cap_usd,
        (reserved_usd > 0 AND updated_at < now() - interval '1 hour') AS stale_reservation
      FROM page_embedding_budget WHERE page_id = $1 FOR UPDATE`, [pageId]);
    if (!row) return { kind: 'unmetered' } as const;
    if (row.state === 'held' && !input.approved) return { kind: 'held', reason: row.reason ?? 'awaiting_approval' } as const;
    if (!input.approved && row.state === 'open') {
      if (input.junk === null) return { kind: 'needs_junk' } as const;
      if (input.junk.reason !== null) {
        await tx.executeRaw(`UPDATE page_embedding_budget SET state = 'held', reason = $2, updated_at = now() WHERE page_id = $1`, [pageId, input.junk.reason]);
        return { kind: 'held', reason: input.junk.reason } as const;
      }
    }
    const plan = planGrant(row, input);
    // reserved_at and the window are page-spend.ts's RESERVED_AT_SQL('$6::float8', '$8::boolean') and RESERVATION_WINDOW_SQL,
    // written out so the statement is one constant text; test/page-embedding-budget-statements.test.ts pins the two equal.
    const [written] = await tx.executeRaw<{ reservation_window: string | null }>(`UPDATE page_embedding_budget SET state = $2, reason = $3, embedding_signature = COALESCE($4, embedding_signature),
        spent_usd = $5::float8, reserved_usd = $6::float8, reserved_at = CASE WHEN $6::float8 <= 0 THEN NULL WHEN $8::boolean THEN reserved_at ELSE GREATEST(now(), reserved_at + interval '1 millisecond') END,
        cap_usd = $7::float8, updated_at = now() WHERE page_id = $1 RETURNING (extract(epoch FROM reserved_at) * 1000000)::bigint::text AS reservation_window`,
    [pageId, plan.state, plan.deferred > 0 ? 'cap_reached' : null, input.signature, plan.spent, plan.reserved, plan.capWritten, plan.openWindow]);
    return {
      kind: 'grant', chunkIndexes: plan.chunkIndexes, reservedUsd: plan.reservedUsd, deferred: plan.deferred, capUsd: plan.capUsd,
      window: written?.reservation_window ?? null,
    } as const;
  });
}

/** Books `bookedUsd` and drops one grant's `reservedUsd` hold, only while the window it reserved in is still open (settleLedgerReservation's embedding statement). */
export async function settlePageEmbeddingReservation(exec: SqlExecutor, pageId: number, settle: {
  window: string | null; reservedUsd: number; bookedUsd: number; unpricedCalls: number;
}): Promise<void> {
  await settleLedgerReservation(exec, { table: 'page_embedding_budget', pageId }, settle.window, settle.reservedUsd, settle.bookedUsd, settle.unpricedCalls);
}
