/**
 * Segmented page storage (Wave B, spec 7.3 item 5): the withdrawal overlay of
 * one segment. readPageSnapshot overlays an inline body whole; a segmented
 * body is overlaid segment by segment, with the same ledger (the page's
 * withdrawals, subject '*' included, and its '*' purge marker) and the same
 * DB normalization (overlayCanonicalBodies), so the 16,384-marker
 * capacity applies per segment. Used by every reader of segment text that
 * must not show withdrawn rows: the segment reader and the segment chunker.
 */
import type { BrainEngine } from '../engine.ts';
import { partialFenceRuns } from '../facts/withdrawal-overlay.ts';
import { overlayCanonicalBodies } from '../page-state/snapshot.ts';
import type { GlobalPurgeMarker, PageWithdrawal } from '../page-state/types.ts';
import { readEntryState } from './entry-state.ts';
import { projectionStaleError } from './segment-projection.ts';

/** The withdrawal ledger of a page (readPageSnapshot's `withdrawals` and `globalPurges`). */
export interface BodyLedger { withdrawals: PageWithdrawal[]; globalPurges?: GlobalPurgeMarker }

export async function readBodyLedger(engine: Pick<BrainEngine, 'readPageSnapshot'>, sourceId: string, slug: string): Promise<BodyLedger> {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  return { withdrawals: snapshot?.withdrawals ?? [], ...(snapshot?.globalPurges ? { globalPurges: snapshot.globalPurges } : {}) };
}

export function ledgerApplies(ledger: BodyLedger): boolean {
  return ledger.withdrawals.length > 0 || (ledger.globalPurges?.count ?? 0) > 0;
}

/**
 * The segment's text after the page's withdrawal overlay. A fence block a
 * forced cut splits cannot be overlaid from one segment: with a ledger that
 * applies, the read view omits its runs here (`view: 'read'`, fail closed) and
 * a trusted body read refuses with `page_projection_stale` (read-range.ts
 * `trustedSegments` joins such a block's segments before overlaying them).
 */
export async function overlaySegmentText(engine: Pick<BrainEngine, 'executeRaw'>, ledger: BodyLedger,
  segment: { sourceId: string; byteStart: number; entryState: unknown }, raw: string, view: 'read' | 'trusted'): Promise<string> {
  if (!ledgerApplies(ledger)) return raw;
  const query = <T>(sql: string, params?: unknown[]) => engine.executeRaw<T>(sql, params);
  const text = raw.includes('gbrain:facts:begin')
    ? (await overlayCanonicalBodies(query, raw, '', ledger.withdrawals, { sourceId: segment.sourceId, marker: ledger.globalPurges })).compiled_truth
    : raw;
  const entryOpen = readEntryState(segment.entryState)?.withdrawal.open === true;
  if (!entryOpen && !text.includes('gbrain:facts:')) return text;
  const { head, tail } = partialFenceRuns(text, entryOpen);
  if (head === 0 && tail === text.length) return text;
  if (view === 'trusted') throw projectionStaleError(segment.byteStart, 'a facts fence block crosses a forced cut and the source has withdrawals');
  return text.slice(head, Math.max(head, tail));
}
