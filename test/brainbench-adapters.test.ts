/**
 * BrainBench adapters over a hermetic PGLite — the shared pipeline's budget
 * caps + suppression modes, and each adapter's seam contract deltas.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createBenchmarkBrain, resetTables } from '../src/eval/longmemeval/harness.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { seedBrain } from '../src/eval/brainbench/seed.ts';
import { runReflexPipeline, estimateTokens } from '../src/eval/brainbench/adapters/shared.ts';
import { OpenClawAdapter } from '../src/eval/brainbench/adapters/openclaw.ts';
import { ClaudeCodeAdapter } from '../src/eval/brainbench/adapters/claude-code.ts';
import { CodexAdapter } from '../src/eval/brainbench/adapters/codex.ts';
import type { BrainBenchFixture, PublicTurn } from '../src/eval/brainbench/types.ts';

let engine: PGLiteEngine;

const FIXTURE: BrainBenchFixture = {
  schema_version: 1,
  fixture_id: 'adapter-test',
  suites: ['know-to-ask'],
  seed_pages: [
    {
      slug: 'people/alice-example',
      content:
        '---\ntitle: Alice Example\ntype: person\naliases: [alice]\nsummary: Founder of Widget Co.\n---\n\nAlice Example founded Widget Co.\n',
    },
    {
      slug: 'companies/widget-co',
      content: '---\ntitle: Widget Co\ntype: company\nsummary: Seed-stage widget marketplace.\n---\n\nWidget Co.\n',
    },
    {
      slug: 'people/charlie-example',
      content: '---\ntitle: Charlie Example\ntype: person\nsummary: Angel investor.\n---\n\nCharlie.\n',
    },
  ],
  turns: [{ turn_id: 1, role: 'user', text: 'placeholder' }],
};

function turn(text: string, id = 1): PublicTurn {
  return { turn_id: id, role: 'user', text };
}

const VIEW = { fixture_id: 'adapter-test', active_source: 'default', turns: [] as PublicTurn[] };

beforeAll(async () => {
  engine = await createBenchmarkBrain();
  await seedBrain(engine, FIXTURE);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('runReflexPipeline (the ONE pipeline, decision 13)', () => {
  test('resolves the alias arm: bare capitalized first name → namespaced slug', async () => {
    // NB: "please ping Alice" not "Ping Alice" — a leading capitalized verb
    // would glue into one multi-token candidate run (entity-salience CAP_RUN).
    const block = await runReflexPipeline(engine, 'default', turn('Can you ping Alice about the round?'), '', {
      maxPointers: 3,
      suppression: 'prior-context',
    });
    expect(block?.pointers.map((p) => p.slug)).toContain('people/alice-example');
  }, 30_000);

  test('budget cap: maxPointers=1 truncates a multi-entity turn', async () => {
    const block = await runReflexPipeline(
      engine,
      'default',
      turn('Please intro Alice Example and Charlie Example to Widget Co.'),
      '',
      { maxPointers: 1, suppression: 'prior-context' },
    );
    expect(block?.pointers.length).toBe(1);
  }, 30_000);

  test('suppression prior-context: an already-seen slug is not re-injected; suppression none re-injects', async () => {
    const prior = 'earlier we discussed people/alice-example in detail';
    const suppressed = await runReflexPipeline(engine, 'default', turn('What about Alice Example?'), prior, {
      maxPointers: 3,
      suppression: 'prior-context',
    });
    expect(suppressed?.pointers.map((p) => p.slug) ?? []).not.toContain('people/alice-example');
    const reinjected = await runReflexPipeline(engine, 'default', turn('What about Alice Example?'), prior, {
      maxPointers: 3,
      suppression: 'none',
    });
    expect(reinjected?.pointers.map((p) => p.slug)).toContain('people/alice-example');
  }, 30_000);

  test('no candidates → null (silence, not an empty block)', async () => {
    const block = await runReflexPipeline(engine, 'default', turn('ok thanks, sounds good'), '', {
      maxPointers: 3,
      suppression: 'prior-context',
    });
    expect(block).toBeNull();
  }, 30_000);
});

describe('OpenClawAdapter (production seam)', () => {
  test('injects the production markdown pointer block and suppresses across turns', async () => {
    const a = new OpenClawAdapter();
    await a.beginConversation(engine, VIEW);
    const r1 = await a.replayTurn(turn('Catch me up on Alice Example.'), '');
    expect(r1.injectedSlugs).toContain('people/alice-example');
    expect(r1.injectedText).toContain('## Brain pages mentioned this turn');
    expect(r1.injectedTokens).toBe(estimateTokens(r1.injectedText));
    // Prior context carries the first injection → re-mention suppressed.
    const prior = `Catch me up on Alice Example.\n${r1.injectedText}`;
    const r2 = await a.replayTurn(turn('Does Alice Example have consent lined up?', 2), prior);
    expect(r2.injectedSlugs).not.toContain('people/alice-example');
    await a.endConversation();
  }, 30_000);
});

describe('ClaudeCodeAdapter (contract seam: hook wire shape, no conversation memory)', () => {
  test('round-trips the UserPromptSubmit JSON contract and ignores prior context', async () => {
    const a = new ClaudeCodeAdapter();
    await a.beginConversation(engine, VIEW);
    const prior = 'we already injected people/alice-example earlier';
    const r = await a.replayTurn(turn('Status on Alice Example?'), prior);
    // No memory: prior context does NOT suppress (the measured contract delta).
    expect(r.injectedSlugs).toContain('people/alice-example');
    await a.endConversation();
  }, 30_000);

  test('respects the 2-pointer hook budget', async () => {
    const a = new ClaudeCodeAdapter();
    await a.beginConversation(engine, VIEW);
    const r = await a.replayTurn(turn('Memo: Alice Example, Charlie Example, and Widget Co all in one.'), '');
    expect(r.injectedSlugs.length).toBeLessThanOrEqual(2);
    await a.endConversation();
  }, 30_000);
});

describe('CodexAdapter (contract seam: static preamble + ≤1 fragment)', () => {
  test('one fragment max; preamble slugs do NOT count as injections; preamble tokens land once', async () => {
    const a = new CodexAdapter();
    await a.beginConversation(engine, VIEW);
    const r1 = await a.replayTurn(turn('Brief me on Alice Example and Charlie Example.'), '');
    expect(r1.injectedSlugs.length).toBeLessThanOrEqual(1);
    // The preamble indexes every page, but only the fragment is scored.
    expect(r1.injectedSlugs.length).toBeLessThan(3);
    const r2 = await a.replayTurn(turn('And Widget Co?', 2), 'prior');
    // First turn carried the preamble cost; later turns don't re-pay it.
    expect(r1.injectedTokens).toBeGreaterThan(r2.injectedTokens);
    await a.endConversation();
  }, 30_000);
});

describe('sentinel isolation (the engine-sharing guarantee, eng-review D9)', () => {
  test('resetTables clears seeded pages AND facts between fixtures', async () => {
    await engine.insertFact(
      { fact: 'sentinel fact brainbench isolation', source: 'bench:test', embedding: null },
      { source_id: 'default' },
    ); // gbrain-allow-direct-insert: isolation probe in a throwaway benchmark brain
    await resetTables(engine);
    const pages = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pages WHERE slug = 'people/alice-example'`,
    );
    expect(pages[0].n).toBe('0');
    const facts = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM facts WHERE fact LIKE '%sentinel fact brainbench%'`,
    );
    expect(facts[0].n).toBe('0');
    // re-seed for any later test in this file (none currently, but keep the brain valid)
    await seedBrain(engine, FIXTURE);
  }, 30_000);
});
