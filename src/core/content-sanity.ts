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

/** Tag added to the start of `reasons` and to error messages so
 *  `src/core/sync.ts:classifyErrorCode` can group hard-blocks under one
 *  code without needing a structured field in the failure shape. The
 *  classifier matches this token via regex. */
export const PAGE_JUNK_PATTERN_CODE = 'PAGE_JUNK_PATTERN';

export type SanityTripReason =
  | 'oversize_warn'      // informational: bytes > bytes_warn but page lands normally
  | 'oversize_block'     // soft-block: write with frontmatter.embed_skip
  | 'junk_pattern'       // hard-block: throw ContentSanityBlockError
  | 'literal_substring'; // hard-block: operator-supplied literal hit

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
  /** Ordered list of trip reasons. `oversize` first when present,
   *  then `junk_pattern`, then `literal_substring`. Stable across
   *  releases so consumers can pattern-match. */
  reasons: SanityTripReason[];
  /** Human-readable messages per reason. Each prefixed with the stable
   *  code token (`PAGE_JUNK_PATTERN:` or `PAGE_OVERSIZED:`) so the
   *  caller can compose them into an error message that `classifyErrorCode`
   *  picks up via regex. */
  reason_messages: string[];
  /** True when any junk pattern or operator literal matched. Caller
   *  should throw `ContentSanityBlockError` when this is set. Note that
   *  oversize alone does NOT trigger this — that's a soft-block. */
  shouldHardBlock: boolean;
  /** True when oversize without hard-block. Caller should write the
   *  page with `frontmatter.embed_skip` set so the embedder skips. */
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
  // error code — a thoughtful page ABOUT 404 errors won't trip.
  {
    name: 'error_page_title',
    pattern: /^(403|404|500|502|503|error \d{3}|page not found)\s*$/i,
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

/**
 * Assess a parsed page against the size + junk-pattern surface.
 *
 * Pure function — same inputs always produce the same outputs. Caller
 * decides what to do with the result (throw on shouldHardBlock, set
 * embed_skip frontmatter on shouldSkipEmbed, write normally otherwise).
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
  /** Operator-supplied literal substrings loaded from
   *  `~/.gbrain/junk-substrings.txt` via `src/core/content-sanity-literals.ts`.
   *  Empty array (default) means built-ins only. */
  extra_literals?: ReadonlyArray<OperatorLiteral>;
}): ContentSanityResult {
  const bytes_warn = opts.bytes_warn ?? DEFAULT_BYTES_WARN;
  const bytes_block = opts.bytes_block ?? DEFAULT_BYTES_BLOCK;

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
  const titleLower = opts.title.toLowerCase();

  const junk_pattern_matches: string[] = [];
  for (const p of BUILT_IN_JUNK_PATTERNS) {
    const scope = p.applies_to ?? 'both';
    let matched = false;
    if (scope === 'title' || scope === 'both') {
      if (p.pattern.test(opts.title)) matched = true;
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

  const reasons: SanityTripReason[] = [];
  const reason_messages: string[] = [];
  const shouldHardBlock =
    junk_pattern_matches.length > 0 || literal_substring_matches.length > 0;

  // Reason ordering: block-level oversize first (so a soft-block that
  // ALSO hits a junk pattern documents both), then junk_pattern, then
  // literal. Warn-level oversize emitted only when no block-level fired.
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
    reasons,
    reason_messages,
    // shouldSkipEmbed: oversize past block threshold but NOT also hard-block.
    // When BOTH fire (the 890K Cloudflare dump case), hard-block wins and
    // the page never lands. Embed-skip is reserved for the legitimate
    // large-content case.
    shouldHardBlock,
    shouldSkipEmbed: oversize && !shouldHardBlock,
  };
}
