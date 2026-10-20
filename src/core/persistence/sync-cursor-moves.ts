/**
 * #6712 (L2, one page, one fate): the managed-sync cursor's pure transitions, peeled out of sync-run.ts. Each returns
 * the next cursor and writes nothing; sync-run.ts saves it with one compare-and-swap. An entry the cursor passes without
 * a commit (waived, held, settled) joins the settled index ranges the checkpoint skips; a deferred entry (retried past
 * the manifest end) leaves the deferred list instead of moving the index; the window of requests admitted after a
 * passed entry becomes the cursor's group, so those requests are read, never frozen again.
 */
import { addSettledRange, type SyncSettledIndexes } from './checkpoint-validation.ts';
import { dependencyKeys } from './sync-group.ts';
import type { Cursor, Pending } from './sync-run.ts';
import type { HeldEntry } from './sync-screen.ts';
import type { NoopWaiver } from './sync-waivers.ts';

/** The cursor after a waived entry: counted under `waived`, plus the #5751 kernel breakdown kept for `legacySkips`. */
export function waivedCursor(cursor: Cursor, waived: NoopWaiver, index = cursor.index): Cursor {
  const prior = cursor.counts.waived ?? { imports: 0, deletes: 0 };
  const passed: Cursor = { ...cursor }; delete passed.pending; delete passed.group;
  const next: Cursor = { ...settledPast(passed, index), counts: { ...cursor.counts,
    waived: { imports: prior.imports + (waived.kind === 'import' ? 1 : 0), deletes: prior.deletes + (waived.kind === 'delete' ? 1 : 0) } } };
  if (waived.kernel.includes('contextual_mode')) next.counts.skippedContextualMode = (next.counts.skippedContextualMode ?? 0) + 1;
  if (waived.kernel.includes('canonical_file_differs')) next.counts.skippedCanonicalBytes = (next.counts.skippedCanonicalBytes ?? 0) + 1;
  if (cursor.passId && waived.kernel.length) next.passLegacyWaived = [...cursor.passLegacyWaived ?? [], index];
  return next;
}
/** #6643: the cursor's settled indexes with its current entry added (it passes that entry without a commit). */
export function settleIndex(cursor: Cursor): SyncSettledIndexes {
  return addSettledRange(cursor.settled ?? { from: cursor.index, ranges: [] }, cursor.index, cursor.index);
}
/** #5988: the cursor past a held entry (no request admitted for it, or none committed); #6712: `index` may name a deferred entry. */
export function advanceHeld(held: Cursor, converted?: string[], index = held.index): Cursor {
  const next: Cursor = { ...held, counts: { ...held.counts, held: (held.counts.held ?? 0) + 1 }, ...(converted ? { convertedFromFailed: converted } : {}) };
  delete next.pending; delete next.group;
  return settledPast(next, index);
}
/**
 * #6712: the cursor with entry `index` settled without a commit: the cursor's own entry advances the cursor, a deferred
 * entry leaves the deferred list. Either way the index joins the settled ranges the checkpoint skips.
 */
export function settledPast(cursor: Cursor, index: number): Cursor {
  if (index === cursor.index) return promoteWindow({ ...cursor, index: cursor.index + 1, settled: settleIndex(cursor) });
  const next: Cursor = { ...cursor, deferred: (cursor.deferred ?? []).filter(entry => entry.index !== index),
    settled: addSettledRange(cursor.settled ?? { from: cursor.index, ranges: [] }, index, index) };
  if (!next.deferred!.length) delete next.deferred;
  return next;
}
/**
 * #6712: a cursor with no pending entry whose window starts at its index takes the window's first group as its group:
 * those requests were admitted after an entry the cursor has now passed, and are read, never frozen again.
 */
export function promoteWindow(cursor: Cursor): Cursor {
  const [first, ...rest] = cursor.window ?? [];
  if (cursor.pending || !first?.length) return cursor;
  // A pass's intents carry no index (cursorIntent): its window head is the entry at the cursor's index by path, never frozen again under the same request.
  const head = first[0]!.intent;
  if (typeof head.index === 'number' ? head.index !== cursor.index : head.path == null || head.path !== cursor.entries[cursor.index]?.path) return cursor;
  const next: Cursor = { ...cursor, pending: first[0], group: first };
  if (rest.length) next.window = rest; else delete next.window;
  return next;
}
/** #6712: the cursor past its committed pending entry: its own entry advances it, a deferred one leaves the deferred list (its receipt is its record). */
export function committedPast(cursor: Cursor, pending: Pending): Cursor {
  const index = indexOf(cursor, pending);
  const next: Cursor = { ...cursor }; delete next.pending; delete next.group;
  if (index === cursor.index) return promoteWindow({ ...next, index: cursor.index + 1 });
  next.deferred = (cursor.deferred ?? []).filter(entry => entry.index !== index);
  if (!next.deferred.length) delete next.deferred;
  return next;
}
/** #6712: the entry a pending request was frozen for: the cursor's own, or a deferred one past the manifest end. */
export const indexOf = (cursor: Cursor, pending: Pending) => typeof pending.intent.index === 'number' ? pending.intent.index : cursor.index;
export const entryOf = (cursor: Cursor, pending: Pending) => cursor.entries[indexOf(cursor, pending)];
/** #6712: the cursor without `pending` and the group it heads; the window (later admitted requests) stays. */
export function withoutPending(cursor: Cursor): Cursor {
  const base: Cursor = { ...cursor }; delete base.pending; delete base.group;
  return base;
}
/** #6600: the cursor past an idempotent deletion: counted as a waived delete, its index settled. */
export const deletionSettled = (cursor: Cursor, index: number) => waivedCursor(withoutPending(cursor), { kind: 'delete', kernel: [] }, index);
/** #6712: the cursor with `hold`'s page keys recorded, so a later entry of the run that shares one is held behind it. */
export function withHeldKeys(cursor: Cursor, hold: HeldEntry): Cursor {
  if (!hold.slug) return cursor;
  const keys = dependencyKeys({ slug: hold.slug, pageId: hold.page_id ?? null });
  return { ...cursor, heldKeys: { ...cursor.heldKeys, ...Object.fromEntries(keys.map(key => [key, { path: hold.path, code: hold.code }])) } };
}
