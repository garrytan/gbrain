/**
 * synthesize-verify.ts — mechanical claim verification on dream pages
 * (F1b/F4b, eval write-path fix wave; grounding gate, gbrain 10x amendment 7).
 *
 * The synthesis prompt mandates verbatim quotes and source-exact numbers;
 * measured against the Cat 35 benchmark, fewer than half of quoted spans in
 * produced pages were substrings of the source transcript. This pass runs
 * right after the children's put_page writes and BEFORE stampDreamProvenance /
 * reverseWriteRefs / the phase-end embed sweep, so the provenance stamp, the
 * markdown file, and the embedded chunks all carry the verified body.
 *
 *   writtenRefs ──▶ group by page ──▶ claim units (sentences, list items,
 *   (slug,src,      sources = every     table rows) that are NEW:
 *    raw_source)    transcript that       - whole body for pages created
 *                   wrote the page          during this run
 *                                         - only units absent from the
 *                                           pre-run revision (page_versions)
 *                                           for pages that already existed
 *                                     per new unit:
 *                                       quotes → exact / normalized / near
 *                                         (verbatim transcript slice, never
 *                                         across a speaker turn)
 *                                       attribution → the named speaker must
 *                                         be the turn's speaker
 *                                       numbers → must occur in a source
 *                                     any failure → the WHOLE unit leaves the
 *                                       body and is kept in frontmatter
 *                                       `unverified_claims`
 *
 * Invariants:
 *   - NEVER fabricate: every replacement is a verbatim slice of a source
 *     transcript, trimmed to the matched tokens inside one speaker turn.
 *   - NEVER keep an unsupported derived assertion as authoritative text: the
 *     unit is removed from compiled_truth/timeline (so it has no chunks, no
 *     search_vector weight, no timeline/facts extraction, no think/context
 *     evidence) and preserved verbatim in `unverified_claims` for review.
 *     Frontmatter is not chunked or searched, so the record is visible to
 *     get_page readers but excluded from authoritative recall.
 *   - Provenance: every grounded quote records its source path, the
 *     character span in that source, and the speaker of that turn in
 *     frontmatter `grounding.quotes`.
 *
 * Failure contract (fail-open per page, pacer precedent — a verify bug never
 * kills the phase): page read-back miss → count + skip; write-back throw →
 * log slug+source, count, continue. Zero LLM calls; pure string ops with hard
 * probe/size caps.
 *
 * Write-back reuses the SAME canonical pipeline the children's put_page tool
 * executes — importFromContent (page + tags + chunks + link extraction in one
 * transaction, content_hash recomputed) with noEmbed: the phase-end embed
 * sweep backfills.
 *
 * Kill switch: `dream.synthesize.quote_verify` (default on), read by
 * loadSynthConfig — the incident escape hatch for the one mechanism that
 * rewrites page bodies.
 */

import { basename } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { importFromContent } from '../import-file.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { throwIfAborted } from '../abort-check.ts';
import type { Page } from '../types.ts';
import { materializedHistoryRanges, prepareCanonicalProjections } from '../persistence/canonical-projections.ts';
import { prepareAutomaticLinks } from '../persistence/links-preparation.ts';
import { isAutoLinkEnabled } from '../link-extraction.ts';

/** Minimum quoted-span inner length considered a "quote" (shorter spans are
 * scare quotes / titles, not transcript quotations). */
const MIN_QUOTE_CHARS = 15;
/** Soft cap: quoted spans examined per page (CPU bound, not correctness). */
const MAX_QUOTES_PER_PAGE = 200;
/** Near-match acceptance floor (token overlap) and ambiguity margin. */
const NEAR_MATCH_FLOOR = 0.8;
const NEAR_MATCH_AMBIGUITY = 0.05;
/** A near-match repair longer than this multiple of the quote is refused. */
const NEAR_MATCH_MAX_GROWTH = 1.3;
/** Rung-3 CPU bounds: candidate windows scored, TOTAL trigram indexOf probes
 * (a long ungroundable quote must not do thousands of full-transcript scans
 * on the event loop), trigrams considered (stride-sampled above this), and
 * the largest normalized quote rung 3 will attempt at all — a multi-thousand
 * char "quote" that isn't exact/normalized is fabricated in practice. */
const MAX_ANCHOR_CANDIDATES = 50;
const MAX_ANCHOR_PROBES = 200;
const MAX_NEAR_TRIGRAMS = 50;
const MAX_NEAR_QUOTE_NORM_CHARS = 2000;
/** Near-match window shaping: growth over the quote's normalized length and
 * fixed char slack on each side (clipped to one speaker turn, then trimmed to
 * the matched tokens). */
const WINDOW_GROWTH = 1.2;
const WINDOW_SLACK_BEFORE = 20;
const WINDOW_SLACK_AFTER = 40;
/** Occurrences of an exact/normalized quote considered for speaker checks. */
const MAX_OCCURRENCES = 8;
/** Unique numeric/date claims checked per page (CPU bound). */
const MAX_NUMERIC_CLAIMS_PER_PAGE = 200;
/** Frontmatter record caps (newest kept) so repeated cycles stay bounded. */
const MAX_UNVERIFIED_RECORDS = 100;
const MAX_PROVENANCE_RECORDS = 200;
const PROVENANCE_TEXT_CHARS = 160;

export const UNVERIFIED_CLAIMS_KEY = 'unverified_claims';
export const GROUNDING_KEY = 'grounding';
/** Body left behind when every unit on a page failed verification (the
 * engine refuses to blank a non-empty body for maintenance writers). */
export const ALL_CLAIMS_QUARANTINED_BODY = 'All claims on this page failed source verification; they are kept in `unverified_claims` for review.';

/** Shared code/link masking (offset-preserving): fenced blocks, inline code,
 * wikilinks, and markdown link targets are replaced with spaces so quote
 * marks and slug dates inside them never register as prose claims. */
function maskNonProse(body: string): string {
  return body
    .replace(/```[\s\S]*?(?:```|$)/g, m => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, m => ' '.repeat(m.length))
    .replace(/\[\[[^\]]*\]\]/g, m => ' '.repeat(m.length))
    .replace(/\]\([^)]*\)/g, m => ' '.repeat(m.length));
}

export interface QuoteVerifyStats {
  pages_checked: number;
  /** Pages whose body or grounding record was written back. */
  pages_repaired: number;
  /** Pages with at least one quarantined claim. */
  pages_with_quarantine: number;
  /** Pre-existing pages verified against their pre-run revision (diff only). */
  preexisting_diffed: number;
  /** Pre-existing pages with no revision recorded during this run (unchanged). */
  skipped_unchanged: number;
  quotes_total: number;
  exact: number;
  normalized_fixed: number;
  near_fixed: number;
  unbalanced: number;
  /** Claim units removed from the body into `unverified_claims`. */
  quarantined_claims: number;
  /** Quotes found in no source transcript. */
  quote_not_in_source: number;
  /** Quotes whose only source match crossed a speaker turn. */
  quote_crosses_speakers: number;
  /** Quotes attributed to a speaker other than the one who said them. */
  speaker_mismatch: number;
  /** Numeric/date claims found in no source transcript. */
  number_not_in_source: number;
  skipped_no_transcript: number;
  /** Pages where read-back or write-back failed (fail-open, logged). */
  errors: number;
}

export function emptyQuoteVerifyStats(): QuoteVerifyStats {
  return {
    pages_checked: 0,
    pages_repaired: 0,
    pages_with_quarantine: 0,
    preexisting_diffed: 0,
    skipped_unchanged: 0,
    quotes_total: 0,
    exact: 0,
    normalized_fixed: 0,
    near_fixed: 0,
    unbalanced: 0,
    quarantined_claims: 0,
    quote_not_in_source: 0,
    quote_crosses_speakers: 0,
    speaker_mismatch: 0,
    number_not_in_source: 0,
    skipped_no_transcript: 0,
    errors: 0,
  };
}

/**
 * Offset-mapped grounding normalization — the wave's shared primitive (also
 * used by the triage-rescue segment check and, at prompt-build time, by
 * buildTriageMapBlock's quote filter via the mapless `normForGrounding`).
 *
 * Folds: whitespace runs → single space, curly quotes/apostrophes → straight,
 * unicode dashes → '-', case → lower. `map[i]` = index in the ORIGINAL string
 * of the character that produced `norm[i]`, so any match in normalized space
 * maps back to a VERBATIM original slice (outside-voice amendment: without
 * the map, "replace with verbatim span" would not be verbatim).
 *
 * Invariant: norm.length === map.length ALWAYS — toLowerCase() can expand one
 * code unit into several (U+0130 'İ' → 'i' + U+0307), so every emitted code
 * unit records its own source index (security-review fix: a single push per
 * source char desynced every later offset and could slice garbage — or
 * nothing — back into a page as a "verbatim" repair).
 */
export function normalizeForGrounding(s: string): { norm: string; map: number[] } {
  return foldForGrounding(s, true) as { norm: string; map: number[] };
}

/**
 * The ONE folding core. `withMap=false` skips the offset-map allocation (an
 * 8-byte-per-char array the presence-check callers throw away) but runs the
 * IDENTICAL fold, so `normForGrounding(x) === normalizeForGrounding(x).norm`
 * holds by construction rather than by assertion — including the cases a
 * whole-string `.toLowerCase()` fast path got wrong (Greek final sigma
 * 'ΟΔΟΣ' → per-char 'οδοσ' vs whole-string 'οδος', and non-BMP pairs).
 * Parity matters: the rescue gate and the repair ladder must mean the same
 * thing by "normalized substring of the transcript".
 */
function foldForGrounding(s: string, withMap: boolean): { norm: string; map: number[] } | string {
  const out: string[] = [];
  const map: number[] = [];
  let pendingSpace = false;
  // Iterate by CODE POINT (for..of), not code unit: a surrogate pair
  // lowercases as a pair (Deseret 𐐀 → 𐐨) but never half by half, so a
  // per-unit loop would silently leave non-BMP text unfolded and diverge
  // from the mapless path. `idx` tracks the code-unit offset for the map.
  let idx = 0;
  for (const cp of s) {
    const i = idx;
    idx += cp.length;
    let ch = cp;
    if (/\s/.test(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (ch === '‘' || ch === '’' || ch === 'ʼ') ch = "'";
    else if (ch === '“' || ch === '”') ch = '"';
    else if (ch === '–' || ch === '—' || ch === '−') ch = '-';
    // #4706: models render '…' as three dots; fold so quote provenance and
    // grounding agree. One-to-many like the toLowerCase expansions below —
    // every emitted unit maps to the ellipsis' original index.
    else if (ch === '…') ch = '...';
    if (pendingSpace) {
      out.push(' ');
      if (withMap) map.push(map.length > 0 ? map[map.length - 1] : i);
      pendingSpace = false;
    }
    const low = ch.toLowerCase();
    for (const lowCp of low) {
      out.push(lowCp);
      if (withMap) for (let k = 0; k < lowCp.length; k++) map.push(i);
    }
  }
  const norm = out.join('');
  return withMap ? { norm, map } : norm;
}

/**
 * Plain normalized form (no offset map) — for presence checks (the triage
 * rescue's segment verification, buildTriageMapBlock's quote filter, the
 * numeric-claim scan). Same fold as normalizeForGrounding by construction;
 * skips only the offset-map allocation.
 */
export function normForGrounding(s: string): string {
  return foldForGrounding(s, false) as string;
}

/** One speaker-turn anchor (`**Name** (ts):`, `role (tN):`, `Name:`), in
 * ORIGINAL transcript offsets. `labelEnd` is where the turn's words begin. */
export interface SpeakerTurn {
  labelStart: number;
  labelEnd: number;
  speaker: string;
}

export interface GroundedTranscript {
  content: string;
  norm: string;
  map: number[];
  /** Speaker-turn anchors, ascending. Absent or empty: no turn structure. */
  turns?: SpeakerTurn[];
}

/** A transcript prepared for verification: grounding text, speaker turns,
 * the canonical numbers and dates it states, and the speaker-mention
 * patterns used for attribution checks. */
export interface GroundedSource extends GroundedTranscript {
  path: string;
  turns: SpeakerTurn[];
  numbers: Set<string>;
  nameNorm: string;
  speakers: Array<{ key: string; label: string; re: RegExp }>;
}

export interface TranscriptForVerify {
  content: string;
}

const ROLE_ALIASES: Record<string, string> = {
  user: 'user', human: 'user', me: 'user',
  assistant: 'assistant', ai: 'assistant', bot: 'assistant',
  system: 'system',
};
const ROLE_MENTION: Record<string, string> = {
  user: 'user|human',
  assistant: 'assistant',
  system: 'system',
};
const BOLD_ANCHOR_RE = /^[ \t]*\*\*([^*\n]{1,60}?)\*\*(?:[ \t]*\([^)\n]{0,40}\))?[ \t]*:/;
const PLAIN_ANCHOR_RE = /^[ \t]*(?:\[[^\]\n]{1,40}\][ \t]*)?([A-Za-z][A-Za-z0-9.'_-]*(?: [A-Za-z][A-Za-z0-9.'_-]*){0,3})(?:[ \t]*\([^)\n]{0,40}\))?[ \t]*:(?=[ \t]|\r?$)/;

/** Canonical speaker identity: role labels fold to their role, names to lowercase. */
export function speakerKey(label: string): string {
  const k = label.trim().toLowerCase();
  return ROLE_ALIASES[k] ?? k;
}

/**
 * Speaker turns from line-start anchors. Bold anchors (the transcript
 * renderer's format) always count; plain `Label:` anchors count when the
 * label is a role word or opens at least two lines, so a prose line such as
 * `Note: ...` is not mistaken for a speaker.
 */
export function parseSpeakerTurns(content: string): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  const plain: SpeakerTurn[] = [];
  const plainCounts = new Map<string, number>();
  let offset = 0;
  for (const line of content.split('\n')) {
    const bold = BOLD_ANCHOR_RE.exec(line);
    if (bold) {
      turns.push({ labelStart: offset, labelEnd: offset + bold[0].length, speaker: bold[1].trim() });
    } else {
      const p = PLAIN_ANCHOR_RE.exec(line);
      if (p) {
        const speaker = p[1].trim();
        plain.push({ labelStart: offset, labelEnd: offset + p[0].length, speaker });
        plainCounts.set(speaker.toLowerCase(), (plainCounts.get(speaker.toLowerCase()) ?? 0) + 1);
      }
    }
    offset += line.length + 1;
  }
  for (const t of plain) {
    const k = t.speaker.toLowerCase();
    if (ROLE_ALIASES[k] || (plainCounts.get(k) ?? 0) >= 2) turns.push(t);
  }
  return turns.sort((a, b) => a.labelStart - b.labelStart);
}

function turnIndexAt(turns: SpeakerTurn[], offset: number): number {
  let lo = 0, hi = turns.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (turns[mid].labelStart <= offset) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

/** Speaker of the turn containing an original-offset position, or null. */
export function speakerAt(turns: SpeakerTurn[] | undefined, offset: number): string | null {
  if (!turns?.length) return null;
  const i = turnIndexAt(turns, offset);
  return i >= 0 ? turns[i].speaker : null;
}

/** True when [start, end) touches a speaker label, i.e. spans two turns. */
function crossesTurn(turns: SpeakerTurn[] | undefined, start: number, end: number): boolean {
  if (!turns?.length) return false;
  let lo = 0, hi = turns.length - 1, first = turns.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (turns[mid].labelEnd > start) { first = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return first < turns.length && turns[first].labelStart < end;
}

/** First normalized index whose original offset is >= `orig`. */
function normIndexAt(map: number[], orig: number): number {
  let lo = 0, hi = map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (map[mid] < orig) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function speakerMentionPatterns(turns: SpeakerTurn[]): GroundedSource['speakers'] {
  const byKey = new Map<string, string>();
  for (const t of turns) if (!byKey.has(speakerKey(t.speaker))) byKey.set(speakerKey(t.speaker), t.speaker);
  const out: GroundedSource['speakers'] = [];
  for (const [key, label] of byKey) {
    const role = ROLE_MENTION[key];
    let alts: string[];
    let flags = 'u';
    if (role) {
      alts = [role];
      flags += 'i';
    } else {
      alts = [escapeRegExp(label)];
      const first = label.split(' ')[0];
      if (label.includes(' ') && first.length >= 3 && !ROLE_ALIASES[first.toLowerCase()]) alts.push(escapeRegExp(first));
      if (label[0] === label[0].toLowerCase()) flags += 'i';
    }
    out.push({ key, label, re: new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${alts.join('|')})(?![\\p{L}\\p{N}_-])`, flags) });
  }
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_ALT = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const MULTIPLIERS: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

function canonNumber(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/**
 * Every number and date a text states, in canonical forms, so "$250K",
 * "$250,000" and "250 thousand" agree, and "2026-03-14" agrees with
 * "March 14th". Keys: plain values ("250000"), percents ("5%"), ISO dates
 * ("date:2026-03-14") and month-day pairs ("md:3-14").
 */
export function numericFacts(text: string): Set<string> {
  const out = new Set<string>();
  const s = normForGrounding(text);
  for (const m of s.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(k|mm|m|bn|b|thousand|million|billion)?(?![a-z])/g)) {
    const base = Number.parseFloat(m[1].replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;
    out.add(canonNumber(base));
    if (m[2]) out.add(canonNumber(base * MULTIPLIERS[m[2]]));
  }
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent\b)/g)) out.add(`${canonNumber(Number.parseFloat(m[1]))}%`);
  for (const m of s.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    out.add(`date:${m[1]}-${m[2]}-${m[3]}`);
    out.add(`md:${Number(m[2])}-${Number(m[3])}`);
  }
  for (const m of s.matchAll(new RegExp(`\\b(${MONTH_ALT})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g'))) {
    out.add(`md:${MONTHS.indexOf(m[1]) + 1}-${Number(m[2])}`);
  }
  for (const m of s.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_ALT})[a-z]*\\b`, 'g'))) {
    out.add(`md:${MONTHS.indexOf(m[2]) + 1}-${Number(m[1])}`);
  }
  return out;
}

/** Prepare one transcript for verification. */
export function groundSource(path: string, content: string): GroundedSource {
  const { norm, map } = normalizeForGrounding(content);
  const turns = parseSpeakerTurns(content);
  const name = basename(path);
  return {
    path,
    content,
    norm,
    map,
    turns,
    numbers: numericFacts(`${content}\n${name}`),
    nameNorm: normForGrounding(name),
    speakers: speakerMentionPatterns(turns),
  };
}

/**
 * Quote-span extraction from a page BODY (frontmatter already split off).
 * Marks are collected with ABSOLUTE offsets over the masked body (no
 * paragraph-slice arithmetic — the original split/rejoin approximation
 * dropped every span after a separator longer than two chars, which let
 * fabricated quotes escape verification entirely; caught by the ship review's
 * runtime probe). Pairing is per mark TYPE within each paragraph: straight
 * `"` pairs sequentially; curly pairs directionally (`“` with the next `”`),
 * so an interior curly-quoted phrase inside a straight-quoted span no longer
 * mis-pairs across types. A paragraph with unpairable marks of a type skips
 * that type's spans there (counted `unbalanced`, never guessed at); spans
 * nested inside another span are dropped (the outer span is the quote).
 */
export function extractQuoteSpans(body: string): { spans: Array<{ start: number; end: number; inner: string }>; unbalanced: number } {
  const spans: Array<{ start: number; end: number; inner: string }> = [];
  let unbalanced = 0;
  const masked = maskNonProse(body);

  // Exact paragraph ranges via matchAll — offsets never drift.
  const bounds: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const m of masked.matchAll(/\n\s*\n/g)) {
    bounds.push({ start: cursor, end: m.index ?? 0 });
    cursor = (m.index ?? 0) + m[0].length;
  }
  bounds.push({ start: cursor, end: masked.length });

  for (const b of bounds) {
    const straight: number[] = [];
    const curlyOpen: number[] = [];
    const pairs: Array<[number, number]> = [];
    let paraUnbalanced = false;
    for (let i = b.start; i < b.end; i++) {
      const ch = masked[i];
      if (ch === '"') straight.push(i);
      else if (ch === '“') curlyOpen.push(i);
      else if (ch === '”') {
        const open = curlyOpen.pop();
        if (open === undefined) paraUnbalanced = true;
        else pairs.push([open, i]);
      }
    }
    if (curlyOpen.length > 0) paraUnbalanced = true;
    if (straight.length % 2 !== 0) paraUnbalanced = true;
    else for (let m = 0; m + 1 < straight.length; m += 2) pairs.push([straight[m], straight[m + 1]]);
    if (paraUnbalanced) unbalanced++;

    for (const [start, end] of pairs) {
      const inner = body.slice(start + 1, end);
      if (inner.length >= MIN_QUOTE_CHARS) spans.push({ start, end, inner });
      if (spans.length >= MAX_QUOTES_PER_PAGE) break;
    }
    if (spans.length >= MAX_QUOTES_PER_PAGE) break;
  }

  // Drop spans nested inside another span — the outer span is the quote; a
  // nested repair would splice inside a region the outer repair replaces.
  spans.sort((a, b2) => a.start - b2.start);
  const kept: typeof spans = [];
  let lastEnd = -1;
  for (const sp of spans) {
    if (sp.start < lastEnd) continue;
    kept.push(sp);
    lastEnd = sp.end;
  }
  return { spans: kept, unbalanced };
}

export type GroundResult =
  | { status: 'exact'; spans: Array<[number, number]> }
  | { status: 'normalized' | 'near'; replacement: string; spans: Array<[number, number]> }
  | { status: 'none'; reason: 'not_found' | 'crosses_speakers' };

const PUNCT_EDGE = /[.,;:!?]/;

/**
 * Ground one quoted span against a transcript. Returns the verbatim
 * transcript slice to substitute for a normalized or near match, the
 * original-offset spans of the accepted occurrences (for speaker and
 * source-span provenance), or 'none'. A match that spans two speaker turns
 * is never accepted: quoting across a turn boundary puts one speaker's words
 * in another's mouth.
 */
export function groundQuote(inner: string, t: GroundedTranscript): GroundResult {
  let crossed = false;

  // Rung 1: exact substring.
  const exact: Array<[number, number]> = [];
  for (let at = t.content.indexOf(inner), n = 0; at >= 0 && n < MAX_OCCURRENCES; at = t.content.indexOf(inner, at + 1), n++) {
    if (crossesTurn(t.turns, at, at + inner.length)) crossed = true;
    else exact.push([at, at + inner.length]);
  }
  if (exact.length) return { status: 'exact', spans: exact };

  const q = normalizeForGrounding(inner);
  if (q.norm.length === 0) return { status: 'none', reason: 'not_found' };

  // Rung 2: normalized whole-span match → map back to the original slice.
  const normalized: Array<[number, number]> = [];
  for (let pos = t.norm.indexOf(q.norm), n = 0; pos >= 0 && n < MAX_OCCURRENCES; pos = t.norm.indexOf(q.norm, pos + 1), n++) {
    const start = t.map[pos];
    const endIdx = t.map[pos + q.norm.length - 1];
    // Defensive: a map hole must never become a "verbatim" repair.
    if (start === undefined || endIdx === undefined) continue;
    if (crossesTurn(t.turns, start, endIdx + 1)) crossed = true;
    else normalized.push([start, endIdx + 1]);
  }
  if (normalized.length) {
    const [start, end] = normalized[0];
    const replacement = t.content.slice(start, end);
    if (replacement.length === 0) return { status: 'none', reason: 'not_found' };
    return replacement === inner ? { status: 'exact', spans: normalized } : { status: 'normalized', replacement, spans: normalized };
  }

  // Rung 3: near match. Anchor on word trigrams from the quote; score
  // candidate windows (clipped to the anchor's speaker turn) by token
  // overlap; accept a single clear winner ≥ floor, trimmed to the matched
  // tokens. Hard-bounded: total probes, trigrams (stride-sampled), quote size.
  const none: GroundResult = { status: 'none', reason: crossed ? 'crosses_speakers' : 'not_found' };
  if (q.norm.length > MAX_NEAR_QUOTE_NORM_CHARS) return none;
  const qTokens = q.norm.split(' ').filter(w => w.length > 0);
  if (qTokens.length < 4) return none;
  const qBare = new Set(qTokens.map(w => w.replace(/[^\p{L}\p{N}]/gu, '')).filter(w => w.length > 0));
  const triCount = qTokens.length - 2;
  const stride = Math.max(1, Math.ceil(triCount / MAX_NEAR_TRIGRAMS));
  const candidates: Array<{ start: number; end: number; score: number }> = [];
  const seenStarts = new Set<number>();
  let probes = 0;
  for (let g = 0; g + 2 < qTokens.length && candidates.length < MAX_ANCHOR_CANDIDATES && probes < MAX_ANCHOR_PROBES; g += stride) {
    const gram = qTokens.slice(g, g + 3).join(' ');
    let from = 0;
    while (candidates.length < MAX_ANCHOR_CANDIDATES && probes < MAX_ANCHOR_PROBES) {
      probes++;
      const at = t.norm.indexOf(gram, from);
      if (at < 0) break;
      from = at + 1;
      let lo = 0, hi = t.norm.length;
      if (t.turns?.length) {
        const ti = turnIndexAt(t.turns, t.map[at]);
        if (ti >= 0) lo = normIndexAt(t.map, t.turns[ti].labelEnd);
        if (ti + 1 < t.turns.length) hi = normIndexAt(t.map, t.turns[ti + 1].labelStart);
        if (at < lo) continue;
      }
      const targetLen = q.norm.length;
      let winStart = Math.max(lo, at - Math.floor(g / Math.max(1, qTokens.length) * targetLen) - WINDOW_SLACK_BEFORE);
      let winEnd = Math.min(hi, winStart + Math.ceil(targetLen * WINDOW_GROWTH) + WINDOW_SLACK_AFTER);
      while (winStart > lo && t.norm[winStart] !== ' ') winStart--;
      while (winEnd < hi && t.norm[winEnd] !== ' ') winEnd++;
      if (seenStarts.has(winStart)) continue;
      seenStarts.add(winStart);
      const winTokens = t.norm.slice(winStart, winEnd).split(' ').filter(w => w.length > 0);
      const counts = new Map<string, number>();
      for (const w of winTokens) counts.set(w, (counts.get(w) ?? 0) + 1);
      let hit = 0;
      for (const w of qTokens) {
        const c = counts.get(w) ?? 0;
        if (c > 0) { hit++; counts.set(w, c - 1); }
      }
      candidates.push({ start: winStart, end: winEnd, score: hit / qTokens.length });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < NEAR_MATCH_FLOOR) return none;
  const second = candidates.find(c => c.start !== best.start);
  if (second && best.score - second.score < NEAR_MATCH_AMBIGUITY && second.score >= NEAR_MATCH_FLOOR) {
    // Two plausible homes — refusing to guess beats repairing to the wrong span.
    return none;
  }
  // Trim the window to the first and last tokens the quote shares with it.
  const tokens: Array<{ start: number; end: number }> = [];
  for (const m of t.norm.slice(best.start, best.end).matchAll(/\S+/g)) {
    const bare = m[0].replace(/[^\p{L}\p{N}]/gu, '');
    if (qBare.has(bare)) tokens.push({ start: best.start + (m.index ?? 0), end: best.start + (m.index ?? 0) + m[0].length });
  }
  if (!tokens.length) return none;
  const oFirst = t.map[tokens[0].start];
  const oLast = t.map[tokens[tokens.length - 1].end - 1];
  if (oFirst === undefined || oLast === undefined) return none;
  let a = oFirst, b = oLast + 1;
  const innerTrim = inner.trim();
  if (!PUNCT_EDGE.test(innerTrim[0] ?? '')) while (a < b && PUNCT_EDGE.test(t.content[a])) a++;
  if (!PUNCT_EDGE.test(innerTrim[innerTrim.length - 1] ?? '')) while (b > a && PUNCT_EDGE.test(t.content[b - 1])) b--;
  const replacement = t.content.slice(a, b).trim();
  if (replacement.length === 0) return none;
  if (normForGrounding(replacement).length > Math.ceil(q.norm.length * NEAR_MATCH_MAX_GROWTH)) return none;
  if (crossesTurn(t.turns, a, b)) return { status: 'none', reason: 'crosses_speakers' };
  return { status: 'near', replacement, spans: [[a, b]] };
}

const NUMERIC_CLAIM_RES: Array<{ re: RegExp; key: (m: RegExpMatchArray) => string[] }> = [
  // Currency, optionally scaled ($2M, $250,000, $1.5 billion).
  { re: /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|mm|m|bn|b|thousand|million|billion)?(?![a-z])/gi,
    key: m => [canonNumber(Number.parseFloat(m[1].replace(/,/g, '')) * (m[2] ? MULTIPLIERS[m[2].toLowerCase()] : 1))] },
  // Scaled plain amounts (3 million users).
  { re: /\b(\d[\d,]*(?:\.\d+)?)\s+(thousand|million|billion)\b/gi,
    key: m => [canonNumber(Number.parseFloat(m[1].replace(/,/g, '')) * MULTIPLIERS[m[2].toLowerCase()])] },
  { re: /\b(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi, key: m => [`${canonNumber(Number.parseFloat(m[1]))}%`] },
  { re: /\b(\d{4})-(\d{2})-(\d{2})\b/g, key: m => [`date:${m[1]}-${m[2]}-${m[3]}`, `md:${Number(m[2])}-${Number(m[3])}`] },
  { re: new RegExp(`\\b(${MONTH_ALT})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi'),
    key: m => [`md:${MONTHS.indexOf(m[1].toLowerCase()) + 1}-${Number(m[2])}`] },
  // Thousands-separated or 4+ digit numbers (years, counts, ids).
  { re: /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{4,}\b/g, key: m => [canonNumber(Number.parseFloat(m[0].replace(/,/g, '')))] },
];

/**
 * Numeric and date claims in `text` that no source states. `text` must
 * already be masked (code, links) and have grounded quotes blanked. A claim
 * is supported when any of its canonical keys appears among a source's
 * numbers, or its normalized text occurs in a source or its file name.
 */
export function unsupportedNumericClaims(text: string, sources: GroundedSource[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const covered: Array<[number, number]> = [];
  for (const { re, key } of NUMERIC_CLAIM_RES) {
    for (const m of text.matchAll(re)) {
      const at = m.index ?? 0;
      if (covered.some(([s, e]) => at >= s && at < e)) continue;
      covered.push([at, at + m[0].length]);
      const claim = normForGrounding(m[0]);
      if (!claim || seen.has(claim) || seen.size >= MAX_NUMERIC_CLAIMS_PER_PAGE) continue;
      seen.add(claim);
      const keys = key(m);
      const supported = sources.some(src =>
        keys.some(k => src.numbers.has(k)) || src.norm.includes(claim) || src.nameNorm.includes(claim));
      if (!supported) out.push(m[0].trim());
    }
  }
  return out;
}

const LIST_MARKER_RE = /^(?:[-*+]|\d+[.)]|>|#{1,6})[ \t]+/;
const EMPTY_LINE_AFTER_REMOVAL_RE = /^\s*(?:[-*+]|\d+[.)]|>|#{1,6})?\s*$/;
const REMOVED = '\uFFFF';

/**
 * Claim units: sentences within a line, whole list items, whole table rows.
 * A boundary never falls inside a quoted span, so every quote belongs to
 * exactly one unit. Offsets exclude surrounding whitespace and list markers.
 */
export function claimUnits(body: string, spans: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const inQuote = new Uint8Array(body.length + 1);
  const closeAt = new Set<number>();
  for (const sp of spans) {
    for (let i = sp.start + 1; i < sp.end; i++) inQuote[i] = 1;
    closeAt.add(sp.end);
  }
  const raw: Array<[number, number]> = [];
  let unitStart = 0;
  let lineStart = 0;
  let tableLine = body.trimStart().startsWith('|');
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\n' && !inQuote[i]) {
      raw.push([unitStart, i]);
      unitStart = i + 1;
      lineStart = i + 1;
      tableLine = body.slice(lineStart, lineStart + 200).trimStart().startsWith('|');
      continue;
    }
    if (tableLine || inQuote[i]) continue;
    const next = body[i + 1];
    const atGap = next === undefined || /\s/.test(next);
    if (atGap && (/[.!?]/.test(ch) || (closeAt.has(i) && /[.!?]/.test(body[i - 1] ?? '')))) {
      raw.push([unitStart, i + 1]);
      unitStart = i + 1;
    }
  }
  raw.push([unitStart, body.length]);
  const units: Array<{ start: number; end: number }> = [];
  for (let [s, e] of raw) {
    while (s < e && /\s/.test(body[s])) s++;
    const marker = LIST_MARKER_RE.exec(body.slice(s, Math.min(e, s + 12)));
    if (marker && (s === 0 || body[s - 1] === '\n' || /^[ \t]*$/.test(body.slice(body.lastIndexOf('\n', s - 1) + 1, s)))) s += marker[0].length;
    while (e > s && /\s/.test(body[e - 1])) e--;
    if (e > s) units.push({ start: s, end: e });
  }
  return units;
}

export type ClaimFailure = 'quote_not_in_source' | 'quote_crosses_speakers' | 'speaker_mismatch' | 'number_not_in_source';

export interface QuarantinedClaim {
  text: string;
  reason: ClaimFailure;
  detail: string;
}

export interface QuoteProvenance {
  text: string;
  source: string;
  span: [number, number];
  speaker: string | null;
}

export interface BodyVerification {
  body: string;
  changed: boolean;
  quotes: number;
  exact: number;
  normalized: number;
  near: number;
  unbalanced: number;
  quarantined: QuarantinedClaim[];
  provenance: QuoteProvenance[];
  failures: Record<ClaimFailure, number>;
}

function groundAcross(inner: string, sources: GroundedSource[]): { result: Exclude<GroundResult, { status: 'none' }>; source: GroundedSource } | { result: Extract<GroundResult, { status: 'none' }> } {
  const rank = { exact: 3, normalized: 2, near: 1 } as const;
  let best: { result: Exclude<GroundResult, { status: 'none' }>; source: GroundedSource } | null = null;
  let crossed = false;
  for (const source of sources) {
    const g = groundQuote(inner, source);
    if (g.status === 'none') { if (g.reason === 'crosses_speakers') crossed = true; continue; }
    if (!best || rank[g.status] > rank[best.result.status]) best = { result: g, source };
    if (g.status === 'exact') break;
  }
  return best ?? { result: { status: 'none', reason: crossed ? 'crosses_speakers' : 'not_found' } };
}

function blank(s: string, ranges: Array<[number, number]>): string {
  let out = s;
  for (const [a, b] of ranges) out = out.slice(0, a) + ' '.repeat(b - a) + out.slice(b);
  return out;
}

function clip(s: string, n = PROVENANCE_TEXT_CHARS): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 3)}...` : flat;
}

/**
 * Verify one body (compiled_truth or timeline) against its source
 * transcripts. Pure. With `priorNorm` (the normalized pre-run revision of a
 * page that already existed), only units absent from it are checked; every
 * other unit is left exactly as it was.
 */
export function verifyBody(body: string, sources: GroundedSource[], opts: { priorNorm?: string } = {}): BodyVerification {
  const { spans, unbalanced } = extractQuoteSpans(body);
  const masked = maskNonProse(body);
  const failures: Record<ClaimFailure, number> = { quote_not_in_source: 0, quote_crosses_speakers: 0, speaker_mismatch: 0, number_not_in_source: 0 };
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const quarantined: QuarantinedClaim[] = [];
  const provenance: QuoteProvenance[] = [];
  let quotes = 0, exact = 0, normalized = 0, near = 0;

  // Materialized timeline history (#5567) is database history a write rendered
  // back into an existing page, not a claim this run authored. Only a marked
  // bullet absent from the pre-run revision was materialized during the run
  // (with its stored detail); an edit under a bullet that already existed is
  // verified like any other new unit. A new page has no history to render.
  const history = opts.priorNorm === undefined ? [] : materializedHistoryRanges(body)
    .filter(([start, end]) => !opts.priorNorm!.includes(normForGrounding(body.slice(start, end).split('\n')[1] ?? '')));
  for (const u of claimUnits(body, spans)) {
    const text = body.slice(u.start, u.end);
    if (history.some(([start, end]) => u.start >= start && u.start < end)) continue;
    if (opts.priorNorm !== undefined && opts.priorNorm.includes(normForGrounding(text))) continue;
    const unitSpans = spans.filter(sp => sp.start >= u.start && sp.end < u.end);
    const quoteRanges = unitSpans.map(sp => [sp.start - u.start, sp.end - u.start + 1] as [number, number]);
    const attribution = blank(text, quoteRanges);
    const mentioned = new Map<string, string>();
    for (const src of sources) for (const sp of src.speakers) if (sp.re.test(attribution)) mentioned.set(sp.key, sp.label);

    const unitFailures: Array<{ reason: ClaimFailure; detail: string }> = [];
    const fail = (reason: ClaimFailure, detail: string) => { failures[reason]++; unitFailures.push({ reason, detail }); };
    const unitEdits: typeof edits = [];
    const unitProvenance: QuoteProvenance[] = [];
    for (const sp of unitSpans) {
      quotes++;
      const g = groundAcross(sp.inner, sources);
      if (g.result.status === 'none') {
        fail(g.result.reason === 'crosses_speakers' ? 'quote_crosses_speakers' : 'quote_not_in_source', clip(sp.inner));
        continue;
      }
      const { result, source } = g as { result: Exclude<GroundResult, { status: 'none' }>; source: GroundedSource };
      const speakers = result.spans.map(([a]) => speakerAt(source.turns, a)).filter((s): s is string => s !== null);
      if (mentioned.size > 0 && speakers.length > 0 && !speakers.some(s => mentioned.has(speakerKey(s)))) {
        fail('speaker_mismatch', `attributed to ${[...mentioned.values()].join(', ')}; said by ${speakers[0]}: ${clip(sp.inner, 80)}`);
        continue;
      }
      if (result.status === 'exact') exact++;
      else {
        if (result.status === 'normalized') normalized++; else near++;
        // Collapse interior newlines: splicing a transcript line break inside
        // a quoted span would split the markdown paragraph and orphan the marks.
        unitEdits.push({ start: sp.start + 1, end: sp.end, text: result.replacement.replace(/\s*\n\s*/g, ' ') });
      }
      unitProvenance.push({
        text: clip(result.status === 'exact' ? sp.inner : result.replacement),
        source: source.path,
        span: result.spans[0],
        speaker: speakers[0] ?? null,
      });
    }
    const numbers = unsupportedNumericClaims(blank(masked.slice(u.start, u.end), quoteRanges), sources);
    for (const n of numbers) fail('number_not_in_source', n);

    if (unitFailures.length > 0) {
      quarantined.push({ text: clip(text, 2000), reason: unitFailures[0].reason, detail: unitFailures.map(f => f.detail).join('; ') });
      edits.push({ start: u.start, end: u.end, text: REMOVED });
    } else {
      edits.push(...unitEdits);
      provenance.push(...unitProvenance);
    }
  }

  let out = body;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  if (out.includes(REMOVED)) {
    const lines: string[] = [];
    for (const line of out.split('\n')) {
      if (!line.includes(REMOVED)) { lines.push(line); continue; }
      const rest = line.split(REMOVED).join('').replace(/([^ \t])[ \t]{2,}/g, '$1 ').replace(/[ \t]+$/, '');
      if (!EMPTY_LINE_AFTER_REMOVAL_RE.test(rest)) lines.push(rest);
    }
    out = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\n+$/, body.endsWith('\n') ? '\n' : '');
  }
  return { body: out, changed: out !== body, quotes, exact, normalized, near, unbalanced, quarantined, provenance, failures };
}

export interface VerifiablePage {
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
}

interface UnverifiedRecord extends QuarantinedClaim { sources: string[]; detected_at: string }

function recordList<T>(fm: Record<string, unknown> | undefined, key: string, pick?: string): T[] {
  const v = pick ? (fm?.[key] as Record<string, unknown> | undefined)?.[pick] : fm?.[key];
  return Array.isArray(v) ? v.filter(x => x && typeof x === 'object') as T[] : [];
}

/**
 * Verify a whole dream page: both bodies, then the frontmatter records.
 * `prior` is the page's pre-run revision when it already existed (only new
 * units are checked, and its records carry forward); null for a page this
 * run created. Quarantined units accumulate in `unverified_claims`; grounded
 * quotes accumulate source-span + speaker provenance in `grounding.quotes`.
 */
export function verifyDreamPage(
  page: VerifiablePage,
  sources: GroundedSource[],
  opts: { prior: VerifiablePage | null; checkedAt: string },
  stats: QuoteVerifyStats,
): VerifiablePage & { changed: boolean } {
  const priorNorm = opts.prior ? normForGrounding(`${opts.prior.compiled_truth}\n${opts.prior.timeline ?? ''}`) : undefined;
  const truth = verifyBody(page.compiled_truth ?? '', sources, { priorNorm });
  const timeline = verifyBody(page.timeline ?? '', sources, { priorNorm });
  stats.pages_checked++;
  for (const r of [truth, timeline]) {
    stats.quotes_total += r.quotes;
    stats.exact += r.exact;
    stats.normalized_fixed += r.normalized;
    stats.near_fixed += r.near;
    stats.unbalanced += r.unbalanced;
    stats.quarantined_claims += r.quarantined.length;
    for (const k of Object.keys(r.failures) as ClaimFailure[]) stats[k] += r.failures[k];
  }
  const newlyQuarantined = [...truth.quarantined, ...timeline.quarantined];
  if (newlyQuarantined.length > 0) stats.pages_with_quarantine++;

  let compiled = truth.body;
  if (!compiled.trim() && (page.compiled_truth ?? '').trim() && !timeline.body.trim()) compiled = ALL_CLAIMS_QUARANTINED_BODY;

  const sourcePaths = sources.map(s => s.path);
  const unverified = new Map<string, UnverifiedRecord>();
  for (const r of [
    ...recordList<UnverifiedRecord>(opts.prior?.frontmatter, UNVERIFIED_CLAIMS_KEY),
    ...recordList<UnverifiedRecord>(page.frontmatter, UNVERIFIED_CLAIMS_KEY),
    ...newlyQuarantined.map(q => ({ ...q, sources: sourcePaths, detected_at: opts.checkedAt })),
  ]) {
    if (typeof r.text === 'string') unverified.set(normForGrounding(r.text), r);
  }
  const bodyNorm = normForGrounding(`${compiled}\n${timeline.body}`);
  const quotes = new Map<string, QuoteProvenance>();
  for (const q of [...recordList<QuoteProvenance>(opts.prior?.frontmatter, GROUNDING_KEY, 'quotes'), ...truth.provenance, ...timeline.provenance]) {
    if (typeof q.text !== 'string' || !bodyNorm.includes(normForGrounding(q.text.replace(/\.\.\.$/, '')))) continue;
    quotes.set(`${q.source} ${q.span?.[0]} ${q.span?.[1]}`, q);
  }

  const frontmatter: Record<string, unknown> = { ...page.frontmatter };
  if (unverified.size > 0) frontmatter[UNVERIFIED_CLAIMS_KEY] = [...unverified.values()].slice(-MAX_UNVERIFIED_RECORDS);
  if (quotes.size > 0 || unverified.size > 0 || opts.prior?.frontmatter?.[GROUNDING_KEY]) {
    frontmatter[GROUNDING_KEY] = {
      checked_at: opts.checkedAt,
      sources: sourcePaths,
      quotes: [...quotes.values()].slice(-MAX_PROVENANCE_RECORDS),
    };
  } else {
    delete frontmatter[GROUNDING_KEY];
  }
  const changed = compiled !== page.compiled_truth || timeline.body !== (page.timeline ?? '')
    || JSON.stringify(frontmatter) !== JSON.stringify(page.frontmatter);
  return { compiled_truth: compiled, timeline: timeline.body, frontmatter, changed };
}

/** Database clock reading taken before a run's writes; pages created at or
 * after it are the run's own, earlier pages are verified by diff. */
export async function readVerifyEpoch(engine: BrainEngine): Promise<Date> {
  const rows = await engine.executeRaw<{ now: unknown }>('SELECT now() AS now');
  return new Date(rows[0]?.now as string);
}

/**
 * Per-transcript write epochs: the earliest creation time of the child jobs
 * that synthesized each transcript. A resumed or coalesced child created in
 * an earlier run keeps its original epoch, so the pages it wrote then still
 * count as its own. Transcripts without a job row fall back to `fallback`.
 */
export async function loadChildWriteEpochs(
  engine: BrainEngine,
  childIds: number[],
  jobRawSource: Map<number, string>,
  fallback: Date,
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  for (const path of jobRawSource.values()) out.set(path, fallback);
  if (!childIds.length) return out;
  const rows = await engine.executeRaw<{ id: number | string; created_at: unknown }>(
    'SELECT id, created_at FROM minion_jobs WHERE id = ANY($1::int[])', [childIds]);
  for (const row of rows) {
    const path = jobRawSource.get(Number(row.id));
    const at = new Date(row.created_at as string);
    if (!path || Number.isNaN(at.getTime())) continue;
    if (at < (out.get(path) ?? fallback)) out.set(path, at);
  }
  return out;
}

/**
 * The revision of a page as it stood before `since`: the first version
 * snapshot taken at or after `since` (writes snapshot the prior state before
 * overwriting). Null when nothing overwrote the page since then.
 */
export async function loadPreRunRevision(engine: BrainEngine, slug: string, sourceId: string, since: Date): Promise<VerifiablePage | null> {
  const rows = await engine.executeRaw<{ compiled_truth: string; timeline: string | null; frontmatter: unknown }>(
    `SELECT pv.compiled_truth, pv.timeline, pv.frontmatter
       FROM page_versions pv JOIN pages p ON p.id = pv.page_id
      WHERE p.slug = $1 AND p.source_id = $2 AND pv.snapshot_at >= $3::timestamptz
      ORDER BY pv.snapshot_at ASC, pv.id ASC LIMIT 1`,
    [slug, sourceId, since.toISOString()],
  );
  const row = rows[0];
  if (!row) return null;
  const fm = typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter;
  return { compiled_truth: row.compiled_truth ?? '', timeline: row.timeline ?? '', frontmatter: (fm ?? {}) as Record<string, unknown> };
}

/**
 * The verification scope of one written page: null prior for a page created
 * at or after `since`, the pre-run revision for an older page, or 'unchanged'
 * when an older page has no revision since then.
 */
export async function resolveVerifyPrior(engine: BrainEngine, page: Pick<Page, 'slug' | 'created_at'>, sourceId: string, since: Date): Promise<VerifiablePage | null | 'unchanged'> {
  if (new Date(page.created_at).getTime() >= since.getTime()) return null;
  return (await loadPreRunRevision(engine, page.slug, sourceId, since)) ?? 'unchanged';
}

/**
 * Orchestrator entry: verify every page this phase's children wrote.
 * Sources are the transcripts of every child that wrote the page (a page
 * two transcripts touched is checked against both). A page's epoch is the
 * earliest `sinceByTranscript` entry of its sources, else `since`. Pages
 * created at or after it are verified whole; older pages are verified only
 * on the units their pre-epoch revision lacks. A small LRU keeps
 * resident grounding state bounded to a few transcripts.
 */
export async function verifyAndRepairDreamPages(
  engine: BrainEngine,
  refs: Array<{ slug: string; source_id: string; raw_source?: string }>,
  transcriptsByPath: Map<string, TranscriptForVerify>,
  opts: { since: Date; sinceByTranscript?: Map<string, Date>; checkedAt?: string; signal?: AbortSignal },
): Promise<QuoteVerifyStats> {
  const stats = emptyQuoteVerifyStats();
  const checkedAt = opts.checkedAt ?? new Date().toISOString().slice(0, 10);
  const pages = new Map<string, { slug: string; source_id: string; paths: string[] }>();
  for (const ref of refs) {
    const key = `${ref.source_id} ${ref.slug}`;
    const known = ref.raw_source && transcriptsByPath.has(ref.raw_source) ? ref.raw_source : undefined;
    const entry = pages.get(key) ?? { slug: ref.slug, source_id: ref.source_id, paths: [] };
    if (known && !entry.paths.includes(known)) entry.paths.push(known);
    pages.set(key, entry);
  }
  const cache = new Map<string, GroundedSource>();
  const sourceFor = (path: string): GroundedSource => {
    let g = cache.get(path);
    if (g) { cache.delete(path); cache.set(path, g); return g; }
    g = groundSource(path, transcriptsByPath.get(path)!.content);
    cache.set(path, g);
    if (cache.size > 4) cache.delete(cache.keys().next().value as string);
    return g;
  };

  const ordered = [...pages.values()].sort((a, b) => (a.paths[0] ?? '').localeCompare(b.paths[0] ?? ''));
  for (const ref of ordered) {
    throwIfAborted(opts.signal, '[dream] quote verify');
    if (ref.paths.length === 0) { stats.skipped_no_transcript++; continue; }
    try {
      const page = await engine.getPage(ref.slug, { sourceId: ref.source_id });
      if (!page) { stats.errors++; continue; }
      const since = ref.paths.reduce((min, p) => {
        const at = opts.sinceByTranscript?.get(p);
        return at && at < min ? at : min;
      }, opts.since);
      const prior = await resolveVerifyPrior(engine, page, ref.source_id, since);
      if (prior === 'unchanged') { stats.skipped_unchanged++; continue; }
      if (prior) stats.preexisting_diffed++;
      const verified = verifyDreamPage(page, ref.paths.map(sourceFor), { prior, checkedAt }, stats);
      if (verified.changed) {
        const tags = await engine.getTags(ref.slug, { sourceId: ref.source_id });
        const next = { ...page, compiled_truth: verified.compiled_truth, timeline: verified.timeline, frontmatter: verified.frontmatter };
        const md = serializePageToMarkdown(next, tags);
        // The children's put_page projected timeline, facts, takes and links
        // from the unverified body; re-project from the verified body in the
        // same transaction so no derived row outlives its quarantined claim.
        const parsed = { type: page.type, title: page.title, compiled_truth: next.compiled_truth, timeline: next.timeline, frontmatter: next.frontmatter, tags };
        // Preserving writer (#5567): rows for bullets the verifier removed are
        // deleted; database-only timeline history is kept.
        const project = await prepareCanonicalProjections(engine, parsed, ref.slug, ref.source_id,
          await engine.readPageSnapshot(ref.slug, { sourceId: ref.source_id }), 'preserving');
        const links = await isAutoLinkEnabled(engine) ? await prepareAutomaticLinks(engine, ref.slug, parsed, ref.source_id) : undefined;
        // noEmbed: the phase-end embed sweep backfills. Provenance fields
        // null → engine COALESCE keeps the first-write record intact.
        await importFromContent(engine, ref.slug, md, {
          noEmbed: true, remote: false, sourceId: ref.source_id,
          beforeCommit: async tx => { await project(tx); await links?.apply(tx); },
        });
        stats.pages_repaired++;
      }
    } catch (e) {
      // Fail-open: a verify bug never kills the phase — but a cooperative
      // abort must still unwind.
      throwIfAborted(opts.signal, '[dream] quote verify');
      stats.errors++;
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[dream] quote verify ${ref.slug}@${ref.source_id} failed: ${msg}\n`);
    }
    // Cooperative yield per page: the string passes are synchronous CPU.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return stats;
}
