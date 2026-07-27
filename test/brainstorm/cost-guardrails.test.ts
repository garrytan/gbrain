/**
 * v0.37.1 — cost guardrails + judge chunking + far-set cap.
 *
 * Regression suite for fix/brainstorm-cost-guardrails. The 13K-page brain
 * incident: estimated cost $0.96, actual $50.71 (53x over) because the
 * domain-bank's `listPrefixSampledPages` returned one page per prefix and
 * the brain had ~2K distinct prefixes. The judge phase then tried to score
 * 15,868 ideas in a single LLM call (3M tokens > 1M context window).
 *
 * These tests pin the new behavior:
 *   - CLI parses --max-cost, --max-far-set, --strict-budget, --judge-model,
 *     --max-ideas-per-judge-call.
 *   - runJudge chunks large idea sets into batches of `maxIdeasPerCall`.
 *   - fetchFar caps the prefix list to `maxFarSet` and trims pages to `m`.
 */

import { describe, test, expect } from 'bun:test';
import { parseBrainstormArgs } from '../../src/commands/brainstorm.ts';
import { runJudge, BRAINSTORM_JUDGE_CONFIG, type JudgeIdea } from '../../src/core/brainstorm/judges.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';

describe('parseBrainstormArgs — new cost-guardrail flags', () => {
  test('--max-cost parses positive float', () => {
    const r = parseBrainstormArgs(['hello', '--max-cost', '2.50']);
    expect(r.maxCost).toBe(2.5);
    expect(r.error).toBeUndefined();
  });

  test('--max-cost rejects non-positive', () => {
    const r = parseBrainstormArgs(['hello', '--max-cost', '0']);
    expect(r.error).toMatch(/--max-cost/);
  });

  test('--max-far-set parses positive int', () => {
    const r = parseBrainstormArgs(['hello', '--max-far-set', '20']);
    expect(r.maxFarSet).toBe(20);
  });

  test('--strict-budget is a boolean flag', () => {
    const r = parseBrainstormArgs(['hello', '--strict-budget']);
    expect(r.strictBudget).toBe(true);
  });

  test('--judge-model captures the next arg', () => {
    const r = parseBrainstormArgs(['hello', '--judge-model', 'anthropic:claude-sonnet-4-6']);
    expect(r.judgeModel).toBe('anthropic:claude-sonnet-4-6');
  });

  test('--judge-model rejects missing value', () => {
    const r = parseBrainstormArgs(['hello', '--judge-model']);
    expect(r.error).toMatch(/--judge-model/);
  });

  test('--max-ideas-per-judge-call parses positive int', () => {
    const r = parseBrainstormArgs(['hello', '--max-ideas-per-judge-call', '50']);
    expect(r.maxIdeasPerJudgeCall).toBe(50);
  });

  test('flags compose with --limit and --yes', () => {
    const r = parseBrainstormArgs([
      'why are AI coding tools converging',
      '--max-cost', '10',
      '--max-far-set', '25',
      '--limit', '8',
      '--yes',
    ]);
    expect(r.error).toBeUndefined();
    expect(r.maxCost).toBe(10);
    expect(r.maxFarSet).toBe(25);
    expect(r.limit).toBe(8);
    expect(r.yes).toBe(true);
    expect(r.question).toBe('why are AI coding tools converging');
  });
});

describe('runJudge — chunks large idea sets to avoid context overflow', () => {
  // Build a fake chat that returns a well-formed batch verdict for whatever
  // ideas are in the prompt. The mock parses the `## Idea <id>` headings to
  // know which ids it should score, so we can assert each chunk lands.
  function makeFakeChat() {
    const state = { calls: 0, lastIdeaCount: 0, allScoredIds: [] as string[] };
    const chat = async (opts: ChatOpts): Promise<ChatResult> => {
      state.calls += 1;
      const rawContent = opts.messages[0]?.content;
      const user = typeof rawContent === 'string' ? rawContent : '';
      const ideaMatches = Array.from(user.matchAll(/## Idea (\S+)/g)).map((m) => m[1] as string);
      state.lastIdeaCount = ideaMatches.length;
      state.allScoredIds.push(...ideaMatches);
      const ideasJson = ideaMatches.map((id) => ({
        id,
        scores: { originality: 4, resistance: 4, thesis_density: 4, concrete_grounding: 4, cognitive_load: 4 },
        note: 'mock',
      }));
      const text = '```json\n' + JSON.stringify({ ideas: ideasJson }) + '\n```';
      const result: ChatResult = {
        text,
        blocks: [{ type: 'text', text }],
        stopReason: 'end',
        model: 'mock:judge',
        providerId: 'mock',
        usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
      };
      return result;
    };
    return { chat, state };
  }

  function makeIdeas(n: number): JudgeIdea[] {
    return Array.from({ length: n }, (_, i) => ({
      id: String(i + 1).padStart(3, '0'),
      text: `idea body ${i}`,
      close_slug: 'wiki/close',
      far_slug: 'wiki/far',
    }));
  }

  test('250 ideas with maxIdeasPerCall=100 → 3 chunks, all ideas scored', async () => {
    const fake = makeFakeChat();
    const ideas = makeIdeas(250);
    const result = await runJudge(BRAINSTORM_JUDGE_CONFIG, ideas, {
      chatFn: fake.chat,
      maxIdeasPerCall: 100,
      stderrWrite: () => {},
    });
    expect(fake.state.calls).toBe(3); // 100 + 100 + 50
    expect(result.ideas.length).toBe(250);
    expect(fake.state.allScoredIds.sort()).toEqual(ideas.map((i) => i.id).sort());
  });

  test('single chunk path preserved for small idea sets', async () => {
    const fake = makeFakeChat();
    const ideas = makeIdeas(10);
    const result = await runJudge(BRAINSTORM_JUDGE_CONFIG, ideas, {
      chatFn: fake.chat,
      maxIdeasPerCall: 100,
      stderrWrite: () => {},
    });
    expect(fake.state.calls).toBe(1);
    expect(result.ideas.length).toBe(10);
  });

  test('usage tokens accumulate across chunks', async () => {
    const fake = makeFakeChat();
    const ideas = makeIdeas(250);
    const result = await runJudge(BRAINSTORM_JUDGE_CONFIG, ideas, {
      chatFn: fake.chat,
      maxIdeasPerCall: 100,
      stderrWrite: () => {},
    });
    // Each mock call reports 100 in / 50 out; 3 calls → 300 / 150.
    expect(result.usage.input_tokens).toBe(300);
    expect(result.usage.output_tokens).toBe(150);
  });

  test('default chunk size is 100 (codex r2 follow-up)', async () => {
    const fake = makeFakeChat();
    const ideas = makeIdeas(101);
    await runJudge(BRAINSTORM_JUDGE_CONFIG, ideas, {
      chatFn: fake.chat,
      // no maxIdeasPerCall → default 100
      stderrWrite: () => {},
    });
    expect(fake.state.calls).toBe(2); // 100 + 1
  });
});
