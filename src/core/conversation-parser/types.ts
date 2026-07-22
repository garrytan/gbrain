/**
 * v0.41.16.0 — Conversation parser type surface.
 *
 * The orchestrator's contract surface. Built-in patterns + user-
 * declared simple_patterns + LLM polish + LLM fallback all flow
 * through the same `ParseResult`.
 *
 * Per D4: parser uses `ParsePhase` (per-page axis). The progressive-
 * batch primitive uses `Stage` (corpus-rollout axis). Different
 * concepts, different audit JSONLs, no cross-pollution.
 *
 * Per D7: every PatternEntry carries `test_positive[]` + `test_negative[]`
 * so module-load validation runs at startup.
 *
 * Per D9: PatternEntry.speaker_clean is optional; orchestrator falls
 * back to `DEFAULT_SPEAKER_CLEAN`.
 *
 * Per D5: every PatternEntry has explicit `multi_line` flag.
 *
 * Per D11: every PatternEntry has optional `quick_reject` for O(1)
 * prefix screening.
 *
 * Per D19: every PatternEntry declares `timezone_policy`.
 *
 * Per D16: arbitrary user regex is OUT. v1 only supports user-declared
 * `simple_pattern` (a structured spec compiled by gbrain to a known-
 * safe regex). The simple_pattern shape lives in `simple-pattern.ts`.
 */

import type { Page } from '../types.ts';

/**
 * Parsed message after orchestrator runs. Matches the existing
 * `ConversationMessage` shape from extract-conversation-facts.ts so
 * downstream callers don't need adapter code.
 */
export interface MatchedMessage {
  speaker: string;
  /** ISO 8601 timestamp. May be `1970-01-01T00:00:00Z` for time-only
   *  formats when no frontmatter date is available. */
  timestamp: string;
  text: string;
}

/**
 * Which per-page phase produced the result.
 *   - 'regex_match': a built-in or user simple_pattern matched.
 *   - 'polish': LLM polished a regex-matched output.
 *   - 'llm_fallback': all regex paths returned 0 messages; LLM
 *     fallback was called and returned this output.
 *   - 'no_match': nothing parsed; returned [] of messages.
 */
export type ParsePhase = 'regex_match' | 'polish' | 'llm_fallback' | 'no_match';

/**
 * Verdict from the orchestrator. Surfaced in audit JSONL and the
 * `gbrain conversation-parser scan` debug command.
 */
export interface ParseResult {
  messages: MatchedMessage[];
  /** Which phase produced the final messages. */
  phase: ParsePhase;
  /** When phase=regex_match or polish: which pattern won. */
  matched_pattern_id?: string;
  /** Number of patterns scored before the winner emerged (D18). */
  patterns_scored?: number;
  /** When polish ran: how many messages were merged/dropped/edited. */
  polish_delta?: {
    merged: number;
    dropped: number;
    edits: number;
  };
  /** When llm_fallback ran: model id used. */
  llm_fallback_model?: string;
  /** Per-line diagnostics for debug command — only populated when
   *  caller sets `opts.diagnostic = true`. */
  unmatched_line_count?: number;
  /** Once-per-page warn from timezone_policy = utc_assumed_with_warn
   *  patterns when no frontmatter timezone is set. */
  timezone_warning?: string;
}

/**
 * Source of date for time-only formats. Per D8: orchestrator owns
 * the derivation chain — caller passes the Page, orchestrator
 * extracts `frontmatter.date` slice OR `effective_date` OR explicit
 * fallback OR '1970-01-01'.
 */
export type DateSource = 'inline' | 'frontmatter' | 'combined';

/** Time-format flavor a pattern's regex emits. */
export type TimeFormat = '12h_ampm' | '24h' | 'unix' | 'rfc2822';

/**
 * Per D19: how a pattern handles timezone. The orchestrator uses this
 * to decide whether to attach a `timezone_warning` to the ParseResult
 * AND how to construct the ISO timestamp.
 */
export type TimezonePolicy =
  | 'inline_utc'             // Existing: regex captures full ISO/UTC; trust it.
  | 'frontmatter_tz'         // Caller's frontmatter MUST have `timezone:`; refuse otherwise.
  | 'utc_assumed_with_warn'; // Default UTC; emit once-per-page warn if no frontmatter timezone.

/**
 * Capture-group index map. Each pattern declares where its captures
 * land in the regex's match array (1-indexed per JS conventions).
 *
 * Speaker is always required. Other fields depend on the pattern's
 * shape:
 *   - inline-date patterns set `date_group`, `hour_group`, `minute_group`.
 *   - time-only patterns omit `date_group` (derived from frontmatter).
 *   - 12h patterns also set `ampm_group`.
 *   - rfc2822 patterns set `date_group` only; orchestrator passes the
 *     captured string to Date.parse().
 */
export interface CaptureMap {
  speaker_group: number;
  text_group: number;
  date_group?: number;
  hour_group?: number;
  minute_group?: number;
  ampm_group?: number;
}

/**
 * A built-in pattern OR a user-declared pattern (after `simple_pattern`
 * compilation).
 *
 * Built-ins MUST carry `test_positive` + `test_negative`; module-load
 * validation runs them via `validatePatternEntry` (D7).
 *
 * User patterns from simple_pattern compilation only need test_positive
 * if the user supplies sample lines.
 */
export interface PatternEntry {
  /** Stable kebab-case id. Examples: 'imessage-slack', 'telegram-bracket'. */
  id: string;
  /** Built-in vs user-declared (simple_pattern compiled). */
  origin: 'builtin' | 'user_simple';
  /**
   * The line-matching regex. Built-ins are hand-vetted (no ReDoS risk).
   * User patterns are compiled from `simple_pattern` spec to a known-
   * safe regex shape.
   */
  regex: RegExp;
  /** Capture-group index map. */
  captures: CaptureMap;
  /** Inline-date vs frontmatter-date vs combined. */
  date_source: DateSource;
  /** 12h vs 24h vs unix vs rfc2822. */
  time_format: TimeFormat;
  /** D19: timezone handling for time-only formats. */
  timezone_policy: TimezonePolicy;
  /**
   * D5: when true, the regex matches the FIRST line of a multi-line
   * message; the orchestrator absorbs subsequent lines into
   * `MatchedMessage.text` until the next anchor.
   * When false (default), the regex matches a complete one-line
   * message; continuation logic still applies for orphan lines.
   */
  multi_line: boolean;
  /**
   * D11: optional cheap O(1) prefix check. If set, orchestrator runs
   * this FIRST per line; only tries `regex` if quick_reject matches.
   * Examples: `/^\*\*\[/` for telegram-bracket.
   */
  quick_reject?: RegExp;
  /**
   * D9: optional speaker post-processing. When unset, orchestrator
   * uses `DEFAULT_SPEAKER_CLEAN`.
   */
  speaker_clean?: RegExp;
  /**
   * v0.41.29.0: when true, the orchestrator recomputes this pattern's
   * acceptance score over the FULL body (not just the head window)
   * before applying SCORING_MIN_ACCEPTANCE. Set on broad no-time
   * patterns (`bold-name-no-time`) whose regex matches a common prose
   * idiom (`**Label:** text`): without it, a notes page with a few bold
   * labels CLUSTERED in its first 10 lines scores 0.3 on the head pass,
   * skips the `< SCORING_HEAD_TRIGGER_THRESHOLD` rescore, and clears the
   * 0.05 floor — mis-parsing prose as a conversation. Full-body scoring
   * drops that page below the floor (3/200 ≈ 0.015 → no_match) while a
   * real transcript stays ~1.0.
   */
  score_full_body?: boolean;
  /** D7: module-load validation — known-positive sample lines. */
  test_positive: string[];
  /** D7: module-load validation — known-negative sample lines. */
  test_negative: string[];
  /** Documentation pointer for future maintainers. */
  source_doc?: string;
}

/** Caller opts for `parseConversation`. */
export interface ParseConversationOpts {
  /**
   * Per D8: the Page object. Orchestrator extracts date + timezone +
   * effective_date from frontmatter. When unset, orchestrator uses
   * `explicitFallbackDate` (next) then '1970-01-01'.
   */
  page?: Page;
  /**
   * Explicit ISO date `YYYY-MM-DD` override. Surfaces for callers
   * (eval CLI, debug command) that don't have a full Page.
   * Surfaces as `ParseConversationOpts.fallbackDate` for back-compat
   * with PR #1461's shape.
   */
  fallbackDate?: string;
  /** When true, populate `ParseResult.unmatched_line_count`. Debug only. */
  diagnostic?: boolean;
  /** When true, skip LLM polish even if config enables it. */
  noPolish?: boolean;
  /** When true, skip LLM fallback even if config enables it. */
  noFallback?: boolean;
  /** Caller-supplied patterns to add (e.g. user simple_pattern compiled). */
  userPatterns?: readonly PatternEntry[];
  /** Caller-supplied disabled-builtin id list (config or per-call). */
  disabledBuiltinIds?: readonly string[];
}

/** Resolved date + timezone for a Page, per D8 derivation chain. */
export interface DateContext {
  /** ISO YYYY-MM-DD string. */
  fallbackDate: string;
  /** IANA timezone (e.g. 'America/Los_Angeles') or undefined. */
  timezone?: string;
  /** Which step of the derivation chain won (for debug). */
  source: 'frontmatter_date' | 'effective_date' | 'explicit' | 'epoch_default';
}
