/**
 * The withdrawal overlay of a Rust page snapshot (readPageSnapshot, getPage, readPageSnapshotsBatch), as
 * page-state/snapshot.ts applies it on PGLite and Postgres.
 *
 * The store answers the page's ledger rows (rust/crates/gbrain-store/src/page_withdrawals.rs): `withdrawals` (the
 * source's withdrawals under subject `*` or the slug, then the slug's purge tombstones) and, when the source has a
 * subject-`*` tombstone, the `globalPurges` marker and every such tombstone in `globalPurgeRows`. This side keeps the
 * `*` tombstones whose hash a fence claim of the page has (`fenceClaimHashes`, as `resolveGlobalPurges` does), drops
 * `globalPurgeRows`, and, on a page that is not segmented, strikes withdrawn fence rows and drops purged ones from the
 * truth and timeline (`overlayWithdrawalBody`).
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

/** The snapshot with PGLite's withdrawal overlay applied (the page must already be decoded with `toGetPage`). */
export function overlayStoreSnapshot(snapshot: StoreSnapshot): PageSnapshot {
  const { globalPurgeRows, ...rest } = snapshot;
  const withdrawals = rest.withdrawals ?? [];
  if (!withdrawals.length && !globalPurgeRows?.length) return { ...rest, withdrawals };
  const page = rest.page;
  const body = fingerprintText(page.compiled_truth), timeline = fingerprintText(page.timeline);
  let all = withdrawals;
  if (globalPurgeRows?.length) {
    const hashes = new Set(fenceClaimHashes([body, timeline]));
    const named = globalPurgeRows.filter((row) => hashes.has(row.fact_hash));
    if (named.length) all = [...withdrawals, ...named];
  }
  if (!isSegmentedPage(page)) {
    page.compiled_truth = overlayWithdrawalBody(page.compiled_truth, body, all);
    page.timeline = overlayWithdrawalBody(page.timeline, timeline, all);
  }
  return { ...rest, withdrawals: all };
}
