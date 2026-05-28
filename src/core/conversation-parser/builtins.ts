/**
 * v0.41.16.0 — Built-in conversation parser pattern registry.
 *
 * Twelve hand-vetted patterns covering the chat-export formats this
 * codebase is most likely to encounter. Each pattern's regex was
 * derived from a public format reference (source_doc field) so future
 * maintainers can verify against the wild shape.
 *
 * Contracts (eng review + codex outside voice):
 *   - D7: every entry carries `test_positive[]` (>=2) + `test_negative[]`
 *     (>=2). Module-load validation in `validatePatternEntry` runs both
 *     sets on every entry at startup; gbrain throws if any drifts.
 *   - D9: `DEFAULT_SPEAKER_CLEAN` is the exported default — patterns
 *     without a `speaker_clean` field inherit it. Only patterns with
 *     special speaker shapes (matrix-element strips ':matrix.org')
 *     override.
 *   - D5: every entry declares `multi_line` explicitly (no implicit
 *     defaulting; ambiguous formats get a clear declaration).
 *   - D11: every entry MAY declare `quick_reject` for O(1) prefix
 *     screening. Patterns without quick_reject still work but pay
 *     full regex cost.
 *   - D19: `timezone_policy` is required on every entry.
 *   - D16: built-in regex is hand-vetted (no ReDoS); arbitrary user
 *     regex is rejected at config-set time (v1 only supports
 *     `simple_pattern` structured spec).
 *
 * Pattern priority order (D18 scoring overrides this at runtime, but
 * priority is the tie-breaker): inline-date formats first
 * (less ambiguous), time-only formats second.
 */

import type { PatternEntry } from './types.ts';

/**
 * Default speaker-clean regex (D9). Strips leading non-letter/digit
 * characters (emoji, decorative glyphs) + optional whitespace. The
 * exact shape from PR #1461's `cleanSpeaker` helper, promoted to a
 * module-level export.
 */
export const DEFAULT_SPEAKER_CLEAN = /^[^\p{L}\p{N}]+\s*/u;

/**
 * Apply DEFAULT_SPEAKER_CLEAN or a pattern-specific override to a raw
 * captured speaker string. Empty-result fallback returns the original
 * trimmed string (matches PR #1461's `cleanSpeaker` behavior).
 */
export function cleanSpeaker(raw: string, override?: RegExp): string {
  const rx = override ?? DEFAULT_SPEAKER_CLEAN;
  const stripped = raw.replace(rx, '').trim();
  return stripped || raw.trim();
}

/** The 12 hand-vetted built-in patterns. */
export const BUILTIN_PATTERNS: readonly PatternEntry[] = [
  // -------------------------------------------------------------------
  // INLINE-DATE patterns (date in every line; less ambiguous; tried first).
  // -------------------------------------------------------------------

  {
    id: 'imessage-slack',
    origin: 'builtin',
    // The existing PR #1461 / pre-existing MESSAGE_LINE_RX shape.
    // Matches: **Speaker** (2024-03-15 9:00 AM): text
    regex:
      /^\*\*(.+?)\*\*\s*\((\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?\)\s*:\s*(.*)$/,
    captures: {
      speaker_group: 1,
      date_group: 2,
      hour_group: 3,
      minute_group: 4,
      ampm_group: 5,
      text_group: 6,
    },
    date_source: 'inline',
    time_format: '12h_ampm',
    timezone_policy: 'inline_utc',
    multi_line: false,
    quick_reject: /^\*\*/,
    test_positive: [
      '**Alice Example** (2024-03-15 9:00 AM): hello',
      '**Bob Example** (2024-03-15 12:00 PM): noon',
      '**Charlie** (2024-03-15 12:00 AM): midnight',
    ],
    test_negative: [
      '**[18:37] G T:** telegram shape, not iMessage',
      'Alice — Today at 18:37',
      '<alice> irc',
    ],
    source_doc: 'pre-existing gbrain MESSAGE_LINE_RX; PR #1461 preserved',
  },

  {
    id: 'telegram-bracket',
    origin: 'builtin',
    // PR #1461's BRACKET_TIME_RX, preserved verbatim.
    // Matches: **[18:37] 👤 G T:** hello
    regex: /^\*\*\[(\d{1,2}):(\d{2})\]\s+(.+?):\*\*\s*(.*)$/,
    captures: {
      speaker_group: 3,
      hour_group: 1,
      minute_group: 2,
      text_group: 4,
    },
    date_source: 'frontmatter',
    time_format: '24h',
    timezone_policy: 'utc_assumed_with_warn',
    multi_line: false,
    quick_reject: /^\*\*\[/,
    test_positive: [
      '**[18:37] \u{1f464} G T:** hello',
      '**[06:00] \u{1f916} Zion:** On it.',
      '**[22:15] Plain Name:** no emoji',
    ],
    test_negative: [
      '**Alice** (2024-03-15 9:00 AM): iMessage shape',
      '[18:37] Alice: missing the bold markers',
      'just text',
    ],
    source_doc: 'PR #1461 (closed); preserved verbatim with Co-Authored-By',
  },

  {
    // v0.41.18+ (D-FOLLOWUP-1.B closes the user-facing half of #1533):
    // matches the shape Circleback meeting exports use after an
    // OpenClaw meeting-ingestion pipeline reformats them. Two
    // sub-shapes in the wild (verified across a 367-file corpus):
    //   **Participant 2** (00:00): Companies that we have...      ← (HH:MM)
    //   **Participant 1** (00:00:00): We found the apostrophes...  ← (HH:MM:SS)
    //
    // The time group is elapsed time from meeting start, NOT
    // wall-clock. Parser treats it as wall-clock 24h on the
    // frontmatter date — speaker + text are captured correctly, but
    // every message lands on the same day starting at 00:00 + offset
    // minutes. The downstream fact extractor only cares about
    // speaker + content, so this is honest-enough; precise per-line
    // wall-clock timestamps would require a new `elapsed_time:
    // true` flag on PatternEntry (v0.42+).
    //
    // Declaration position is AFTER imessage-slack + telegram-
    // bracket so on the rare tie those more-specific patterns win.
    // The regex deliberately requires `\)` immediately after the
    // time so `(2024-03-15 9:00 AM)` and `(9:00 AM)` shapes fall
    // through to imessage-slack instead of false-matching here.
    // The seconds segment is a non-capturing optional group so
    // capture indexes stay identical across both sub-shapes.
    id: 'bold-paren-time',
    origin: 'builtin',
    regex: /^\*\*(.+?)\*\*\s+\((\d{1,2}):(\d{2})(?::\d{2})?\)\s*:\s*(.*)$/,
    captures: {
      speaker_group: 1,
      hour_group: 2,
      minute_group: 3,
      text_group: 4,
    },
    date_source: 'frontmatter',
    time_format: '24h',
    timezone_policy: 'utc_assumed_with_warn',
    multi_line: false,
    quick_reject: /^\*\*/,
    test_positive: [
      '**Garry Tan** (00:00): hello world',
      '**Participant 2** (02:22): response here',
      '**Alex Graveley** (15:09): That’s exactly right.',
      '**Participant 1** (00:00:00): hello world with seconds',
      '**Participant 2** (01:23:45): mid-meeting line',
    ],
    test_negative: [
      // imessage-slack shape (full date+time) MUST fall through to imessage-slack:
      '**Alice Example** (2024-03-15 9:00 AM): iMessage shape',
      // telegram-bracket shape MUST fall through to telegram-bracket:
      '**[18:37] \u{1f464} G T:** telegram bracket',
      // No bold markers:
      'Alice (00:00): missing the bold',
      // Bold but no parens:
      '**Alice** hello world',
    ],
    source_doc:
      'OpenClaw meeting-ingestion pipeline reformat of Circleback transcripts (see your OpenClaw skills/meeting-ingestion/SKILL.md)',
  },

  {
    id: 'telegram-text-export',
    origin: 'builtin',
    // Telegram Desktop's text-export shape: `Alice Doe, [Mar 15, 2024 at 6:37:00 PM]`
    // The body lands on the next line(s) and is absorbed via multi_line.
    regex:
      /^([\p{L}\p{N}][\p{L}\p{N}\s.'-]*?),\s*\[([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})\s+at\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)\]\s*$/u,
    captures: {
      speaker_group: 1,
      // date_group skipped — the orchestrator handles RFC-style date
      // reconstruction in code (Mar + 15 + 2024 → 2024-03-15).
      // We re-use date_group=2 to hint "look at multiple groups"; the
      // orchestrator special-cases time_format='12h_ampm' + date_source
      // ='inline' with a month-name capture.
      // Simpler: this pattern emits ISO via a custom code path in parse.ts.
      hour_group: 5,
      minute_group: 6,
      ampm_group: 8,
      text_group: 0, // text comes from next line (multi_line)
    },
    date_source: 'inline',
    time_format: '12h_ampm',
    timezone_policy: 'inline_utc',
    multi_line: true,
    quick_reject: /,\s*\[[A-Za-z]{3}\s+\d/,
    test_positive: [
      'Alice Example, [Mar 15, 2024 at 6:37:00 PM]',
      'Bob Example, [Jan 1, 2024 at 12:00:00 AM]',
    ],
    test_negative: [
      'Alice Example, [03/15/24, 18:37]',
      '**Alice** (2024-03-15 9:00 AM): wrong format',
    ],
    source_doc: 'Telegram Desktop "Export chat history" plain-text shape',
  },

  {
    id: 'whatsapp-iso',
    origin: 'builtin',
    // WhatsApp ISO export: `[15/03/24, 18:37:00] Alice: hello`
    regex:
      /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s*(\d{1,2}):(\d{2}):(\d{2})\]\s+(.+?):\s+(.*)$/,
    captures: {
      // dd/mm/yy + hh:mm:ss + speaker + text. Orchestrator reconstructs
      // ISO date from groups 3 (yy), 2 (mm), 1 (dd).
      speaker_group: 7,
      hour_group: 4,
      minute_group: 5,
      text_group: 8,
    },
    date_source: 'inline',
    time_format: '24h',
    timezone_policy: 'inline_utc',
    multi_line: true,
    quick_reject: /^\[\d/,
    test_positive: [
      '[15/03/24, 18:37:00] Alice Example: hello',
      '[01/01/24, 00:00:00] Bob Example: midnight',
    ],
    test_negative: [
      '[18:37] Alice: no date prefix',
      '3/15/24, 6:37 PM - Alice: US locale',
    ],
    source_doc: 'WhatsApp "Export chat" feature, EU/ISO locale variant',
  },

  {
    id: 'whatsapp-us',
    origin: 'builtin',
    // WhatsApp US locale export: `3/15/24, 6:37 PM - Alice: hello`
    regex:
      /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})\s*(AM|PM)\s+-\s+(.+?):\s+(.*)$/,
    captures: {
      // mm/dd/yy + hh:mm + AM/PM + speaker + text. Orchestrator
      // reconstructs ISO date from groups 3 (yy), 1 (mm), 2 (dd).
      speaker_group: 7,
      hour_group: 4,
      minute_group: 5,
      ampm_group: 6,
      text_group: 8,
    },
    date_source: 'inline',
    time_format: '12h_ampm',
    timezone_policy: 'inline_utc',
    multi_line: true,
    quick_reject: /^\d{1,2}\/\d{1,2}\/\d{2,4}/,
    test_positive: [
      '3/15/24, 6:37 PM - Alice Example: hello',
      '12/31/23, 11:59 PM - Bob Example: nye',
    ],
    test_negative: [
      '[15/03/24, 18:37:00] Alice: ISO variant',
      'Alice (2024-03-15 9:00 AM): iMessage',
    ],
    source_doc: 'WhatsApp "Export chat" feature, US locale variant',
  },

  {
    id: 'discord-export',
    origin: 'builtin',
    // DiscordChatExporter TXT shape: `[03/15/2024 6:37 PM] Alice Example`
    // The body lands on the next line(s) (multi_line).
    regex:
      /^\[(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\]\s+(.+)$/,
    captures: {
      // mm/dd/yyyy + hh:mm + AM/PM + speaker. Body on next line.
      speaker_group: 7,
      hour_group: 4,
      minute_group: 5,
      ampm_group: 6,
      text_group: 0, // body comes from next line (multi_line)
    },
    date_source: 'inline',
    time_format: '12h_ampm',
    timezone_policy: 'inline_utc',
    multi_line: true,
    quick_reject: /^\[\d{1,2}\/\d{1,2}\/\d{4}/,
    test_positive: [
      '[03/15/2024 6:37 PM] Alice Example',
      '[01/01/2024 12:00 AM] Bob Example',
    ],
    test_negative: [
      '[15/03/24, 18:37:00] Alice: WhatsApp shape',
      'Alice — Today at 18:37',
    ],
    source_doc:
      'DiscordChatExporter (Tyrrrz/DiscordChatExporter) TXT export shape',
  },

  {
    id: 'teams-export',
    origin: 'builtin',
    // Teams export: `Alice Smith, 3/15/2024 6:37 PM: hello`
    regex:
      /^([\p{L}\p{N}][\p{L}\p{N}\s.'-]*?),\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM):\s+(.*)$/u,
    captures: {
      speaker_group: 1,
      hour_group: 5,
      minute_group: 6,
      ampm_group: 7,
      text_group: 8,
    },
    date_source: 'inline',
    time_format: '12h_ampm',
    timezone_policy: 'inline_utc',
    multi_line: true,
    quick_reject: /,\s+\d{1,2}\/\d{1,2}\/\d{4}/,
    test_positive: [
      'Alice Example, 3/15/2024 6:37 PM: hello',
      'Bob Example, 12/31/2023 11:59 PM: nye',
    ],
    test_negative: [
      '**Alice** (2024-03-15 9:00 AM): iMessage shape',
      '[03/15/2024 6:37 PM] Alice: Discord export',
    ],
    source_doc: 'Microsoft Teams chat export (web/desktop) plain-text render',
  },

  {
    id: 'signal-export',
    origin: 'builtin',
    // signal-cli backup render: `Alice Example (2024-03-15 18:37:00 UTC): hello`
    regex:
      /^(.+?)\s+\((\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+UTC\):\s+(.*)$/,
    captures: {
      speaker_group: 1,
      date_group: 2,
      hour_group: 3,
      minute_group: 4,
      text_group: 6,
    },
    date_source: 'inline',
    time_format: '24h',
    timezone_policy: 'inline_utc',
    multi_line: true,
    quick_reject: /\s+\(\d{4}-\d{2}-\d{2}/,
    test_positive: [
      'Alice Example (2024-03-15 18:37:00 UTC): hello',
      'Bob Example (2024-01-01 00:00:00 UTC): nye',
    ],
    test_negative: [
      '**Alice** (2024-03-15 9:00 AM): iMessage shape (no UTC suffix)',
      'Alice (2024-03-15 6:37 PM): missing UTC and seconds',
    ],
    source_doc: 'signal-cli (AsamK/signal-cli) JSON-to-text render shape',
  },

  // -------------------------------------------------------------------
  // TIME-ONLY patterns (date comes from frontmatter).
  // -------------------------------------------------------------------

  {
    id: 'discord-classic',
    origin: 'builtin',
    // Classic in-app render: `Alice Example — Today at 18:37`
    // Multi-line: body on next line(s).
    // Uses U+2014 EM DASH (decoded for source clarity).
    regex: /^([\p{L}\p{N}][\p{L}\p{N}\s.'-]*?)\s+—\s+(?:Today|Yesterday)\s+at\s+(\d{1,2}):(\d{2})\s*(AM|PM)?\s*$/u,
    captures: {
      speaker_group: 1,
      hour_group: 2,
      minute_group: 3,
      ampm_group: 4,
      text_group: 0, // body on next line (multi_line)
    },
    date_source: 'frontmatter',
    time_format: '12h_ampm',
    timezone_policy: 'utc_assumed_with_warn',
    multi_line: true,
    quick_reject: /—\s+(Today|Yesterday)/,
    test_positive: [
      'Alice Example — Today at 6:37 PM',
      'Bob Example — Yesterday at 12:00 AM',
    ],
    test_negative: [
      'Alice Example, 3/15/2024 6:37 PM: hello',
      '[03/15/2024 6:37 PM] Alice',
    ],
    source_doc: 'Discord web/desktop in-app message render',
  },

  {
    id: 'matrix-element',
    origin: 'builtin',
    // Element/Matrix shape: `[18:37] @alice:matrix.org: hello`
    regex:
      /^\[(\d{1,2}):(\d{2})\]\s+(@[\p{L}\p{N}_.-]+:[\p{L}\p{N}.-]+):\s+(.*)$/u,
    captures: {
      speaker_group: 3,
      hour_group: 1,
      minute_group: 2,
      text_group: 4,
    },
    date_source: 'frontmatter',
    time_format: '24h',
    timezone_policy: 'utc_assumed_with_warn',
    multi_line: false,
    quick_reject: /^\[\d{1,2}:\d{2}\]\s+@/,
    // Special speaker_clean: strip leading @ and trailing :matrix.org-style suffix.
    speaker_clean: /^@|:[\p{L}\p{N}.-]+$/gu,
    test_positive: [
      '[18:37] @alice:matrix.org: hello',
      '[06:00] @bob:example.org: morning',
    ],
    test_negative: [
      '[18:37] Alice: matrix without @',
      '**[18:37] G T:** telegram bracket',
    ],
    source_doc: 'Element/matrix-archive script shape',
  },

  {
    id: 'irc-classic',
    origin: 'builtin',
    // Classic IRC log: `<alice> hello`
    regex: /^<([^>]+)>\s+(.*)$/,
    captures: {
      speaker_group: 1,
      text_group: 2,
    },
    date_source: 'frontmatter',
    time_format: '24h',
    timezone_policy: 'utc_assumed_with_warn',
    multi_line: false,
    quick_reject: /^</,
    test_positive: ['<alice> hello world', '<bob> response here'],
    test_negative: [
      '<-- alice has joined #channel',
      'Alice: not irc format',
    ],
    source_doc:
      'IRC default log format (irssi /SET autolog, weechat /SET logger.format)',
  },

  {
    id: 'irc-weechat',
    origin: 'builtin',
    // weechat default with timestamps: `18:37 <alice> hello`
    regex: /^(\d{1,2}):(\d{2})\s+<([^>]+)>\s+(.*)$/,
    captures: {
      hour_group: 1,
      minute_group: 2,
      speaker_group: 3,
      text_group: 4,
    },
    date_source: 'frontmatter',
    time_format: '24h',
    timezone_policy: 'utc_assumed_with_warn',
    multi_line: false,
    quick_reject: /^\d{1,2}:\d{2}\s+</,
    test_positive: ['18:37 <alice> hello', '06:00 <bob> morning'],
    test_negative: ['<alice> classic irc, no time', '[18:37] @alice: matrix'],
    source_doc: 'weechat default logger.format `%H:%M %p\\t%m`',
  },
];

/**
 * Validate a PatternEntry's regex against its declared positive +
 * negative sample sets. Throws with a descriptive message if any
 * positive sample fails to match OR any negative sample matches.
 *
 * Called once per built-in at module load. User-declared patterns
 * call this at config-set time with their sample lines.
 */
export function validatePatternEntry(entry: PatternEntry): void {
  for (const sample of entry.test_positive) {
    if (!entry.regex.test(sample)) {
      throw new Error(
        `[conversation-parser] PatternEntry '${entry.id}' regex does not match its test_positive sample: ${JSON.stringify(sample)}`,
      );
    }
    // quick_reject MUST also match every test_positive (else the
    // orchestrator's fast-path would skip the pattern incorrectly).
    if (entry.quick_reject && !entry.quick_reject.test(sample)) {
      throw new Error(
        `[conversation-parser] PatternEntry '${entry.id}' quick_reject FAILS to match its test_positive sample: ${JSON.stringify(sample)}. quick_reject must be a strict superset of regex.`,
      );
    }
  }
  for (const sample of entry.test_negative) {
    if (entry.regex.test(sample)) {
      throw new Error(
        `[conversation-parser] PatternEntry '${entry.id}' regex incorrectly matches its test_negative sample: ${JSON.stringify(sample)}`,
      );
    }
  }
  // Defensive: capture-group indices must be valid wrt regex's
  // group count. JS regex doesn't expose group count directly; we
  // re-run against the first positive sample and check.
  if (entry.test_positive.length > 0) {
    const m = entry.regex.exec(entry.test_positive[0]);
    if (m === null) return; // already thrown above
    const requiredGroups = [
      entry.captures.speaker_group,
      entry.captures.date_group,
      entry.captures.hour_group,
      entry.captures.minute_group,
      entry.captures.ampm_group,
    ].filter((g): g is number => typeof g === 'number');
    for (const g of requiredGroups) {
      if (g >= m.length) {
        throw new Error(
          `[conversation-parser] PatternEntry '${entry.id}' captures group ${g} but regex only emits ${m.length - 1} groups`,
        );
      }
    }
  }
}

/**
 * Validate every built-in at module load. Throws if any pattern
 * drifts. Called at the bottom of this file.
 */
function validateAllBuiltins(): void {
  for (const entry of BUILTIN_PATTERNS) {
    validatePatternEntry(entry);
  }
  // Defensive: assert ids are unique.
  const ids = new Set<string>();
  for (const entry of BUILTIN_PATTERNS) {
    if (ids.has(entry.id)) {
      throw new Error(
        `[conversation-parser] duplicate built-in PatternEntry id: ${entry.id}`,
      );
    }
    ids.add(entry.id);
  }
}

// D7: run at module load. Any drift = gbrain refuses to start.
validateAllBuiltins();
