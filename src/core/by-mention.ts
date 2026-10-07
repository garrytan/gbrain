/**
 * Auto-link entity mentions to known entity pages (orphan reduction, #1409;
 * entity recall, src/core/mentions/).
 *
 * `buildGazetteer` reads the brain's linkable entity pages (the pack-aware
 * per-source type set from `mentions/policy.ts`) and their names (titles plus
 * `page_aliases` rows: frontmatter aliases, declared aliases and title
 * subjects) into a token-Map lookup structure for body-text scanning.
 *
 * `findMentionedEntities` is a pure function that scans body text against
 * the gazetteer, applies the maximal-munch matcher (longest gazetteer
 * entry wins at each offset), case-sensitive entries, per-page ignore names,
 * the self-link guard, the cross-source guard, and the per-page
 * first-mention-only cap (1 link per (source_slug, target_slug)).
 *
 * Design decisions:
 *  - Linkable types come from the source's schema pack (primitive: entity
 *    types and their type aliases, product excluded) unioned with person,
 *    company, organization and entity.
 *  - Token-Map + multi-word phrase pass (no new deps, no regex alternation,
 *    no Aho-Corasick).
 *  - DB-source only — callers walk pages from the database.
 *  - `link_source='mentions'` writes are filtered out of backlink-count for
 *    search ranking (see postgres-engine.ts/pglite-engine.ts).
 *  - Self-link guard.
 *  - Ignore-list applied at gazetteer-build time, not match time. Built-in
 *    ambiguous tokens (Apple, Amazon, Square, Stripe, Box) are dropped from
 *    the gazetteer only when no corresponding entity page exists: a page the
 *    user created is trusted. `mentions.ignore` names are dropped always;
 *    pages listed in `mentions.exclude_slugs` get no entry at all (#5829).
 */

import { createHash } from 'crypto';
import type { BrainEngine } from './engine.ts';
import { isUndefinedTableError } from './utils.ts';
import { CJK_SLUG_CHARS } from './cjk.ts';
import { stripCodeBlocks, isCrossSourceLinksEnabled } from './link-extraction.ts';
// #4222: shared generic-token reject list — same list gates enrichEntity
// minting and drives the junk_entity_hubs doctor check.
import { isGenericEntityToken } from './entity-name-quality.ts';
import { ALWAYS_LINKABLE_TYPES, linkableTypesFor, loadSourcePack, readMentionPolicy, type MentionPolicy, type PackTypes } from './mentions/policy.ts';
import { siblingVerdict, type SiblingCandidate } from './mentions/siblings.ts';

/**
 * The four types that are always linkable, whatever the schema pack says. The
 * full per-source set is `linkableTypesFor` (mentions/policy.ts).
 */
export const LINKABLE_ENTITY_TYPES = ALWAYS_LINKABLE_TYPES;

let aliasGazetteerWarned = false;

/**
 * Minimum name length for gazetteer inclusion. Filters out 2-3 char names
 * (AI, YC, X, IBM) that produce dense false-positive auto-links in body text.
 */
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

/** Where a gazetteer name came from: the page title or a `page_aliases` row's origin. */
export type GazetteerOrigin = 'title' | 'frontmatter' | 'declared' | 'subject';

export interface GazetteerEntry {
  /** Canonical page slug (e.g. `companies/acme-corp`). */
  slug: string;
  /** Source id (multi-source brains). 'default' for single-source. */
  source_id: string;
  /** Original title (preserved for the mention payload). */
  title: string;
  /** Lowercase title tokens in order. Length 1 = single-word entity. */
  tokens: string[];
  /** Absent on hand-built entries: a title. */
  origin?: GazetteerOrigin;
  /**
   * Set on case-sensitive entries (single-token declared aliases): the tokens
   * as written, NFC. A body token matches only when its original text equals.
   */
  caseTokens?: string[];
  /** Spelling being matched (the alias, not the display title, for aliases). */
  matchText?: string;
  /**
   * Set on a name two or three identity siblings claim (mentions/siblings.ts):
   * a match links to every sibling with the same tokens instead of one.
   */
  shared?: true;
}

/**
 * Gazetteer is keyed by lowercase FIRST token. Multiple entries can
 * share a first token (e.g. "Acme" + "Acme Corp" + "Acme Foundation").
 * At match time, the scanner picks the entry with the most tokens that
 * matches the body-text token sequence at the current offset (maximal
 * munch).
 */
export type Gazetteer = Map<string, GazetteerEntry[]>;

/**
 * Fingerprint of every gazetteer entry (source_id, slug, title, tokens) for
 * the by-mention resume checkpoint. Hashing only the first-token bucket KEYS
 * missed a new "Acme Labs" beside an existing "Acme Corp", so resumed pages
 * silently skipped the new entity.
 */
export function hashGazetteer(gazetteer: Gazetteer): string {
  const entries: string[] = [];
  for (const bucket of gazetteer.values()) {
    for (const e of bucket) entries.push(`${e.source_id}\0${e.slug}\0${e.title}\0${e.tokens.join(' ')}\0${e.matchText ?? ''}${e.caseTokens ? `\0${e.caseTokens.join(' ')}` : ''}`);
  }
  // Matching semantics are part of the resume identity, not just DB contents.
  return createHash('sha256').update('shared-sibling-names-v3\n').update(entries.sort().join('\n')).digest('hex').slice(0, 8);
}

/** One row of the saved entry set the mention pass diffs (mention_gazetteer_entries). */
export interface GazetteerEntryKey {
  source_id: string;
  name_norm: string;
  target_slug: string;
  case_sensitive: boolean;
}

/** The gazetteer's entries as (source, normalized name, target, case flag), deduped and sorted. */
export function gazetteerEntryKeys(gazetteer: Gazetteer): GazetteerEntryKey[] {
  const out = new Map<string, GazetteerEntryKey>();
  for (const bucket of gazetteer.values()) {
    for (const e of bucket) {
      const name_norm = (e.caseTokens ?? e.tokens).join(' ');
      const key: GazetteerEntryKey = { source_id: e.source_id, name_norm, target_slug: e.slug, case_sensitive: !!e.caseTokens };
      out.set(`${key.source_id}\0${key.name_norm}\0${key.target_slug}\0${key.case_sensitive}`, key);
    }
  }
  return [...out.values()].sort((x, y) => x.source_id.localeCompare(y.source_id) || x.name_norm.localeCompare(y.name_norm)
    || x.target_slug.localeCompare(y.target_slug) || Number(x.case_sensitive) - Number(y.case_sensitive));
}

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

/** A name the gazetteer dropped, with the reason (read by `extract mentions --explain`). */
export interface DroppedName {
  source_id: string;
  slug: string;
  name: string;
  origin: GazetteerOrigin;
  reason: 'below_min_length' | 'generic_token' | 'alias_collision' | 'ambiguous_first_word' | 'ignored' | 'excluded_slug' | 'title_wins';
}

export interface BuildGazetteerOpts {
  /** Mention policy (types, `mentions.ignore`, `mentions.exclude_slugs`); read from config when absent. */
  policy?: MentionPolicy;
  /**
   * Authoritative build for the mention pass: a pack that fails to resolve or
   * an alias read that fails throws instead of degrading to a smaller set.
   */
  strict?: boolean;
  /** Collects every dropped name with its reason. */
  dropped?: DroppedName[];
}

export interface FindMentionsOpts {
  /** Source slug of the page being scanned. Used for self-link guard. */
  fromSlug: string;
  /** Source id of the page being scanned. Used for cross-source guard. */
  fromSourceId: string;
  /**
   * Lift the cross-source guard: a mention in source A of an entity that
   * lives only in source B produces a mention with the entity's own
   * `source_id`. Callers derive this from `link_resolution.cross_source`
   * (via `isCrossSourceLinksEnabled`) so the mention scan follows the same
   * operator opt-in as wikilink resolution. Default false — the historical
   * same-source-only posture.
   */
  allowCrossSource?: boolean;
  /**
   * Names the scanning page opts out of (its frontmatter `mention_ignore`),
   * compared on normalized tokens.
   */
  ignoreNames?: readonly string[];
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

export function hasCJK(s: string): boolean {
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
      const ch = title.slice(i, i + charLen);
      if (isCJKChar(ch)) tokens.push(normalizeToken(ch));
      i += charLen;
    }
    return tokens;
  }
  // Non-ASCII, non-CJK title (emoji, symbols, etc.) — empty set.
  return [];
}

/**
 * Build a token-Map gazetteer from every linkable entity page in the brain.
 *
 * Linkable types are resolved per source (`linkableTypesFor`: the four
 * always-linkable types plus the source pack's entity types and their type
 * aliases). Soft-deleted pages excluded. Each entity page contributes its
 * title and its `page_aliases` rows (frontmatter aliases, declared aliases,
 * title subjects; one row per alias with precedence frontmatter > declared >
 * subject). Guards on every name: the 4-character minimum, the generic-token
 * reject list for single-token person titles and every single-token alias,
 * the ignore lists. Guards on aliases only: an alias claimed by two pages of one source is dropped, an alias equal
 * to an existing title in the same source yields to the title, and a
 * single-token alias equal to the first word of another entity's multi-word
 * name in the source is dropped (an ambiguous first word never links alone).
 * Ignore-list applied per CK12: built-in ambiguous tokens dropped unless
 * the user has explicitly created the corresponding page; `mentions.ignore`
 * names always drop; a page in `mentions.exclude_slugs` contributes neither
 * its title nor its aliases.
 *
 * Returned gazetteer is keyed by lowercase first token; entries with the
 * same first token co-exist in the same bucket (e.g. "Acme" + "Acme Corp").
 */
export async function buildGazetteer(
  engine: BrainEngine,
  opts: BuildGazetteerOpts = {},
): Promise<Gazetteer> {
  const policy = opts.policy ?? await readMentionPolicy(engine);
  const dropped = opts.dropped;
  const drop = (d: DroppedName) => { dropped?.push(d); };
  const sources = await engine.executeRaw<{ id: string }>('SELECT DISTINCT source_id AS id FROM pages WHERE deleted_at IS NULL', []);
  const typesBySource = new Map<string, Set<string>>();
  const packBySource = new Map<string, PackTypes | null>();
  for (const { id } of sources) {
    const pack = await loadSourcePack(engine, id, { strict: opts.strict });
    packBySource.set(id, pack);
    typesBySource.set(id, new Set(linkableTypesFor(pack, policy)));
  }
  const allTypes = [...new Set([...typesBySource.values()].flatMap(set => [...set]))];
  const linkable = (sourceId: string | null, type: string | null) => !!type && (typesBySource.get(sourceId ?? 'default')?.has(type) ?? false);
  const rows = (await engine.executeRaw<{ slug: string; source_id: string | null; title: string | null; type: string | null }>(
    `SELECT slug, source_id, title, type
     FROM pages
     WHERE type = ANY($1::text[])
       AND deleted_at IS NULL`,
    [allTypes],
  )).filter(r => linkable(r.source_id, r.type));

  const ignoreSet = new Set<string>(DEFAULT_IGNORE_LIST);
  const userIgnore = new Set(policy.ignore.map(n => tokenizeTitle(n).join(' ')).filter(Boolean));
  const excludedSlugs = new Set(policy.excludeSlugs);

  const gazetteer: Gazetteer = new Map();
  const add = (entry: GazetteerEntry) => {
    const key = entry.tokens[0]!;
    const bucket = gazetteer.get(key);
    if (bucket) bucket.push(entry);
    else gazetteer.set(key, [entry]);
  };
  // Per source: the first token of every multi-word entity name (titles here,
  // aliases below), for the ambiguous-first-word guard on single-token aliases.
  const firstWords = new Map<string, Set<string>>();
  const noteFirstWord = (src: string, tokens: string[]) => {
    if (tokens.length < 2) return;
    const set = firstWords.get(src) ?? new Set<string>();
    set.add(tokens[0]!);
    firstWords.set(src, set);
  };
  for (const row of rows) {
    if (!row.title) continue;
    const src = row.source_id ?? 'default';
    const base = { source_id: src, slug: row.slug, name: row.title, origin: 'title' as const };
    if (excludedSlugs.has(row.slug)) { drop({ ...base, reason: 'excluded_slug' }); continue; }
    if (!hasCJK(row.title) && row.title.length < MIN_NAME_LENGTH) { drop({ ...base, reason: 'below_min_length' }); continue; }
    if (hasCJK(row.title) && cjkCharCount(row.title) < MIN_CJK_NAME_LENGTH) { drop({ ...base, reason: 'below_min_length' }); continue; }
    // CK12 policy: an ignore-listed name the user explicitly created a page
    // for is always allowed, so DEFAULT_IGNORE_LIST never drops a TITLE
    // (every row here is a real page); it bites on the ALIAS entries below,
    // which are not user-created pages. `mentions.ignore` and
    // `mentions.exclude_slugs` are the operator's levers for titles.

    const tokens = tokenizeTitle(row.title);
    if (tokens.length === 0) continue;
    if (tokens[0]!.length < MIN_NAME_LENGTH && tokens.length === 1) { drop({ ...base, reason: 'below_min_length' }); continue; }
    if (userIgnore.has(tokens.join(' '))) { drop({ ...base, reason: 'ignored' }); continue; }
    // #4222: a single-generic-token PERSON title ("Will", "Chief") is a
    // junk-hub magnet — every prose occurrence of the word would accrete
    // another mention edge onto a near-empty page. Dropped from the gazetteer
    // even though the page exists (unlike the CK12 ignore-list rule above,
    // which trusts user-created pages: these titles are overwhelmingly
    // extractor-minted, and the page itself stays intact — only the
    // auto-link accretion stops). Multi-token titles ("Will Smith") and
    // non-person titles are unaffected; aliases of every type are checked
    // below.
    if (tokens.length === 1 && row.type === 'person' && isGenericEntityToken(tokens[0]!)) { drop({ ...base, reason: 'generic_token' }); continue; }
    noteFirstWord(src, tokens);
    add({ slug: row.slug, source_id: src, title: row.title, tokens, origin: 'title', matchText: row.title });
  }

  // ── Alias entries ────────────────────────────────────────────────────────
  // page_aliases rows joined to LIVE linkable entity pages become additional
  // gazetteer entries, so a body mention of "saoirse" links to
  // people/saoirse-x and "QUCO" links to the account that declares it.
  // Guards (stricter than titles — aliases are not user-created pages):
  //   - one row per (source, alias, page) with origin precedence
  //     frontmatter > declared > subject
  //   - ignore-list applies CASE-INSENSITIVELY with NO existing-page escape
  //     (aliases store normalized lowercase; DEFAULT_IGNORE_LIST is cased)
  //   - an alias claimed by >1 page at its best origin within a source is
  //     dropped (ambiguous); a lower-precedence claim yields
  //   - aliases colliding with any existing page TITLE in the SAME source
  //     are skipped (the title entry wins; per-source scoping per R2-9)
  //   - MIN_NAME_LENGTH and the generic-token list apply to the alias string
  //   - a single-token alias equal to the first word of a multi-word entity
  //     name in the same source is dropped
  //   - a case-sensitive row (a single-token declared alias) matches only
  //     the original-case text
  let aliasRows: Array<{ alias_norm: string; slug: string; source_id: string | null; title: string | null; type: string | null;
    origin: string | null; case_sensitive: boolean | null; alias_text: string | null; identity: unknown }> = [];
  try {
    aliasRows = (await engine.executeRaw<typeof aliasRows[number]>(
      `SELECT pa.alias_norm, pa.slug, pa.source_id, p.title, p.type, pa.origin, pa.case_sensitive, pa.alias_text, p.frontmatter->>'identity' AS identity
       FROM page_aliases pa
       JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id
       WHERE p.type = ANY($1::text[])
         AND p.deleted_at IS NULL`,
      [allTypes],
    )).filter(r => linkable(r.source_id, r.type));
  } catch (err) {
    // pre-v110 brains: no page_aliases table — titles-only gazetteer.
    // Any OTHER failure (connection blip, permission) warns once per process
    // (adversarial F12): a silently titles-only gazetteer under-links every
    // page processed until restart, and nobody would know why. A strict
    // (mention-pass) build throws instead, so nothing is reconciled against
    // a partial gazetteer.
    if (opts.strict) throw err;
    if (!isUndefinedTableError(err) && !aliasGazetteerWarned) {
      aliasGazetteerWarned = true;
      console.error(`[gbrain] gazetteer alias load degraded (titles-only): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const ignoreLc = new Set(Array.from(ignoreSet, (n) => n.toLowerCase()));
  // Per-source title index for alias-vs-title collision checks.
  const titleBySource = new Set<string>();
  for (const r of rows) {
    if (r.title) titleBySource.add(`${r.source_id ?? 'default'} ${r.title.toLowerCase()}`);
  }
  const rank = (origin: string | null) => origin === 'subject' ? 2 : origin === 'declared' ? 1 : 0;
  // Best (lowest) origin rank per (source, alias, slug), then per (source, alias).
  const bestPerPage = new Map<string, typeof aliasRows[number]>();
  for (const a of aliasRows) {
    const k = `${a.source_id ?? 'default'} ${a.alias_norm} ${a.slug}`;
    const prev = bestPerPage.get(k);
    if (!prev || rank(a.origin) < rank(prev.origin)) bestPerPage.set(k, a);
  }
  const claims = new Map<string, { rank: number; slugs: Set<string>; pages: SiblingCandidate[]; shared?: boolean }>();
  for (const a of bestPerPage.values()) {
    const k = `${a.source_id ?? 'default'} ${a.alias_norm}`;
    const r = rank(a.origin);
    const c = claims.get(k);
    const page = { slug: a.slug, title: a.title, type: a.type, identity: a.identity };
    if (!c || r < c.rank) claims.set(k, { rank: r, slugs: new Set([a.slug]), pages: [page] });
    else if (r === c.rank && !c.slugs.has(a.slug)) { c.slugs.add(a.slug); c.pages.push(page); }
  }
  // A name identity siblings share (the subject of "Account sheet: X" and
  // "CRM record: X", or a code both declare) links to every sibling.
  for (const [k, c] of claims) {
    if (c.slugs.size > 1) c.shared = siblingVerdict(c.pages, packBySource.get(k.slice(0, k.indexOf(' '))) ?? null, policy) === 'group';
  }
  const aliasEntries: Array<{ entry: GazetteerEntry; base: Omit<DroppedName, 'reason'> }> = [];
  for (const a of bestPerPage.values()) {
    const alias = a.alias_norm?.trim();
    if (!alias || !a.title) continue;
    const src = a.source_id ?? 'default';
    const origin = (a.origin ?? 'frontmatter') as GazetteerOrigin;
    const written = a.case_sensitive && a.alias_text ? a.alias_text : alias;
    const base = { source_id: src, slug: a.slug, name: written, origin };
    const claim = claims.get(`${src} ${alias}`)!;
    if (rank(a.origin) > claim.rank) continue;
    if (excludedSlugs.has(a.slug)) { drop({ ...base, reason: 'excluded_slug' }); continue; }
    if (claim.slugs.size > 1 && !claim.shared) { drop({ ...base, reason: 'alias_collision' }); continue; }
    if (alias.length < MIN_NAME_LENGTH && !hasCJK(alias)) { drop({ ...base, reason: 'below_min_length' }); continue; }
    if (hasCJK(alias) && cjkCharCount(alias) < MIN_CJK_NAME_LENGTH) { drop({ ...base, reason: 'below_min_length' }); continue; }
    if (ignoreLc.has(alias.toLowerCase())) { drop({ ...base, reason: 'ignored' }); continue; }
    if (titleBySource.has(`${src} ${alias.toLowerCase()}`)) { drop({ ...base, reason: 'title_wins' }); continue; }
    const tokens = tokenizeTitle(alias);
    if (tokens.length === 0) continue;
    if (tokens[0]!.length < MIN_NAME_LENGTH && tokens.length === 1) { drop({ ...base, reason: 'below_min_length' }); continue; }
    if (userIgnore.has(tokens.join(' '))) { drop({ ...base, reason: 'ignored' }); continue; }
    if (tokens.length === 1 && isGenericEntityToken(tokens[0]!)) { drop({ ...base, reason: 'generic_token' }); continue; }
    const caseTokens = a.case_sensitive && a.alias_text ? caseTokensOf(a.alias_text) : undefined;
    const entry: GazetteerEntry = { slug: a.slug, source_id: src, title: a.title, tokens, origin, matchText: alias,
      ...(caseTokens && caseTokens.length === tokens.length ? { caseTokens } : {}), ...(claim.shared ? { shared: true as const } : {}) };
    noteFirstWord(src, tokens);
    aliasEntries.push({ entry, base });
  }
  for (const { entry, base } of aliasEntries) {
    if (entry.tokens.length === 1 && firstWords.get(entry.source_id)?.has(entry.tokens[0]!)) {
      drop({ ...base, reason: 'ambiguous_first_word' });
      continue;
    }
    add(entry);
  }

  // Sort each bucket by token-count DESC so maximal-munch walks longest-first;
  // ties break on (source_id, slug) so the pick among same-name entries is
  // deterministic instead of following DB row order.
  for (const bucket of gazetteer.values()) {
    bucket.sort((a, b) =>
      (b.tokens.length - a.tokens.length)
      || a.source_id.localeCompare(b.source_id)
      || a.slug.localeCompare(b.slug));
  }
  return gazetteer;
}

/** Original-case tokens of a name (NFC, not lowercased), aligned with tokenizeTitle. */
function caseTokensOf(name: string): string[] {
  return tokenizeForScan(name).map(t => name.slice(t.offset, t.offset + t.length).normalize('NFC'));
}

// ============================================================
// Body-text scanner (pure)
// ============================================================

/** Suffixes that may attach to a Hangul name: an optional title or honorific,
 * then up to two particles or copula forms (지원씨는, 지원에게서, 지원이었다).
 * Any other attached Hangul continues a longer word (지원하는, 지원금), which
 * was 99% of 1,041 word-internal matches on a Korean corpus while this suffix
 * set kept 65 of 74 real name mentions (docs/designs/hangul-mention-boundaries.md).
 */
const HANGUL_NAME_TITLES = '씨 님 오빠 언니 누나 선배 후배 선생님 선생 교수 대표 사장 회장 팀장 부장 과장 이사 의원 기자 작가 감독 측';
const HANGUL_NAME_PARTICLES = '이 가 은 는 을 를 의 에 에게 에게서 한테 한테서 께 께서 와 과 랑 이랑 도 만 로 으로 로서 으로서 로부터 으로부터 에서 부터 까지 처럼 보다 마저 조차 뿐 밖에 이나 이든 이라도 라도 이여 이며 이고 이다 입니다 이에요 예요 이었다 였다 이었던 였던 이라는 라는 이라고 라고 이란 이야 야 아';
const hangulAlternation = (words: string) => `(?:${words.split(' ').sort((a, b) => b.length - a.length).join('|')})`;
const HANGUL_NAME_SUFFIX_RE = new RegExp(
  `^${hangulAlternation(HANGUL_NAME_TITLES)}?${hangulAlternation(HANGUL_NAME_PARTICLES)}{0,2}(?![가-힣])`, 'u',
);

/** Korean uses word spaces; Han/Kana retain character-substring matching.
 * Validate each candidate before maximal-munch selection so an invalid longer
 * phrase does not consume a valid shorter name. The name must start a word and
 * end at a non-Hangul character or an attached name suffix (above).
 */
function hasHangulMatchBoundary(
  text: string, tokens: ScannedToken[], start: number, entry: GazetteerEntry,
): boolean {
  if (!entry.tokens.every(t => /^[가-힣]+$/u.test(t))) return true;
  const first = tokens[start]!;
  if (first.offset > 0 && /[가-힣]/u.test(text[first.offset - 1]!)) return false;
  const last = tokens[start + entry.tokens.length - 1]!;
  const end = last.offset + last.length;
  const actual = text.slice(first.offset, end).replace(/\s+/gu, ' ');
  const expected = (entry.matchText ?? entry.tokens.join('')).trim().replace(/\s+/gu, ' ');
  return actual === expected && HANGUL_NAME_SUFFIX_RE.test(text.slice(end, end + 12));
}

/**
 * Scan body text for mentions of gazetteer entities. Pure function — no
 * IO. Returns `Mention[]` ordered by offset, deduped per
 * `(fromSourceId, fromSlug → entry.source_id, entry.slug)` pair
 * (first-mention-only cap).
 *
 * Matcher is maximal-munch: at each token offset, the longest gazetteer
 * entry that matches the body-token sequence wins. Single-word entries
 * are length-1 maximal matches.
 *
 * Guards (deterministic):
 *  - D13 self-link: skip when BOTH `source_id` and `slug` match the
 *    scanning page. Slug uniqueness is `(source_id, slug)`, so once the
 *    cross-source guard is lifted a foreign namesake is a real target.
 *  - Cross-source: skip when `fromSourceId !== entry.source_id` UNLESS
 *    `opts.allowCrossSource` (the `link_resolution.cross_source` opt-in —
 *    the same switch wikilink resolution honours). A same-name entity in
 *    the scanning page's OWN source always outranks a cross-source twin,
 *    whichever way the switch is set (bucket order is length-only, so the
 *    first maximal match may be the foreign twin).
 *  - First-mention-only cap: dedup by `(entry.source_id, entry.slug)` (one
 *    link per target page regardless of how many body mentions there are).
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
  const ignored = new Set((opts.ignoreNames ?? []).map(n => tokenizeTitle(n).join(' ')).filter(Boolean));
  // A case-sensitive entry matches only the original-case body text.
  const caseMatches = (entry: GazetteerEntry, at: number) => !entry.caseTokens || entry.caseTokens.every((t, k) => {
    const tok = tokens[at + k]!;
    return stripped.slice(tok.offset, tok.offset + tok.length).normalize('NFC') === t;
  });

  const out: Mention[] = [];
  const seenTargets = new Set<string>();
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
      if (i + entry.tokens.length > tokens.length) continue;
      if (!hasHangulMatchBoundary(stripped, tokens, i, entry)) continue;
      if (!caseMatches(entry, i)) continue;
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

    // Same-name twin in the scanning page's own source wins over a foreign
    // one: bucket order is length-only, so `matched` may be the cross-source
    // twin even when an own-source entry with identical tokens exists.
    if (matched.source_id !== opts.fromSourceId) {
      const want = matched.tokens;
      const own = bucket.find(
        e => e.source_id === opts.fromSourceId
          && e.tokens.length === want.length
          && e.tokens.every((t, k) => t === want[k])
          && caseMatches(e, i)
          && hasHangulMatchBoundary(stripped, tokens, i, e),
      );
      if (own) matched = own;
    }
    if (ignored.size > 0 && ignored.has(matched.tokens.join(' '))) {
      i += matchedTokens;
      continue;
    }

    // Guards.
    if (matched.source_id === opts.fromSourceId && matched.slug === opts.fromSlug) {
      i += matchedTokens;
      continue;
    }
    if (!opts.allowCrossSource && matched.source_id !== opts.fromSourceId) {
      i += matchedTokens;
      continue;
    }
    const target = `${matched.source_id}\0${matched.slug}`;
    if (seenTargets.has(target)) {
      i += matchedTokens;
      continue;
    }

    // A shared sibling name links every sibling, unless the scanning page is one of them.
    const want = matched.tokens;
    const group = matched.shared
      ? bucket.filter(e => e.shared && e.source_id === matched!.source_id && e.tokens.length === want.length
        && e.tokens.every((t, k) => t === want[k]) && caseMatches(e, i))
      : [matched];
    if (group.length > 1 && group.some(e => e.source_id === opts.fromSourceId && e.slug === opts.fromSlug)) {
      i += matchedTokens;
      continue;
    }
    for (const e of group) {
      const key = `${e.source_id}\0${e.slug}`;
      if (seenTargets.has(key)) continue;
      out.push({ slug: e.slug, source_id: e.source_id, name: e.title, offset: head.offset });
      seenTargets.add(key);
    }
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
  const allowCrossSource = await isCrossSourceLinksEnabled(engine);

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
            COALESCE(p.title, '') || E'\n\n' || COALESCE(p.compiled_truth, '') || E'\n\n' || COALESCE(p.timeline, '') AS body
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
        allowCrossSource,
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
