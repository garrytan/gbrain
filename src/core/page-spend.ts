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
import type { PageSpendLedger } from './engine-sql/page-spend.ts';
import { parseUsdLimit, resolveSpendPosture } from './spend-posture.ts';

export { RESERVATION_WINDOW_SQL } from './engine-sql/page-spend.ts';

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

type Ledger = PageSpendLedger;

/** Book `bookedUsd` and drop one grant's `reservedUsd` hold, only while the window it reserved in is still open. */
export async function settleLedgerReservation(engine: Pick<BrainEngine, 'settlePageSpendReservation'>, ledger: Ledger, window: string | null,
  reservedUsd: number, bookedUsd: number, unpriced = 0): Promise<void> {
  if (window === null || (reservedUsd === 0 && bookedUsd === 0)) return;
  await engine.settlePageSpendReservation(ledger, window, reservedUsd, bookedUsd, unpriced);
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
  const ledger: Ledger = { table: 'page_derivation_spend', pageId, family };
  return engine.transaction(async tx => {
    const row = await tx.lockPageSpendLedger(ledger);
    if (!row) return { kind: 'unmetered' } as const;
    const spent = row.spent_usd + (row.stale_reservation ? row.reserved_usd : 0);
    const reserved = row.stale_reservation ? 0 : row.reserved_usd;
    if (spent + reserved + estimate > capUsd) {
      return { kind: 'refused', reason: 'cap_reached', capUsd, spentUsd: spent, reservedUsd: reserved, estimateUsd: estimate } as const;
    }
    const window = await tx.writePageSpendReservation(ledger, { spent, reserved: reserved + estimate, keepWindow: reserved > 0 });
    const grant: PageSpendGrant = {
      reservedUsd: estimate, capUsd,
      settle: ({ ok, usd }) => settleLedgerReservation(engine, ledger, window, estimate, ok ? usd ?? estimate : 0),
    };
    return { kind: 'grant', grant } as const;
  });
}
