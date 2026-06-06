import { describe, it, expect } from 'bun:test';
import { SQLiteEngine } from '../../src/core/sqlite-engine.ts';
import { runAutoPromote } from '../../src/core/auto-promote/service.ts';
import { defaultAutoPromoteConfig } from '../../src/core/auto-promote/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const NOW = '2026-06-01T00:00:00Z';

async function seedEligibleCandidate(engine: BrainEngine, id = 'cand-1', overrides: Record<string, unknown> = {}) {
  return engine.createMemoryCandidateEntry({
    id, scope_id: 'workspace:default', candidate_type: 'fact',
    proposed_content: 'Acme raised a seed round.',
    source_refs: ['User, direct message, 2026-04-22 3:01 PM KST'],
    generated_by: 'manual', extraction_kind: 'manual',
    confidence_score: 0.95, importance_score: 0.8, recurrence_score: 0.2,
    sensitivity: 'work', status: 'captured',
    target_object_type: 'curated_note', target_object_id: 'concepts/acme',
    reviewed_at: null, review_reason: null,
    ...overrides,
  });
}
async function seedTargetPage(engine: BrainEngine, content = 'Acme is tracked in MBrain. [Source: User, direct message, 2026-04-20 9:00 AM KST]') {
  return engine.putPage('concepts/acme', {
    type: 'concept',
    title: 'Acme',
    compiled_truth: content,
    timeline: '- **2026-04-20** | Initial Acme note. [Source: User, direct message, 2026-04-20 9:00 AM KST]',
    frontmatter: {},
  });
}
async function withEngine(fn: (engine: SQLiteEngine) => Promise<void>) {
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: ':memory:' });
    await engine.initSchema();
    await fn(engine);
  } finally {
    await engine.disconnect();
  }
}
const stubExecutor = (decision: string, confidence: number) => async (_req?: any) => ({
  status: 'succeeded' as const,
  output: JSON.stringify({ decision, confidence, reasoning: 'stub', source_refs: [] }),
  token_usage_json: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, cost_estimate_usd: null,
});
const stubContext = async () => '';
async function pageContext(engine: BrainEngine, targetRef: string) {
  const page = await engine.getPage(targetRef);
  return {
    text: page ? `${page.compiled_truth}\n\n---\n\n${page.timeline}` : '',
    content_hash: page?.content_hash ?? null,
  };
}

describe('runAutoPromote', () => {
  it('promotes a low-risk candidate via a confident stub verdict', async () => {
    await withEngine(async (engine) => {
      await seedTargetPage(engine);
      const candidate = await seedEligibleCandidate(engine);
      const res = await runAutoPromote({
        engine, config: { ...defaultAutoPromoteConfig(), enabled: true }, now: NOW,
        runnerExecutor: stubExecutor('promote', 0.95), contextLoader: (targetRef) => pageContext(engine, targetRef),
        runner: { kind: 'claude_code' } as any,
        allow_canonical_page_writes: true,
      });
      expect(res.counts.auto_promoted).toBe(1);
      expect(res.counts.canonical_handoffs).toBe(1);
      expect(res.counts.canonical_writes).toBe(1);
      expect((await engine.getMemoryCandidateEntry(candidate.id))?.status).toBe('promoted');
      expect((await engine.getPage('concepts/acme'))?.compiled_truth).toContain('Acme raised a seed round.');
      expect(await engine.listCanonicalHandoffEntries({ candidate_id: candidate.id })).toHaveLength(1);
    });
  });
  it('records a handoff but skips canonical write when the page changes after judgment', async () => {
    await withEngine(async (engine) => {
      const target = await seedTargetPage(engine);
      const candidate = await seedEligibleCandidate(engine);
      const res = await runAutoPromote({
        engine,
        config: { ...defaultAutoPromoteConfig(), enabled: true },
        now: NOW,
        runnerExecutor: async (req: any) => {
          await seedTargetPage(engine, 'Acme changed after judgment. [Source: User, direct message, 2026-04-21 9:00 AM KST]');
          return stubExecutor('promote', 0.95)(req);
        },
        contextLoader: async (targetRef) => {
          const page = await engine.getPage(targetRef);
          expect(page?.content_hash).toBe(target.content_hash);
          return { text: page?.compiled_truth ?? '', content_hash: page?.content_hash ?? null };
        },
        runner: { kind: 'claude_code' } as any,
        allow_canonical_page_writes: true,
      });

      expect(res.counts.auto_promoted).toBe(1);
      expect(res.counts.canonical_handoffs).toBe(1);
      expect(res.counts.canonical_writes).toBe(0);
      expect(res.excluded.find((entry) => entry.id === candidate.id)?.reason).toContain('content hash mismatch');
      expect((await engine.getPage('concepts/acme'))?.compiled_truth).not.toContain('Acme raised a seed round.');
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
  it('does not persist verdict cache rows during dry-run', async () => {
    await withEngine(async (engine) => {
      await seedEligibleCandidate(engine);
      const cfg = { ...defaultAutoPromoteConfig(), enabled: true, dry_run: true };

      await runAutoPromote({ engine, config: cfg, now: NOW, runnerExecutor: stubExecutor('defer', 0.3), contextLoader: stubContext, runner: { kind: 'claude_code' } as any });
      await runAutoPromote({ engine, config: cfg, now: NOW, runnerExecutor: stubExecutor('defer', 0.3), contextLoader: stubContext, runner: { kind: 'claude_code' } as any });

      const rows = (engine as any).db.query('SELECT * FROM auto_promote_verdicts').all();
      expect(rows).toHaveLength(0);
      expect(await engine.listCanonicalHandoffEntries({ candidate_id: 'cand-1' })).toHaveLength(0);
    });
  });
  it('respects runner call budget', async () => {
    await withEngine(async (engine) => {
      await seedTargetPage(engine);
      await seedEligibleCandidate(engine, 'cand-1');
      await seedEligibleCandidate(engine, 'cand-2', { target_object_id: 'concepts/acme' });
      const calls: any[] = [];

      await runAutoPromote({
        engine,
        config: { ...defaultAutoPromoteConfig(), enabled: true, dry_run: false },
        now: '2026-06-06T00:00:00.000Z',
        runner: { kind: 'claude_code' } as any,
        runnerExecutor: async (request) => {
          calls.push(request);
          return {
            status: 'succeeded' as const,
            output: JSON.stringify({ decision: 'defer', confidence: 0.5, reasoning: 'budget test' }),
            token_usage_json: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            cost_estimate_usd: null,
          };
        },
        contextLoader: (targetRef) => pageContext(engine, targetRef),
        scope_id: 'workspace:default',
        max_runner_calls: 1,
      });

      expect(calls).toHaveLength(1);
      const rows = (engine as any).db.query('SELECT * FROM auto_promote_verdicts').all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
    });
  });
  it('excludes candidates with unresolved contradictions before judging by default', async () => {
    await withEngine(async (engine) => {
      await seedTargetPage(engine);
      const candidate = await seedEligibleCandidate(engine, 'conflicted');
      await seedEligibleCandidate(engine, 'challenged', { sensitivity: 'secret' });
      await engine.createMemoryCandidateContradictionEntry({
        id: 'contradiction-open',
        scope_id: 'workspace:default',
        candidate_id: candidate.id,
        challenged_candidate_id: 'challenged',
        outcome: 'unresolved',
        review_reason: 'Open contradiction fixture.',
      });
      let calls = 0;
      const res = await runAutoPromote({
        engine,
        config: { ...defaultAutoPromoteConfig(), enabled: true },
        now: NOW,
        runnerExecutor: async (req: any) => {
          calls++;
          return stubExecutor('promote', 0.95)(req);
        },
        contextLoader: (targetRef) => pageContext(engine, targetRef),
        runner: { kind: 'claude_code' } as any,
      });

      expect(calls).toBe(0);
      expect(res.excluded.find((entry) => entry.id === candidate.id)?.reason).toBe('open_contradiction');
      expect((await engine.getMemoryCandidateEntry(candidate.id))?.status).toBe('captured');
      expect((await engine.getPage('concepts/acme'))?.compiled_truth).not.toContain('Acme raised a seed round.');
    });
  });
  it('misses cache when source refs or target context change', async () => {
    await withEngine(async (engine) => {
      await seedEligibleCandidate(engine);
      let context = 'old canonical context';
      let calls = 0;
      const executor = async (req: any) => {
        calls++;
        return stubExecutor('defer', 0.3)(req);
      };
      const cfg = { ...defaultAutoPromoteConfig(), enabled: true };

      await runAutoPromote({ engine, config: cfg, now: NOW, runnerExecutor: executor, contextLoader: async () => context, runner: { kind: 'claude_code' } as any });
      context = 'new canonical context';
      await runAutoPromote({ engine, config: cfg, now: NOW, runnerExecutor: executor, contextLoader: async () => context, runner: { kind: 'claude_code' } as any });
      await engine.updateMemoryCandidateEntryStatus('cand-1', { status: 'candidate', reviewed_at: NOW, review_reason: 'source refs changed' });
      const current = await engine.getMemoryCandidateEntry('cand-1');
      await engine.deleteMemoryCandidateEntry('cand-1');
      await engine.createMemoryCandidateEntry({
        ...current!,
        source_refs: ['User, direct message, 2026-04-23 3:01 PM KST'],
        status: 'candidate',
      } as any);
      await runAutoPromote({ engine, config: cfg, now: NOW, runnerExecutor: executor, contextLoader: async () => context, runner: { kind: 'claude_code' } as any });

      expect(calls).toBe(3);
    });
  });
  it('passes escalation_model to risky candidate judge requests', async () => {
    await withEngine(async (engine) => {
      await seedEligibleCandidate(engine, 'risky', { extraction_kind: 'inferred' });
      const models: Array<string | null | undefined> = [];
      const executor = async (req: any) => {
        models.push(req.model);
        return stubExecutor('defer', 0.3)(req);
      };
      const cfg = {
        ...defaultAutoPromoteConfig(),
        enabled: true,
        first_pass_model: 'first-pass',
        escalation_model: 'escalation',
      };

      await runAutoPromote({ engine, config: cfg, now: NOW, runnerExecutor: executor, contextLoader: stubContext, runner: { kind: 'claude_code' } as any });

      expect(models).toEqual(['escalation']);
    });
  });
  it('lets handoff-only candidates reach the runner but blocks canonical writes', async () => {
    await withEngine(async (engine) => {
      await seedTargetPage(engine);
      const candidate = await seedEligibleCandidate(engine, 'handoff-only', { candidate_type: 'open_question' });
      const calls: any[] = [];
      const res = await runAutoPromote({
        engine,
        config: { ...defaultAutoPromoteConfig(), enabled: true },
        now: NOW,
        runnerExecutor: async (req: any) => {
          calls.push(req);
          return stubExecutor('promote', 0.95)(req);
        },
        contextLoader: (targetRef) => pageContext(engine, targetRef),
        runner: { kind: 'claude_code' } as any,
        allow_canonical_page_writes: true,
      });

      expect(calls).toHaveLength(1);
      expect(res.counts.selected_low_risk).toBe(0);
      expect(res.counts.selected_risky).toBe(1);
      expect(res.counts.auto_promoted).toBe(1);
      expect(res.counts.canonical_handoffs).toBe(1);
      expect(res.counts.canonical_writes).toBe(0);
      expect(res.excluded.find((entry) => entry.id === candidate.id)?.reason).toBe('canonical_policy_not_allowed');
      expect((await engine.getPage('concepts/acme'))?.compiled_truth).not.toContain('Acme raised a seed round.');
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
