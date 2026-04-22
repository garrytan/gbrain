/**
 * routing-eval.ts — Check 5 of the skillify checklist.
 *
 * Validates that given a user intent, the skill-resolver table routes to
 * the correct skill. Two layers (per the essay's "both layers matter"
 * framing):
 *
 *   Layer A (structural): always runs, no LLM. Normalize both the intent
 *     and each resolver trigger phrase, then check if any trigger is a
 *     substring of the intent. A fixture `expected_skill` passes iff:
 *       - that skill's trigger matches AND
 *       - no other skill's trigger matches (unambiguous)
 *     Supports negative cases (`expected_skill: null` — nothing should
 *     match) and ambiguity declarations (`ambiguous_with: [...]` — list
 *     of skills this intent is allowed to also match).
 *
 *   Layer B (LLM tie-break, optional): only runs via `gbrain routing-eval
 *     --llm`. Not yet implemented in v0.17 core; the CLI stubs the flag
 *     so call sites are ready.
 *
 * Fixture linter (D-CX-6): we reject fixtures where the normalized
 * `intent` is a verbatim substring of any trigger phrase attached to
 * its `expected_skill`. Copying trigger text into the intent turns
 * Layer A into a tautology (trigger ⊂ trigger). Fixtures must paraphrase.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseResolverEntries } from './check-resolvable.ts';

// ---------------------------------------------------------------------------
// Fixture types
// ---------------------------------------------------------------------------

export interface RoutingFixture {
  /** Natural-language user intent. Required. */
  intent: string;
  /**
   * Skill slug (matches the directory name under `skills/`) that should
   * fire. Use `null` for negative cases: "nothing should match this intent."
   */
  expected_skill: string | null;
  /**
   * Optional: skills the intent is ALLOWED to also match without being
   * flagged as ambiguous. Use for always-on skills that naturally
   * co-fire (signal-detector, brain-ops). Skills listed here are
   * exempted from the ambiguity check; a match that includes
   * `expected_skill` and zero-or-more `ambiguous_with` entries is
   * considered unambiguous.
   */
  ambiguous_with?: string[];
  /** Optional: source path this fixture came from. Populated by loader. */
  source?: string;
}

export interface RoutingReport {
  totalCases: number;
  top1Accuracy: number; // 0..1
  passed: number;
  missed: number;
  ambiguous: number;
  falsePositives: number; // negative cases that matched something
  details: RoutingCaseResult[];
}

export type RoutingOutcome =
  | 'pass'
  | 'missed' // expected_skill was not in match set
  | 'ambiguous' // matched expected AND others not listed in ambiguous_with
  | 'false_positive'; // negative case (expected null) matched something

export interface RoutingCaseResult {
  fixture: RoutingFixture;
  outcome: RoutingOutcome;
  matchedSkills: string[];
  note?: string;
}

// ---------------------------------------------------------------------------
// Normalization + trigger extraction
// ---------------------------------------------------------------------------

/**
 * Normalize a string for routing comparison:
 *   - lowercase
 *   - replace any non-alphanumeric char with a space
 *   - collapse whitespace
 *   - trim
 *
 * Stripping punctuation is deliberately aggressive. Question marks,
 * quotes, dashes, commas, and apostrophes all collapse to spaces. This
 * means `"What's up?"` and `whats up` compare equal — which is what
 * a routing match should do. The cost is slightly over-permissive
 * matching; the benefit is reliable matches across quote/punctuation
 * variants that agents emit in practice.
 */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Extract candidate trigger phrases from a resolver cell. Two shapes:
 *   1. Cell contains double-quoted strings → return each quoted phrase
 *      separately. Example: `"what do we know about", "tell me about"`
 *      → ["what do we know about", "tell me about"].
 *   2. Cell has no quotes → return [whole cell] as one phrase.
 *      Example: `Creating/enriching a person or company page` →
 *      ["creating enriching a person or company page"] (normalized).
 *
 * All returned phrases are normalized via `normalizeText`.
 */
export function extractTriggerPhrases(cellText: string): string[] {
  const quoted = [...cellText.matchAll(/"([^"]+)"/g)].map(m => m[1]);
  const source = quoted.length > 0 ? quoted : [cellText];
  return source
    .map(normalizeText)
    .filter(s => s.length >= 3); // drop empty or trivially-short phrases
}

// ---------------------------------------------------------------------------
// Resolver → skill-to-phrases index
// ---------------------------------------------------------------------------

export interface SkillTriggerIndex {
  /** Map of skill slug → set of normalized trigger phrases. */
  skillPhrases: Map<string, string[]>;
}

/** Skill slug extracted from a resolver skillPath like `skills/foo/SKILL.md` → `foo`. */
function skillSlugFromPath(skillPath: string): string | null {
  const m = skillPath.match(/^skills\/([^/]+)\/SKILL\.md/);
  return m ? m[1] : null;
}

export function indexResolverTriggers(resolverContent: string): SkillTriggerIndex {
  const entries = parseResolverEntries(resolverContent);
  const skillPhrases = new Map<string, string[]>();
  for (const e of entries) {
    if (e.isGStack) continue;
    const slug = skillSlugFromPath(e.skillPath);
    if (!slug) continue;
    const phrases = extractTriggerPhrases(e.trigger);
    const existing = skillPhrases.get(slug) ?? [];
    skillPhrases.set(slug, [...existing, ...phrases]);
  }
  return { skillPhrases };
}

// ---------------------------------------------------------------------------
// Structural routing match
// ---------------------------------------------------------------------------

export interface StructuralMatchResult {
  /** Skills whose trigger phrases are substrings of the normalized intent. */
  matched: string[];
  /** True if more than one non-always-on skill matched. */
  ambiguous: boolean;
}

/** Always-on skills routinely co-fire; a match that includes them
 *  alongside a specific target skill is NOT ambiguous. */
const ALWAYS_ON_SKILLS = new Set(['signal-detector', 'brain-ops', 'ingest']);

export function structuralRouteMatch(
  intent: string,
  index: SkillTriggerIndex,
): StructuralMatchResult {
  const normalizedIntent = normalizeText(intent);
  const matched: string[] = [];
  for (const [slug, phrases] of index.skillPhrases) {
    for (const phrase of phrases) {
      if (phrase.length === 0) continue;
      if (normalizedIntent.includes(phrase)) {
        matched.push(slug);
        break;
      }
    }
  }
  const specific = matched.filter(s => !ALWAYS_ON_SKILLS.has(s));
  return { matched, ambiguous: specific.length > 1 };
}

// ---------------------------------------------------------------------------
// Fixture linter + loader
// ---------------------------------------------------------------------------

export interface FixtureLintIssue {
  fixture: RoutingFixture;
  reason: 'intent_copies_trigger' | 'unknown_expected_skill' | 'invalid_shape';
  detail: string;
}

/**
 * Lint fixtures against the resolver (D-CX-6). Reject cases where:
 *   - The normalized intent EQUALS any trigger phrase for its
 *     expected skill (pure tautology — the fixture is the trigger).
 *   - The expected_skill is unknown to the resolver.
 *
 * We deliberately do NOT reject intents that merely CONTAIN trigger
 * words in a natural sentence (e.g. "please look up that paper"
 * containing trigger "look up"). Layer A's whole mechanism is
 * substring match on the resolver triggers; a fixture that embeds
 * trigger words in surrounding context is valid and useful. The
 * linter's job is to catch copy-paste tautologies, not word overlap.
 */
export function lintRoutingFixtures(
  fixtures: RoutingFixture[],
  index: SkillTriggerIndex,
): FixtureLintIssue[] {
  const issues: FixtureLintIssue[] = [];
  for (const f of fixtures) {
    if (typeof f.intent !== 'string' || f.intent.trim().length === 0) {
      issues.push({
        fixture: f,
        reason: 'invalid_shape',
        detail: 'intent must be a non-empty string',
      });
      continue;
    }
    if (f.expected_skill !== null && typeof f.expected_skill !== 'string') {
      issues.push({
        fixture: f,
        reason: 'invalid_shape',
        detail: 'expected_skill must be a string or null',
      });
      continue;
    }
    // Negative case (null) can't copy a trigger — skip that check.
    if (f.expected_skill === null) continue;
    if (!index.skillPhrases.has(f.expected_skill)) {
      issues.push({
        fixture: f,
        reason: 'unknown_expected_skill',
        detail: `expected_skill '${f.expected_skill}' is not in the resolver`,
      });
      continue;
    }
    const normalizedIntent = normalizeText(f.intent);
    const phrases = index.skillPhrases.get(f.expected_skill) ?? [];
    for (const phrase of phrases) {
      if (phrase.length > 0 && normalizedIntent === phrase) {
        issues.push({
          fixture: f,
          reason: 'intent_copies_trigger',
          detail: `intent is verbatim-identical to trigger phrase '${phrase}'`,
        });
        break;
      }
    }
  }
  return issues;
}

/**
 * Walk each child of skillsDir looking for `routing-eval.jsonl` and
 * return all fixtures with the source path attached. JSONL format:
 * one JSON object per non-empty line; lines starting with `//` or `#`
 * are skipped as comments. Malformed lines are returned as
 * no-fixture-but-log events via the returned `malformed[]` array.
 */
export interface LoadResult {
  fixtures: RoutingFixture[];
  malformed: { file: string; line: number; raw: string; error: string }[];
}

export function loadRoutingFixtures(skillsDir: string): LoadResult {
  const fixtures: RoutingFixture[] = [];
  const malformed: LoadResult['malformed'] = [];
  if (!existsSync(skillsDir)) return { fixtures, malformed };
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return { fixtures, malformed };
  }
  for (const entry of entries) {
    if (entry.startsWith('.') || entry.startsWith('_')) continue;
    const dir = join(skillsDir, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const fixturePath = join(dir, 'routing-eval.jsonl');
    if (!existsSync(fixturePath)) continue;

    let content: string;
    try {
      content = readFileSync(fixturePath, 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;
      if (raw.startsWith('//') || raw.startsWith('#')) continue;
      try {
        const obj = JSON.parse(raw) as RoutingFixture;
        fixtures.push({ ...obj, source: fixturePath });
      } catch (err) {
        malformed.push({
          file: fixturePath,
          line: i + 1,
          raw,
          error: (err as Error).message,
        });
      }
    }
  }
  return { fixtures, malformed };
}

// ---------------------------------------------------------------------------
// Main eval runner
// ---------------------------------------------------------------------------

export interface RunRoutingEvalOptions {
  /** Reserved for Layer B (LLM tie-break). Not implemented in v0.17. */
  llm?: boolean;
}

export function runRoutingEval(
  resolverContent: string,
  fixtures: RoutingFixture[],
  _opts: RunRoutingEvalOptions = {},
): RoutingReport {
  const index = indexResolverTriggers(resolverContent);
  const details: RoutingCaseResult[] = [];
  let passed = 0;
  let missed = 0;
  let ambiguous = 0;
  let falsePositives = 0;

  for (const fixture of fixtures) {
    const result = structuralRouteMatch(fixture.intent, index);
    let outcome: RoutingOutcome;
    let note: string | undefined;

    if (fixture.expected_skill === null) {
      // Negative case: nothing specific should match.
      const specific = result.matched.filter(s => !ALWAYS_ON_SKILLS.has(s));
      if (specific.length === 0) {
        outcome = 'pass';
        passed++;
      } else {
        outcome = 'false_positive';
        falsePositives++;
        note = `negative case unexpectedly matched: ${specific.join(', ')}`;
      }
    } else if (!result.matched.includes(fixture.expected_skill)) {
      outcome = 'missed';
      missed++;
      note =
        result.matched.length > 0
          ? `matched instead: ${result.matched.join(', ')}`
          : 'no matches';
    } else {
      // expected_skill matched; check for ambiguity beyond the allow-list.
      const allowed = new Set([
        ...(fixture.ambiguous_with ?? []),
        ...ALWAYS_ON_SKILLS,
        fixture.expected_skill,
      ]);
      const unexpected = result.matched.filter(s => !allowed.has(s));
      if (unexpected.length === 0) {
        outcome = 'pass';
        passed++;
      } else {
        outcome = 'ambiguous';
        ambiguous++;
        note = `also matched: ${unexpected.join(', ')}`;
      }
    }
    details.push({ fixture, outcome, matchedSkills: result.matched, note });
  }

  const totalCases = fixtures.length;
  const top1Accuracy = totalCases === 0 ? 1 : passed / totalCases;

  return {
    totalCases,
    top1Accuracy,
    passed,
    missed,
    ambiguous,
    falsePositives,
    details,
  };
}
