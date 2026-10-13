/**
 * #6503: fact extraction over text longer than the extractor ceiling.
 *
 * The extractor reads at most MAX_TURN_TEXT_CHARS characters per call
 * (extract.ts keeps that slice only as a defensive guard). Before this module
 * the facts pipeline handed a page's whole `compiled_truth` (and any long
 * `extract_facts` turn text) to one call, so everything past 8,000 characters
 * was silently dropped. Now a text that fits is one call, unchanged; a longer
 * text is split into overlapping windows (text-windows.ts) that each fit the
 * ceiling with a one-line part header, one call per window, and the facts are
 * merged. Windows break on blank lines, then lines, then sentences, and share
 * FACT_WINDOW_OVERLAP_CHARS characters so a claim straddling a boundary is
 * read whole at least once.
 *
 * Any failed window fails the whole text with that window's outcome: the
 * caller's existing failure contract (throw on transport failures, a
 * skipped_reason otherwise) applies to the text as a unit, so a page is never
 * reported as extracted when part of it was not read.
 *
 * Merging: an exact repeat across windows (the same claim fingerprint as the
 * facts index uses, gbrain_fact_normalize, about the same entity and speaker)
 * keeps its first occurrence; the caller may pass `isRepeat` to also drop
 * near-repeats with its own dedup verdict. Everything else then flows through
 * the pipeline's usual DB dedup and write decision.
 */
import { extractFactsFromTurnWithOutcome, MAX_TURN_TEXT_CHARS, type ExtractedFact, type ExtractFactsOutcome, type ExtractInput } from './extract.ts';
import { normalizeLoweredClaim } from './withdrawal-schema.ts';
import { planTextWindows, type TextWindow } from '../text-windows.ts';

/** Room kept in every window for the part header. */
export const FACT_WINDOW_HEADER_RESERVE = 200;
/** Text characters per window: the extractor ceiling minus the header. */
export const FACT_WINDOW_CHARS = MAX_TURN_TEXT_CHARS - FACT_WINDOW_HEADER_RESERVE;
/** Characters consecutive windows share (~6% of a window). */
export const FACT_WINDOW_OVERLAP_CHARS = 500;

/** One window (the text itself) when it fits the ceiling; otherwise overlapping windows of FACT_WINDOW_CHARS. */
export function planFactWindows(text: string): TextWindow[] {
  if (text.length <= MAX_TURN_TEXT_CHARS) return [{ index: 0, count: 1, start: 0, end: text.length, text }];
  return planTextWindows(text, FACT_WINDOW_CHARS, FACT_WINDOW_OVERLAP_CHARS);
}

/** The text one window's call receives: a part header (within FACT_WINDOW_HEADER_RESERVE) and the window. */
export function factWindowText(window: TextWindow, totalChars: number): string {
  return `[Part ${window.index + 1} of ${window.count} of one longer text, characters ${window.start}-${window.end} of ${totalChars}. ` +
    `Parts overlap slightly; a claim near an edge may appear in two parts.]\n${window.text}`;
}

const claimKey = (f: ExtractedFact): string =>
  `${(f.entity_slug ?? '').toLowerCase()}\u0000${f.attributed_to ?? ''}\u0000${normalizeLoweredClaim(f.fact.toLowerCase().trim().replace(/\s+/g, ' '))}`;

/** Merge per-window facts in window order, dropping exact repeats and (when given) `isRepeat` near-repeats of kept facts. */
export async function mergeWindowFacts(
  perWindow: ExtractedFact[][],
  isRepeat?: (candidate: ExtractedFact, kept: ExtractedFact) => Promise<boolean>,
): Promise<ExtractedFact[]> {
  const kept: ExtractedFact[] = [];
  const keys = new Set<string>();
  for (const facts of perWindow) {
    for (const fact of facts) {
      const key = claimKey(fact);
      if (keys.has(key)) continue;
      let repeat = false;
      if (isRepeat) for (const prior of kept) if (await isRepeat(fact, prior)) { repeat = true; break; }
      if (repeat) continue;
      keys.add(key);
      kept.push(fact);
    }
  }
  return kept;
}

/**
 * Extract facts from text of any length. A text within the ceiling is the
 * single historical call with the input untouched; a longer one is one call
 * per window (same model, hints, observation date and admission), stopping at
 * the first failed window and returning its outcome.
 */
export async function extractFactsFromTextWithOutcome(
  input: ExtractInput,
  opts: {
    isRepeat?: (candidate: ExtractedFact, kept: ExtractedFact) => Promise<boolean>;
    /** Test seam: the per-call extractor. */
    extractOne?: (input: ExtractInput) => Promise<ExtractFactsOutcome>;
  } = {},
): Promise<ExtractFactsOutcome> {
  const extractOne = opts.extractOne ?? extractFactsFromTurnWithOutcome;
  if (input.isDreamGenerated || !input.turnText) return extractOne(input);
  const windows = planFactWindows(input.turnText);
  if (windows.length === 1) return extractOne(input);
  const perWindow: ExtractedFact[][] = [];
  for (const window of windows) {
    const outcome = await extractOne({ ...input, turnText: factWindowText(window, input.turnText.length) });
    if (!outcome.ok) return outcome;
    perWindow.push(outcome.facts);
  }
  return { ok: true, facts: await mergeWindowFacts(perWindow, opts.isRepeat) };
}
