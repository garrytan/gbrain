/**
 * The withdrawal overlay of a Rust page snapshot (readPageSnapshot, getPage, readPageSnapshotsBatch), as
 * page-state/snapshot.ts and page-snapshot-batch.ts apply it on PGLite and Postgres.
 *
 * The store answers the page's ledger rows (rust/crates/gbrain-store/src/page_withdrawals.rs): `withdrawals`, and, when
 * the source has a subject-`*` purge tombstone, the `globalPurges` marker and every such tombstone in `globalPurgeRows`.
 * Here the `*` tombstones whose hash a fence claim of the page has join `withdrawals` (`resolveGlobalPurges`), the
 * `globalPurgeRows` field is dropped (the SQL snapshot has none), and on a page that is not segmented the fence rows the
 * ledger names are struck (a withdrawal) or dropped (a purge) in the truth and the timeline (`overlayWithdrawalBody`).
 *
 * The fingerprint text comes from the store (`normalizeFenceLines`): each line lowercased as Postgres `lower()` does and
 * every `[[:space:]]` run made one space, the text the SQL statement computes. It is read only when the snapshot has
 * ledger rows and the page text has a facts fence; without either the SQL overlay changes nothing either.
 */
import { fenceClaimHashes, overlayWithdrawalBody } from '../../facts/withdrawal-overlay.ts';
import { isSegmentedPage } from '../../page-body/page-shape.ts';
import type { NormalizedFenceLines } from '../../engine-sql/export-reads.ts';
import type { PageSnapshot, PageWithdrawal } from '../../page-state/types.ts';
import { toGetPage } from '../store-codec.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall } from './common.ts';

/** A snapshot as the store answers it. */
type StoreSnapshot = PageSnapshot & { globalPurgeRows?: PageWithdrawal[] };

const hasFence = (text: unknown): text is string => typeof text === 'string' && text.includes('gbrain:facts:begin');

/** The store snapshot as the SQL engines answer it: page decoded, `*` tombstones resolved, the overlay applied. */
export async function overlaidSnapshot(brain: StoreBrain, member: string, stored: StoreSnapshot): Promise<PageSnapshot> {
  const { globalPurgeRows, ...snapshot } = stored;
  const page = toGetPage(snapshot.page);
  const ledger = snapshot.withdrawals ?? [];
  const tombstones = globalPurgeRows ?? [];
  if ((!ledger.length && !tombstones.length) || (!hasFence(page.compiled_truth) && !hasFence(page.timeline))) {
    return { ...snapshot, page };
  }
  const [normalized]: NormalizedFenceLines[] = await storeCall({ member, slug: page.slug }, () =>
    brain.normalizeFenceLines([page.compiled_truth ?? ''], [page.timeline ?? '']));
  const body = normalized?.body ?? '', timeline = normalized?.timeline ?? '';
  const hashes = tombstones.length ? new Set(fenceClaimHashes([body, timeline])) : new Set<string>();
  const withdrawals = [...ledger, ...tombstones.filter(row => hashes.has(row.fact_hash))];
  if (!isSegmentedPage(page)) {
    page.compiled_truth = overlayWithdrawalBody(page.compiled_truth, body, withdrawals);
    if (typeof page.timeline === 'string') page.timeline = overlayWithdrawalBody(page.timeline, timeline, withdrawals);
  }
  return { ...snapshot, page, withdrawals };
}
