/**
 * Per-segment derivation watermarks (Wave B PR 4, wave-b spec 8.1-8.6): the shared types and pure helpers every
 * incremental pipeline codes against. Rows live in page_segment_derivations (DDL in page-body/schema.ts, migration
 * v273); the engine reads and writes them through readSegmentDerivations / upsertSegmentDerivations /
 * retireSegmentDerivations (SQL in engine-sql/page-body.ts).
 *
 * A row says: pipeline `kind` at `version` ran on occurrence `occurrenceId` of a page while the occurrence held the
 * segment text `segmentSha256` in the context `contextHash`, and settled in `state`. The work left for a pipeline is
 * every live occurrence without a settled row whose three inputs match (planSegmentDerivations), so the set is found
 * from manifest metadata without reading a body. 'done' and 'skipped' are settled (a skip is a decision made for those
 * exact inputs); 'partial' and 'failed' are retried.
 *
 * facts.source_window anchors a conversation fact to the window it was extracted from (SourceWindow), so an append
 * extracts only new windows and deletes only the facts of retired ones.
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../belief/keys.ts';
import { SEGMENT_DERIVATION_KINDS, SEGMENT_DERIVATION_STATES } from './schema.ts';

export { SEGMENT_DERIVATION_KINDS, SEGMENT_DERIVATION_STATES };
export type SegmentDerivationKind = typeof SEGMENT_DERIVATION_KINDS[number];
export type SegmentDerivationState = typeof SEGMENT_DERIVATION_STATES[number];
export const SETTLED_DERIVATION_STATES: readonly SegmentDerivationState[] = ['done', 'skipped'];

/**
 * What a pipeline records for one occurrence. `output` stays bounded per segment (candidates, keys, digests, anchors).
 * It is not text-free: a links row keeps the excerpts and dated lines its candidates carry (what links.context and the
 * temporal pass store), so the store is swept, not probed: a fact purge deletes every row of the pages it rewrote, or that
 * no live segment backs, whose output or receipt holds the claim in its normalized form (segment-derive.ts
 * continueDerivationPurges, in batches after the purge commits; a live segment's row on another page holds what that page's prose still says, and the receipt
 * reports it with that prose), fence rewrites delete the rows of the runs they touched and of
 * occurrences no longer live, and demotion to inline deletes the page's rows. Prefer digests and offsets where the
 * pipeline can read the segment again (a fences row keeps fence digests, never fence text).
 */
export interface SegmentDerivationInput {
  pageId: number;
  kind: SegmentDerivationKind;
  occurrenceId: number;
  version: number;
  segmentSha256: Uint8Array;
  contextHash: Uint8Array;
  state: SegmentDerivationState;
  output: unknown;
  receipt: unknown;
}

/** A stored row: the input plus its timestamps (ISO-8601 UTC). */
export interface SegmentDerivationRow extends SegmentDerivationInput {
  createdAt: string;
  updatedAt: string;
}

/**
 * The context hash of one segment for one pipeline: SHA-256 over the canonical JSON of the pipeline kind, the
 * segment's manifest `entry_state` and every page-level input the pipeline reads (title, type, pack fingerprint,
 * gazetteer generation, gap settings, ...). Canonical JSON sorts keys at every depth, so an entry state read back
 * from JSONB hashes the same as the one the segmenter built. The pipeline version is stored beside the hash, not in it.
 */
export function segmentDerivationContextHash(kind: SegmentDerivationKind, input: { entryState: unknown; page: Record<string, unknown> }): Uint8Array {
  const digest = createHash('sha256').update(canonicalJson(['gbrain.segment_derivation.v1', kind, input.entryState ?? null, input.page])).digest();
  return new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
}

/** A live occurrence as a pipeline sees it: identity, segment text hash and its context hash for that pipeline. */
export interface LiveSegment {
  occurrenceId: number;
  sha256: Uint8Array;
  contextHash: Uint8Array;
}

export interface SegmentDerivationPlan {
  /** Live occurrences to (re)derive, in input order. */
  todo: LiveSegment[];
  /** Settled rows whose inputs still match a live occurrence: their outputs are the page aggregate's inputs. */
  current: SegmentDerivationRow[];
  /** Rows whose occurrence is no longer live: delete them (retireSegmentDerivations) and undo their effects. */
  retired: SegmentDerivationRow[];
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b));

/** Split one pipeline's rows of a page against its live occurrences at `version` (rows of another kind are ignored). */
export function planSegmentDerivations(kind: SegmentDerivationKind, version: number, live: readonly LiveSegment[],
  rows: readonly SegmentDerivationRow[]): SegmentDerivationPlan {
  const byOccurrence = new Map<number, SegmentDerivationRow>();
  for (const row of rows) if (row.kind === kind) byOccurrence.set(row.occurrenceId, row);
  const liveIds = new Set(live.map(segment => segment.occurrenceId));
  const plan: SegmentDerivationPlan = { todo: [], current: [], retired: [] };
  for (const segment of live) {
    const row = byOccurrence.get(segment.occurrenceId);
    const settled = row !== undefined && SETTLED_DERIVATION_STATES.includes(row.state) && row.version === version
      && sameBytes(row.segmentSha256, segment.sha256) && sameBytes(row.contextHash, segment.contextHash);
    if (settled) plan.current.push(row);
    else plan.todo.push(segment);
  }
  for (const row of byOccurrence.values()) if (!liveIds.has(row.occurrenceId)) plan.retired.push(row);
  return plan;
}

/** facts.source_window: the conversation window a fact came from. Snake-case keys: it is stored as JSONB as-is. */
export interface SourceWindow {
  occurrence_id: number;
  window_ordinal: number;
  /** Lowercase hex SHA-256 of the rendered window text the extractor saw. */
  window_text_sha: string;
}

export function sourceWindowFor(occurrenceId: number, windowOrdinal: number, windowText: string): SourceWindow {
  return { occurrence_id: occurrenceId, window_ordinal: windowOrdinal, window_text_sha: createHash('sha256').update(windowText).digest('hex') };
}

/** One string per window identity, for set membership (live windows vs a page's stored facts). */
export function sourceWindowKey(window: SourceWindow): string {
  return `${window.occurrence_id}:${window.window_ordinal}:${window.window_text_sha}`;
}

/** A stored source_window (already JSONB-decoded), or null for NULL; throws on a value the column CHECK would refuse. */
export function parseSourceWindow(value: unknown): SourceWindow | null {
  if (value === null || value === undefined) return null;
  const w = value as Record<string, unknown>;
  if (typeof value !== 'object' || Array.isArray(value) || !Number.isSafeInteger(w.occurrence_id) || !Number.isSafeInteger(w.window_ordinal)
    || typeof w.window_text_sha !== 'string' || !/^[0-9a-f]{64}$/.test(w.window_text_sha)) {
    throw new Error(`malformed facts.source_window: ${JSON.stringify(value)}`);
  }
  return { occurrence_id: w.occurrence_id as number, window_ordinal: w.window_ordinal as number, window_text_sha: w.window_text_sha };
}

/** Derivation rows a fact purge's recorded sweep refused (they hold its claim); the caller's step did not settle. */
export class DerivationWriteRefused extends Error {
  readonly code = 'derivation_purge_pending';
  constructor(readonly refused: number) {
    super(`${refused} derivation row(s) were not stored: a fact purge's sweep of stored derivation results is still running and they hold its claim.`);
  }
}
