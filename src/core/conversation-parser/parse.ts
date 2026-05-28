/**
 * v0.41.16.0 — Conversation parser orchestrator.
 *
 * Drives the per-page parse pipeline:
 *
 *   1. Resolve date context from Page (D8 precedence:
 *      explicit > frontmatter.date > effective_date > 1970-01-01).
 *   2. Score candidate patterns across the first N lines (D18). Pick
 *      the highest-scoring; tie-break on declared priority order.
 *   3. Apply the winning pattern (multi-line continuations honored
 *      per D5).
 *   4. If zero matched: optionally call LLM fallback (D15 opt-IN).
 *   5. Optionally polish regex-matched output via LLM (D15 opt-IN).
 *   6. Return ParseResult with phase + matched_pattern_id + diagnostics.
 *
 * Behavior contract: PR #1461's 33 tests (27 existing + 6 telegram-
 * bracket) MUST pass against this orchestrator. The
 * `parseConversation(body, opts)` shape from the prior
 * `parseConversationMessages(body, opts)` is preserved via a thin
 * adapter in `extract-conversation-facts.ts` (T5 retrofit).
 *
 * Pure-function inner core: no I/O, no LLM calls except via the
 * polish/fallback wrappers in `llm-polish.ts` + `llm-fallback.ts`
 * (T4). Those wrappers are passed in via opts so this file stays
 * test-isolatable.
 */

import {
  BUILTIN_PATTERNS,
  cleanSpeaker,
} from './builtins.ts';
import type {
  DateContext,
  MatchedMessage,
  ParseConversationOpts,
  ParseResult,
  PatternEntry,
} from './types.ts';

export type { ParseConversationOpts, ParseResult, MatchedMessage } from './types.ts';

/**
 * How many head-of-body lines to score patterns against (D18).
 * Higher = more accurate disambiguation, more regex calls per page.
 * 10 balances both — typical chat exports have homogeneous shape so
 * 10 lines is enough to differentiate Telegram from Discord from
 * WhatsApp.
 */
const SCORING_HEAD_LINES = 10;

/**
 * Head-pass score below which `parseConversation` falls back to a
 * full-body re-score (v0.41.18+ fix for #1533 + Codex P1 #1).
 *
 * Why a threshold instead of `=== 0`: meeting pages start with
 * `## Summary` + blockquotes + `## Transcript` headings. A
 * blockquote like `> [12:00] Foo` can accidentally match an
 * unrelated pattern's regex (irc-classic at score 0.1) which would
 * suppress the fallback even when 175 of 226 lines further down are
 * valid imessage-slack. 0.3 = "fewer than 3 of 10 head lines
 * matched"; chat-only pages still score 1.0 and skip the fallback
 * entirely, so the fast path is preserved.
 */
const SCORING_HEAD_TRIGGER_THRESHOLD = 0.3;

/**
 * Minimum final winner score required to accept `regex_match`
 * (v0.41.18+ Codex P1 #2). A 500-line essay with one stray
 * `**Name** (date time):` line scores ~1/500 = 0.002 for
 * imessage-slack, which without this floor would flip to
 * `regex_match` with `messages.length = 1` — a false positive that
 * silently corrupts downstream fact extraction. 0.05 = "at least 5%
 * of non-blank lines anchored a message"; real transcript pages
 * typically score 0.5+ and sail through, accidental anchors do not.
 */
const SCORING_MIN_ACCEPTANCE = 0.05;

/**
 * Tie-breaker priority: lower index wins on score tie. Mirrors
 * BUILTIN_PATTERNS declaration order. User-declared patterns get
 * priority Infinity (lose every tie).
 */
function priorityOf(id: string): number {
  const idx = BUILTIN_PATTERNS.findIndex((p) => p.id === id);
  return idx >= 0 ? idx : Infinity;
}

/**
 * Derive the date+timezone context for a Page per D8 precedence.
 *
 *   1. opts.fallbackDate (caller's explicit ISO date)
 *   2. page.frontmatter.date — sliced to YYYY-MM-DD
 *   3. page.effective_date — sliced to YYYY-MM-DD
 *   4. '1970-01-01' epoch default
 *
 * Timezone comes from `page.frontmatter.timezone` (IANA tz like
 * `'America/Los_Angeles'`) when present; otherwise undefined.
 *
 * Exported for tests + the eval CLI's debug command.
 */
export function deriveDateContext(opts: ParseConversationOpts): DateContext {
  if (opts.fallbackDate) {
    const sliced = opts.fallbackDate.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(sliced)) {
      return {
        fallbackDate: sliced,
        timezone: extractTimezone(opts.page),
        source: 'explicit',
      };
    }
  }
  const page = opts.page;
  if (page?.frontmatter) {
    const fmDate = page.frontmatter.date;
    if (typeof fmDate === 'string') {
      const sliced = fmDate.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(sliced)) {
        return {
          fallbackDate: sliced,
          timezone: extractTimezone(page),
          source: 'frontmatter_date',
        };
      }
    }
  }
  if (page?.effective_date) {
    return {
      fallbackDate: page.effective_date.toISOString().slice(0, 10),
      timezone: extractTimezone(page),
      source: 'effective_date',
    };
  }
  return {
    fallbackDate: '1970-01-01',
    timezone: extractTimezone(page),
    source: 'epoch_default',
  };
}

function extractTimezone(page: ParseConversationOpts['page']): string | undefined {
  const tz = page?.frontmatter?.timezone;
  return typeof tz === 'string' && tz.length > 0 ? tz : undefined;
}

/**
 * Map a 12-hour pattern to 24-hour using the AM/PM marker.
 * 12 AM = 0, 12 PM = 12, 1..11 PM = 13..23.
 */
function to24h(hour: number, ampm: string | undefined): number {
  if (!ampm) return hour;
  const am = ampm.toUpperCase();
  if (am === 'PM' && hour < 12) return hour + 12;
  if (am === 'AM' && hour === 12) return 0;
  return hour;
}

/**
 * Build ISO timestamp for a regex match. Handles inline-date patterns
 * (date in capture groups) AND time-only patterns (date from
 * DateContext).
 *
 * Special-cases:
 *   - telegram-text-export: month-name + day + year + 12h_ampm
 *     reconstruction.
 *   - whatsapp-iso: dd/mm/yy reconstruction.
 *   - whatsapp-us / discord-export / teams-export: mm/dd/yy + 12h_ampm.
 *
 * Returns null if reconstruction fails (caller treats as orphan line).
 */
function buildIso(
  match: RegExpExecArray,
  entry: PatternEntry,
  dateCtx: DateContext,
): string | null {
  const { captures } = entry;

  // Pattern-specific date reconstruction.
  switch (entry.id) {
    case 'telegram-text-export': {
      // groups: 1=speaker, 2=monthName, 3=day, 4=year, 5=hour, 6=min, 7=sec, 8=ampm
      const monthName = match[2];
      const day = Number(match[3]);
      const year = Number(match[4]);
      const hourRaw = Number(match[5]);
      const minute = Number(match[6]);
      const ampm = match[8];
      const month = monthNameToIndex(monthName);
      if (month < 0 || !Number.isFinite(day) || !Number.isFinite(year)) return null;
      const hour = to24h(hourRaw, ampm);
      const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
    }
    case 'whatsapp-iso': {
      // groups: 1=dd, 2=mm, 3=yy, 4=hh, 5=mm, 6=ss, 7=speaker, 8=text
      const day = Number(match[1]);
      const month = Number(match[2]);
      const yearRaw = Number(match[3]);
      const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
      const hour = Number(match[4]);
      const minute = Number(match[5]);
      if (![day, month, year, hour, minute].every(Number.isFinite)) return null;
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
    }
    case 'whatsapp-us': {
      // groups: 1=mm, 2=dd, 3=yy, 4=hh, 5=mm, 6=ampm, 7=speaker, 8=text
      const month = Number(match[1]);
      const day = Number(match[2]);
      const yearRaw = Number(match[3]);
      const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
      const hourRaw = Number(match[4]);
      const minute = Number(match[5]);
      const ampm = match[6];
      if (![month, day, year, hourRaw, minute].every(Number.isFinite)) return null;
      const hour = to24h(hourRaw, ampm);
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
    }
    case 'discord-export': {
      // groups: 1=mm, 2=dd, 3=yyyy, 4=hh, 5=mm, 6=ampm, 7=speaker
      const month = Number(match[1]);
      const day = Number(match[2]);
      const year = Number(match[3]);
      const hourRaw = Number(match[4]);
      const minute = Number(match[5]);
      const ampm = match[6];
      if (![month, day, year, hourRaw, minute].every(Number.isFinite)) return null;
      const hour = to24h(hourRaw, ampm);
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
    }
    case 'teams-export': {
      // groups: 1=speaker, 2=mm, 3=dd, 4=yyyy, 5=hh, 6=mm, 7=ampm, 8=text
      const month = Number(match[2]);
      const day = Number(match[3]);
      const year = Number(match[4]);
      const hourRaw = Number(match[5]);
      const minute = Number(match[6]);
      const ampm = match[7];
      if (![month, day, year, hourRaw, minute].every(Number.isFinite)) return null;
      const hour = to24h(hourRaw, ampm);
      const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
    }
  }

  // Generic path for patterns whose captures map directly to
  // date/hour/minute/ampm groups.
  if (
    entry.date_source === 'inline' &&
    captures.date_group !== undefined &&
    captures.hour_group !== undefined &&
    captures.minute_group !== undefined
  ) {
    const date = match[captures.date_group];
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return null;
    }
    const hourRaw = Number(match[captures.hour_group]);
    const minute = Number(match[captures.minute_group]);
    if (!Number.isFinite(hourRaw) || !Number.isFinite(minute)) return null;
    const ampm =
      captures.ampm_group !== undefined ? match[captures.ampm_group] : undefined;
    const hour = to24h(hourRaw, ampm);
    return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
  }

  // Time-only patterns: date from DateContext.
  if (
    entry.date_source === 'frontmatter' &&
    captures.hour_group !== undefined &&
    captures.minute_group !== undefined
  ) {
    const hourRaw = Number(match[captures.hour_group]);
    const minute = Number(match[captures.minute_group]);
    if (!Number.isFinite(hourRaw) || !Number.isFinite(minute)) return null;
    const ampm =
      captures.ampm_group !== undefined ? match[captures.ampm_group] : undefined;
    const hour = to24h(hourRaw, ampm);
    return `${dateCtx.fallbackDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
  }

  // No-time patterns (irc-classic): only frontmatter date is
  // available; anchor every message at 00:00:00 of that day.
  // Honest: messages lose intra-day ordering, but at least they
  // parse and the day-level fact attribution is correct.
  if (entry.date_source === 'frontmatter' && captures.hour_group === undefined) {
    return `${dateCtx.fallbackDate}T00:00:00Z`;
  }

  return null;
}

const MONTHS_SHORT = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];
function monthNameToIndex(name: string): number {
  return MONTHS_SHORT.indexOf(name.toLowerCase().slice(0, 3));
}

/**
 * Apply ONE pattern to the full body. Returns the matched messages
 * with their ISO timestamps. Handles multi-line continuations per D5.
 *
 * For multi_line=true patterns: the regex matches ONLY the FIRST line
 * of a multi-line message; subsequent lines until the next anchor
 * (next match or end-of-body) become the body.
 *
 * For multi_line=false patterns: the regex matches a complete line;
 * continuation lines (orphan lines after a match) append to the
 * previous message's body.
 *
 * Exported for unit tests + the eval CLI debug command.
 */
export function applyPattern(
  body: string,
  entry: PatternEntry,
  dateCtx: DateContext,
): MatchedMessage[] {
  if (!body) return [];
  const out: MatchedMessage[] = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trim();
    if (!line) continue;

    // Quick-reject fast path.
    if (entry.quick_reject && !entry.quick_reject.test(line)) {
      // Continuation handling for orphan lines.
      if (out.length > 0) {
        out[out.length - 1].text = out[out.length - 1].text
          ? `${out[out.length - 1].text}\n${line}`
          : line;
      }
      continue;
    }

    const m = entry.regex.exec(line);
    if (m) {
      const iso = buildIso(m, entry, dateCtx);
      if (iso === null) continue; // reconstruction failed; skip line
      const rawSpeaker = m[entry.captures.speaker_group] ?? '';
      const speaker = cleanSpeaker(rawSpeaker, entry.speaker_clean);
      let text = '';
      if (entry.captures.text_group > 0) {
        text = (m[entry.captures.text_group] ?? '').trim();
      }
      // Multi-line patterns: text on next line(s) until next anchor.
      // (Even when text_group is set, multi_line=true means SUBSEQUENT
      // non-anchor lines also absorb into this message's body.)
      out.push({ speaker, timestamp: iso, text });
    } else if (out.length > 0) {
      // Continuation line.
      out[out.length - 1].text = out[out.length - 1].text
        ? `${out[out.length - 1].text}\n${line}`
        : line;
    }
  }
  return out;
}

/**
 * Split a body into non-blank trimmed lines. `headCap` (when set)
 * limits the result to the first N lines — used by the head-pass
 * scorer; omit for full-body scoring.
 */
function getNonBlankLines(body: string, headCap?: number): string[] {
  if (!body) return [];
  const all = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return headCap !== undefined ? all.slice(0, headCap) : all;
}

/**
 * Core scorer over a pre-split line array. Both `scorePattern` (head
 * window) and `scorePatternFull` (whole body) delegate here so the
 * quick_reject + regex loop lives in one place. Reused by
 * `parseConversation`'s fallback path which pre-splits ONCE and
 * passes the array to all 12 candidates (saves 11 redundant body
 * splits per fallback pass).
 */
function scoreFromLines(
  lines: readonly string[],
  entry: PatternEntry,
): number {
  if (lines.length === 0) return 0;
  let anchored = 0;
  for (const line of lines) {
    if (entry.quick_reject && !entry.quick_reject.test(line)) continue;
    if (entry.regex.test(line)) anchored++;
  }
  return anchored / lines.length;
}

/**
 * Score how well a pattern matches the first N lines of a body (D18).
 * Returns 0..1 ratio of matched lines. Higher = more confident.
 *
 * Quick_reject is honored (lines that don't pass quick_reject still
 * count as "could be continuation"; not penalized).
 *
 * Exported for tests.
 */
export function scorePattern(body: string, entry: PatternEntry): number {
  return scoreFromLines(getNonBlankLines(body, SCORING_HEAD_LINES), entry);
}

/**
 * Score how well a pattern matches the FULL body, no head cap
 * (v0.41.18+ Codex P1 #1 — full-body fallback when head pass falls
 * below `SCORING_HEAD_TRIGGER_THRESHOLD`).
 *
 * Cost-aware: in `parseConversation`'s fallback path we pre-split
 * ONCE and route through `scoreFromLines` directly, NOT through this
 * wrapper, to avoid 12 redundant body splits per pass. This wrapper
 * exists for direct unit testing and for any future caller that
 * needs full-body scoring of a single pattern.
 */
export function scorePatternFull(body: string, entry: PatternEntry): number {
  return scoreFromLines(getNonBlankLines(body), entry);
}

/**
 * Parse a conversation body into messages. Tries built-in patterns
 * (minus disabled), then user patterns (D7-validated), then optional
 * LLM fallback (T4; not yet wired).
 *
 * The shape matches PR #1461's `parseConversationMessages(body, opts)`
 * for back-compat. `extract-conversation-facts.ts` adapts via
 * `parseConversation(body, { page })` in T5.
 */
export function parseConversation(
  body: string,
  opts: ParseConversationOpts = {},
): ParseResult {
  if (!body) {
    return { messages: [], phase: 'no_match' };
  }

  const dateCtx = deriveDateContext(opts);

  // Assemble candidate pool: built-ins (minus disabled) + user patterns.
  const disabledSet = new Set(opts.disabledBuiltinIds ?? []);
  const builtinPool = BUILTIN_PATTERNS.filter((p) => !disabledSet.has(p.id));
  const userPool = opts.userPatterns ?? [];
  const candidates: readonly PatternEntry[] = [...builtinPool, ...userPool];

  if (candidates.length === 0) {
    return { messages: [], phase: 'no_match' };
  }

  // D18: score every candidate; pick the highest. Tie-break on
  // declared priority order (built-in declaration order; user patterns
  // lose every tie).
  type Scored = { entry: PatternEntry; score: number; priority: number };
  const sortScored = (arr: Scored[]) =>
    arr.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.priority - b.priority;
    });
  let scored: Scored[] = candidates.map((entry) => ({
    entry,
    score: scorePattern(body, entry),
    priority: priorityOf(entry.id),
  }));
  sortScored(scored);

  // REGRESSION (closes #1533 + Codex P1 #1): meeting pages have
  // ## Summary + blockquote + ## Transcript ahead of the chat. The
  // pre-fix "trigger fallback only when score === 0" shape left a
  // real bug class open — a stray head match (e.g. a blockquote
  // that accidentally matches an unrelated pattern at 0.1)
  // suppressed the fallback even when 175 of 226 lines further down
  // were valid imessage-slack. Threshold 0.3 means "fewer than 3 of
  // 10 head lines matched"; chat-only pages still score 1.0 and skip
  // the fallback. Re-score every candidate against the full body,
  // pre-splitting ONCE to avoid 12 redundant body splits.
  if (scored[0].score < SCORING_HEAD_TRIGGER_THRESHOLD) {
    const allLines = getNonBlankLines(body);
    scored = candidates.map((entry) => ({
      entry,
      score: scoreFromLines(allLines, entry),
      priority: priorityOf(entry.id),
    }));
    sortScored(scored);
    // NOTE: patterns_scored stays as scored.length (= candidate
    // count, typically 12) even when the fallback runs — the
    // diagnostic reports "candidates considered" not "scoring
    // attempts" (Codex P2 #7).
  }

  const top = scored[0];
  const patternsScored = scored.length;

  // Minimum acceptance floor (closes Codex P1 #2): an essay with
  // one stray `**Name** (date time):` line scores ~1/300 ≈ 0.003 —
  // below the 5% floor we stay no_match instead of returning a
  // 1-message false positive. Real transcript pages typically score
  // 0.5+ and sail through.
  if (top.score < SCORING_MIN_ACCEPTANCE) {
    return {
      messages: [],
      phase: 'no_match',
      patterns_scored: patternsScored,
      unmatched_line_count: opts.diagnostic
        ? body.split(/\r?\n/).filter((l) => l.trim().length > 0).length
        : undefined,
    };
  }

  const messages = applyPattern(body, top.entry, dateCtx);

  // Timezone warning surface (D19).
  let timezone_warning: string | undefined;
  if (
    top.entry.timezone_policy === 'utc_assumed_with_warn' &&
    !dateCtx.timezone &&
    messages.length > 0
  ) {
    timezone_warning = `[conversation-parser] pattern=${top.entry.id} assumed UTC for time-only timestamps; add 'timezone: <IANA>' to page frontmatter for accurate facts`;
  }

  return {
    messages,
    phase: 'regex_match',
    matched_pattern_id: top.entry.id,
    patterns_scored: patternsScored,
    timezone_warning,
    unmatched_line_count: opts.diagnostic
      ? body
          .split(/\r?\n/)
          .filter((l) => l.trim().length > 0).length - messages.length
      : undefined,
  };
}
