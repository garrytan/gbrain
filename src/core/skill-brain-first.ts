/**
 * skill-brain-first.ts — Pure analyzer for the v0.36.x `skill_brain_first`
 * doctor check + skillify-check gate + dry-fix `--fix` MISSING_RULE pattern.
 *
 * Motivation (tweet-shield incident, 2026-05-19): cross-modal eval flagged
 * Garry's Palantir tweet as risky because no model knew he built it. The
 * brain already had "designed the entire Finance product UI" and "150+
 * PSDs from April-December 2006." Brain-first compliance — search the brain
 * before any external API — would have caught it. This module catches
 * authors who didn't declare brain-first or didn't opt out explicitly.
 *
 * One pure function, three consumers (Q1 from /plan-eng-review):
 *   - `runDoctor()` maps it across the manifest for `skill_brain_first`
 *   - `skillify-check` calls it on a single SKILL.md as required item 12
 *   - `dry-fix.ts` MISSING_RULE_PATTERNS calls it as the "should I insert
 *      a Convention callout here?" gate
 *
 * Exemption order (top wins):
 *   1. Frontmatter `brain_first: exempt` → exempt_explicit
 *   2. No external-lookup pattern in body → exempt_no_external
 *   3. Otherwise apply compliance detection (3-tier ladder)
 *
 * Compliance ladder (any one passes):
 *   a. Canonical `> **Convention:** ... brain-first ...` callout → compliant_callout
 *   b. Explicit `## Phase 1 [brain]` or `## Step 0 [brain]` heading → compliant_phase
 *   c. First brain reference offset < first external reference offset → compliant_position
 *
 * **NOTE (CMT2 from /plan-eng-review):** there is NO `tools + writes_pages`
 * structural exemption. Skills like `idea-ingest`, `meeting-ingestion`,
 * and `data-research` write pages AND call external APIs — the exact mixed
 * class brain-first targets. They get flagged so authors declare stance,
 * not hidden behind a structural rule. Skills that genuinely ARE the brain
 * (`brain-ops`, `signal-detector`) exempt via compliance detection because
 * they already carry the canonical callout — no structural rule needed.
 *
 * **NOTE (F6 from /plan-eng-review):** all position-relative scanning is
 * BODY-ONLY. YAML frontmatter is excluded from offset comparison so a
 * `tools: [web_search]` declaration doesn't false-flag the skill (the
 * declaration is metadata, not execution). The body extractor returns the
 * content starting AFTER the closing `---` of the frontmatter fence.
 *
 * **NOTE (F7 from /plan-eng-review):** the canonical-callout regex anchors
 * on the literal `> **Convention:**` + `brain-first` substring, agnostic to
 * path syntax (backtick / markdown-link / plain text). The three existing
 * compliant skills (brain-ops, perplexity-research, academic-verify) use
 * plain-text paths, so this is the load-bearing detection shape, not
 * `extractDelegationTargets` which only matches backtick paths.
 */

import type { ParsedFrontmatter } from './skill-frontmatter.ts';
import { formatBrainFirstTypoHint } from './skill-frontmatter.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BrainFirstReason =
  | 'exempt_explicit'      // brain_first: exempt in frontmatter
  | 'exempt_no_external'   // no external-lookup pattern present in body
  | 'compliant_callout'    // canonical > **Convention:** ... brain-first ... callout
  | 'compliant_phase'      // explicit ## Phase 1 / Step 0 brain heading
  | 'compliant_position'   // first brain ref appears before first external ref (body)
  | 'missing_brain_first'; // external pattern + no compliance signal

export interface BrainFirstAnalysis {
  /** Stable identifier — the manifest entry name OR the dir name. */
  skill: string;
  /** OK if any exemption or compliance path matched; warn otherwise. */
  status: 'ok' | 'warn';
  /** Why the analyzer landed where it did. Drives the doctor message. */
  reason: BrainFirstReason;
  /**
   * The literal pattern names that matched external-lookup detection.
   * Empty when `exempt_no_external` (no external pattern present).
   * Populated even on compliance paths so callers can surface what the
   * skill is calling (e.g. "perplexity + exa, compliant via callout").
   */
  external_patterns_matched: string[];
  /**
   * Paste-ready typo hint when the frontmatter has a near-miss
   * declaration (`brain-first: exempt`, `BrainFirst: Exempt`, quoted
   * values, etc.). Surfaced in the doctor message and skillify-check
   * error output.
   */
  typo_hint?: string;
  /**
   * True when this skill was in the v0.36.x-and-earlier PR #1206
   * hardcoded EXEMPT_SKILLS allowlist. The doctor message appends a
   * dedicated hint for these on first detection (CMT1 from plan review:
   * replaces the dropped upgrade migration with a guided opt-in via
   * `gbrain doctor --fix`).
   */
  formerly_hardcoded_exempt: boolean;
}

// ---------------------------------------------------------------------------
// Pattern constants (exported for shared use in tests + dry-fix.ts detect)
// ---------------------------------------------------------------------------

/**
 * External-lookup tools that trigger the brain-first compliance gate.
 * Each entry pairs a stable identifier (for telemetry) with a regex.
 *
 * Word-boundary anchored so a comment about `web_search_history` won't
 * match `web_search`. Case-insensitive because skill authors capitalize
 * inconsistently (`Perplexity`, `PERPLEXITY`, `perplexity`).
 *
 * Captain API specifically allows `captain api`, `captain_api`,
 * `captain-api`, and `captainapi` because the actual product is
 * referenced with all four shapes across skills.
 */
export const EXTERNAL_LOOKUP_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'web_search', re: /\bweb_search\b/i },
  { name: 'web_fetch', re: /\bweb_fetch\b/i },
  { name: 'exa', re: /\bexa[\s._-]/i },
  { name: 'perplexity', re: /\bperplexity\b/i },
  { name: 'happenstance', re: /\bhappenstance\b/i },
  { name: 'crustdata', re: /\bcrustdata\b/i },
  { name: 'captain_api', re: /\bcaptain[\s._-]?api\b/i },
  { name: 'firecrawl', re: /\bfirecrawl\b/i },
];

/**
 * Brain-reference patterns that signal compliance. These match the
 * canonical brain-tool invocations developers actually write.
 */
export const BRAIN_REFERENCE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bgbrain[\s_]+search\b/i,
  /\bgbrain[\s_]+query\b/i,
  /\bgbrain[\s_]+get[_-]?page\b/i,
  /\bgbrain[\s_]+find[_-]?experts\b/i,
  /\bgbrain[\s_]+get[_-]?backlinks\b/i,
  /\bgbrain[\s_]+get[_-]?timeline\b/i,
  /\bgbrain[\s_]+traverse[_-]?graph\b/i,
  // Bare tool names (subagent context, OpenClaw plugin form):
  /\bsearch\s+the\s+brain\b/i,
  /\bquery\s+the\s+brain\b/i,
  /\bcheck\s+the\s+brain\b/i,
];

/**
 * Canonical Convention callout regex. Anchored at start-of-line on a
 * blockquote that contains BOTH the literal `**Convention:**` marker
 * AND the `brain-first` substring (with optional `.md` extension).
 *
 * Path syntax is intentionally ignored — the three existing compliant
 * skills use varied forms (`> **Convention:** see skills/conventions/
 * brain-first.md ...`, `> **Convention:** see conventions/brain-first.md
 * ...`, `> **Convention:** see [conventions/brain-first.md](...) ...`).
 * The literal `**Convention:**` + `brain-first` is the load-bearing
 * signal, not the path shape.
 */
export const CONVENTION_CALLOUT_RE = /^>\s*\*\*Convention:\*\*[^\n]*brain-first/im;

/**
 * Explicit phase-heading regex. Matches `## Phase 1: Brain-First Lookup`,
 * `### Step 0: Brain Context`, etc. — any H2+ heading that names a brain
 * phase as step 0 or phase 1.
 */
export const PHASE_HEADING_RE = /^##+\s*(?:Phase\s*1|Step\s*0)\b[^\n]*brain/im;

/**
 * Frontmatter fence regex used by body extraction. Conservative match:
 * leading `---\n` through the next `\n---` (greedy stop). Matches the
 * shape `parseSkillFrontmatter` already accepts.
 */
const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;

// ---------------------------------------------------------------------------
// Hardcoded EXEMPT_SKILLS (CMT1 — replaces the dropped upgrade migration)
// ---------------------------------------------------------------------------

/**
 * Skills that were in PR #1206's hardcoded EXEMPT_SKILLS allowlist
 * (committed to v0.36.x-and-earlier `doctor.ts`). The list is
 * preserved here ONLY for the doctor hint flow: when a skill in this
 * set newly flags after v0.36.x ships the structural-signal exemption,
 * the doctor message guides the user to either:
 *   1. `gbrain doctor --fix` to auto-add the canonical callout, OR
 *   2. add `brain_first: exempt` to frontmatter (if genuinely infra)
 *
 * The list is informational — removing it later doesn't break
 * compliance detection. It's a guided opt-in surface, NOT an
 * exemption rule.
 *
 * Per CMT1 from /plan-eng-review (codex direction): doctor surfaces +
 * `--fix` applies via dry-fix safety gates, replacing the originally-
 * planned silent migration. User stays in the loop.
 *
 * Source: PR #1206 `feature/doctor-brain-first-check`,
 * `src/commands/doctor.ts` (pre-supersede).
 */
export const FORMERLY_HARDCODED_EXEMPT: ReadonlySet<string> = new Set([
  // Brain-internal skills (PR rationale: "ARE the brain")
  'brain-ops', 'brain-commit', 'brain-enrichment-pipeline', 'brain-export',
  'brain-ingest-gate', 'brain-librarian', 'brain-link-refs', 'brain-link-report',
  'brain-pdf', 'brain-pdf-auto', 'brain-plan', 'brain-publish', 'brain-storage',
  'brain-storage-links', 'brain-taxonomist',
  'gbrain', 'gbrain-pr', 'gbrain-upgrade', 'benchmark-gbrain',
  // External-tool wrappers (their entire job IS external lookup)
  'exa', 'happenstance', 'crustdata', 'captain-api',
  // Pure-infra skills (system, not knowledge)
  'healthcheck', 'backblaze', 'browser', 'browser-use', 'binary-deps',
  'captcha-solver', 'container-restart', 'durable-service', 'data-loss-gate',
  'channel-discovery', 'clawvisor', 'clawvisor-shield',
  'cron-scheduler', 'cronify', 'correction-pipeline',
  'acknowledge', 'ask-user', 'backoff',
  'acp-coding', 'code-pr', 'skill-creator', 'ingest', 'freshness-monitor',
]);

// ---------------------------------------------------------------------------
// Pure analyzer
// ---------------------------------------------------------------------------

/**
 * Analyze a single SKILL.md for brain-first compliance. Pure function —
 * no I/O, no side effects, no random clocks. Drives the doctor check,
 * the skillify-check gate, and the dry-fix MISSING_RULE detector.
 *
 * @param content  — raw SKILL.md content (incl. frontmatter)
 * @param skillName — stable identifier (manifest entry name or dir name)
 * @param frontmatter — pre-parsed frontmatter from `parseSkillFrontmatter()`,
 *                     or null if the skill has no YAML fence (treated as
 *                     empty frontmatter for analysis purposes)
 */
export function analyzeSkillBrainFirst(
  content: string,
  skillName: string,
  frontmatter: ParsedFrontmatter | null,
): BrainFirstAnalysis {
  const formerly = FORMERLY_HARDCODED_EXEMPT.has(skillName);
  const typo_hint = frontmatter?.brain_first_typo
    ? formatBrainFirstTypoHint(frontmatter.brain_first_typo) ?? undefined
    : undefined;

  // Exemption 1: explicit declarative opt-out
  if (frontmatter?.brain_first === 'exempt') {
    return {
      skill: skillName,
      status: 'ok',
      reason: 'exempt_explicit',
      external_patterns_matched: [],
      typo_hint,
      formerly_hardcoded_exempt: formerly,
    };
  }

  // Body extraction — strip frontmatter so a `tools: [web_search]`
  // declaration in YAML doesn't false-flag the skill (F6 from review).
  const body = stripFrontmatter(content);

  // Scan body for external-lookup patterns.
  const external_patterns_matched = EXTERNAL_LOOKUP_PATTERNS
    .filter(p => p.re.test(body))
    .map(p => p.name);

  // Exemption 2: no external pattern present anywhere in body. Trivially
  // doesn't need brain-first — the skill never reaches for external data.
  if (external_patterns_matched.length === 0) {
    return {
      skill: skillName,
      status: 'ok',
      reason: 'exempt_no_external',
      external_patterns_matched: [],
      typo_hint,
      formerly_hardcoded_exempt: formerly,
    };
  }

  // External pattern present → apply compliance ladder.

  // Compliance a: canonical Convention callout referencing brain-first.
  if (CONVENTION_CALLOUT_RE.test(body)) {
    return {
      skill: skillName,
      status: 'ok',
      reason: 'compliant_callout',
      external_patterns_matched,
      typo_hint,
      formerly_hardcoded_exempt: formerly,
    };
  }

  // Compliance b: explicit Phase 1 / Step 0 brain heading.
  if (PHASE_HEADING_RE.test(body)) {
    return {
      skill: skillName,
      status: 'ok',
      reason: 'compliant_phase',
      external_patterns_matched,
      typo_hint,
      formerly_hardcoded_exempt: formerly,
    };
  }

  // Compliance c: first brain reference appears BEFORE first external
  // reference in body. Position-relative ordering — body-only by
  // construction (we're scanning `body`, not `content`).
  const firstBrainOffset = findFirstBrainRefOffset(body);
  const firstExternalOffset = findFirstExternalRefOffset(body);
  if (
    firstBrainOffset !== -1 &&
    firstExternalOffset !== -1 &&
    firstBrainOffset < firstExternalOffset
  ) {
    return {
      skill: skillName,
      status: 'ok',
      reason: 'compliant_position',
      external_patterns_matched,
      typo_hint,
      formerly_hardcoded_exempt: formerly,
    };
  }

  // Otherwise: external pattern present, no compliance signal. Warn.
  return {
    skill: skillName,
    status: 'warn',
    reason: 'missing_brain_first',
    external_patterns_matched,
    typo_hint,
    formerly_hardcoded_exempt: formerly,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Return the SKILL.md content with the leading YAML frontmatter fence
 * stripped. If no fence is present, returns the input unchanged.
 *
 * Critical for position-relative scanning (F6): `tools: [web_search]`
 * in frontmatter must not count as the "first external reference."
 */
export function stripFrontmatter(content: string): string {
  return content.replace(FRONTMATTER_RE, '');
}

/**
 * Offset (0-indexed) of the first brain-reference match in body, or -1.
 * Scans through BRAIN_REFERENCE_PATTERNS in declared order; returns the
 * MINIMUM matching offset across all patterns (so multi-pattern hits
 * still surface the earliest).
 */
export function findFirstBrainRefOffset(body: string): number {
  let min = -1;
  for (const re of BRAIN_REFERENCE_PATTERNS) {
    const m = body.match(re);
    if (m && m.index !== undefined) {
      if (min === -1 || m.index < min) min = m.index;
    }
  }
  return min;
}

/**
 * Offset (0-indexed) of the first external-reference match in body, or -1.
 * Sibling of findFirstBrainRefOffset; same minimum-across-patterns semantics.
 */
export function findFirstExternalRefOffset(body: string): number {
  let min = -1;
  for (const { re } of EXTERNAL_LOOKUP_PATTERNS) {
    const m = body.match(re);
    if (m && m.index !== undefined) {
      if (min === -1 || m.index < min) min = m.index;
    }
  }
  return min;
}

// ---------------------------------------------------------------------------
// Message builder — used by doctor + skillify-check + dry-fix
// ---------------------------------------------------------------------------

/**
 * Build a human-readable per-skill summary line. Used by the doctor
 * message + skillify-check error output. Includes the typo hint and
 * the formerly-hardcoded-exempt note when applicable.
 */
export function buildBrainFirstSummaryLine(a: BrainFirstAnalysis): string {
  if (a.status === 'ok') {
    return `${a.skill}: ok (${a.reason})`;
  }
  const parts: string[] = [
    `${a.skill}: external lookup (${a.external_patterns_matched.join(', ')}) without brain-first compliance`,
  ];
  if (a.formerly_hardcoded_exempt) {
    parts.push(
      `(was hardcoded-exempt in PR #1206 — opt out explicitly via 'brain_first: exempt' or run 'gbrain doctor --fix' to add the canonical callout)`,
    );
  }
  if (a.typo_hint) {
    parts.push(`(typo: ${a.typo_hint})`);
  }
  return parts.join(' ');
}
