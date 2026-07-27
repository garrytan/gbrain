/**
 * v0.41.16.0 — Conversation parser quality eval.
 *
 * Pure functions consumed by `gbrain eval conversation-parser` and the
 * nightly probe. Inputs are JSONL fixtures; outputs are FixtureScore
 * rows + an EvalReport aggregate.
 *
 * Per Layer 4 of the plan:
 *   - Per-fixture row: matched_pattern_id, messages_parsed,
 *     expected_messages, recall, participants_recall.
 *   - Aggregate: pattern coverage %, recall mean, fail list.
 *
 * Fixture shape (one per JSONL line):
 *   {
 *     fixture_id: string,
 *     pattern: string | null,         // expected pattern id, null = adversarial (expects [])
 *     frontmatter: Record<string, unknown>,
 *     body: string,
 *     expected_messages: number,
 *     expected_participants: string[],
 *   }
 */

import { parseConversation } from './parse.ts';
import type { Page } from '../types.ts';

export interface ConversationFixture {
  fixture_id: string;
  pattern: string | null;
  frontmatter: Record<string, unknown>;
  body: string;
  expected_messages: number;
  expected_participants: string[];
}

export interface FixtureScore {
  fixture_id: string;
  expected_pattern: string | null;
  matched_pattern_id?: string;
  messages_parsed: number;
  expected_messages: number;
  recall: number;
  participants_recall: number;
  passed: boolean;
  reasons: string[];
}

export interface EvalReport {
  schema_version: 1;
  total_fixtures: number;
  passed: number;
  failed: number;
  recall_mean: number;
  participants_recall_mean: number;
  pattern_coverage: Record<string, number>;
  fixtures: FixtureScore[];
  failed_fixture_ids: string[];
}

/**
 * Score a single fixture against the parser. Pure function.
 *
 * Pass criteria:
 *   - Adversarial fixture (pattern=null, expected_messages=0):
 *     parser MUST return 0 messages (otherwise the LLM fallback
 *     hallucinated structure where there was none).
 *   - Positive fixture: matched_pattern_id MUST equal expected pattern
 *     id, AND recall MUST be >= the floor (default 0.9), AND
 *     participants_recall MUST be 1.0 (every expected speaker shows).
 */
export function scoreFixture(
  fixture: ConversationFixture,
  opts: { minRecall?: number; noLlm?: boolean } = {},
): FixtureScore {
  const minRecall = opts.minRecall ?? 0.9;
  const page = {
    frontmatter: fixture.frontmatter,
  } as unknown as Page;

  const result = parseConversation(fixture.body, {
    page,
    noPolish: opts.noLlm,
    noFallback: opts.noLlm,
  });

  const messages_parsed = result.messages.length;
  const expected_messages = fixture.expected_messages;
  const recall =
    expected_messages > 0 ? messages_parsed / expected_messages : 1;

  const expectedParticipantsSet = new Set(fixture.expected_participants);
  const actualParticipantsSet = new Set(result.messages.map((m) => m.speaker));
  const intersection = [...expectedParticipantsSet].filter((p) =>
    actualParticipantsSet.has(p),
  ).length;
  const participants_recall =
    expectedParticipantsSet.size > 0
      ? intersection / expectedParticipantsSet.size
      : 1;

  const reasons: string[] = [];
  let passed = true;

  // Adversarial fixture: must parse to 0.
  if (fixture.pattern === null) {
    if (messages_parsed > 0) {
      passed = false;
      reasons.push(
        `adversarial fixture: expected 0 messages, parser returned ${messages_parsed}`,
      );
    }
  } else {
    // Positive fixture: must hit expected pattern + recall.
    if (result.matched_pattern_id !== fixture.pattern) {
      passed = false;
      reasons.push(
        `expected pattern '${fixture.pattern}', got '${result.matched_pattern_id ?? 'no_match'}'`,
      );
    }
    if (recall < minRecall) {
      passed = false;
      reasons.push(
        `recall ${recall.toFixed(2)} < floor ${minRecall.toFixed(2)}`,
      );
    }
    if (participants_recall < 1.0) {
      passed = false;
      reasons.push(
        `participants_recall ${participants_recall.toFixed(2)} < 1.0`,
      );
    }
  }

  return {
    fixture_id: fixture.fixture_id,
    expected_pattern: fixture.pattern,
    matched_pattern_id: result.matched_pattern_id,
    messages_parsed,
    expected_messages,
    recall,
    participants_recall,
    passed,
    reasons,
  };
}

/**
 * Aggregate per-fixture scores into a stable JSON envelope for CI
 * gating + human reports.
 */
export function aggregateScores(
  scores: FixtureScore[],
): EvalReport {
  const total_fixtures = scores.length;
  const passed = scores.filter((s) => s.passed).length;
  const failed = total_fixtures - passed;
  const recall_mean =
    total_fixtures > 0
      ? scores.reduce((acc, s) => acc + s.recall, 0) / total_fixtures
      : 0;
  const participants_recall_mean =
    total_fixtures > 0
      ? scores.reduce((acc, s) => acc + s.participants_recall, 0) /
        total_fixtures
      : 0;

  const pattern_coverage: Record<string, number> = {};
  for (const s of scores) {
    const id = s.matched_pattern_id ?? '_no_match';
    pattern_coverage[id] = (pattern_coverage[id] ?? 0) + 1;
  }

  return {
    schema_version: 1,
    total_fixtures,
    passed,
    failed,
    recall_mean,
    participants_recall_mean,
    pattern_coverage,
    fixtures: scores,
    failed_fixture_ids: scores.filter((s) => !s.passed).map((s) => s.fixture_id),
  };
}

/**
 * Parse a JSONL file content into ConversationFixture[]. Skips
 * blank lines + comment lines (lines starting with `#`).
 *
 * Throws on malformed JSON (caller's CLI surfaces the line number).
 */
export function parseFixtureJsonl(content: string): ConversationFixture[] {
  const out: ConversationFixture[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `[conversation-parser eval] malformed JSON on line ${i + 1}: ${(err as Error).message}`,
      );
    }
    out.push(parsed as ConversationFixture);
  }
  return out;
}
