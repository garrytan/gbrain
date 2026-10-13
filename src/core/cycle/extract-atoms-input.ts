/**
 * #6503: the extract_atoms input cap and how an item longer than it is read.
 *
 * The model reads at most `cycle.extract_atoms.max_input_chars` characters per
 * call (`cycle.extract_atoms.max_source_chars` is the older spelling of the
 * same knob). An item that fits is one call on its whole text, as it always
 * was. A longer item is split into overlapping windows that each fit the cap
 * (text-windows.ts), one call per window, so the model reads every character:
 * nothing is cut. Quote provenance is verified inside the window the model
 * read and its offsets are mapped back onto the full text, and the item is
 * stamped complete only after every window settled (extract-atoms.ts, with
 * the per-window idempotency in extract-atoms-windows.ts).
 *
 * v0.60.189.0 cut such items at the cap and gave them a *partial disposition*
 * (`partial_input_chars` in `extract_atoms_page_state` /
 * `extract_atoms_transcript_state`, or `partial` on a managed `managed-atoms`
 * checkpoint) so discovery skipped them until the cap rose. Windowing reads
 * the whole item at any cap, so `releasePartialDispositions` clears every
 * such record before discovery and those items are extracted in full.
 */
import type { BrainEngine } from '../engine.ts';
import { corpusTextForExtraction } from '../context/corpus-segments.ts';
import { planTextWindows, type TextWindow } from '../text-windows.ts';
import { ATOM_WINDOW_OVERLAP_CHARS } from './extract-atoms-windows.ts';
import type { AtomPageInput } from './extract-atoms-page-state.ts';

export const DEFAULT_EXTRACT_MAX_INPUT_CHARS = 50_000;
export const EXTRACT_MAX_INPUT_CHARS_KEY = 'cycle.extract_atoms.max_input_chars';

/**
 * The input cap: `max_source_chars` (floor 500) is read first so the newer
 * `max_input_chars` (floor 1000: below that the extractor sees a fragment too
 * small to yield atoms and every item burns budget for nothing) wins when both
 * are set. Fail-soft to the default on any config-read failure.
 */
export async function resolveExtractAtomsInputCap(engine: BrainEngine): Promise<number> {
  let cap = DEFAULT_EXTRACT_MAX_INPUT_CHARS;
  try {
    const legacy = Number(await engine.getConfig('cycle.extract_atoms.max_source_chars'));
    if (Number.isFinite(legacy) && legacy >= 500) cap = Math.floor(legacy);
    const configured = Number(await engine.getConfig(EXTRACT_MAX_INPUT_CHARS_KEY));
    if (Number.isFinite(configured) && configured >= 1_000) cap = Math.floor(configured);
  } catch { /* keep the default */ }
  return cap;
}

export type ExtractAtomsItem =
  | { kind: 'transcript'; filePath: string; content: string; contentHash: string }
  | ({ kind: 'page' } & AtomPageInput);

export interface ExtractAtomsInput {
  /** The full extraction text (post paste-strip for a transcript); stored quote offsets index it. */
  text: string;
  /**
   * The model calls. One window holding `text` unchanged when it fits the cap
   * (the historical single call); otherwise overlapping windows, each within
   * the cap, whose union is `text`.
   */
  windows: TextWindow[];
  /** Characters of `text`. */
  inputChars: number;
}

/**
 * Plan the item's model calls once. Pastes are stripped from a transcript
 * first (#5812); windows never split a surrogate pair (#4529/#4540).
 */
export function extractAtomsInput(item: ExtractAtomsItem, maxInputChars: number): ExtractAtomsInput {
  const text = item.kind === 'transcript' ? corpusTextForExtraction(item.filePath, item.content) : item.content;
  return { text, windows: planTextWindows(text, maxInputChars, ATOM_WINDOW_OVERLAP_CHARS), inputChars: text.length };
}

/**
 * Clear every partial disposition v0.60.189.0 recorded for a cut item, so
 * this run's discovery offers those items again and reads them in full.
 * Fail-soft: a failed release leaves the items skipped, never re-spent.
 */
export async function releasePartialDispositions(engine: BrainEngine, sourceId: string): Promise<void> {
  try {
    await engine.executeRaw(
      `UPDATE extract_atoms_page_state scan SET partial_input_chars=NULL, updated_at=now()
         FROM sources s WHERE s.id=$1 AND scan.source_incarnation=s.incarnation AND scan.partial_input_chars IS NOT NULL`,
      [sourceId]);
    await engine.executeRaw(
      `UPDATE extract_atoms_transcript_state SET partial_input_chars=NULL, updated_at=now()
        WHERE source_id=$1 AND partial_input_chars IS NOT NULL`,
      [sourceId]);
    await engine.executeRaw(
      `DELETE FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1
         AND completed_keys->0->>'partial' IS NOT NULL`,
      [sourceId]);
  } catch (err) {
    console.error(`[extract_atoms] partial-disposition release failed (items cut by an earlier version stay skipped): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Stamp the transcript-side tombstone (v146). The file-backed mirror of the
 * page scan state: transcripts have no frontmatter, and their discovery is
 * gated only by `atomsExistingForHashes` and this table, so a transcript that
 * yields no atom row has nothing else to mark it done and would be
 * re-attempted every cycle. The row is (source_id, file_path, content_hash)-
 * keyed, so an edited transcript is a different row and re-eligibilizes.
 * Fail-soft: the transcript stays rediscoverable.
 */
export async function stampTranscriptTombstone(engine: BrainEngine, sourceId: string, filePath: string, contentHash: string): Promise<void> {
  try {
    await engine.executeRaw(
      `INSERT INTO extract_atoms_transcript_state (source_id, file_path, content_hash, fail_count, tombstoned, updated_at)
       VALUES ($1, $2, $3, 0, TRUE, now())
       ON CONFLICT (source_id, file_path, content_hash) DO UPDATE SET tombstoned = TRUE, updated_at = now()`,
      [sourceId, filePath, contentHash.slice(0, 16)]);
  } catch { /* fail-soft: transcript stays rediscoverable */ }
}
