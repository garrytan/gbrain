/**
 * extract_atoms quote provenance and window merge (#4706, #6503). Peeled out
 * of extract-atoms.ts, which re-exports `locateQuote` and `mergeWindowAtoms`.
 */
import { slugifySegment } from '../sync.ts';
import type { TextWindow } from '../text-windows.ts';
import type { ExtractedAtom } from './extract-atoms-parse.ts';
import { normalizeForGrounding } from './synthesize-verify.ts';

/**
 * #4706 — locate a model-returned quote inside the text it was extracted from.
 *
 * This is the provenance step, and it runs at EXTRACTION because the
 * alternative — matching a stored quote back to its source LATER — is not
 * solvable: a passage and its negation ("would not improve" vs "would
 * improve") are ~99% similar, so no after-the-fact matcher can tell which one
 * an atom came from, and picking wrong writes a reversed claim into the
 * brain. At extraction there is no such ambiguity: we know exactly which text
 * was sent to the model, so the question collapses to "is this string in the
 * text we just handed it?" — a fact rather than a guess.
 *
 * Folding rides `normalizeForGrounding` — the v0.47.8.0 quote-repair core in
 * synthesize-verify.ts (the "ONE folding core" invariant: this module must
 * mean the same thing by "normalized substring" as the repair ladder does).
 * Everything is decided in FOLDED space, including uniqueness: a typographic
 * twin ('“go now”' vs '"go now"') is only visible there, and returning an
 * offset that might name the wrong passage is worse than returning none.
 *
 * Fail-closed on ambiguity: candidates are validated by a round-trip re-fold
 * (folding is lossy and one-to-many — '…' → '...' — so a folded hit can land
 * part-way through one original character), THEN counted. Zero or 2+ valid
 * passages → null; a truncated scan (MAX_CANDIDATES exhausted with hits
 * pending) is UNPROVEN uniqueness → null.
 *
 * Returns ORIGINAL-text offsets, or null when the model paraphrased.
 */
export function locateQuote(
  content: string,
  quote: string,
): { start: number; end: number } | null {
  if (!quote || !content) return null;
  const c = normalizeForGrounding(content);
  const q = normalizeForGrounding(quote);
  if (!q.norm) return null;

  // Enumerate every folded hit, keep those that survive the round-trip
  // boundary check, THEN judge ambiguity. Order matters: rejecting on raw
  // hit-count first would let an INVALID partial-character match veto a
  // genuinely unique valid one ("No. First. No… not ever" has two folded
  // hits for "no." but only the first is character-aligned).
  const valid: Array<{ start: number; end: number }> = [];
  const MAX_CANDIDATES = 8; // pathological input shouldn't scan a whole book
  let at = c.norm.indexOf(q.norm);
  let seen = 0;
  while (at !== -1 && seen < MAX_CANDIDATES) {
    seen++;
    const start = c.map[at]!;
    // map[] names the FIRST code unit of the original character; advance the
    // end by the whole code point, not +1 — a bare +1 splits the surrogate
    // pair when the quote ends with a non-BMP char ('ship it 🚀'), and the
    // half-pair slice then fails the round-trip re-fold below.
    const lastOrig = c.map[at + q.norm.length - 1]!;
    const lastCp = content.codePointAt(lastOrig);
    const end = lastOrig + (lastCp !== undefined && lastCp > 0xffff ? 2 : 1);
    if (
      normalizeForGrounding(content.slice(start, end)).norm === q.norm &&
      !valid.some(v => v.start === start && v.end === end)
    ) {
      valid.push({ start, end });
    }
    // Step by one, not by length: overlapping hits are distinct passages
    // for ambiguity purposes.
    at = c.norm.indexOf(q.norm, at + 1);
  }
  // Cap exhausted with hits still pending: uniqueness UNPROVEN → fail closed.
  if (at !== -1) return null;
  // Exactly one surviving passage, or we cannot say which the atom used.
  if (valid.length !== 1) return null;
  return valid[0]!;
}

/**
 * Canonical slug stem for an atom title. Routes through slugifySegment (the
 * same normalizer the FS-import path uses) and RE-STRIPS a trailing dash after
 * the 60-char truncation — the cut can land on a hyphen and re-introduce one.
 * Two writers disagreeing on that trailing dash (`…would` vs `…would-`) was the
 * "trailing-dash twin" duplicate bug.
 */
export function atomSlugStem(title: string): string {
  return slugifySegment(title).slice(0, 60).replace(/-+$/g, '') || 'untitled';
}

/** An extracted atom with its provenance fields decided (#4706) and ready for frontmatter. */
export type MergedAtom = ExtractedAtom & { quoteFields: Record<string, unknown> };

/**
 * #6503 — merge what an item's windows returned into one atom list.
 *
 * Provenance (#4706) is decided per window: a quote is located inside the
 * window the model READ (never the wider item, so a quote that happens to
 * occur elsewhere in the item cannot verify), then its offsets are shifted by
 * the window's start so `source_quote_offset` indexes the full item text and
 * `source_quote` is the full text's own characters at those offsets. A quote
 * not located in its window is dropped with `quote_unverified`.
 *
 * A single window is passed through in order, untouched (the historical
 * one-call behavior). Across windows, an atom is a repeat and dropped when its
 * whole title folds (slugifySegment: case, punctuation, accents) to the same
 * slug as a kept atom's, or its verified quote overlaps a kept atom's verified
 * quote (the same passage, read twice in the overlap). The fold is NOT cut to
 * the 60-char slug stem: atomSlug() hashes the full title precisely so two
 * distinct titles sharing that stem stay separate atoms, and the merge must
 * not drop one of them as a repeat. The first occurrence is kept; a kept atom
 * without a verified quote adopts a repeat's verified one.
 */
export function mergeWindowAtoms(text: string, settled: Array<{ window: TextWindow; atoms: ExtractedAtom[] }>): MergedAtom[] {
  const out: MergedAtom[] = [];
  const byTitle = new Map<string, MergedAtom>();
  const spans: Array<{ start: number; end: number; atom: MergedAtom }> = [];
  const multi = settled.length > 1;
  for (const { window, atoms } of settled) {
    for (const atom of atoms) {
      const loc = atom.source_quote ? locateQuote(window.text, atom.source_quote) : null;
      const span = loc ? { start: loc.start + window.start, end: loc.end + window.start } : null;
      const quoteFields: Record<string, unknown> = atom.source_quote
        ? (span
            ? { source_quote: text.slice(span.start, span.end), source_quote_offset: [span.start, span.end], source_quote_verified: true }
            : { quote_unverified: 'model paraphrased; not present in source' })
        : {};
      const merged: MergedAtom = { ...atom, quoteFields };
      if (!multi) { out.push(merged); continue; }
      const titleKey = slugifySegment(atom.title) || atom.title;
      const repeat = byTitle.get(titleKey) ?? (span ? spans.find(s => s.start < span.end && span.start < s.end)?.atom : undefined);
      if (repeat) {
        if (span && repeat.quoteFields.source_quote_verified !== true) {
          repeat.quoteFields = quoteFields;
          spans.push({ ...span, atom: repeat });
        }
        continue;
      }
      out.push(merged);
      byTitle.set(titleKey, merged);
      if (span) spans.push({ ...span, atom: merged });
    }
  }
  return out;
}
