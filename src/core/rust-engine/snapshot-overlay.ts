/**
 * The withdrawal overlay of a Rust page snapshot (readPageSnapshot, getPage, readPageSnapshotsBatch), as
 * page-state/snapshot.ts applies it on PGLite and Postgres.
 *
 * The store answers the page's ledger rows (rust/crates/gbrain-store/src/page_withdrawals.rs): `withdrawals` (the
 * source's withdrawals under subject `*` or the slug, then the slug's purge tombstones) and, when the source has a
 * subject-`*` tombstone, the `globalPurges` marker and every such tombstone in `globalPurgeRows`. This side keeps the
 * `*` tombstones whose hash a fence claim of the page has (`fenceClaimHashes`, as `resolveGlobalPurges` does), drops
 * `globalPurgeRows` (kept on the snapshot's marker as `rows`, for the overlay of other text), and, on a page that is not segmented, strikes withdrawn fence rows and drops purged ones from the
 * truth and timeline (`overlayWithdrawalBody`). A segmented page keeps its ledger rows and is never read as a whole
 * body (its body getters refuse page_body_segmented), as the SQL engines leave it. A segmented page's seal overlays its timeline lead the same way
 * (`overlayStoreLead`).
 *
 * The fingerprint text is each line lowercased with every run of FACT_SPACE_CLASS made one space, as the SQL engines'
 * `regexp_replace(lower(line), FACT_SPACE_CLASS+, ' ', 'g')` over `string_to_array(text, chr(10))` (page-state/snapshot.ts).
 * The class is that list, never JavaScript's `\s`: U+0085 folds here and U+1680 and U+00A0 do not.
 */
import { overlayWithdrawalBody } from '../facts/withdrawal-overlay.ts';
import { FACT_SPACE_CLASS } from '../facts/withdrawal-schema.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { namedGlobalPurges } from '../page-state/snapshot.ts';
import type { PageSnapshot, PageWithdrawal } from '../page-state/types.ts';

/** A snapshot as the store answers it: PageSnapshot plus the unresolved subject-`*` tombstones. */
export type StoreSnapshot = PageSnapshot & { globalPurgeRows?: PageWithdrawal[] };

const FACT_SPACE_RUN = new RegExp(`${FACT_SPACE_CLASS}+`, 'g');

function fingerprintText(text: string | null | undefined): string {
  if (!text) return '';
  return text.split('\n').map((line) => line.toLowerCase().replace(FACT_SPACE_RUN, ' ')).join('\n');
}

/** `withdrawals` plus the subject-`*` tombstones whose hash a fence claim of the fingerprinted `texts` has. */
function withNamedPurges(withdrawals: PageWithdrawal[], globalPurgeRows: PageWithdrawal[] | undefined, texts: string[]): PageWithdrawal[] {
  const named = namedGlobalPurges(globalPurgeRows, texts);
  return named.length ? [...withdrawals, ...named] : withdrawals;
}

/** The snapshot with PGLite's withdrawal overlay applied (the page must already be decoded with `toGetPage`). */
export function overlayStoreSnapshot(snapshot: StoreSnapshot): PageSnapshot {
  const { globalPurgeRows, ...stored } = snapshot;
  // The snapshot keeps the marker (as on PGLite), with the rows the store answered as its plain `rows`: a later overlay of
  // other text (a segment, a restage) names its tombstones from them (overlayCanonicalBodies), on this side of the
  // owner socket or the other.
  const rest: PageSnapshot = stored.globalPurges && globalPurgeRows ? { ...stored, globalPurges: { ...stored.globalPurges, rows: globalPurgeRows } } : stored;
  const withdrawals = rest.withdrawals ?? [];
  if (!withdrawals.length && !globalPurgeRows?.length) return { ...rest, withdrawals };
  const page = rest.page;
  // A segmented page has no whole body, and its body getters throw page_body_segmented, so read neither. The SQL
  // engines fingerprint its stored body columns, which are NULL, so no '*' tombstone is named and the body is untouched.
  if (isSegmentedPage(page)) return { ...rest, withdrawals };
  const body = fingerprintText(page.compiled_truth), timeline = fingerprintText(page.timeline);
  const all = withNamedPurges(withdrawals, globalPurgeRows, [body, timeline]);
  page.compiled_truth = overlayWithdrawalBody(page.compiled_truth, body, all);
  page.timeline = overlayWithdrawalBody(page.timeline, timeline, all);
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
