/**
 * Citation validation for `gbrain enrich` output (fail-closed).
 *
 * `buildEnrichPrompt` (thin.ts) instructs the model to cite every non-obvious
 * claim inline with `[Source: <slug>]`, using the slugs that label the
 * retrieved evidence blocks. Nothing downstream ever checked the model kept
 * that promise: `[Source: calendar/2022/11 – calendar/2023/02]` (a date
 * range), `[Source: <real-slug> and related calendar entries]` (prose glued
 * onto a real slug), `[Source: email domain]` (not a slug at all), and bare
 * factual sentences with no citation marker have all been observed in real
 * `--thin` output. The generic `core/output/validators/citation.ts` only
 * checks a marker exists somewhere in the paragraph, is opt-in
 * (`writer.lint_on_put_page`, off by default), and non-blocking — none of
 * that is wired into the enrich write path at all.
 *
 * This module is enrich-specific and sentence/claim-granular (matching what
 * the prompt actually asks the model for: "one citation per claim"), and it
 * RESOLVES targets against the brain instead of just checking a marker
 * exists. `validateEnrichCitations` never drops a bad claim silently: it is
 * moved verbatim into a `## Unverified (needs review)` section so it can
 * never be read as a cited fact, and the caller (`commands/enrich.ts`)
 * decides whether `--strict-citations` should refuse to write the page at
 * all instead.
 *
 * No engine import here on purpose — `resolveSlug` is an injected callback
 * so the parsing/quarantine logic (the bulk of this file, and the bulk of
 * what needs testing) stays pure and fast to test. The caller closes over
 * `BrainEngine.getPage` + the source scope.
 */

// ---------------------------------------------------------------------------
// Slug / source-id grammar (shared source of truth, not re-derived here).
// ---------------------------------------------------------------------------

import { PAGE_SLUG_SEG } from '../cjk.ts';
import { SOURCE_ID_RE } from '../source-id.ts';

/** A citation target: either `slug` (bare) or `source-id:slug` (qualified). */
export interface CitationTarget {
  sourceId?: string;
  slug: string;
}

/** Resolves one target to true/false. Caller supplies scope (own source,
 *  federated sources, whatever the enrich run actually consulted). */
export type ResolveSlugFn = (target: CitationTarget) => Promise<boolean>;

export interface QuarantinedClaim {
  /** Verbatim claim text (sentence or bullet content), citation marker included. */
  text: string;
  /** Human-readable reason it was quarantined (no citation / malformed / unresolvable). */
  reason: string;
}

export interface CitationValidationResult {
  /** The body with invalid claims removed and a trailing Unverified section
   *  appended when any were found. Unchanged (byte-for-byte re-flow aside)
   *  when nothing was quarantined. */
  compiledTruth: string;
  /** Count of `[Source: ...]` brackets whose every target resolved. */
  citationsOk: number;
  /** Count of `[Source: ...]` brackets that were malformed/unresolvable, PLUS
   *  one per factual claim that carried no citation at all. */
  citationsInvalid: number;
  /** Count of claims (sentences/bullets) moved to the Unverified section. */
  sentencesQuarantined: number;
  quarantined: QuarantinedClaim[];
}

export const UNVERIFIED_HEADING = '## Unverified (needs review)';

/** Bare slug: one or more `/`-joined PAGE_SLUG_SEG segments. Matches the
 *  grammar SlugRegistry / dream-cycle SUMMARY_SLUG_RE already validate
 *  against (single source of truth: `PAGE_SLUG_SEG` in `core/cjk.ts`). */
const BARE_SLUG_RE = new RegExp(`^${PAGE_SLUG_SEG}(?:/${PAGE_SLUG_SEG})*$`, 'u');

/** `[Source: <content>]`, case-insensitive on the "Source:" label (matches
 *  the generic citation validator's tolerance). Captures the raw content. */
const CITATION_BRACKET_RE = /\[Source:\s*([^\]]*)\]/gi;

// ---------------------------------------------------------------------------
// Target parsing (pure, no I/O).
// ---------------------------------------------------------------------------

/**
 * Parse ONE comma/semicolon-split token into a citation target. Accepts a
 * bare slug (`people/alice`) or a source-qualified slug
 * (`google-mail:people/alice`). Anything else — a date range, prose glued
 * onto a slug, an em/en-dash, a plain-English phrase — fails BOTH shapes and
 * returns null (malformed).
 */
export function parseCitationTarget(rawToken: string): CitationTarget | null {
  const token = rawToken.trim();
  if (!token) return null;
  const colonIdx = token.indexOf(':');
  if (colonIdx === -1) {
    return BARE_SLUG_RE.test(token) ? { slug: token } : null;
  }
  const left = token.slice(0, colonIdx);
  const right = token.slice(colonIdx + 1);
  if (SOURCE_ID_RE.test(left) && BARE_SLUG_RE.test(right)) {
    return { sourceId: left, slug: right };
  }
  return null;
}

/**
 * Parse the full content of one `[Source: ...]` bracket into one or more
 * targets (comma/semicolon-separated — "a citation with multiple slugs must
 * resolve all"). Returns null if the bracket is empty or ANY piece fails to
 * parse as a target — the whole citation is malformed, not just one piece.
 */
export function parseCitationTargets(bracketContent: string): CitationTarget[] | null {
  const raw = bracketContent.trim();
  if (!raw) return null;
  const pieces = raw.split(/[,;]/);
  const targets: CitationTarget[] = [];
  for (const piece of pieces) {
    const target = parseCitationTarget(piece);
    if (!target) return null;
    targets.push(target);
  }
  return targets;
}

/** Every `[Source: ...]` bracket's raw (untrimmed) content, in order. */
export function extractCitationBrackets(text: string): string[] {
  return [...text.matchAll(CITATION_BRACKET_RE)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// "Does this claim need a citation at all" heuristic (sentence/bullet-level
// sibling of citation.ts's paragraph-level `looksFactual`).
// ---------------------------------------------------------------------------

const FACTUAL_KEYWORD_RE =
  /\b(is|was|were|has|have|had|will|would|built|raised|founded|co-founded|said|wrote|attended|works|worked|joined|left|shipped|led|leads|leading|serves|serving|runs|running|studied|graduated|launched|acquired|sold|merged|reports|reported)\b/i;

/** True when `text` (one sentence or one bullet's content, marker stripped)
 *  makes a claim that should carry a citation. */
export function looksFactualClaim(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^#{1,6}\s/.test(t)) return false; // stray heading
  if (/^>/.test(t)) return false; // stray blockquote marker
  const withoutMarker = t.replace(/^(?:[-*+]|\d+\.)\s+/, '');
  // Pure key-value line: "**Key:** value" with no sentence punctuation.
  if (/^\*\*[^*]+:\*\*\s*\S[^.]*$/.test(withoutMarker) && !withoutMarker.includes('.')) return false;
  const withoutCitations = withoutMarker.replace(CITATION_BRACKET_RE, '').trim();
  const measured = withoutCitations || withoutMarker;
  if (measured.length < 40 && !FACTUAL_KEYWORD_RE.test(measured)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Prose sentence splitting — a trailing `[Source: ...]` (or several) must
// stay glued to the sentence it cites, not become its own fragment.
// ---------------------------------------------------------------------------

/**
 * Split a joined prose paragraph into claims. A claim ends at `.`/`!`/`?`
 * (repeated punctuation collapses, e.g. "?!"), then greedily absorbs any
 * immediately-following `[Source: ...]` bracket(s) — so "Alice founded
 * WidgetCo. [Source: x] She also raised money. [Source: y]" splits into two
 * claims, each keeping its own citation, instead of a naive `.`-split that
 * would strand `[Source: x]` as its own bare "sentence".
 */
export function splitProseClaims(text: string): string[] {
  const claims: string[] = [];
  const n = text.length;
  let start = 0;
  let i = 0;

  while (i < n) {
    const ch = text[i];
    if (ch === '.' || ch === '!' || ch === '?') {
      let j = i + 1;
      while (j < n && /[.!?]/.test(text[j])) j++;
      let k = j;
      // Absorb any run of immediately-following (whitespace-separated)
      // [Source: ...] brackets into this claim.
      for (;;) {
        const wsLen = /^\s*/.exec(text.slice(k))![0].length;
        const afterWs = k + wsLen;
        if (!text.slice(afterWs).toLowerCase().startsWith('[source:')) break;
        const closeIdx = text.indexOf(']', afterWs);
        if (closeIdx === -1) break;
        k = closeIdx + 1;
      }
      const claim = text.slice(start, k).trim();
      if (claim) claims.push(claim);
      let m = k;
      while (m < n && /\s/.test(text[m])) m++;
      start = m;
      i = m;
      continue;
    }
    i++;
  }
  const rest = text.slice(start).trim();
  if (rest) claims.push(rest);
  return claims;
}

// ---------------------------------------------------------------------------
// Per-claim resolution.
// ---------------------------------------------------------------------------

interface ClaimVerdict {
  valid: boolean;
  ok: number;
  invalid: number;
  reason?: string;
}

async function resolveClaim(content: string, resolveSlug: ResolveSlugFn): Promise<ClaimVerdict> {
  const brackets = extractCitationBrackets(content);
  if (brackets.length === 0) {
    return { valid: false, ok: 0, invalid: 1, reason: 'no citation marker' };
  }
  let ok = 0;
  let invalid = 0;
  const reasons: string[] = [];
  for (const bracket of brackets) {
    const targets = parseCitationTargets(bracket);
    if (targets === null) {
      invalid++;
      reasons.push(`malformed citation target "${bracket.trim()}"`);
      continue;
    }
    let allResolved = true;
    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design: a
      // citation with N comma-separated targets must resolve every one, and
      // we short-circuit on the first miss.
      const found = await resolveSlug(target);
      if (!found) { allResolved = false; break; }
    }
    if (allResolved) ok++;
    else { invalid++; reasons.push(`unresolvable citation target "${bracket.trim()}"`); }
  }
  return { valid: invalid === 0, ok, invalid, reason: reasons.join('; ') || undefined };
}

// ---------------------------------------------------------------------------
// Structural walk: fences / headings / blockquotes / tables pass through
// untouched; bullet blocks validate one claim per item; prose paragraphs
// validate one claim per sentence (splitProseClaims).
// ---------------------------------------------------------------------------

const BULLET_LINE_RE = /^\s*(?:[-*+]|\d+\.)\s+/;
const HEADING_RE = /^#{1,6}\s/;
const FENCE_RE = /^\s*(```+|~~~+)/;

function stripBulletMarker(line: string): { marker: string; content: string } {
  const m = BULLET_LINE_RE.exec(line);
  return m ? { marker: m[0], content: line.slice(m[0].length) } : { marker: '', content: line };
}

export async function validateEnrichCitations(
  body: string,
  resolveSlug: ResolveSlugFn,
): Promise<CitationValidationResult> {
  const lines = (body ?? '').split('\n');
  const outLines: string[] = [];
  const quarantined: QuarantinedClaim[] = [];
  let citationsOk = 0;
  let citationsInvalid = 0;

  let i = 0;
  let inFence = false;

  const evalClaim = async (rawClaim: string): Promise<{ kept: boolean; text: string }> => {
    const trimmed = rawClaim.trim();
    const brackets = extractCitationBrackets(trimmed);
    if (brackets.length === 0 && !looksFactualClaim(trimmed)) {
      return { kept: true, text: rawClaim };
    }
    const verdict = await resolveClaim(trimmed, resolveSlug);
    citationsOk += verdict.ok;
    citationsInvalid += verdict.invalid;
    if (verdict.valid) return { kept: true, text: rawClaim };
    quarantined.push({ text: trimmed, reason: verdict.reason ?? 'invalid citation' });
    return { kept: false, text: rawClaim };
  };

  while (i < lines.length) {
    const line = lines[i];

    if (inFence) {
      outLines.push(line);
      if (FENCE_RE.test(line)) inFence = false;
      i++;
      continue;
    }
    if (FENCE_RE.test(line)) {
      inFence = true;
      outLines.push(line);
      i++;
      continue;
    }
    if (line.trim() === '') { outLines.push(line); i++; continue; }
    if (HEADING_RE.test(line.trim())) { outLines.push(line); i++; continue; }
    if (/^>/.test(line.trim())) { outLines.push(line); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { outLines.push(line); i++; continue; }

    if (BULLET_LINE_RE.test(line)) {
      // Gather the contiguous bullet block (markers + indented continuations).
      const blockLines: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '' || HEADING_RE.test(l.trim()) || FENCE_RE.test(l) || /^>/.test(l.trim())) break;
        blockLines.push(l);
        i++;
      }
      const items: string[] = [];
      for (const l of blockLines) {
        if (BULLET_LINE_RE.test(l)) items.push(l);
        else if (items.length > 0) items[items.length - 1] += ' ' + l.trim();
        else items.push(l);
      }
      for (const item of items) {
        const { marker, content } = stripBulletMarker(item);
        const { kept } = await evalClaim(content);
        if (kept) outLines.push(marker ? `${marker}${content.trim()}` : item);
      }
      continue;
    }

    // Prose paragraph: gather contiguous plain lines, join, split to claims.
    const paraLines: string[] = [];
    while (i < lines.length) {
      const l = lines[i];
      if (
        l.trim() === '' ||
        HEADING_RE.test(l.trim()) ||
        FENCE_RE.test(l) ||
        /^>/.test(l.trim()) ||
        BULLET_LINE_RE.test(l) ||
        /^\s*\|.*\|\s*$/.test(l)
      ) break;
      paraLines.push(l);
      i++;
    }
    const paraText = paraLines.join(' ').replace(/\s+/g, ' ').trim();
    if (!paraText) continue;
    const claims = splitProseClaims(paraText);
    const kept: string[] = [];
    for (const claim of claims) {
      const res = await evalClaim(claim);
      if (res.kept) kept.push(claim);
    }
    if (kept.length > 0) outLines.push(kept.join(' '));
  }

  let compiledTruth = outLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  if (quarantined.length > 0) {
    const section = [
      UNVERIFIED_HEADING,
      '',
      ...quarantined.map((q) => `- ${q.text} _(${q.reason})_`),
    ].join('\n');
    compiledTruth = compiledTruth ? `${compiledTruth}\n\n${section}\n` : `${section}\n`;
  }

  return {
    compiledTruth,
    citationsOk,
    citationsInvalid,
    sentencesQuarantined: quarantined.length,
    quarantined,
  };
}
