/**
 * The withdrawal overlay of a Rust page snapshot (readPageSnapshot, getPage, readPageSnapshotsBatch), as
 * page-state/snapshot.ts applies it on PGLite and Postgres.
 *
 * The store answers the page's ledger rows (rust/crates/gbrain-store/src/page_withdrawals.rs): `withdrawals` (the
 * source's withdrawals under subject `*` or the slug, then the slug's purge tombstones) and, when the source has a
 * subject-`*` tombstone, the `globalPurges` marker and every such tombstone in `globalPurgeRows`. This side keeps the
 * `*` tombstones whose hash a fence claim of the page has (`fenceClaimHashes`, as `resolveGlobalPurges` does), drops
 * `globalPurgeRows`, and, on a page that is not segmented, strikes withdrawn fence rows and drops purged ones from the
 * truth and timeline (`overlayWithdrawalBody`). A segmented page's seal overlays its timeline lead the same way
 * (`overlayStoreLead`).
 *
 * The fingerprint text is each line lowercased with every whitespace run made one space, as the SQL engines'
 * `regexp_replace(lower(line), '[[:space:]]+', ' ', 'g')` over `string_to_array(text, chr(10))`.
 */
import { fenceClaimHashes, overlayWithdrawalBody } from '../facts/withdrawal-overlay.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import type { PageSnapshot, PageWithdrawal } from '../page-state/types.ts';

/** A snapshot as the store answers it: PageSnapshot plus the unresolved subject-`*` tombstones. */
export type StoreSnapshot = PageSnapshot & { globalPurgeRows?: PageWithdrawal[] };

function fingerprintText(text: string | null | undefined): string {
  if (!text) return '';
  return text.split('\n').map((line) => line.toLowerCase().replace(/\s+/g, ' ')).join('\n');
}

/** `withdrawals` plus the subject-`*` tombstones whose hash a fence claim of the fingerprinted `texts` has. */
function withNamedPurges(withdrawals: PageWithdrawal[], globalPurgeRows: PageWithdrawal[] | undefined, texts: string[]): PageWithdrawal[] {
  if (!globalPurgeRows?.length) return withdrawals;
  const hashes = new Set(fenceClaimHashes(texts));
  const named = globalPurgeRows.filter((row) => hashes.has(row.fact_hash));
  return named.length ? [...withdrawals, ...named] : withdrawals;
}

/** The snapshot with PGLite's withdrawal overlay applied (the page must already be decoded with `toGetPage`). */
export function overlayStoreSnapshot(snapshot: StoreSnapshot): PageSnapshot {
  const { globalPurgeRows, ...rest } = snapshot;
  const withdrawals = rest.withdrawals ?? [];
  if (!withdrawals.length && !globalPurgeRows?.length) return { ...rest, withdrawals };
  const page = rest.page;
  // A segmented page's body is never loaded (reading it throws `page_body_segmented`), so it names no fence claim.
  const segmented = isSegmentedPage(page);
  const body = segmented ? '' : fingerprintText(page.compiled_truth), timeline = segmented ? '' : fingerprintText(page.timeline);
  const all = withNamedPurges(withdrawals, globalPurgeRows, [body, timeline]);
  if (!segmented) {
    page.compiled_truth = overlayWithdrawalBody(page.compiled_truth, body, all);
    page.timeline = overlayWithdrawalBody(page.timeline, timeline, all);
  }
  return { ...rest, withdrawals: all };
}

/**
 * A segmented page's timeline lead with the overlay PGLite's seal applies (engine-sql/page-body.ts `sealSegmentedPage`:
 * `overlayCanonicalBodies` over an empty body): the page's ledger rows (`ledger`, the store snapshot read with
 * `includeDeleted`) strike withdrawn fence rows and drop purged ones, with the subject-`*` tombstones a fence claim of
 * the lead names.
 */
export function overlayStoreLead(lead: string, ledger: Pick<StoreSnapshot, 'withdrawals' | 'globalPurgeRows'>): string {
  const timeline = fingerprintText(lead);
  return overlayWithdrawalBody(lead, timeline, withNamedPurges(ledger.withdrawals ?? [], ledger.globalPurgeRows, ['', timeline]));
}
