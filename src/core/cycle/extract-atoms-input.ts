/**
 * #6503: the extract_atoms input cap and what a cut item becomes.
 *
 * The model reads at most `cycle.extract_atoms.max_input_chars` characters of
 * an item (`cycle.extract_atoms.max_source_chars` is the older spelling of the
 * same knob). Before this module the cut was silent and the item was then
 * stamped complete on its full content hash, so the tail was never read and a
 * re-extraction could retire the atoms an earlier, larger-cap extraction had
 * produced from it. A cut item now gets a *partial disposition*: its head is
 * extracted once and the atoms are published, but no completion stamp is
 * written and no absent atom is retired. The disposition is recorded under
 * (content hash, cap) in `extract_atoms_page_state` /
 * `extract_atoms_transcript_state` (`partial_input_chars`) or, on a managed
 * brain, in the item's `managed-atoms` checkpoint (`partial`), so discovery
 * skips the item (it is not re-spent) until the cap rises or the content
 * changes. `releasePartialDispositions` runs before discovery with the current
 * cap and clears the records a raised cap supersedes.
 */
import type { BrainEngine } from '../engine.ts';
import type { SqlEngine } from '../persistence/model.ts';
import { truncateUtf8 } from '../text-safe.ts';
import { corpusTextForExtraction } from '../context/corpus-segments.ts';
import { AtomPageStateError, type AtomPageInput } from './extract-atoms-page-state.ts';
import { planExtraction, type ExtractionPlan, type StoredWatermark } from '../extraction-watermark.ts';

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
  /** Exactly the text the model receives; quote provenance verifies against it. */
  promptContent: string;
  /** The model does not read the whole item (a head, an appended tail or its newest window): partial disposition. */
  truncated: boolean;
  /** Characters of the text the cap applied to (post paste-strip for a transcript). */
  inputChars: number;
  /** A page's watermark plan (extraction-watermark.ts), stored once the item's extraction succeeded. */
  plan?: ExtractionPlan;
}

/**
 * Bind the cut once. Pastes are stripped from a transcript first (#5812), the
 * cap is applied UTF-8-safely (#4529/#4540: a bare slice can split a
 * surrogate pair), and `truncated` is measured on the text the cap applied to.
 * Large pages A7: a page whose stored watermark still matches its body reads
 * the text appended since (`watermark`); a tail read is partial input too, so
 * the #6503 disposition holds (no completion stamp, nothing retired).
 */
export function extractAtomsInput(item: ExtractAtomsItem, maxInputChars: number, watermark: StoredWatermark | null = null): ExtractAtomsInput {
  if (item.kind === 'page') {
    const plan = planExtraction(item.content, watermark, { cap: maxInputChars, pipeline: 'extract_atoms', emptyTail: 'head' });
    return { promptContent: plan.text, truncated: plan.mode !== 'full', inputChars: item.content.length, plan };
  }
  const text = corpusTextForExtraction(item.filePath, item.content);
  const promptContent = truncateUtf8(text, maxInputChars);
  return { promptContent, truncated: promptContent.length < text.length, inputChars: text.length };
}

/** The one stderr line per cut item; names the knob that raises the cap. Null for a complete appended-tail read. */
export function inputTruncatedLine(originLabel: string, input: ExtractAtomsInput, maxInputChars: number): string | null {
  const cut = input.plan?.truncated;
  if (input.plan && !cut) return null;
  if (cut?.kind === 'tail_window') {
    return `[extract_atoms] ${originLabel}: ${cut.total_chars} chars were appended since the last extraction; the model read the newest ${cut.processed_chars}. `
      + `Atoms are kept, the item is not marked complete, and doctor's extraction_input_truncated lists it: gbrain config set ${EXTRACT_MAX_INPUT_CHARS_KEY} <n>`;
  }
  return `[extract_atoms] ${originLabel}: input truncated to ${maxInputChars} of ${input.inputChars} chars; the model did not read the tail. ` +
    `Atoms from the head are kept, the item is not marked complete and is skipped until the cap rises: gbrain config set ${EXTRACT_MAX_INPUT_CHARS_KEY} <n>`;
}

/**
 * Clear the partial dispositions a raised cap supersedes, so the items they
 * covered are offered again by this run's discovery. Rows recorded at or
 * above the current cap stay (the model would read the same text again).
 * Fail-soft: a failed release leaves the items skipped, never re-spent.
 */
export async function releasePartialDispositions(engine: BrainEngine, sourceId: string, maxInputChars: number): Promise<void> {
  try {
    await engine.executeRaw(
      `UPDATE extract_atoms_page_state scan SET partial_input_chars=NULL, updated_at=now()
         FROM sources s WHERE s.id=$1 AND scan.source_incarnation=s.incarnation AND scan.partial_input_chars < $2`,
      [sourceId, maxInputChars]);
    await engine.executeRaw(
      `UPDATE extract_atoms_transcript_state SET partial_input_chars=NULL, updated_at=now()
        WHERE source_id=$1 AND partial_input_chars < $2`,
      [sourceId, maxInputChars]);
    await engine.executeRaw(
      `DELETE FROM op_checkpoints WHERE op='managed-atoms' AND completed_keys->0->>'sourceId'=$1
         AND (completed_keys->0->>'partial')::integer < $2`,
      [sourceId, maxInputChars]);
  } catch (err) {
    console.error(`[extract_atoms] partial-disposition release failed (cut items stay skipped): ${err instanceof Error ? err.message : String(err)}`);
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

/**
 * Record an unmanaged item's partial disposition under its current content
 * and the cap it was read under. The page row is pinned to the page identity
 * discovery read (the same predicate `writeAtomPageState` uses), so a page
 * that changed under the run records nothing and stays retryable.
 */
export async function recordPartialDisposition(engine: SqlEngine, sourceId: string, item: ExtractAtomsItem, maxInputChars: number): Promise<void> {
  if (item.kind === 'transcript') {
    await engine.executeRaw(
      `INSERT INTO extract_atoms_transcript_state (source_id, file_path, content_hash, fail_count, tombstoned, partial_input_chars, updated_at)
       VALUES ($1, $2, $3, 0, FALSE, $4, now())
       ON CONFLICT (source_id, file_path, content_hash) DO UPDATE SET partial_input_chars=EXCLUDED.partial_input_chars, updated_at=now()`,
      [sourceId, item.filePath, item.contentHash.slice(0, 16), maxInputChars]);
    return;
  }
  if (!item.identity) throw new AtomPageStateError('unpinned');
  const rows = await engine.executeRaw(
    `INSERT INTO extract_atoms_page_state (source_incarnation, page_id, content_hash, fail_count, tombstoned, partial_input_chars)
      SELECT s.incarnation, p.id, p.content_hash, 0, false, $7::integer
      FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE p.id=$1 AND s.incarnation=$2::uuid AND p.source_id=$3 AND p.slug=$4
        AND p.content_hash=$5 AND p.knowledge_revision=$6::uuid AND p.deleted_at IS NULL
      FOR SHARE OF p, s
      ON CONFLICT (source_incarnation, page_id, content_hash) DO UPDATE
        SET partial_input_chars=EXCLUDED.partial_input_chars, updated_at=now()
      RETURNING page_id`,
    [item.identity.pageId, item.identity.sourceIncarnation, sourceId, item.slug, item.contentHash, item.identity.revision, maxInputChars])
    .catch((error: unknown) => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      throw new AtomPageStateError(code === '42P01' ? 'schema' : code === '42501' ? 'denied' : 'storage');
    });
  if (!rows.length) throw new AtomPageStateError('changed');
}
