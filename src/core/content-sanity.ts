/**
 * Content-sanity assessor for the ingest narrow waist.
 *
 * Pure module — no engine I/O, no filesystem access. Consumed by:
 *   - `src/core/import-file.ts` — wires the gate into `importFromContent`
 *     so EVERY ingestion path inherits it (sync, gbrain import, put_page
 *     MCP op, gbrain capture, POST /ingest webhook via ingest_capture).
 *   - `src/commands/lint.ts` — surfaces matching content as `huge-page`
 *     + `scraper-junk` lint rules so brain-authors see issues in their
 *     source repo before sync.
 *   - `src/commands/doctor.ts` — surfaces historical inventory via
 *     `oversized_pages`, `scraper_junk_pages`, and
 *     `content_sanity_audit_recent` checks.
 *   - `src/commands/sources.ts` `audit` subcommand — dry-run scan of a
 *     source repo's `local_path` reporting would-blocks + size
 *     distribution without touching the DB.
 *
 * Two failure modes treated differently (D14-D16 + D6-D9 review trail):
 *   - **Scraper junk** (built-in pattern OR operator literal match) →
 *     HARD-BLOCK. Caller is expected to `throw new ContentSanityBlockError(...)`.
 *     Existing exception-handling at every wrapper site (import.ts/cli.ts,
 *     operations.ts put_page, sync.ts:929 catch) fires correctly through
 *     this single throw point. No new status vocabulary required.
 *   - **Oversize alone** (bytes > block_bytes WITHOUT junk-pattern match) →
 *     SOFT-BLOCK. Caller writes the page with `frontmatter.embed_skip` set
 *     via `buildEmbedSkipMarker` from `src/core/embed-skip.ts`. The embedder
 *     skips on next sweep at all 5 wiring sites. Page lands so legitimate
 *     large content (2MB conversation transcripts) is preserved.
 *
 * Bytes are measured against `compiled_truth + timeline` (the parsed body
 * after `parseMarkdown` splits at the timeline sentinel). Frontmatter is
 * NOT counted — the operational concern is the embed-pipeline-input size.
 * Codex r2 #7 caught the earlier compiled_truth-only design that missed
 * pages with huge timeline sections.
 *
 * Pattern set is hand-vetted regex evaluated against `title` + the first
 * ~2KB of body content. 6 built-in patterns (D3 dropped a shape-based
 * `empty_body_with_source_url` rule because legitimate stub pages with
 * `source_url` frontmatter were getting flagged). Operator literals come
 * in via `extra_literals` from `src/core/content-sanity-literals.ts`
 * (literal substrings only — no regex per Codex r1 #10 ReDoS concerns).
 *
 * The kill-switch (`GBRAIN_NO_SANITY=1` / `content_sanity.disabled: true`)
 * is honored by the CALLER (import-file.ts), not by this module. The
 * assessor stays pure so unit tests don't need env mutation.
 */

/** Maximum number of body bytes scanned for pattern matches. The body
 *  is sliced to this size before regex/substring evaluation so pattern
 *  cost stays O(2KB) regardless of page size. Cloudflare/CAPTCHA junk
 *  pages have their telltale text at the top — 2KB covers the realistic
 *  cases. Operators who need deeper scanning can override via env. */
export const SCAN_HEAD_BYTES = 2048;

/** Default warn threshold. Operator override via
 *  `content_sanity.bytes_warn` config key or `GBRAIN_PAGE_WARN_BYTES`
 *  env var. Above this, lint surfaces `huge-page` rule + ingest emits
 *  stderr warn. Page still writes. */
export const DEFAULT_BYTES_WARN = 50_000;

/** Default block threshold. Operator override via
 *  `content_sanity.bytes_block` config key or `GBRAIN_PAGE_BLOCK_BYTES`
 *  env var. Above this, page writes but `frontmatter.embed_skip` is set
 *  and the embedder skips on next sweep. Page is still queryable; just
 *  not searchable until manually re-embedded or split. */
export const DEFAULT_BYTES_BLOCK = 500_000;

/** Default max markup ratio. When the prose pass runs (warn-tier window,
 *  `prose_check_enabled`, non-code page) and `markup_ratio` exceeds this,
 *  the page is FLAGGED (`content_flag: markup_heavy`) — it stays fully
 *  searchable, the agent just gets a "looks like boilerplate" warning.
 *  Conservative on purpose: a false positive costs a one-line note, not a
 *  vanished page. Operator override via `content_sanity.max_markup_ratio`
 *  or `GBRAIN_MAX_MARKUP_RATIO`. */
export const DEFAULT_MAX_MARKUP_RATIO = 0.85;

/** Tag added to the start of `reasons` and to error messages so
 *  `src/core/sync.ts:classifyErrorCode` can group hard-blocks under one
 *  code without needing a structured field in the failure shape. The
 *  classifier matches this token via regex. */
export const PAGE_JUNK_PATTERN_CODE = 'PAGE_JUNK_PATTERN';

export type SanityTripReason =
  | 'oversize_warn'      // informational: bytes > bytes_warn but page lands normally
  | 'oversize_block'     // soft-block + flag: write with frontmatter.embed_skip + content_flag
  | 'high_markup'        // flag: write normally + content_flag (markup_heavy); stays searchable
  | 'junk_pattern'       // quarantine (or reject): high-confidence junk
  | 'literal_substring'; // quarantine (or reject): operator-supplied literal hit

export interface JunkPattern {
  /** Stable identifier surfaced in error messages, audit JSONL, and
   *  doctor output. Snake_case. Treat as a stable contract — renaming
   *  one means rewriting downstream consumers. */
  name: string;
  /** Case-insensitive regex. Evaluated against the chosen scope; cost
   *  is bounded by SCAN_HEAD_BYTES. */
  pattern: RegExp;
  /** Where the pattern applies. Defaults to 'both' (title AND body
   *  head-slice). 'title' is useful for error-page-title detection;
   *  'body' for content-shape patterns. */
  applies_to?: 'body' | 'title' | 'both';
}

export interface OperatorLiteral {
  name: string;
  /** Literal substring. Case-insensitive match via `.toLowerCase()`.
   *  Regex meta-characters in the substring are matched literally. */
  substring: string;
  applies_to?: 'body' | 'title' | 'both';
}

export interface ContentSanityResult {
  /** UTF-8 byte length of `compiled_truth + timeline`. Frontmatter is
   *  NOT included (the operational concern is embed-pipeline input). */
  bytes: number;
  /** True when bytes > effective bytes_block. Drives soft-block. */
  oversize: boolean;
  /** Names of built-in patterns that matched (zero or more). */
  junk_pattern_matches: string[];
  /** Names of operator literals that matched (zero or more). */
  literal_substring_matches: string[];
  /** Prose character count after markup stripping. Only computed when the
   *  prose pass ran (warn-tier window, prose_check_enabled, non-code page);
   *  `null` otherwise. Reported for audit/doctor visibility — NOT a trigger
   *  on its own (low-prose alone never quarantines or flags). */
  prose_chars: number | null;
  /** Markup:total ratio in [0, 1]. `null` when the prose pass didn't run.
   *  Drives `high_markup` when it exceeds the effective `max_markup_ratio`. */
  markup_ratio: number | null;
  /** Ordered list of trip reasons. `oversize` first when present, then
   *  `high_markup`, then `junk_pattern`, then `literal_substring`. Stable
   *  across releases so consumers can pattern-match. */
  reasons: SanityTripReason[];
  /** Human-readable messages per reason. Each prefixed with the stable
   *  code token (`PAGE_JUNK_PATTERN:` or `PAGE_OVERSIZED:`) so the
   *  caller can compose them into an error message that `classifyErrorCode`
   *  picks up via regex. */
  reason_messages: string[];
  /** True when high-confidence junk fired (built-in pattern OR operator
   *  literal). The caller chooses quarantine (hide) vs reject (throw) via
   *  `junk_disposition`. Does NOT fire on `high_markup` (that's a flag, not
   *  a hide) or on oversize alone (that's a soft-block). */
  shouldQuarantine: boolean;
  /** Back-compat alias for `shouldQuarantine`. The 5 pre-v0.42 consumers
   *  read `shouldHardBlock`; keep it identical so they compile unchanged. */
  shouldHardBlock: boolean;
  /** True for the fuzzy/oversize "warn the agent, keep it usable" tier:
   *  `high_markup` (page stays searchable) OR oversize-soft-block. NOT set
   *  when `shouldQuarantine` (quarantine hides the page; a flag would be
   *  invisible). `flag_reason` names which. */
  shouldFlag: boolean;
  /** Which flag tier fired: `markup_heavy` (in-window markup-ratio) or
   *  `oversized` (> bytes_block). `null` when `shouldFlag` is false. The
   *  two are mutually exclusive (the prose pass only runs below block). */
  flag_reason: 'markup_heavy' | 'oversized' | null;
  /** True when oversize without quarantine. Caller writes the page with
   *  `frontmatter.embed_skip` set so the embedder skips. */
  shouldSkipEmbed: boolean;
}

/** Built-in pattern set. Hand-vetted regex compiled once at module
 *  load. Adding a pattern: include a stable `name`, a case-insensitive
 *  regex with `i` flag, and document the real-world example in plain
 *  prose so future reviewers know what shape it catches. */
export const BUILT_IN_JUNK_PATTERNS: ReadonlyArray<JunkPattern> = Object.freeze([
  // Cloudflare interstitials — the dominant scraper-junk class.
  {
    name: 'cloudflare_attention_required',
    pattern: /attention required.*cloudflare/i,
    applies_to: 'both',
  },
  {
    name: 'cloudflare_just_a_moment',
    // Both signals required — "just a moment..." alone fires on
    // legitimate writing; the cdn-cgi/challenge URL is the discriminator.
    pattern: /just a moment\.\.\.[\s\S]{0,500}cdn-cgi\/challenge-platform/i,
    applies_to: 'body',
  },
  {
    name: 'cloudflare_ray_id',
    pattern: /cloudflare ray id:/i,
    applies_to: 'body',
  },
  // Interstitial "checking your browser" / JS-challenge gates. These are
  // the exact shapes that motivated issue #1699 — a Cloudflare browser
  // check ingested as if it were the article. Title OR body so we catch
  // both the bare-title scrape and the full interstitial dump.
  {
    name: 'cloudflare_checking_browser',
    pattern: /checking your browser before/i,
    applies_to: 'both',
  },
  {
    name: 'cf_browser_verification',
    pattern: /cf[-_]browser[-_]verification/i,
    applies_to: 'both',
  },
  {
    name: 'enable_javascript_cookies',
    pattern: /enable javascript and cookies to continue/i,
    applies_to: 'both',
  },
  // Generic 403 / blocked-access pages.
  {
    name: 'access_denied',
    pattern: /^\s*access denied\b/im,
    applies_to: 'both',
  },
  // CAPTCHA gates.
  {
    name: 'captcha_required',
    pattern: /verify you are (a )?human|captcha required|please complete the security check/i,
    applies_to: 'both',
  },
  // Bare error-page titles. Anchored so the title is exclusively the
  // error phrase — a thoughtful page ABOUT 404 errors or one titled
  // "How to Handle Access Denied Errors" won't trip.
  //
  // v0.41.13 (supersedes PR #1561): expanded from bare numeric codes
  // + "page not found" to also catch Cloudflare/WAF challenge
  // titles ("Forbidden", "Access Denied", "Service Unavailable",
  // "Robot Check", "Verify You Are Human"). Deliberately drops PR
  // #1561's bare-`error` matcher (would false-positive on
  // legitimate taxonomy pages titled "Error"). 232+ scraper pages
  // motivating this change (202+ from straylight-brain).
  {
    name: 'error_page_title',
    pattern: /^(403|404|500|502|503|error \d{3}|page not found|forbidden|access denied|service unavailable|robot check|verify you are human)\s*$/i,
    applies_to: 'title',
  },
  // Cloudflare challenge title (companion to the body-scoped
  // `cloudflare_just_a_moment` pattern above, which requires both
  // phrase + URL). The title alone is a sufficient signal because
  // legitimate pages don't title themselves "Just a moment...".
  //
  // v0.41.13: distinct name from `error_page_title` so audit JSONL
  // (`~/.gbrain/audit/content-sanity-YYYY-Www.jsonl`) and doctor's
  // `content_sanity_audit_recent` aggregation stay diagnosable.
  // PR #1561 reused the `error_page_title` name and collapsed audit
  // signal; we don't.
  {
    name: 'cloudflare_challenge_title',
    pattern: /^just a moment\.{0,3}$/i,
    applies_to: 'title',
  },
]);

/** Tagged error thrown from `importFromContent` on hard-block. The
 *  existing exception-handling at every wrapper site catches it and
 *  surfaces a non-zero exit (import), MCP error envelope (put_page),
 *  or sync-failure record. Message embeds `PAGE_JUNK_PATTERN:` so
 *  `classifyErrorCode` picks it up via regex without needing a
 *  structured `error_code` field on `ImportResult`. */
export class ContentSanityBlockError extends Error {
  readonly code = PAGE_JUNK_PATTERN_CODE;
  readonly result: ContentSanityResult;

  constructor(result: ContentSanityResult) {
    // Compose message from the result's reason messages. The
    // `PAGE_JUNK_PATTERN:` prefix is already in each reason_message
    // so the classifier regex hits regardless of which reasons fired.
    const summary = result.reason_messages.join('; ');
    super(`Content rejected by sanity gate: ${summary}`);
    this.name = 'ContentSanityBlockError';
    this.result = result;
  }
}

/** Result of the prose-vs-markup pass. `markup_ratio` is the fraction of
 *  the body (with code excluded from BOTH numerator and denominator) that
 *  is markup syntax rather than prose. High ratio = nav/boilerplate shape. */
export interface ProseAssessment {
  prose_chars: number;
  total_chars: number;
  markup_ratio: number;
}

// Pattern set for `assessProse`. Code (fenced + inline) is stripped FIRST
// and excluded from the denominator entirely (Codex #2 — a code-heavy doc
// must not read as high-markup). The remaining strips count toward markup.
const FENCED_CODE_RE = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const HTML_TAG_RE = /<\/?[a-z][^>]*>/gi;
const MD_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
// Keep anchor text, drop the URL: [text](url) -> text
const MD_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
// Line-leading structural markers: headings, list bullets, blockquotes,
// table pipes/separators, hr rules, emphasis runs.
const MD_STRUCT_RE = /^[ \t]*(#{1,6}\s|[-*+]\s|>\s|\|.*\||[-=]{3,}\s*$|\d+\.\s)/gm;
const MD_EMPHASIS_RE = /[*_~]{1,3}/g;
const TABLE_PIPE_RE = /\|/g;

/**
 * Pure prose-vs-markup assessment. Strips code (excluded from the ratio),
 * then measures how much of the REMAINING content is markup syntax vs real
 * sentences. Returns a ratio in [0, 1]; high = boilerplate/nav shape.
 *
 * Deliberately conservative + cheap. NOT a parser — a heuristic. The whole
 * point is to FLAG (warn the agent), not to hide, so precision matters less
 * than catching the obvious nav-blob shape without nuking legit prose.
 */
export function assessProse(body: string): ProseAssessment {
  // Code excluded from the denominator (Codex #2): a code doc isn't junk.
  const noCode = body.replace(FENCED_CODE_RE, ' ').replace(INLINE_CODE_RE, ' ');
  const total_chars = noCode.replace(/\s+/g, '').length;
  if (total_chars === 0) {
    return { prose_chars: 0, total_chars: 0, markup_ratio: 0 };
  }
  // Strip markup constructs to leave (approximately) prose. Order matters:
  // images before links (image syntax is a superset), links before emphasis.
  const prose = noCode
    .replace(MD_IMAGE_RE, ' ')
    .replace(MD_LINK_RE, '$1')
    .replace(HTML_TAG_RE, ' ')
    .replace(MD_STRUCT_RE, ' ')
    .replace(TABLE_PIPE_RE, ' ')
    .replace(MD_EMPHASIS_RE, ' ');
  const prose_chars = prose.replace(/\s+/g, '').length;
  // Clamp: stripping can never produce MORE chars than the denominator, but
  // guard against pathological inputs so the ratio stays in [0, 1].
  const ratio = Math.min(1, Math.max(0, (total_chars - prose_chars) / total_chars));
  return { prose_chars, total_chars, markup_ratio: ratio };
}

/**
 * Assess a parsed page against the size + junk-pattern + prose surface.
 *
 * Pure function — same inputs always produce the same outputs. Caller
 * decides disposition (quarantine/reject on shouldQuarantine, content_flag
 * on shouldFlag, embed_skip on shouldSkipEmbed, write normally otherwise).
 * Disposition precedence is the CALLER's job: quarantine > flag.
 *
 * The body bytes input is `compiled_truth + timeline` (Codex r2 #7
 * fix: pages can have huge timeline sections that would evade a
 * compiled_truth-only check). Frontmatter is NOT counted.
 */
export function assessContentSanity(opts: {
  /** Post-parseMarkdown body (before timeline split). */
  compiled_truth: string;
  /** Post-parseMarkdown timeline section (empty string if no sentinel). */
  timeline: string;
  /** Post-parseMarkdown title. Some patterns key on title alone. */
  title: string;
  /** Effective warn threshold; defaults to DEFAULT_BYTES_WARN. */
  bytes_warn?: number;
  /** Effective block threshold; defaults to DEFAULT_BYTES_BLOCK. */
  bytes_block?: number;
  /** Effective max markup ratio; defaults to DEFAULT_MAX_MARKUP_RATIO. */
  max_markup_ratio?: number;
  /** Master switch for the prose/markup pass. Default true (caller may
   *  pass the resolved `content_sanity.prose_check_enabled`). */
  prose_check_enabled?: boolean;
  /** Page kind. `'code'` is exempt from the prose pass (Codex #2 — code
   *  pages legitimately read as high-markup). */
  page_kind?: string;
  /** Operator-supplied literal substrings loaded from
   *  `~/.gbrain/junk-substrings.txt` via `src/core/content-sanity-literals.ts`.
   *  Empty array (default) means built-ins only. */
  extra_literals?: ReadonlyArray<OperatorLiteral>;
}): ContentSanityResult {
  const bytes_warn = opts.bytes_warn ?? DEFAULT_BYTES_WARN;
  const bytes_block = opts.bytes_block ?? DEFAULT_BYTES_BLOCK;
  const max_markup_ratio = opts.max_markup_ratio ?? DEFAULT_MAX_MARKUP_RATIO;
  const prose_check_enabled = opts.prose_check_enabled !== false;

  // Bytes measured against the parsed body (compiled_truth + timeline).
  // Buffer.byteLength counts UTF-8 bytes the same way the doctor's
  // octet_length() does at the DB layer, so the two surfaces agree on
  // the same page (D2 parity).
  const body = opts.compiled_truth + (opts.timeline ? '\n' + opts.timeline : '');
  const bytes = Buffer.byteLength(body, 'utf-8');
  const oversize = bytes > bytes_block;

  // Head-slice for pattern evaluation. Cost stays O(SCAN_HEAD_BYTES)
  // regardless of body size. Lowercased once so substring matching
  // doesn't repeat the lowercase per literal.
  const bodyHead = body.slice(0, SCAN_HEAD_BYTES);
  const bodyHeadLower = bodyHead.toLowerCase();
  // Defensive coercion (issue #1939): this is a pure exported fn; lint.ts and
  // import-file both pass `parsed.title`, which a malformed YAML date/number
  // title could make non-string. Never throw on a bad title.
  const title = String(opts.title ?? '');
  const titleLower = title.toLowerCase();

  const junk_pattern_matches: string[] = [];
  for (const p of BUILT_IN_JUNK_PATTERNS) {
    const scope = p.applies_to ?? 'both';
    let matched = false;
    if (scope === 'title' || scope === 'both') {
      if (p.pattern.test(title)) matched = true;
    }
    if (!matched && (scope === 'body' || scope === 'both')) {
      if (p.pattern.test(bodyHead)) matched = true;
    }
    if (matched) junk_pattern_matches.push(p.name);
  }

  const literal_substring_matches: string[] = [];
  if (opts.extra_literals && opts.extra_literals.length > 0) {
    for (const lit of opts.extra_literals) {
      const scope = lit.applies_to ?? 'both';
      const needle = lit.substring.toLowerCase();
      if (needle.length === 0) continue;
      let matched = false;
      if (scope === 'title' || scope === 'both') {
        if (titleLower.includes(needle)) matched = true;
      }
      if (!matched && (scope === 'body' || scope === 'both')) {
        if (bodyHeadLower.includes(needle)) matched = true;
      }
      if (matched) literal_substring_matches.push(lit.name);
    }
  }

  // Prose/markup pass — ONLY in the warn-tier window (bytes_warn < bytes
  // <= bytes_block), only when enabled, only for non-code pages. Tiny legit
  // pages (stubs, atoms, daily notes) never enter it, so they can't be
  // flagged on low prose; the O(n) markup-strip cost is paid only on
  // already-suspicious medium pages; oversize pages are handled by the
  // soft-block path so the prose pass would be redundant there.
  let prose_chars: number | null = null;
  let markup_ratio: number | null = null;
  let high_markup = false;
  const inProseWindow = bytes > bytes_warn && bytes <= bytes_block;
  if (prose_check_enabled && inProseWindow && opts.page_kind !== 'code') {
    const prose = assessProse(body);
    prose_chars = prose.prose_chars;
    markup_ratio = prose.markup_ratio;
    high_markup = markup_ratio > max_markup_ratio;
  }

  const reasons: SanityTripReason[] = [];
  const reason_messages: string[] = [];
  // High-confidence junk → quarantine (hide) or reject. The fuzzy markup
  // signal does NOT contribute here (Q1=A — it flags, it doesn't hide).
  const shouldQuarantine =
    junk_pattern_matches.length > 0 || literal_substring_matches.length > 0;
  // Oversize-without-quarantine → soft-block (don't embed). When BOTH
  // oversize and junk fire (the 890K Cloudflare dump), quarantine wins.
  const shouldSkipEmbed = oversize && !shouldQuarantine;
  // Flag (warn the agent, keep usable) for the fuzzy/oversize tier — but
  // NOT when quarantining (a hidden page's flag is invisible). markup_heavy
  // and oversized are mutually exclusive (prose pass only runs below block).
  const shouldFlag = !shouldQuarantine && (high_markup || shouldSkipEmbed);
  const flag_reason: 'markup_heavy' | 'oversized' | null = !shouldFlag
    ? null
    : high_markup
      ? 'markup_heavy'
      : 'oversized';

  // Reason ordering: block-level oversize first (so a soft-block that
  // ALSO hits a junk pattern documents both), then high_markup, then
  // junk_pattern, then literal. Warn-level oversize emitted only when no
  // block-level fired.
  if (oversize) {
    reasons.push('oversize_block');
    reason_messages.push(`PAGE_OVERSIZED: body ${bytes} bytes exceeds ${bytes_block} byte block threshold`);
  } else if (bytes > bytes_warn) {
    // Warn tier: bytes between bytes_warn and bytes_block. Page lands
    // normally; consumer emits stderr and (when configured) lint surfaces
    // `huge-page` rule. This row IS auditable so doctor's recent-events
    // check can surface flow-rate signal ("operators crossing warn often").
    reasons.push('oversize_warn');
    reason_messages.push(`PAGE_OVERSIZE_WARN: body ${bytes} bytes exceeds ${bytes_warn} byte warn threshold`);
  }
  if (high_markup) {
    reasons.push('high_markup');
    reason_messages.push(
      `PAGE_MARKUP_HEAVY: markup ratio ${markup_ratio!.toFixed(2)} exceeds ${max_markup_ratio} (flag, not hide)`,
    );
  }
  if (junk_pattern_matches.length > 0) {
    reasons.push('junk_pattern');
    reason_messages.push(
      `${PAGE_JUNK_PATTERN_CODE}: matched built-in pattern(s): ${junk_pattern_matches.join(', ')}`,
    );
  }
  if (literal_substring_matches.length > 0) {
    reasons.push('literal_substring');
    reason_messages.push(
      `${PAGE_JUNK_PATTERN_CODE}: matched operator literal(s): ${literal_substring_matches.join(', ')}`,
    );
  }

  return {
    bytes,
    oversize,
    junk_pattern_matches,
    literal_substring_matches,
    prose_chars,
    markup_ratio,
    reasons,
    reason_messages,
    shouldQuarantine,
    // Back-compat alias: the 5 pre-v0.42 consumers read shouldHardBlock.
    shouldHardBlock: shouldQuarantine,
    shouldFlag,
    flag_reason,
    shouldSkipEmbed,
  };
}
