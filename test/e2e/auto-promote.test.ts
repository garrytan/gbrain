import { describe, it, expect, setDefaultTimeout } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runAutoPromote } from '../../src/core/auto-promote/service.ts';
import { defaultAutoPromoteConfig } from '../../src/core/auto-promote/config.ts';
import { createCliRunnerExecutor } from '../../src/core/auto-promote/cli-executor.ts';
import { parsePromotionVerdict } from '../../src/core/auto-promote/verdict.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const NOW = '2026-06-01T00:00:00Z';
setDefaultTimeout(20_000);

async function withEngine(fn: (engine: PGLiteEngine) => Promise<void>) {
  const engine = new PGLiteEngine();
  try {
    await engine.connect({ engine: 'pglite' });
    await engine.initSchema();
    await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

async function seed(engine: BrainEngine, id: string, overrides: Record<string, unknown>) {
  return engine.createMemoryCandidateEntry({
    id, scope_id: 'workspace:default', candidate_type: 'fact',
    proposed_content: 'placeholder',
    source_refs: ['User, direct message, 2026-04-22 3:01 PM KST'],
    generated_by: 'manual', extraction_kind: 'manual',
    confidence_score: 0.95, importance_score: 0.8, recurrence_score: 0.2,
    sensitivity: 'work', status: 'captured',
    target_object_type: 'curated_note', target_object_id: 'concepts/acme',
    reviewed_at: null, review_reason: null,
    ...overrides,
  } as any);
}

// Stub executor: promote the low-risk candidate, defer the risky one. Branches on prompt content.
function makeStubExecutor(counter: { calls: number }) {
  return async (req: any) => {
    counter.calls++;
    const isRisky = req.prompt.includes('RISKY');
    const verdict = isRisky
      ? { decision: 'defer', confidence: 0.3, reasoning: 'unsure', source_refs: [] }
      : { decision: 'promote', confidence: 0.95, reasoning: 'clear', source_refs: [] };
    return { status: 'succeeded' as const, output: JSON.stringify(verdict), token_usage_json: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, cost_estimate_usd: null };
  };
}
const stubContext = async () => '';
const RUN_REAL = !!process.env.MBRAIN_E2E_REAL_CLI;

describe('auto-promote E2E pipeline (PGLite, stub runner)', () => {
  it('promotes low-risk, defers risky, excludes secret; counts + cache correct', async () => {
    await withEngine(async (engine) => {
      await seed(engine, 'low', { proposed_content: 'LOW RISK eligible fact', extraction_kind: 'manual', sensitivity: 'work' });
      await seed(engine, 'risky', { proposed_content: 'RISKY inferred fact', extraction_kind: 'inferred', sensitivity: 'work' });
      await seed(engine, 'secret', { proposed_content: 'SECRET fact', extraction_kind: 'manual', sensitivity: 'secret' });

      const counter = { calls: 0 };
      const cfg = { ...defaultAutoPromoteConfig(), enabled: true };
      const args = { engine, config: cfg, now: NOW, runnerExecutor: makeStubExecutor(counter), contextLoader: stubContext, runner: { kind: 'claude_code' } as any };

      const res = await runAutoPromote(args);
      expect(res.counts.selected_low_risk).toBe(1);
      expect(res.counts.selected_risky).toBe(1);
      expect(res.counts.auto_promoted).toBe(1);
      expect(res.counts.canonical_handoffs).toBe(1);
      expect(res.counts.canonical_writes).toBe(1);
      expect(res.counts.escalated).toBe(1);
      expect(res.counts.deferred).toBe(1);
      expect(res.counts.excluded).toBe(1);
      expect((await engine.getMemoryCandidateEntry('low'))?.status).toBe('promoted');
      expect(await engine.listCanonicalHandoffEntries({ candidate_id: 'low' })).toHaveLength(1);
      expect((await engine.getPage('concepts/acme'))?.compiled_truth).toContain('LOW RISK eligible fact');
      // The gate only advances candidates it PROMOTES. A `defer` verdict means the
      // gate never calls advanceToStaged, so `risky` stays at its seeded `captured` status.
      expect((await engine.getMemoryCandidateEntry('risky'))?.status).toBe('captured');
      // `secret` is excluded by sensitivity before any judge call; never advanced.
      expect((await engine.getMemoryCandidateEntry('secret'))?.status).toBe('captured');

      const callsAfterFirst = counter.calls; // 2: low + risky judged; secret excluded, never judged
      expect(callsAfterFirst).toBe(2);

      // Second run: 'low' is now promoted (not selected); 'risky' stays selectable and its defer verdict is cached -> no new executor call.
      await runAutoPromote(args);
      expect(counter.calls).toBe(callsAfterFirst); // cache hit -> no additional executor calls
    });
  });

  it('dry_run promotes nothing', async () => {
    await withEngine(async (engine) => {
      await seed(engine, 'low', { proposed_content: 'LOW RISK eligible fact' });
      const counter = { calls: 0 };
      const cfg = { ...defaultAutoPromoteConfig(), enabled: true, dry_run: true };
      const res = await runAutoPromote({ engine, config: cfg, now: NOW, runnerExecutor: makeStubExecutor(counter), contextLoader: stubContext, runner: { kind: 'claude_code' } as any });
      expect(res.counts.auto_promoted).toBe(0);
      expect(res.counts.canonical_handoffs).toBe(0);
      expect(res.counts.canonical_writes).toBe(0);
      expect((await engine.getMemoryCandidateEntry('low'))?.status).not.toBe('promoted');
      expect(await engine.listCanonicalHandoffEntries({ candidate_id: 'low' })).toHaveLength(0);
    });
  });
});

describe('auto-promote real-CLI verdict (opt-in via MBRAIN_E2E_REAL_CLI)', () => {
  it.skipIf(!RUN_REAL)('parses a real claude/codex verdict', async () => {
    const exec = createCliRunnerExecutor({});
    const res = await exec({
      runner: { kind: 'claude_code' } as any,
      task_type: 'candidate_promotion_review' as any, source_scope: {} as any,
      prompt: 'Return ONLY this JSON and nothing else: {"decision":"defer","confidence":0.5,"reasoning":"test","source_refs":[]}',
      input: '', tool_policy: { status: 'allowed' } as any, allowed_tools: ['emit_promotion_verdict'] as any,
    });
    expect(res.status).toBe('succeeded');
    const parsed = parsePromotionVerdict(res.output, 'real-1');
    expect(parsed.ok).toBe(true);
  });
});
