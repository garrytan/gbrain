/**
 * synthesize-verify.ts — mechanical quote verify/repair on dream pages (F1b/F4b,
 * eval write-path fix wave).
 *
 * The synthesis prompt mandates verbatim quotes; measured against the Cat 35
 * benchmark, fewer than half of quoted spans in produced pages were substrings
 * of the source transcript — the model paraphrases inside quotation marks.
 * This pass runs right after the children's put_page writes and BEFORE
 * stampDreamProvenance / reverseWriteRefs / the phase-end embed sweep, so the
 * provenance stamp, the markdown file, and the embedded chunks all carry the
 * repaired body.
 *
 *   writtenRefs ──▶ scope filter ──▶ per-page repair ladder ──▶ write-back
 *   (slug,src,      only NEW pages     per quoted span:          only when a
 *    raw_source)    whose slug carries  1. exact substring → keep span changed,
 *        │          this transcript's   2. normalized match → replace with
 *        │          hash6 suffix           the VERBATIM transcript span
 *        ▼          (people/pattern     3. near match (rare-trigram anchor,
 *   skipped_*        edits skipped)        ≥0.8 token overlap) → replace
 *   counters                            4. else STRIP the quote marks
 *                                          (honest paraphrase, never invent)
 *
 * Ladder invariant: NEVER fabricate — every replacement is a verbatim slice of
 * the source transcript; when nothing grounds, the span loses its quotation
 * marks but keeps its text. Whole-page verification is scoped to pages this
 * transcript CREATED (slug carries the transcript's content-hash suffix, which
 * binds page↔transcript identity); pre-existing pages a child modified
 * (people/patterns) may quote OTHER sources and are skipped, counted.
 *
 * Failure contract (fail-open, pacer precedent — a verify bug never kills the
 * phase): unbalanced quote marks → skip that paragraph's spans of that mark
 * type + count; page read-back miss → skip page + count; write-back throw →
 * log slug+source, count, continue. Zero LLM calls; pure string ops with hard
 * probe/size caps so adversarial page or transcript content degrades to
 * "strip" or "skip", never to unbounded CPU.
 *
 * Write-back reuses the SAME canonical pipeline the children's put_page tool
 * executes — importFromContent (page + tags + chunks + link extraction in one
 * transaction, content_hash recomputed) with noEmbed: the phase-end embed
 * sweep backfills, exactly like the oneshot runner's deferEmbeds writes. A
 * bare engine.putPage would upsert only the pages row and leave stale
 * chunk_text for the sweep to embed.
 *
 * Kill switch: `dream.synthesize.quote_verify` (default on), read by
 * loadSynthConfig — the incident escape hatch for the one mechanism that
 * rewrites page bodies.
 */

import type { BrainEngine } from '../engine.ts';
import { importFromContent } from '../import-file.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { throwIfAborted } from '../abort-check.ts';

/** Minimum quoted-span inner length considered a "quote" (shorter spans are
 * scare quotes / titles, not transcript quotations). */
const MIN_QUOTE_CHARS = 15;
/** Soft cap: quoted spans examined per page (CPU bound, not correctness). */
const MAX_QUOTES_PER_PAGE = 200;
/** Near-match acceptance floor (token overlap) and ambiguity margin. */
const NEAR_MATCH_FLOOR = 0.8;
const NEAR_MATCH_AMBIGUITY = 0.05;
/** Rung-3 CPU bounds: candidate windows scored, TOTAL trigram indexOf probes
 * (a long ungroundable quote must not do thousands of full-transcript scans
 * on the event loop), trigrams considered (stride-sampled above this), and
 * the largest normalized quote rung 3 will attempt at all — a multi-thousand
 * char "quote" that isn't exact/normalized is fabricated in practice and
 * goes straight to strip. */
const MAX_ANCHOR_CANDIDATES = 50;
const MAX_ANCHOR_PROBES = 200;
const MAX_NEAR_TRIGRAMS = 50;
const MAX_NEAR_QUOTE_NORM_CHARS = 2000;
/** Near-match window shaping: growth over the quote's normalized length and
 * fixed char slack on each side (word-boundary snapped after). */
const WINDOW_GROWTH = 1.2;
const WINDOW_SLACK_BEFORE = 20;
const WINDOW_SLACK_AFTER = 40;
/** F4b soft cap: unique numeric/date claims checked per page (warn-only
 * telemetry — a bounded sample keeps its signal on numbers-dense pages). */
const MAX_NUMERIC_CLAIMS_PER_PAGE = 200;

/** Shared code/link masking (offset-preserving): fenced blocks, inline code,
 * wikilinks, and markdown link targets are replaced with spaces so quote
 * marks inside them never pair with prose quotes. */
function maskNonProse(body: string): string {
  return body
    .replace(/```[\s\S]*?(?:```|$)/g, m => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, m => ' '.repeat(m.length))
    .replace(/\[\[[^\]]*\]\]/g, m => ' '.repeat(m.length))
    .replace(/\]\([^)]*\)/g, m => ' '.repeat(m.length));
}

export interface QuoteVerifyStats {
  pages_checked: number;
  pages_repaired: number;
  quotes_total: number;
  exact: number;
  normalized_fixed: number;
  near_fixed: number;
  stripped: number;
  unbalanced: number;
  skipped_preexisting: number;
  skipped_no_transcript: number;
  /** F4b warn-only: numeric/date claims in page bodies absent from the transcript. */
  numeric_claim_warns: number;
  /** Pages where read-back or write-back failed (fail-open, logged). */
  errors: number;
}

function emptyStats(): QuoteVerifyStats {
  return {
    pages_checked: 0,
    pages_repaired: 0,
    quotes_total: 0,
    exact: 0,
    normalized_fixed: 0,
    near_fixed: 0,
    stripped: 0,
    unbalanced: 0,
    skipped_preexisting: 0,
    skipped_no_transcript: 0,
    numeric_claim_warns: 0,
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

interface GroundedTranscript {
  content: string;
  norm: string;
  map: number[];
}

export interface TranscriptForVerify {
  content: string;
  /** First 6 hex chars of the transcript content hash — the slug binding. */
  hash6: string;
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
  | { status: 'exact' }
  | { status: 'normalized' | 'near'; replacement: string }
  | { status: 'none' };

/**
 * Ground one quoted span against the transcript. Returns the verbatim
 * transcript slice to substitute when the span is a normalized or near match;
 * 'none' when nothing grounds (caller strips the quote marks).
 */
export function groundQuote(inner: string, t: GroundedTranscript): GroundResult {
  if (t.content.includes(inner)) return { status: 'exact' };

  const q = normalizeForGrounding(inner);
  if (q.norm.length === 0) return { status: 'none' };

  // Rung 2: normalized whole-span match → map back to the original slice.
  const pos = t.norm.indexOf(q.norm);
  if (pos >= 0) {
    const start = t.map[pos];
    const endIdx = t.map[pos + q.norm.length - 1];
    // Defensive: a map hole or empty slice must never become a "verbatim"
    // repair (the desync class the map invariant now prevents; belt+braces).
    if (start === undefined || endIdx === undefined) return { status: 'none' };
    const replacement = t.content.slice(start, endIdx + 1);
    if (replacement.length === 0) return { status: 'none' };
    return replacement === inner ? { status: 'exact' } : { status: 'normalized', replacement };
  }

  // Rung 3: near match. Anchor on word trigrams from the quote; score
  // candidate windows by token overlap; accept a single clear winner ≥ floor.
  // Hard-bounded: total probes, trigrams (stride-sampled), quote size.
  if (q.norm.length > MAX_NEAR_QUOTE_NORM_CHARS) return { status: 'none' };
  const qTokens = q.norm.split(' ').filter(w => w.length > 0);
  if (qTokens.length < 4) return { status: 'none' };
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
      // Window: extend around the anchor to the quote's normalized length
      // (WINDOW_GROWTH) + fixed slack, snapped to word boundaries.
      const targetLen = q.norm.length;
      let winStart = Math.max(0, at - Math.floor(g / Math.max(1, qTokens.length) * targetLen) - WINDOW_SLACK_BEFORE);
      let winEnd = Math.min(t.norm.length, winStart + Math.ceil(targetLen * WINDOW_GROWTH) + WINDOW_SLACK_AFTER);
      while (winStart > 0 && t.norm[winStart] !== ' ') winStart--;
      while (winEnd < t.norm.length && t.norm[winEnd] !== ' ') winEnd++;
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
  if (!best || best.score < NEAR_MATCH_FLOOR) return { status: 'none' };
  const second = candidates.find(c => c.start !== best.start);
  if (second && best.score - second.score < NEAR_MATCH_AMBIGUITY && second.score >= NEAR_MATCH_FLOOR) {
    // Two plausible homes — refusing to guess beats repairing to the wrong
    // span (ambiguity falls through to strip).
    return { status: 'none' };
  }
  const oStart = t.map[best.start];
  const oEndIdx = t.map[Math.max(best.start, best.end - 1)];
  if (oStart === undefined || oEndIdx === undefined) return { status: 'none' };
  const replacement = t.content.slice(oStart, oEndIdx + 1).trim();
  if (replacement.length === 0) return { status: 'none' };
  return { status: 'near', replacement };
}

/**
 * F4b (warn-only): count numeric/date claims in the body that do not ground
 * in the transcript. Currency, percents, 4+ digit numbers, ISO dates, and
 * month-name dates. No repair, no LLM — telemetry a future grounding gate
 * (filed TODO E7) can act on. Bounded: first MAX_NUMERIC_CLAIMS_PER_PAGE
 * unique claims (a numbers-dense table must not scan the transcript
 * thousands of times for warn-only telemetry).
 */
export function countUngroundedNumericClaims(body: string, t: GroundedTranscript): number {
  // Same mask as quote extraction — wikilinks and link targets included:
  // dream pages MUST carry wikilinks, and slugs embed dates/ids
  // (`meetings/2026-08-30`, `…-a1b2c3`) that would otherwise register as
  // structurally-ungroundable "claims" and inflate the very baseline the
  // filed grounding-gate follow-up (E7) would threshold on.
  const masked = maskNonProse(body);
  const claimRe = /\$[\d,]+(?:\.\d+)?[kmbKMB]?|\b\d+(?:\.\d+)?%|\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}\b|\b\d{4,}\b/gi;
  let warns = 0;
  const seen = new Set<string>();
  for (const m of masked.match(claimRe) ?? []) {
    if (seen.size >= MAX_NUMERIC_CLAIMS_PER_PAGE) break;
    const claim = normForGrounding(m);
    if (claim.length === 0 || seen.has(claim)) continue;
    seen.add(claim);
    if (!t.norm.includes(claim)) warns++;
  }
  return warns;
}

/** Split a serialized page into its frontmatter block and body. */
function splitFrontmatter(md: string): { fm: string; body: string } {
  if (md.startsWith('---\n')) {
    const end = md.indexOf('\n---\n', 4);
    if (end >= 0) return { fm: md.slice(0, end + 5), body: md.slice(end + 5) };
  }
  return { fm: '', body: md };
}

/**
 * Repair one page body against its transcript. Pure: returns the repaired
 * body + per-ladder counts; the caller decides whether to write back.
 */
export function repairBody(body: string, t: GroundedTranscript): {
  body: string;
  changed: boolean;
  quotes: number;
  exact: number;
  normalized: number;
  near: number;
  stripped: number;
  unbalanced: number;
} {
  const { spans, unbalanced } = extractQuoteSpans(body);
  let out = body;
  let exact = 0, normalized = 0, near = 0, stripped = 0;
  // Repair back-to-front so earlier span offsets stay valid.
  for (const sp of [...spans].sort((a, b) => b.start - a.start)) {
    const g = groundQuote(sp.inner, t);
    if (g.status === 'exact') { exact++; continue; }
    if (g.status === 'normalized' || g.status === 'near') {
      if (g.status === 'normalized') normalized++; else near++;
      // Collapse interior newline runs to a single space: the match was found
      // under a normalization that folds ALL whitespace, so this is
      // equivalent text — but splicing a transcript line break inside a
      // quoted span would split the markdown paragraph and leave the opening
      // and closing marks in different paragraphs (permanently unverifiable
      // on any later pass).
      const flat = g.replacement.replace(/\s*\n\s*/g, ' ');
      out = out.slice(0, sp.start + 1) + flat + out.slice(sp.end);
      continue;
    }
    // Strip: drop the enclosing quote marks, keep the text — an honest
    // paraphrase instead of a false verbatim claim. Never delete content.
    stripped++;
    out = out.slice(0, sp.start) + sp.inner + out.slice(sp.end + 1);
  }
  return { body: out, changed: out !== body, quotes: spans.length, exact, normalized, near, stripped, unbalanced };
}

/**
 * Orchestrator entry: verify/repair every newly-created page from this
 * phase's writtenRefs. `transcriptsByPath` maps a transcript filePath →
 * its full content + hash6 (the slug-binding suffix). Refs are grouped by
 * transcript so each GroundedTranscript (content + norm + offset map, ~10x
 * the transcript's bytes) is built once and released before the next —
 * resident overhead is bounded to ONE transcript regardless of phase size.
 */
export async function verifyAndRepairDreamPages(
  engine: BrainEngine,
  refs: Array<{ slug: string; source_id: string; raw_source?: string }>,
  transcriptsByPath: Map<string, TranscriptForVerify>,
  opts: { signal?: AbortSignal } = {},
): Promise<QuoteVerifyStats> {
  const stats = emptyStats();
  // Dedupe defensively by (source, slug) and group by transcript.
  const seen = new Set<string>();
  const byTranscript = new Map<string, Array<{ slug: string; source_id: string }>>();
  for (const ref of refs) {
    const key = `${ref.source_id} ${ref.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = ref.raw_source ? transcriptsByPath.get(ref.raw_source) : undefined;
    if (!t) { stats.skipped_no_transcript++; continue; }
    // Scope: only pages this transcript CREATED — the slug carries the
    // transcript's hash6 (or hash6-c<idx> for chunked children). A modified
    // pre-existing page (people/patterns) may quote OTHER sources; whole-page
    // verification against one transcript would strip their valid quotes.
    if (!ref.slug.includes(`-${t.hash6}`)) { stats.skipped_preexisting++; continue; }
    const group = byTranscript.get(ref.raw_source as string);
    if (group) group.push({ slug: ref.slug, source_id: ref.source_id });
    else byTranscript.set(ref.raw_source as string, [{ slug: ref.slug, source_id: ref.source_id }]);
  }

  for (const [rawSource, group] of byTranscript) {
    throwIfAborted(opts.signal, '[dream] quote verify');
    const t = transcriptsByPath.get(rawSource)!;
    const { norm, map } = normalizeForGrounding(t.content);
    const grounded: GroundedTranscript = { content: t.content, norm, map };

    for (const ref of group) {
      throwIfAborted(opts.signal, '[dream] quote verify');
      try {
        const page = await engine.getPage(ref.slug, { sourceId: ref.source_id });
        if (!page) { stats.errors++; continue; }
        stats.pages_checked++;
        const tags = await engine.getTags(ref.slug, { sourceId: ref.source_id });
        const md = serializePageToMarkdown(page, tags);
        const { fm, body } = splitFrontmatter(md);
        const r = repairBody(body, grounded);
        stats.quotes_total += r.quotes;
        stats.exact += r.exact;
        stats.normalized_fixed += r.normalized;
        stats.near_fixed += r.near;
        stats.stripped += r.stripped;
        stats.unbalanced += r.unbalanced;
        stats.numeric_claim_warns += countUngroundedNumericClaims(r.body, grounded);
        if (r.changed) {
          // Canonical write pipeline — same as the children's put_page tool:
          // page + tags + chunks + link extraction, content_hash recomputed.
          // noEmbed: the phase-end embed sweep backfills (oneshot deferEmbeds
          // parity). Provenance fields null → engine COALESCE keeps the
          // first-write record intact.
          await importFromContent(engine, ref.slug, fm + r.body, {
            noEmbed: true,
            remote: false,
            sourceId: ref.source_id,
          });
          stats.pages_repaired++;
        }
      } catch (e) {
        // Fail-open: a verify bug never kills the phase (pacer precedent) —
        // but a cooperative abort must still unwind.
        throwIfAborted(opts.signal, '[dream] quote verify');
        stats.errors++;
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[dream] quote verify ${ref.slug}@${ref.source_id} failed: ${msg}\n`);
      }
      // Cooperative yield per page: the string passes are synchronous CPU;
      // the drain's lock heartbeats need the loop to breathe on big phases.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    // grounded (norm + map) goes out of scope here — one transcript resident.
  }
  return stats;
}
