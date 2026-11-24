/**
 * The withdrawal overlay of a Rust page snapshot (readPageSnapshot, getPage, readPageSnapshotsBatch), as
 * page-state/snapshot.ts applies it on PGLite and Postgres.
 *
 * The store answers the page's ledger rows (rust/crates/gbrain-store/src/page_withdrawals.rs): `withdrawals` (the
 * source's withdrawals under subject `*` or the slug, then the slug's purge tombstones) and, when the source has a
 * subject-`*` tombstone, the `globalPurges` marker and every such tombstone in `globalPurgeRows`. This side keeps the
 * `*` tombstones whose hash a fence claim of the page has (`fenceClaimHashes`, as `resolveGlobalPurges` does), keeps
 * `globalPurgeRows` (the overlay of other text reads them through listGlobalPurgeWithdrawals), and, on a page that is not
 * segmented, strikes withdrawn fence rows and drops purged ones from the truth and timeline (`overlayWithdrawalBody`).
 * A segmented page keeps its ledger rows and is never read as a whole body (its body getters refuse page_body_segmented),
 * as the SQL engines leave it. A segmented page's seal overlays its timeline lead the same way (`overlayStoreLead`).
 *
 * The fingerprint text is the store's own (`normalizeFenceLines`, `cli_reads::export::normalize_fence_lines`): each line
 * lowercased by the store and every run of FACT_SPACE_CLASS made one space, as the SQL engines'
 * `regexp_replace(lower(line), FACT_SPACE_CLASS+, ' ', 'g')` over `string_to_array(text, chr(10))`. The same engine
 * lowercases the claim that a ledger row's hash was made from, so JavaScript's toLowerCase (U+0130, a final sigma) and
 * `\s` (U+0085, U+1680, U+00A0) never decide a match. One normalize call per read, made only when the snapshot has ledger
 * rows to apply and a fence to apply them to.
 */
import { fenceClaimHashes, overlayWithdrawalBody } from '../facts/withdrawal-overlay.ts';
import type { BrainEngine } from '../engine.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import type { PageSnapshot, PageWithdrawal } from '../page-state/types.ts';
import type { StoreBrain } from './store.ts';
import { storeCall } from './store-members/common.ts';

/** A snapshot as the store answers it: PageSnapshot plus the unresolved subject-`*` tombstones. */
export type StoreSnapshot = PageSnapshot & { globalPurgeRows?: PageWithdrawal[] };

/** The store's fence normalization, bound to its brain (store-members/cli-reads-export.ts `normalizeFenceLines`). */
export type NormalizeFence = BrainEngine['normalizeFenceLines'];

/** The store's `normalizeFenceLines` of `brain`, as the overlay reads it. */
export const storeNormalizer = (brain: StoreBrain): NormalizeFence => (bodies, timelines) =>
  storeCall({ member: 'normalizeFenceLines' }, () => brain.normalizeFenceLines([...bodies], [...timelines]));

const hasFence = (text: string | null | undefined): boolean => typeof text === 'string' && text.includes('gbrain:facts:begin');

/** `withdrawals` plus the subject-`*` tombstones whose hash a fence claim of the fingerprinted `texts` has. */
function withNamedPurges(withdrawals: PageWithdrawal[], globalPurgeRows: PageWithdrawal[] | undefined, texts: string[]): PageWithdrawal[] {
  const hashes = new Set(fenceClaimHashes(texts));
  const named = (globalPurgeRows ?? []).filter((row) => hashes.has(row.fact_hash));
  return named.length ? [...withdrawals, ...named] : withdrawals;
}

/** The snapshot without the store's `globalPurgeRows`, which it keeps aside for this overlay, and its ledger rows listed. */
function keepMarkerRows(snapshot: StoreSnapshot): { rest: PageSnapshot; withdrawals: PageWithdrawal[]; globalPurgeRows: PageWithdrawal[] | undefined } {
  const { globalPurgeRows, ...stored } = snapshot;
  // The snapshot keeps the marker as PGLite does; a later overlay of other text (a segment, a restage) names its
  // tombstones through listGlobalPurgeWithdrawals (overlayCanonicalBodiesTyped).
  const rest: PageSnapshot = stored;
  return { rest, withdrawals: rest.withdrawals ?? [], globalPurgeRows };
}

/**
 * The snapshots with PGLite's withdrawal overlay applied (each page must already be decoded with `toGetPage`), the store
 * normalizing the fence text of every page that has something to apply in one call.
 */
export async function overlayStoreSnapshots(normalize: NormalizeFence, snapshots: readonly StoreSnapshot[]): Promise<PageSnapshot[]> {
  const kept = snapshots.map(keepMarkerRows);
  // A segmented page has no whole body, and its body getters throw page_body_segmented, so read neither. The SQL
  // engines fingerprint its stored body columns, which are NULL, so no '*' tombstone is named and the body is untouched.
  const pending = kept.filter(({ rest, withdrawals, globalPurgeRows }) => (withdrawals.length > 0 || (globalPurgeRows?.length ?? 0) > 0)
    && !isSegmentedPage(rest.page) && (hasFence(rest.page.compiled_truth) || hasFence(rest.page.timeline)));
  const overlaid = new Map<PageSnapshot, PageWithdrawal[]>();
  if (pending.length) {
    const normalized = await normalize(pending.map(({ rest }) => rest.page.compiled_truth ?? ''), pending.map(({ rest }) => rest.page.timeline ?? ''));
    for (const row of normalized) {
      const { rest, withdrawals, globalPurgeRows } = pending[Number(row.i) - 1]!;
      const body = row.body ?? '', timeline = row.timeline ?? '';
      const all = withNamedPurges(withdrawals, globalPurgeRows, [body, timeline]);
      rest.page.compiled_truth = overlayWithdrawalBody(rest.page.compiled_truth, body, all);
      rest.page.timeline = overlayWithdrawalBody(rest.page.timeline, timeline, all);
      overlaid.set(rest, all);
    }
  }
  return kept.map(({ rest, withdrawals }) => ({ ...rest, withdrawals: overlaid.get(rest) ?? withdrawals }));
}

/** One snapshot with PGLite's withdrawal overlay applied (the page must already be decoded with `toGetPage`). */
export async function overlayStoreSnapshot(normalize: NormalizeFence, snapshot: StoreSnapshot): Promise<PageSnapshot> {
  return (await overlayStoreSnapshots(normalize, [snapshot]))[0]!;
}

/**
 * A segmented page's timeline lead with the overlay PGLite's seal applies (engine-sql/page-body.ts `sealSegmentedPage`:
 * `overlayCanonicalBodies` over an empty body): the page's ledger rows (`ledger`, the store snapshot read with
 * `includeDeleted`) strike withdrawn fence rows and drop purged ones, with the subject-`*` tombstones a fence claim of
 * the lead names.
 */
export async function overlayStoreLead(normalize: NormalizeFence, lead: string, ledger: Pick<StoreSnapshot, 'withdrawals' | 'globalPurgeRows'>): Promise<string> {
  const withdrawals = ledger.withdrawals ?? [];
  if (!hasFence(lead) || (!withdrawals.length && !ledger.globalPurgeRows?.length)) return lead;
  const [normalized] = await normalize([''], [lead]);
  const timeline = normalized?.timeline ?? '';
  return overlayWithdrawalBody(lead, timeline, withNamedPurges(withdrawals, ledger.globalPurgeRows, ['', timeline]));
}
