import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runAutoPromote } from '../../src/core/auto-promote/service.ts';
import { defaultAutoPromoteConfig } from '../../src/core/auto-promote/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const NOW = '2026-06-01T00:00:00Z';

async function seedEligibleCandidate(engine: BrainEngine, id = 'cand-1') {
  return engine.createMemoryCandidateEntry({
    id, scope_id: 'workspace:default', candidate_type: 'fact',
    proposed_content: 'Acme raised a seed round.',
    source_refs: ['User, direct message, 2026-04-22 3:01 PM KST'],
    generated_by: 'manual', extraction_kind: 'manual',
    confidence_score: 0.95, importance_score: 0.8, recurrence_score: 0.2,
    sensitivity: 'work', status: 'captured',
    target_object_type: 'curated_note', target_object_id: 'concepts/acme',
    reviewed_at: null, review_reason: null,
  });
}
async function withEngine(fn: (engine: PGLiteEngine) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-svc-'));
  const engine = new PGLiteEngine();
  try {
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();
    await fn(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}
const stubExecutor = (decision: string, confidence: number) => async (_req?: any) => ({
  status: 'succeeded' as const,
  output: JSON.stringify({ decision, confidence, reasoning: 'stub', source_refs: [] }),
  token_usage_json: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, cost_estimate_usd: null,
});
const stubContext = async () => '';

describe('runAutoPromote', () => {
  it('promotes a low-risk candidate via a confident stub verdict', async () => {
    await withEngine(async (engine) => {
      const candidate = await seedEligibleCandidate(engine);
      const res = await runAutoPromote({
        engine, config: { ...defaultAutoPromoteConfig(), enabled: true }, now: NOW,
        runnerExecutor: stubExecutor('promote', 0.95), contextLoader: stubContext,
        runner: { kind: 'claude_code' } as any,
      });
      expect(res.counts.auto_promoted).toBe(1);
      expect((await engine.getMemoryCandidateEntry(candidate.id))?.status).toBe('promoted');
    });
  });
  it('caches verdicts (executor called once across two runs)', async () => {
    await withEngine(async (engine) => {
      await seedEligibleCandidate(engine);
      let calls = 0;
      const counting = async (req: any) => { calls++; return stubExecutor('defer', 0.3)(req); };
      const cfg = { ...defaultAutoPromoteConfig(), enabled: true };
      await runAutoPromote({ engine, config: cfg, now: NOW, runnerExecutor: counting, contextLoader: stubContext, runner: { kind: 'claude_code' } as any });
      await runAutoPromote({ engine, config: cfg, now: NOW, runnerExecutor: counting, contextLoader: stubContext, runner: { kind: 'claude_code' } as any });
      expect(calls).toBe(1);
    });
  });
  it('does nothing when disabled', async () => {
    await withEngine(async (engine) => {
      await seedEligibleCandidate(engine);
      const res = await runAutoPromote({ engine, config: defaultAutoPromoteConfig(), now: NOW, runnerExecutor: stubExecutor('promote', 1), contextLoader: stubContext, runner: { kind: 'claude_code' } as any });
      expect(res.counts.auto_promoted).toBe(0);
    });
  });
});
