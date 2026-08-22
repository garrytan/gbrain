/**
 * v0.42.0.0 Part B — Auto-link entity mentions to known entity pages.
 * Migration #1 of the consolidated #1409 design doc (orphan reduction).
 *
 * `buildGazetteer` queries the brain for entity-typed pages and produces a
 * token-Map lookup structure suitable for fast body-text scanning.
 *
 * `findMentionedEntities` is a pure function that scans body text against
 * the gazetteer, applies the maximal-munch matcher (longest gazetteer
 * entry wins at each offset), self-link guard, cross-source guard, and
 * per-page first-mention-only cap (1 link per (source_slug, target_slug)).
 *
 * Design decisions locked in /plan-eng-review for v0.42.0.0:
 *  - D2/D10  Hardcoded entity-type filter (not pack-aware) — pack v2
 *            extension filed as TODO-1.
 *  - D6      Token-Map + multi-word phrase pass (no new deps, no regex
 *            alternation, no Aho-Corasick).
 *  - D7      DB-source only — caller restricts page WALK to DB iteration.
 *  - D12     `link_source='mentions'` writes filtered out of backlink-count
 *            for search ranking (see postgres-engine.ts/pglite-engine.ts).
 *  - D13     Self-link guard.
 *  - CK12    Ignore-list applied at gazetteer-build time, NOT match time.
 *            Built-in ambiguous tokens (Apple, Amazon, Square, Stripe, Box)
 *            are dropped from the gazetteer ONLY when no corresponding
 *            entity page exists. If a page DOES exist, the user explicitly
 *            created it and we trust the gazetteer presence.
 */

import type { BrainEngine } from './engine.ts';
import { isUndefinedTableError } from './utils.ts';
import { CJK_SLUG_CHARS } from './cjk.ts';
import { stripCodeBlocks } from './link-extraction.ts';
// #4222: shared generic-token reject list — same list gates enrichEntity
// minting and drives the junk_entity_hubs doctor check.
import { isGenericEntityToken } from './entity-name-quality.ts';

/** D2: hardcoded entity types for v1. Pack-aware extension is TODO-1. */
export const LINKABLE_ENTITY_TYPES = ['person', 'company', 'organization', 'entity'] as const;

/**
 * Minimum title length for gazetteer inclusion. Filters out 2-3 char names
 * (AI, YC, X, IBM) that produce dense false-positive auto-links in body text.
 * Codex CK13 noted v1 will under-deliver on 3-char real entities; the
 * pack-aware follow-up (TODO-1) can let users opt specific 3-char entity
 * types in.
 */
let aliasGazetteerWarned = false;

const MIN_NAME_LENGTH = 4;
const MIN_CJK_NAME_LENGTH = 2;

/**
 * Built-in ignore list — common ambiguous tokens whose body-text mentions
 * are usually NOT references to the named brand/entity. Suppressed at
 * gazetteer-build time when no corresponding entity page exists.
 *
 * Per CK12 (codex outside-voice): if the user has explicitly created
 * `companies/apple` as a page, they want auto-link → ignore-list does
 * not override gazetteer presence. The list only suppresses entries
 * that would NOT otherwise be in the gazetteer.
 */
const DEFAULT_IGNORE_LIST = ['Apple', 'Amazon', 'Square', 'Stripe', 'Box', 'Meta', 'Target', 'Oracle'];

export interface GazetteerEntry {
  /** Canonical page slug (e.g. `companies/acme-corp`). */
  slug: string;
  /** Source id (multi-source brains). 'default' for single-source. */
  source_id: string;
  /** Original title (preserved for the mention payload). */
  title: string;
  /** Lowercase title tokens in order. Length 1 = single-word entity. */
  tokens: string[];
}

/**
 * Gazetteer is keyed by lowercase FIRST token. Multiple entries can
 * share a first token (e.g. "Acme" + "Acme Corp" + "Acme Foundation").
 * At match time, the scanner picks the entry with the most tokens that
 * matches the body-text token sequence at the current offset (maximal
 * munch).
 */
export type Gazetteer = Map<string, GazetteerEntry[]>;

export interface Mention {
  /** Target page slug (the entity being mentioned). */
  slug: string;
  /** Target source id (cross-source guard). */
  source_id: string;
  /** Display name (original title). */
  name: string;
  /** Character offset in the ORIGINAL (un-stripped) body where the mention starts. */
  offset: number;
}

export interface BuildGazetteerOpts {
  /**
   * Optional user-supplied additional ignore-list entries (case-sensitive
   * raw title match). Merged with DEFAULT_IGNORE_LIST.
   */
  extraIgnore?: string[];
}

export interface FindMentionsOpts {
  /** Source slug of the page being scanned. Used for self-link guard. */
  fromSlug: string;
  /** Source id of the page being scanned. Used for cross-source guard. */
  fromSourceId: string;
}

// ============================================================
// Gazetteer construction
// ============================================================

/**
 * The CJK character set this module treats as char-level, declared ONCE.
 *
 * `CJK_SLUG_CHARS` (src/core/cjk.ts) is the repo-wide single source of truth
 * — Han U+4E00–9FFF, Hiragana, Katakana, Hangul syllables — and this module
 * now uses it verbatim.
 *
 * Note the deliberate behaviour change: the walkers here used to carry their
 * own copy of the ranges that also covered Han Extension A (U+3400–4DBF),
 * which cjk.ts scopes out repo-wide (see its header). Aligning on the shared
 * constant means Ext-A characters are no longer treated as CJK by
 * by-mention: they tokenize as word runs and, being a single sub-4-character
 * token, an Ext-A-only entity title now falls below MIN_NAME_LENGTH instead
 * of qualifying under MIN_CJK_NAME_LENGTH. Search, chunking and slug grammar
 * already ignore Ext-A, so this makes by-mention consistent with them rather
 * than being the one subsystem that disagrees.
 *
 * Everything below — TOKEN_RE, hasCJK(), cjkCharCount() and the two
 * per-character walkers — derives from this one import. There are no copies
 * of the ranges in this file.
 */
const CJK_CHAR_RE = new RegExp(`^[${CJK_SLUG_CHARS}]$`, 'u');

/**
 * Conservative code-point bounds for CJK_SLUG_CHARS, derived from the range
 * string itself (strip the `-` separators and the remaining characters are
 * exactly the range endpoints) so they can never drift from it. Used only
 * as a cheap pre-filter — Latin/Vietnamese text short-circuits before the
 * regex in the per-character walkers, which run over every body byte.
 */
const CJK_BOUNDS = ((): { min: number; max: number } => {
  let min = 0x10ffff;
  let max = 0;
  for (const ch of CJK_SLUG_CHARS.replace(/-/g, '')) {
    const cp = ch.codePointAt(0)!;
    if (cp < min) min = cp;
    if (cp > max) max = cp;
  }
  return { min, max };
})();

function isCJKChar(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < CJK_BOUNDS.min || cp > CJK_BOUNDS.max) return false;
  return CJK_CHAR_RE.test(ch);
}

/**
 * Word-run tokenizer: a letter or ASCII digit, followed by any run of
 * letters, ASCII digits and combining marks — CJK excluded throughout, so
 * CJK keeps flowing through the per-character path in the walkers below.
 *
 * Latin scripts with diacritics tokenize as whole words instead of
 * fragmenting on every accented character — "Nguyễn" is one token, not
 * ["nguy","n"], and "Đà Nẵng" is ["đà","nẵng"], not ["n","ng"].
 *
 * Four deliberate boundaries, each of which was a real regression:
 *
 *  - The LEAD must be a letter or digit, so a token can never consist of
 *    combining marks alone. U+FE0F (VARIATION SELECTOR-16, category Mn)
 *    rides on most emoji, so a mark-only token would hijack the gazetteer
 *    key of every emoji-prefixed entity title ("❤️ Health Notes" keying on
 *    U+FE0F instead of "health") and collapse all of them into one shared,
 *    mutually-confusable bucket.
 *  - Combining marks ARE allowed after the lead. NFD Vietnamese is base
 *    letter + mark, so excluding \p{M} would re-fragment the exact names
 *    this tokenizer exists to keep whole.
 *  - Digits are ASCII-only, exactly as the previous /[a-zA-Z0-9]+/ was.
 *    \p{N} would additionally mint tokens for ¹ ½ １ (Nl/No/non-ASCII Nd),
 *    and findMentionedEntities requires gazetteer tokens to be STRICTLY
 *    ADJACENT in the body — so a superscript between the words of
 *    "Acme Corp" would silently break a match that used to work.
 *  - Plain `u` flag, not `v`: the CJK exclusion is a negative lookahead
 *    over CJK_SLUG_CHARS, the same construction src/core/think/gather.ts
 *    already uses. No es2024 target requirement, no set-subtraction syntax.
 */
const TOKEN_RE = new RegExp(
  `(?![${CJK_SLUG_CHARS}])[\\p{L}0-9]` +
  `(?:(?![${CJK_SLUG_CHARS}])[\\p{L}\\p{M}0-9])*`,
  'gu',
);

/**
 * Canonical form for a single token. NFC only — canonical composition, no
 * compatibility folding — so an NFD body and an NFC gazetteer title produce
 * the same token, while diacritics stay significant ("Hồng" still must not
 * match "Hong").
 *
 * Applied PER TOKEN, never to the whole text: `Mention.offset` is contracted
 * to index into the ORIGINAL body (extract-ner.ts slices a context window
 * from it to infer the link verb), and normalizing the text up front would
 * silently shift every offset.
 */
function normalizeToken(s: string): string {
  return s.normalize('NFC').toLowerCase();
}

interface ScannedToken {
  text: string;       // lowercase
  offset: number;     // index in source
  length: number;     // original length (for span tracking)
}

/**
 * Body-text tokenizer. Returns `[token, offset]` pairs.
 *
 * Word runs: each TOKEN_RE match is one token, NFC-normalized and
 *   lowercased. Covers ASCII and diacritic Latin scripts like Vietnamese
 *   ("Nguyễn" → one token, not ["nguy","n"]).
 * CJK: each CJK character (Chinese/Japanese/Korean) is an individual
 *   token. This allows the normal maximal-munch scan path to reach CJK
 *   gazetteer entries without a separate substring pass.
 *
 * `offset` and `length` index into the ORIGINAL string — callers slice
 * context windows out of the untouched body with them.
 *
 * Possessive "Acme's" tokenizes as ['acme', 's'] (single-quote breaks the
 * run) — single-word "Acme" lookup succeeds at offset 0; the trailing 's'
 * is harmless noise.
 *
 * Exported so tests can assert on TOKENIZATION rather than only on the
 * resolved mention (see tokenizeTitle).
 */
export function tokenizeForScan(text: string): ScannedToken[] {
  const out: ScannedToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  // Collect word-run token spans first.
  const wordSpans: Array<{ start: number; end: number }> = [];
  while ((m = TOKEN_RE.exec(text)) !== null) {
    wordSpans.push({ start: m.index, end: m.index + m[0].length });
  }

  // Walk character-by-character: emit word-run tokens at their start
  // positions, then emit individual CJK characters for positions that fall
  // outside every word-run span.
  let spanIdx = 0;
  for (let i = 0; i < text.length;) {
    // Advance spanIdx past any spans that end before or at i.
    while (spanIdx < wordSpans.length && wordSpans[spanIdx]!.end <= i) {
      spanIdx++;
    }

    // If position i is inside a word-run span, emit the full token and jump
    // past it.
    if (spanIdx < wordSpans.length && i >= wordSpans[spanIdx]!.start && i < wordSpans[spanIdx]!.end) {
      const span = wordSpans[spanIdx]!;
      const token = text.slice(span.start, span.end);
      out.push({ text: normalizeToken(token), offset: span.start, length: token.length });
      i = span.end;
      spanIdx++;
      continue;
    }

    // CJK: emit as individual character token.
    const cp = text.codePointAt(i) ?? 0;
    const charLen = cp > 0xffff ? 2 : 1; // surrogate pair
    const charStr = text.slice(i, i + charLen);
    if (isCJKChar(charStr)) {
      out.push({ text: normalizeToken(charStr), offset: i, length: charLen });
      i += charLen;
    } else {
      i++;
    }
  }
  return out;
}

function hasCJK(s: string): boolean {
  for (const ch of s) {
    if (isCJKChar(ch)) return true;
  }
  return false;
}

function cjkCharCount(s: string): number {
  let count = 0;
  for (const ch of s) {
    if (isCJKChar(ch)) count++;
  }
  return count;
}

/**
 * Tokenize a page title for gazetteer insertion.
 *
 * Word-run titles: TOKEN_RE tokenization, NFC-normalized and lowercased —
 *   ASCII plus diacritic Latin scripts (Vietnamese, etc.).
 * CJK titles (no word-run content): split into individual characters —
 *   e.g. "纳瓦尔" → ["纳","瓦","尔"]. This allows normal multi-token
 *   maximal-munch matching to work with character-level CJK tokens
 *   produced by `tokenizeForScan`.
 * Mixed CJK+word-run titles: word-run parts tokenized normally, CJK parts
 *   split into individual characters.
 *
 * Exported so tests can assert on TOKENIZATION rather than only on the
 * resolved mention — a mention-only assertion passes even with a tokenizer
 * that fragments the title and the body symmetrically.
 */
export function tokenizeTitle(title: string): string[] {
  const tokens: string[] = [];
  TOKEN_RE.lastIndex = 0;
  const hasWordRun = TOKEN_RE.test(title);
  if (hasWordRun) {
    // Mixed word-run+CJK or pure word-run: tokenize word runs normally,
    // then append individual CJK characters in order.
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    const wordSpans: Array<{ start: number; end: number; text: string }> = [];
    while ((m = TOKEN_RE.exec(title)) !== null) {
      wordSpans.push({ start: m.index, end: m.index + m[0].length, text: normalizeToken(m[0]) });
    }
    let spanIdx = 0;
    for (let i = 0; i < title.length;) {
      while (spanIdx < wordSpans.length && wordSpans[spanIdx]!.end <= i) spanIdx++;
      if (spanIdx < wordSpans.length && i >= wordSpans[spanIdx]!.start && i < wordSpans[spanIdx]!.end) {
        tokens.push(wordSpans[spanIdx]!.text);
        i = wordSpans[spanIdx]!.end;
        spanIdx++;
        continue;
      }
      const cp = title.codePointAt(i) ?? 0;
      const charLen = cp > 0xffff ? 2 : 1;
      const charStr = title.slice(i, i + charLen);
      if (isCJKChar(charStr)) {
        tokens.push(normalizeToken(charStr));
        i += charLen;
      } else {
        i++;
      }
    }
    return tokens;
  }
  // Pure CJK (no word-run content): split into individual characters.
  if (hasCJK(title)) {
    for (let i = 0; i < title.length;) {
      const cp = title.codePointAt(i) ?? 0;
      const charLen = cp > 0xffff ? 2 : 1;
      tokens.push(normalizeToken(title.slice(i, i + charLen)));
      i += charLen;
    }
    return tokens;
  }
  // Non-ASCII, non-CJK title (emoji, symbols, etc.) — empty set.
  return [];
}

/**
 * Build a token-Map gazetteer from all entity-typed pages in the brain.
 *
 * Hardcoded type filter per D2 (pack-awareness is TODO-1). Soft-deleted
 * pages excluded. Pages with too-short titles excluded (MIN_NAME_LENGTH).
 * Ignore-list applied per CK12: built-in ambiguous tokens dropped unless
 * the user has explicitly created the corresponding page.
 *
 * Returned gazetteer is keyed by lowercase first token; entries with the
 * same first token co-exist in the same bucket (e.g. "Acme" + "Acme Corp").
 */
export async function buildGazetteer(
  engine: BrainEngine,
  opts: BuildGazetteerOpts = {},
): Promise<Gazetteer> {
  const typeList = LINKABLE_ENTITY_TYPES.map(t => `'${t}'`).join(', ');
  const rows = await engine.executeRaw<{ slug: string; source_id: string | null; title: string | null; type: string | null }>(
    `SELECT slug, source_id, title, type
     FROM pages
     WHERE type IN (${typeList})
       AND deleted_at IS NULL`,
    [],
  );

  // Pre-build the existing-slug Set so the ignore-list rule can check
  // "does this name already correspond to a real page?" in O(1).
  const existingTitles = new Set<string>();
  for (const r of rows) {
    if (r.title) existingTitles.add(r.title);
  }
  const ignoreSet = new Set<string>([...DEFAULT_IGNORE_LIST, ...(opts.extraIgnore ?? [])]);

  const gazetteer: Gazetteer = new Map();
  for (const row of rows) {
    if (!row.title) continue;
    if (!hasCJK(row.title) && row.title.length < MIN_NAME_LENGTH) continue;
    if (hasCJK(row.title) && cjkCharCount(row.title) < MIN_CJK_NAME_LENGTH) continue;
    // NOTE (v0.46.15, deliberately preserved): for TITLES this condition is
    // intentionally vacuous — every row here IS a real page, so an
    // ignore-listed name the user explicitly created a page for is always
    // allowed (documented CK12 policy). The ignore list bites only via
    // opts.extraIgnore names that have no page, and — with real teeth — on
    // the ALIAS entries below, which are not user-created pages.
    if (ignoreSet.has(row.title) && !existingTitles.has(row.title)) continue;

    const tokens = tokenizeTitle(row.title);
    if (tokens.length === 0) continue;
    if (tokens[0]!.length < MIN_NAME_LENGTH && tokens.length === 1) continue;
    // #4222: a single-generic-token PERSON title ("Will", "Chief") is a
    // junk-hub magnet — every prose occurrence of the word would accrete
    // another mention edge onto a near-empty page. Dropped from the
    // gazetteer even though the page exists (unlike the CK12 ignore-list
    // rule above, which trusts user-created pages: these titles are
    // overwhelmingly extractor-minted, and the page itself stays intact —
    // only the auto-link accretion stops). Multi-token titles ("Will
    // Smith") and non-person types are unaffected.
    if (tokens.length === 1 && row.type === 'person' && isGenericEntityToken(tokens[0]!)) continue;

    const entry: GazetteerEntry = {
      slug: row.slug,
      source_id: row.source_id ?? 'default',
      title: row.title,
      tokens,
    };
    const key = tokens[0]!;
    const bucket = gazetteer.get(key);
    if (bucket) bucket.push(entry);
    else gazetteer.set(key, [entry]);
  }

  // ── Alias entries (v0.46.15 identity wave, #3801) ────────────────────────
  // page_aliases rows joined to LIVE entity-typed pages become additional
  // gazetteer entries, so a body mention of "saoirse" links to
  // people/saoirse-x. Guards (stricter than titles — aliases are not
  // user-created pages):
  //   - ignore-list applies CASE-INSENSITIVELY with NO existing-page escape
  //     (aliases store normalized lowercase; DEFAULT_IGNORE_LIST is cased)
  //   - aliases mapping to >1 slug within a source are skipped (ambiguous)
  //   - aliases colliding with any existing page TITLE in the SAME source
  //     are skipped (the title entry wins; per-source scoping per R2-9)
  //   - MIN_NAME_LENGTH applies to the alias string
  try {
    const aliasRows = await engine.executeRaw<{
      alias_norm: string;
      slug: string;
      source_id: string | null;
      title: string | null;
    }>(
      `SELECT pa.alias_norm, pa.slug, pa.source_id, p.title
       FROM page_aliases pa
       JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id
       WHERE p.type IN (${typeList})
         AND p.deleted_at IS NULL`,
      [],
    );
    const ignoreLc = new Set(Array.from(ignoreSet, (s) => s.toLowerCase()));
    // Per-source title index for alias-vs-title collision checks.
    const titleBySource = new Set<string>();
    for (const r of rows) {
      if (r.title) titleBySource.add(`${r.source_id ?? 'default'} ${r.title.toLowerCase()}`);
    }
    // Ambiguity: same (source, alias) → multiple slugs.
    const bySourceAlias = new Map<string, Set<string>>();
    for (const a of aliasRows) {
      const k = `${a.source_id ?? 'default'} ${a.alias_norm}`;
      const set = bySourceAlias.get(k) ?? new Set<string>();
      set.add(a.slug);
      bySourceAlias.set(k, set);
    }
    const seenAliasEntry = new Set<string>();
    for (const a of aliasRows) {
      const alias = a.alias_norm?.trim();
      if (!alias || !a.title) continue;
      const src = a.source_id ?? 'default';
      if (alias.length < MIN_NAME_LENGTH && !hasCJK(alias)) continue;
      if (hasCJK(alias) && cjkCharCount(alias) < MIN_CJK_NAME_LENGTH) continue;
      if (ignoreLc.has(alias.toLowerCase())) continue;
      if ((bySourceAlias.get(`${src} ${alias}`)?.size ?? 0) > 1) continue;
      if (titleBySource.has(`${src} ${alias.toLowerCase()}`)) continue;
      const dedupeKey = `${src} ${alias} ${a.slug}`;
      if (seenAliasEntry.has(dedupeKey)) continue;
      seenAliasEntry.add(dedupeKey);
      const tokens = tokenizeTitle(alias);
      if (tokens.length === 0) continue;
      if (tokens[0]!.length < MIN_NAME_LENGTH && tokens.length === 1) continue;
      const entry: GazetteerEntry = { slug: a.slug, source_id: src, title: a.title, tokens };
      const key = tokens[0]!;
      const bucket = gazetteer.get(key);
      if (bucket) bucket.push(entry);
      else gazetteer.set(key, [entry]);
    }
  } catch (err) {
    // pre-v110 brains: no page_aliases table — titles-only gazetteer.
    // Any OTHER failure (connection blip, permission) warns once per process
    // (adversarial F12): a silently titles-only gazetteer under-links every
    // page processed until restart, and nobody would know why.
    if (!isUndefinedTableError(err) && !aliasGazetteerWarned) {
      aliasGazetteerWarned = true;
      console.error(`[gbrain] gazetteer alias load degraded (titles-only): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Sort each bucket by token-count DESC so maximal-munch walks longest-first.
  for (const bucket of gazetteer.values()) {
    bucket.sort((a, b) => b.tokens.length - a.tokens.length);
  }
  return gazetteer;
}

// ============================================================
// Body-text scanner (pure)
// ============================================================

/**
 * Scan body text for mentions of gazetteer entities. Pure function — no
 * IO. Returns `Mention[]` ordered by offset, deduped per
 * `(fromSlug → entry.slug)` pair (first-mention-only cap).
 *
 * Matcher is maximal-munch: at each token offset, the longest gazetteer
 * entry that matches the body-token sequence wins. Single-word entries
 * are length-1 maximal matches.
 *
 * Guards (deterministic):
 *  - D13 self-link: skip when `fromSlug === entry.slug`.
 *  - Cross-source: skip when `fromSourceId !== entry.source_id` (mention
 *    in source A of an entity in source B is suppressed; design doc
 *    treats this as deliberate isolation in v1, can relax in a follow-up).
 *  - First-mention-only cap: dedup by `entry.slug` (one link per
 *    target page regardless of how many body mentions there are).
 *
 * Code-block stripping via `stripCodeBlocks` (preserves offsets, so the
 * returned mention offsets index into the ORIGINAL text not the stripped
 * text — useful for downstream debugging tools).
 */
export function findMentionedEntities(
  text: string,
  gazetteer: Gazetteer,
  opts: FindMentionsOpts,
): Mention[] {
  if (!text || gazetteer.size === 0) return [];
  const stripped = stripCodeBlocks(text);
  const tokens = tokenizeForScan(stripped);
  if (tokens.length === 0) return [];

  const out: Mention[] = [];
  const seenSlugs = new Set<string>();
  let i = 0;

  while (i < tokens.length) {
    const head = tokens[i]!;
    const bucket = gazetteer.get(head.text);
    if (!bucket) {
      i++;
      continue;
    }

    // Maximal-munch: bucket is pre-sorted longest-first. Find the first
    // entry whose subsequent tokens all match the body sequence.
    let matched: GazetteerEntry | null = null;
    let matchedTokens = 0;
    for (const entry of bucket) {
      if (entry.tokens.length === 1) {
        matched = entry;
        matchedTokens = 1;
        break;
      }
      // Multi-word: validate subsequent tokens.
      if (i + entry.tokens.length > tokens.length) continue;
      let allMatch = true;
      for (let k = 1; k < entry.tokens.length; k++) {
        if (tokens[i + k]!.text !== entry.tokens[k]) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        matched = entry;
        matchedTokens = entry.tokens.length;
        break;
      }
    }

    if (!matched) {
      i++;
      continue;
    }

    // Guards.
    if (matched.slug === opts.fromSlug) {
      i += matchedTokens;
      continue;
    }
    if (matched.source_id !== opts.fromSourceId) {
      i += matchedTokens;
      continue;
    }
    if (seenSlugs.has(matched.slug)) {
      i += matchedTokens;
      continue;
    }

    out.push({
      slug: matched.slug,
      source_id: matched.source_id,
      name: matched.title,
      offset: head.offset,
    });
    seenSlugs.add(matched.slug);
    i += matchedTokens;
  }

  return out;
}

// ============================================================
// Stale-mention detection (read-only)
// ============================================================

/** One `link_source='mentions'` row the current gazetteer no longer produces. */
export interface StaleMention {
  from: string;
  to: string;
  /** `link_kind` as stored; NULL rows (legacy / pre-v98) report as 'plain'. */
  kind: string;
}

export interface StaleMentionsScan {
  /** Live pages carrying at least one `link_source='mentions'` row. */
  totalPagesWithMentions: number;
  /** Pages actually re-scanned (bounded by `opts.limit`). */
  pagesScanned: number;
  /** `mentions` rows on the scanned pages. */
  linksScanned: number;
  /** Of those, rows whose target the current gazetteer no longer produces. */
  staleLinks: number;
  /** Stale counts split by `link_kind` — `typed_ner` rows come from extract-ner. */
  staleByKind: Record<string, number>;
  /** True when the brain has NO linkable entity pages at all. */
  emptyGazetteer: boolean;
  /** First few stale rows, for an operator-facing message. */
  examples: StaleMention[];
}

const STALE_MENTIONS_DEFAULT_LIMIT = 500;
const STALE_MENTIONS_MAX_EXAMPLES = 5;

/**
 * Re-derive what `extract links --by-mention` would produce today and report
 * `link_source='mentions'` rows that no longer follow from the current
 * gazetteer + page bodies.
 *
 * STRICTLY READ-ONLY. This deletes nothing and writes nothing; it exists so
 * the drift is visible, because the scan's write path (`addLinksBatch`) is
 * purely additive. Re-running the scan adds today's correct links ALONGSIDE
 * rows left by an older gazetteer, an older tokenizer, or a body that has
 * since stopped mentioning the entity — nothing ever removes those.
 *
 * A row is counted stale when the current scan does not produce its
 * (source_id, slug) target from the page's body. That test is deliberately
 * target-based rather than kind-based, so it covers `link_kind='typed_ner'`
 * rows too: extract-ner derives those from the same mention set, so a target
 * this scan no longer yields cannot have a live verb-typed edge either. The
 * converse does NOT hold — a still-produced target says nothing about
 * whether the stored verb is still right — so `typed_ner` counts are
 * reported separately rather than folded into one number.
 *
 * Bounded by `limit` (default 500) in slug order for determinism. The
 * returned `totalPagesWithMentions` is the unbounded figure so callers can
 * say what was and was not covered instead of implying full coverage.
 */
export async function scanStaleMentions(
  engine: BrainEngine,
  opts: { limit?: number } = {},
): Promise<StaleMentionsScan> {
  const limit = opts.limit ?? STALE_MENTIONS_DEFAULT_LIMIT;

  const totalRow = await engine.executeRaw<{ count: number }>(
    `SELECT COUNT(DISTINCT l.from_page_id)::int AS count
       FROM links l
       JOIN pages p ON p.id = l.from_page_id
      WHERE l.link_source = 'mentions'
        AND p.deleted_at IS NULL`,
    [],
  );
  const totalPagesWithMentions = totalRow[0]?.count ?? 0;

  const empty: StaleMentionsScan = {
    totalPagesWithMentions,
    pagesScanned: 0,
    linksScanned: 0,
    staleLinks: 0,
    staleByKind: {},
    emptyGazetteer: false,
    examples: [],
  };
  if (totalPagesWithMentions === 0) return empty;

  const gazetteer = await buildGazetteer(engine);

  // Same bounded page set for both queries so the link rows and the bodies
  // can never describe different pages.
  const scannedCte =
    `WITH scanned AS (
       SELECT p.id
         FROM pages p
        WHERE p.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM links l
             WHERE l.from_page_id = p.id AND l.link_source = 'mentions'
          )
        ORDER BY p.slug
        LIMIT $1
     )`;

  const bodies = await engine.executeRaw<{
    id: number; slug: string; source_id: string | null; body: string;
  }>(
    `${scannedCte}
     SELECT p.id, p.slug, p.source_id,
            COALESCE(p.compiled_truth, '') || E'\n\n' || COALESCE(p.timeline, '') AS body
       FROM pages p
       JOIN scanned s ON s.id = p.id
      ORDER BY p.slug`,
    [limit],
  );

  const rows = await engine.executeRaw<{
    from_id: number; from_slug: string; to_slug: string;
    to_source_id: string | null; link_kind: string | null;
  }>(
    `${scannedCte}
     SELECT l.from_page_id AS from_id, f.slug AS from_slug,
            t.slug AS to_slug, t.source_id AS to_source_id, l.link_kind
       FROM links l
       JOIN scanned s ON s.id = l.from_page_id
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE l.link_source = 'mentions'
      ORDER BY f.slug, t.slug`,
    [limit],
  );

  const byPage = new Map<number, typeof rows>();
  for (const r of rows) {
    const bucket = byPage.get(r.from_id);
    if (bucket) bucket.push(r);
    else byPage.set(r.from_id, [r]);
  }

  const staleByKind: Record<string, number> = {};
  const examples: StaleMention[] = [];
  let staleLinks = 0;

  for (const page of bodies) {
    const stored = byPage.get(page.id);
    if (!stored || stored.length === 0) continue;

    const fromSourceId = page.source_id ?? 'default';
    const produced = new Set(
      findMentionedEntities(page.body, gazetteer, {
        fromSlug: page.slug,
        fromSourceId,
      }).map(m => `${m.source_id}::${m.slug}`),
    );

    for (const row of stored) {
      const key = `${row.to_source_id ?? 'default'}::${row.to_slug}`;
      if (produced.has(key)) continue;
      staleLinks++;
      const kind = row.link_kind ?? 'plain';
      staleByKind[kind] = (staleByKind[kind] ?? 0) + 1;
      if (examples.length < STALE_MENTIONS_MAX_EXAMPLES) {
        examples.push({ from: page.slug, to: row.to_slug, kind });
      }
    }
  }

  return {
    totalPagesWithMentions,
    pagesScanned: bodies.length,
    linksScanned: rows.length,
    staleLinks,
    staleByKind,
    emptyGazetteer: gazetteer.size === 0,
    examples,
  };
}
