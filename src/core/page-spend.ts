/**
 * PR 4 (Wave B incremental derivation, transcripts): the per-page spend ledgers of the paid derivations on a large page
 * (wave-b spec 8.3) and the reservation window both ledgers use.
 *
 * Families: every paid derivation family (conversation facts and the facts backstop as `facts`, `synopsis`)
 * has its own lifetime ledger per page in page_derivation_spend, each capped by `derive.max_usd_per_page` (default $2;
 * unlimited under `spend.posture tokenmax` when unset; `off` disables it). Embedding keeps its own ledger and cap
 * (page_embedding_budget, `embed.max_usd_per_page`), so derivation spend never starves a page's embeddings, and a new
 * embedding model resets only the embedding ledger.
 *
 * Reservation window: a ledger's open reservations form one window. `reserved_at` is the time the window opened (the
 * first reservation after the ledger had none) and identifies it. Reservations nobody settled for an hour (no
 * reservation or settle on the ledger since: `updated_at`) are folded into spent by the next reservation, and so are
 * those of a ledger a new embedding model replaced; either way the next reservation opens a new window. A grant settles
 * only inside the window it reserved in, so a reservation that was already folded is never booked twice and never
 * releases a newer one. The window closes (reserved_at NULL) when its last reservation settles.
 */
import type { BrainEngine } from './engine.ts';
import { parseUsdLimit, resolveSpendPosture } from './spend-posture.ts';

export const PAGE_DERIVATION_CAP_KEY = 'derive.max_usd_per_page';
export const DEFAULT_PAGE_DERIVATION_CAP_USD = 2;

/** What a paid step spends on a page: the kind and its model, `embedding:<signature>`, `facts:<model>`, `synopsis:<model>`. */
export type PageSpendKind = 'embedding' | 'facts' | 'synopsis';
export type PageSpendSignature = `${PageSpendKind}:${string}`;
export type DerivationFamily = Exclude<PageSpendKind, 'embedding'>;

export interface PageSpendGrant {
  reservedUsd: number;
  capUsd: number;
  /** Book the reservation as spent (`ok`: `usd`, the call's actual cost, else the reservation) or release it (the provider was never called). */
  settle(outcome: { ok: boolean; usd?: number }): Promise<void>;
}

/** `refused`: the estimate does not fit what the cap leaves (`cap_reached`), or an embedding waits for approval (`held`); nothing was reserved. */
export type PageSpendDecision =
  | { kind: 'unmetered' }
  | { kind: 'refused'; reason: 'cap_reached' | 'held' | 'purge_sweep_pending'; capUsd: number; spentUsd: number; reservedUsd: number; estimateUsd: number }
  | { kind: 'grant'; grant: PageSpendGrant };

const RESERVED_EPSILON_USD = 1e-9;
/** A window's id: reserved_at in whole microseconds, as text (a bound timestamp parameter would lose the microseconds). */
export const RESERVATION_WINDOW_SQL = '(extract(epoch FROM reserved_at) * 1000000)::bigint::text';

/**
 * The reserved_at a reservation leaves: the open window's (`keep`), a new window's, or NULL when nothing is reserved. A new
 * window's id is later than the one it replaces even on a millisecond clock (PGLite), so the two never compare equal.
 */
export const RESERVED_AT_SQL = (total: string, keep: string) =>
  `reserved_at = CASE WHEN ${total} <= 0 THEN NULL WHEN ${keep} THEN reserved_at ELSE GREATEST(now(), reserved_at + interval '1 millisecond') END`;

type Ledger = { table: 'page_embedding_budget'; pageId: number } | { table: 'page_derivation_spend'; pageId: number; family: DerivationFamily };

/** Book `bookedUsd` and drop one grant's `reservedUsd` hold, only while the window it reserved in is still open. */
export async function settleLedgerReservation(engine: Pick<BrainEngine, 'executeRaw'>, ledger: Ledger, window: string | null,
  reservedUsd: number, bookedUsd: number, unpriced = 0): Promise<void> {
  if (window === null || (reservedUsd === 0 && bookedUsd === 0)) return;
  const embedding = ledger.table === 'page_embedding_budget';
  await engine.executeRaw(`UPDATE ${ledger.table} SET
      reserved_usd = CASE WHEN reserved_usd - $2::float8 <= $4::float8 THEN 0 ELSE reserved_usd - $2::float8 END,
      reserved_at = CASE WHEN reserved_usd - $2::float8 <= $4::float8 THEN NULL ELSE reserved_at END,
      spent_usd = spent_usd + $3::float8,${embedding ? ` unpriced_calls = unpriced_calls + ${Math.trunc(unpriced)},` : ''} updated_at = now()
    WHERE page_id = $1 AND ${RESERVATION_WINDOW_SQL} = $5::text${embedding ? '' : ' AND family = $6'}`,
  [ledger.pageId, reservedUsd, Math.max(0, bookedUsd), RESERVED_EPSILON_USD, window, ...(embedding ? [] : [ledger.family])]);
}

/** The configured per-family derivation cap: `derive.max_usd_per_page`, else unlimited under `spend.posture tokenmax`, else $2. `off` is Infinity. */
export async function resolvePageDerivationCapUsd(engine: Pick<BrainEngine, 'getConfig' | 'executeRaw'>): Promise<number> {
  const raw = await engine.getConfig(PAGE_DERIVATION_CAP_KEY).catch(() => null);
  if (raw === null || raw === undefined || raw === '') {
    return await resolveSpendPosture(engine as BrainEngine).catch(() => 'gated') === 'tokenmax' ? Infinity : DEFAULT_PAGE_DERIVATION_CAP_USD;
  }
  return parseUsdLimit(raw, DEFAULT_PAGE_DERIVATION_CAP_USD);
}

/** Reserve `estimateUsd` on one family's ledger of a page (row-locked, so concurrent reservations never overspend the cap). */
export async function reserveDerivationSpend(engine: BrainEngine, pageId: number, family: DerivationFamily, estimateUsd: number): Promise<PageSpendDecision> {
  const capUsd = await resolvePageDerivationCapUsd(engine);
  const estimate = Math.max(0, estimateUsd);
  return engine.transaction(async tx => {
    await tx.executeRaw('INSERT INTO page_derivation_spend (page_id, family) VALUES ($1, $2) ON CONFLICT (page_id, family) DO NOTHING', [pageId, family]);
    const [row] = await tx.executeRaw<{ spent_usd: number; reserved_usd: number; stale_reservation: boolean }>(`SELECT spent_usd, reserved_usd,
        (reserved_usd > 0 AND updated_at < now() - interval '1 hour') AS stale_reservation
      FROM page_derivation_spend WHERE page_id = $1 AND family = $2 FOR UPDATE`, [pageId, family]);
    if (!row) return { kind: 'unmetered' } as const;
    const spent = Number(row.spent_usd) + (row.stale_reservation ? Number(row.reserved_usd) : 0);
    const reserved = row.stale_reservation ? 0 : Number(row.reserved_usd);
    if (spent + reserved + estimate > capUsd) {
      return { kind: 'refused', reason: 'cap_reached', capUsd, spentUsd: spent, reservedUsd: reserved, estimateUsd: estimate } as const;
    }
    const [written] = await tx.executeRaw<{ reservation_window: string | null }>(`UPDATE page_derivation_spend SET spent_usd = $3::float8,
        reserved_usd = $4::float8, ${RESERVED_AT_SQL('$4::float8', '$5::boolean')}, updated_at = now()
      WHERE page_id = $1 AND family = $2 RETURNING ${RESERVATION_WINDOW_SQL} AS reservation_window`,
    [pageId, family, spent, reserved + estimate, reserved > 0]);
    const ledger: Ledger = { table: 'page_derivation_spend', pageId, family };
    const grant: PageSpendGrant = {
      reservedUsd: estimate, capUsd,
      settle: ({ ok, usd }) => settleLedgerReservation(engine, ledger, written?.reservation_window ?? null, estimate, ok ? usd ?? estimate : 0),
    };
    return { kind: 'grant', grant } as const;
  });
}
