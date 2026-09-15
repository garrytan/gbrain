/**
 * v0.37.x — T2 amended (TX3 load-bearing): brainstorm crash + --resume.
 *
 * Stub chatFn succeeds on the first N crosses and throws BudgetExhausted
 * on cross N+1 (mid-run crash). First runBrainstorm aborts; reading the
 * checkpoint shows full idea bodies for the completed crosses.
 *
 * Second runBrainstorm with resumeRunId continues from the next cross.
 * **The merged BrainstormResult MUST contain the ideas from the
 * pre-crash crosses (loaded from disk) AND the post-resume crosses.**
 * This is the codex load-bearing finding — resume must produce correct
 * output, not just "pick up where we left off".
 *
 * Schema note: pglite-engine.ts + postgres-engine.ts both query a
 * `page_links` relation. v0.38 lands the `page_links` VIEW (alias of the
 * canonical `links` table) in both the embedded PGLite schema bundle and
 * Postgres migration v81. This test no longer needs a workaround view.
 */

import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { ChunkInput } from '../../src/core/types.ts';
import {
  runBrainstorm,
  BRAINSTORM_PROFILE,
  type BrainstormProfile,
  BudgetExhausted,
} from '../../src/core/brainstorm/orchestrator.ts';
import {
  loadCheckpoint,
} from '../../src/core/brainstorm/checkpoint.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { persistSavedIdea } from '../../src/commands/brainstorm.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';

let engine: PGLiteEngine;
let tmp: string;
let homeBackup: string | undefined;

function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const v = new Float32Array(dim);
  v[idx % dim] = 1.0;
  return v;
}

async function seedSmallBrain(): Promise<void> {
  // 2 close + 4 far across 2 distinct prefixes.
  const closeSlugs = ['wiki/close-a', 'wiki/close-b'];
  const farSlugs = [
    'concepts/decay-a',
    'concepts/decay-b',
    'people/founder-a',
    'people/founder-b',
  ];

  for (let i = 0; i < closeSlugs.length; i++) {
    const slug = closeSlugs[i];
    await engine.putPage(slug, {
      type: 'note',
      title: `Close ${slug}`,
      compiled_truth: `resume merge crash question test fixture body for close anchor ${slug}`,
      timeline: '',
    });
    await engine.upsertChunks(slug, [
      {
        chunk_index: 0,
        chunk_text: `resume merge crash question test ${slug}`,
        chunk_source: 'compiled_truth',
        embedding: basisEmbedding(10 + i),
        token_count: 6,
      },
    ] satisfies ChunkInput[]);
  }

  for (let i = 0; i < farSlugs.length; i++) {
    const slug = farSlugs[i];
    await engine.putPage(slug, {
      type: 'note',
      title: `Far ${slug}`,
      compiled_truth: `Far content for ${slug}: distant cross-domain body.`,
      timeline: '',
    });
    await engine.upsertChunks(slug, [
      {
        chunk_index: 0,
        chunk_text: `cross-domain text ${slug}`,
        chunk_source: 'compiled_truth',
        embedding: basisEmbedding(200 + i),
        token_count: 6,
      },
    ] satisfies ChunkInput[]);
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // page_links view is provided by the embedded schema bundle (v0.38).
  await seedSmallBrain();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-resume-e2e-'));
  homeBackup = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = tmp;
});

afterEach(() => {
  if (homeBackup === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = homeBackup;
  rmSync(tmp, { recursive: true, force: true });
});

function makeChatFnMixed(failOnCrossCallN: number, judgeOpts: { garbage?: boolean } = {}) {
  let crossCalls = 0;
  let judgeCalls = 0;
  const fn = async (opts: ChatOpts): Promise<ChatResult> => {
    const userMsg = opts.messages.find((m) => m.role === 'user');
    const content = typeof userMsg?.content === 'string' ? userMsg.content : '';
    // Judge prompts include "(close=... × far=...)" lines below each `## Idea`
    // heading; cross prompts only contain `## Idea 1` / `## Idea 2` as format
    // instructions.
    const isJudge = /\(close=.* × far=.*\)/.test(content);
    if (isJudge) {
      judgeCalls++;
      if (judgeOpts.garbage) {
        // #4766: a single malformed judge response (parseJudgeJSON throws).
        const text = 'not json at all';
        return {
          text,
          blocks: [{ type: 'text', text }],
          stopReason: 'end',
          model: 'claude-sonnet-4-6',
          providerId: 'fake',
          usage: { input_tokens: 200, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
        };
      }
      const ideaIds = Array.from(content.matchAll(/## Idea (\S+)/g)).map((m) => m[1] as string);
      const json = {
        ideas: ideaIds.map((id) => ({
          id,
          scores: { originality: 4, resistance: 4, thesis_density: 4, concrete_grounding: 4, cognitive_load: 4 },
          note: 'mock judge',
        })),
      };
      const text = '```json\n' + JSON.stringify(json) + '\n```';
      return {
        text,
        blocks: [{ type: 'text', text }],
        stopReason: 'end',
        model: 'claude-sonnet-4-6',
        providerId: 'fake',
        usage: { input_tokens: 200, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 },
      };
    }
    crossCalls++;
    if (crossCalls === failOnCrossCallN) {
      throw new BudgetExhausted(
        `synthetic mid-run crash on cross call ${crossCalls}`,
        { reason: 'cost', spent: 1.5, cap: 1.0 },
      );
    }
    const closeMatch = content.match(/\[(wiki\/close-[ab])\]/);
    const farMatch = content.match(/\[((?:concepts|people)\/[\w-]+)\]/);
    const closeSlug = closeMatch?.[1] ?? 'unknown';
    const farSlug = farMatch?.[1] ?? 'unknown';
    const ideaText = `IDEA-FOR-${closeSlug}--${farSlug}--call${crossCalls}`;
    const text = `1. ${ideaText}\n2. backup idea ${crossCalls}\n3. extra idea ${crossCalls}`;
    return {
      text,
      blocks: [{ type: 'text', text }],
      stopReason: 'end',
      model: 'claude-haiku-4-5-20251001',
      providerId: 'fake',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    };
  };
  return { fn, get crossCalls() { return crossCalls; }, get judgeCalls() { return judgeCalls; } };
}

const tinyProfile: BrainstormProfile = {
  ...BRAINSTORM_PROFILE,
  k_close: 2,
  m_far: 4,
  ideas_per_cross: 1,
};

describe('brainstorm --resume (TX3 load-bearing)', () => {
  test('crash on cross 4 → first run aborts, checkpoint has crosses 1..N with full idea bodies', async () => {
    const chat1 = makeChatFnMixed(4);
    let err1: unknown = null;
    try {
      await runBrainstorm(engine, {}, {
        question: 'test resume crash question',
        profile: tinyProfile,
        skipCostPreview: true,
        maxCostUsd: 100,
        chatFn: chat1.fn,
        embedQueryFn: async () => basisEmbedding(0),
        stderrWrite: () => {},
      });
    } catch (e) {
      err1 = e;
    }
    expect(err1).toBeInstanceOf(BudgetExhausted);

    const dir = join(tmp, '.gbrain', 'brainstorm');
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1);
    const runId = files[0].replace(/\.json$/, '');
    const cp = loadCheckpoint(runId);
    expect(cp).not.toBeNull();
    expect(cp!.completed_crosses.length).toBeGreaterThanOrEqual(1);
    // TX3 load-bearing — full idea bodies, not just counts.
    for (const cc of cp!.completed_crosses) {
      expect(cc.ideas.length).toBeGreaterThanOrEqual(1);
      expect(cc.ideas[0].text.length).toBeGreaterThan(0);
    }
  });

  test('second run with resumeRunId merges pre-crash ideas with post-resume ideas (TX3 contract)', async () => {
    // First run: crash on cross 4 (mid-loop).
    const chat1 = makeChatFnMixed(4);
    try {
      await runBrainstorm(engine, {}, {
        question: 'test resume merge question',
        profile: tinyProfile,
        skipCostPreview: true,
        maxCostUsd: 100,
        chatFn: chat1.fn,
        embedQueryFn: async () => basisEmbedding(0),
        stderrWrite: () => {},
      });
    } catch {
      // expected
    }
    const dir = join(tmp, '.gbrain', 'brainstorm');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1);
    const runId = files[0].replace(/\.json$/, '');
    const cpBefore = loadCheckpoint(runId)!;
    const preCrashIdeaTexts = cpBefore.completed_crosses.flatMap((cc) => cc.ideas.map((i) => i.text));
    expect(preCrashIdeaTexts.length).toBeGreaterThanOrEqual(1);

    // Second run: no crash, no failures.
    const chat2 = makeChatFnMixed(99999);
    const result = await runBrainstorm(engine, {}, {
      question: 'test resume merge question',
      profile: tinyProfile,
      skipCostPreview: true,
      maxCostUsd: 100,
      chatFn: chat2.fn,
      embedQueryFn: async () => basisEmbedding(0),
      stderrWrite: () => {},
      resumeRunId: runId,
    });

    // TX3: every pre-crash idea text from disk MUST appear in the
    // merged result. Resume cannot drop them silently.
    const allIdeaTexts = result.ideas.map((i) => i.text);
    for (const pre of preCrashIdeaTexts) {
      expect(allIdeaTexts).toContain(pre);
    }

    // Total idea count: profile is k_close=2, m_far=4, ideas_per_cross=1
    // → 8 ideas in a clean run. The judge may filter; check raw count
    // by total entries in BrainstormResult.ideas.
    expect(result.ideas.length).toBe(8);

    // After clean completion the checkpoint is cleared.
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBe(0);
  });

  test('resumeRunId with mismatched id refuses with paste-ready hint', async () => {
    const chat = makeChatFnMixed(99999);
    let caught: unknown = null;
    try {
      await runBrainstorm(engine, {}, {
        question: 'mismatch test question',
        profile: tinyProfile,
        skipCostPreview: true,
        chatFn: chat.fn,
        embedQueryFn: async () => basisEmbedding(0),
        stderrWrite: () => {},
        resumeRunId: 'deadbeefcafe0000',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/--resume run_id=deadbeefcafe0000 does not match/);
  });
});

// F2 smoke test: end-to-end --max-cost pre-flight refusal. The user-facing
// path is "estimate exceeds cap, run aborts before any LLM call". This pins
// the (a) typed-throw, (b) reason='cost', (c) paste-ready error message
// content, and (d) that no chatFn calls happen during pre-flight.
describe('brainstorm --max-cost pre-flight refusal (F2 smoke)', () => {
  test('estimate above cap → BudgetExhausted(reason="cost") before any chat call', async () => {
    const chat = makeChatFnMixed(99999);
    let caught: unknown = null;
    try {
      await runBrainstorm(engine, {}, {
        question: 'pre-flight cap smoke question',
        profile: tinyProfile,
        skipCostPreview: true,
        // Pre-run estimate is at the cents level; $0.0001 forces a refusal.
        maxCostUsd: 0.0001,
        chatFn: chat.fn,
        embedQueryFn: async () => basisEmbedding(0),
        stderrWrite: () => {},
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BudgetExhausted);
    const err = caught as BudgetExhausted;
    expect(err.reason).toBe('cost');
    // User-facing hint must point at remediation paths so the operator
    // can fix forward without reading the source.
    expect(err.message).toMatch(/exceeds --max-cost/);
    expect(err.message).toMatch(/--limit/);
    expect(err.message).toMatch(/--max-far-set/);
    // No chat calls during pre-flight — the cap fires before any provider
    // HTTP would happen on a real run.
    expect(chat.crossCalls).toBe(0);
    expect(chat.judgeCalls).toBe(0);
  });
});

// #4766: a judge failure must NOT destroy the paid cross results, and the
// remediation it prints must be a flag that exists. Pre-fix the cleanup
// branch keyed on failed_crosses only, so all-crosses-green + judge-failed
// marked judge_done and unlinked the checkpoint, while the advice named a
// `--retry-judge` flag that no parser handled. `--resume <run_id>` already IS
// the judge-only retry: completed crosses short-circuit from disk and Phase 4
// always runs.
describe('brainstorm judge failure keeps the checkpoint; --resume re-scores (#4766)', () => {
  test('judge parse failure → checkpoint retained (judge_done=false, every cross on disk), stderr names --resume', async () => {
    const chat = makeChatFnMixed(99999, { garbage: true });
    const stderrChunks: string[] = [];
    const result = await runBrainstorm(engine, {}, {
      question: 'judge failure keeps checkpoint question',
      profile: tinyProfile,
      skipCostPreview: true,
      maxCostUsd: 100,
      chatFn: chat.fn,
      embedQueryFn: async () => basisEmbedding(0),
      stderrWrite: (s) => { stderrChunks.push(s); },
    });
    expect(result.judge_failed).toBe(true);
    expect(chat.judgeCalls).toBeGreaterThanOrEqual(1);

    const dir = join(tmp, '.gbrain', 'brainstorm');
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
    expect(files.length).toBe(1);
    const runId = files[0].replace(/\.json$/, '');
    const cp = loadCheckpoint(runId);
    expect(cp).not.toBeNull();
    expect(cp!.judge_done).toBe(false);
    // k_close=2 × m_far=4 = 8 crosses, all paid for, all still on disk.
    expect(cp!.completed_crosses.length).toBe(chat.crossCalls);
    expect(cp!.failed_crosses.length).toBe(0);

    const stderr = stderrChunks.join('');
    expect(stderr).toContain(`--resume ${runId}`);
    expect(stderr).not.toContain('--retry-judge');
  });

  test('second run with resumeRunId + healthy judge re-scores WITHOUT re-paying any cross', async () => {
    const bad = makeChatFnMixed(99999, { garbage: true });
    await runBrainstorm(engine, {}, {
      question: 'judge failure then resume question',
      profile: tinyProfile,
      skipCostPreview: true,
      maxCostUsd: 100,
      chatFn: bad.fn,
      embedQueryFn: async () => basisEmbedding(0),
      stderrWrite: () => {},
    });
    const dir = join(tmp, '.gbrain', 'brainstorm');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1);
    const runId = files[0].replace(/\.json$/, '');

    const good = makeChatFnMixed(99999);
    const result = await runBrainstorm(engine, {}, {
      question: 'judge failure then resume question',
      profile: tinyProfile,
      skipCostPreview: true,
      maxCostUsd: 100,
      chatFn: good.fn,
      embedQueryFn: async () => basisEmbedding(0),
      stderrWrite: () => {},
      resumeRunId: runId,
    });
    expect(good.crossCalls).toBe(0);
    expect(good.judgeCalls).toBe(1);
    expect(result.judge_failed).toBe(false);
    expect(result.ideas.length).toBe(8);
    expect(result.ideas.every((i) => i.judge !== undefined)).toBe(true);
    // Clean completion clears the checkpoint as before.
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBe(0);
  });

  // Pre-landing review: the CLI's save slug carries a random nonce, so a
  // `--resume` after a judge failure saved a SECOND idea page under a fresh
  // slug (and the saved-page comment promised a re-score path that did not
  // exist). The slug now rides in the checkpoint (`ideaSlug` in → `idea_slug`
  // out) so the re-scored run overwrites the page the failed run saved.
  test('resume returns the idea_slug the judge-failed run saved under, so exactly ONE idea page exists after re-score', async () => {
    const question = 'judge failure slug question';
    const pageFor = (slug: string) =>
      serializeMarkdown({ mode: 'brainstorm', question, saved_as: slug }, `# Brainstorm: ${question}\n\nbody`, '', {
        type: 'note',
        title: `Brainstorm: ${question}`,
        tags: [],
      });
    const firstSlug = 'wiki/ideas/2026-01-01-brainstorm-judge-failure-slug-question-aaaaaa';
    const bad = makeChatFnMixed(99999, { garbage: true });
    const first = await runBrainstorm(engine, {}, {
      question,
      profile: tinyProfile,
      skipCostPreview: true,
      maxCostUsd: 100,
      chatFn: bad.fn,
      embedQueryFn: async () => basisEmbedding(0),
      stderrWrite: () => {},
      ideaSlug: firstSlug,
    });
    expect(first.judge_failed).toBe(true);
    expect(first.idea_slug).toBe(firstSlug);
    const dir = join(tmp, '.gbrain', 'brainstorm');
    const runId = readdirSync(dir).filter((f) => f.endsWith('.json'))[0]!.replace(/\.json$/, '');
    expect(loadCheckpoint(runId)?.idea_slug).toBe(firstSlug);

    // The CLI mints a fresh (random-nonce, next-day) slug on every invocation;
    // the checkpoint's slug must win over it.
    const secondSlug = 'wiki/ideas/2026-01-02-brainstorm-judge-failure-slug-question-bbbbbb';
    const good = makeChatFnMixed(99999);
    const second = await runBrainstorm(engine, {}, {
      question,
      profile: tinyProfile,
      skipCostPreview: true,
      maxCostUsd: 100,
      chatFn: good.fn,
      embedQueryFn: async () => basisEmbedding(0),
      stderrWrite: () => {},
      resumeRunId: runId,
      ideaSlug: secondSlug,
    });
    expect(second.judge_failed).toBe(false);
    expect(second.idea_slug).toBe(firstSlug);

    // What the CLI does with each result: save it under `result.idea_slug ??
    // <fresh slug>`. Both saves run after the two brainstorms so the saved
    // page does not join the close/far candidate pool and shift the run_id.
    await persistSavedIdea(engine, { slug: first.idea_slug ?? firstSlug, content: pageFor(firstSlug), provenanceVia: 'brainstorm' });
    await persistSavedIdea(engine, { slug: second.idea_slug ?? secondSlug, content: pageFor(secondSlug), provenanceVia: 'brainstorm' });
    try {
      const ideaPages = (await engine.listPages()).filter((p) => p.slug.startsWith('wiki/ideas/'));
      expect(ideaPages.map((p) => p.slug)).toEqual([firstSlug]);
    } finally {
      for (const slug of [firstSlug, secondSlug]) await engine.deletePage(slug).catch(() => {});
    }
  });
});
