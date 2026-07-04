import { describe, it, expect } from 'bun:test';
import { SQLiteEngine } from '../../src/core/sqlite-engine.ts';
import { runAutoPromote } from '../../src/core/auto-promote/service.ts';
import { defaultAutoPromoteConfig } from '../../src/core/auto-promote/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

const NOW = '2026-06-01T00:00:00Z';

async function seedEligibleCandidate(engine: BrainEngine, id = 'cand-1', overrides: Record<string, unknown> = {}) {
  const candidate = await engine.createMemoryCandidateEntry({
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
  const verificationStatus = overrides.verification_status;
  if (verificationStatus === 'unverified') return candidate;
  const updated = await engine.updateMemoryCandidateEntryVerification(candidate.id, {
    verification_status: verificationStatus === 'refuted' ? 'refuted' : 'verified',
    verification_method: 'source_recheck',
    verification_evidence: `Verified ${candidate.id} for auto-promote service testing.`,
    verification_source_refs: [`Source: auto-promote service fixture for ${candidate.id}`],
    verified_at: '2026-06-16T00:00:00Z',
  });
  return updated ?? candidate;
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
      expect(res.audit).toEqual(expect.arrayContaining([
        expect.objectContaining({
          candidate_id: candidate.id,
          lane: 'low_risk',
          lane_reason: 'canonical_eligible',
          runner_kind: 'claude_code',
          prompt_version: expect.any(String),
          prompt_input_hash: expect.any(String),
          confidence_threshold: expect.any(Number),
          policy_version: 'auto-promote-policy-v1',
          verification: {
            status: 'verified',
            method: 'source_recheck',
          },
          target_snapshot_hash: expect.any(String),
          verdict: {
            decision: 'promote',
            confidence: 0.95,
            judged_at: NOW,
          },
          gate_skip_reason: null,
          preflight_result: null,
          patch_candidate_id: `auto-promote-patch:${candidate.id}`,
          canonical_page_writes_enabled: true,
          canonical_write_result: 'applied',
        }),
      ]));
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
      expect(res.excluded.find((entry) => entry.id === candidate.id)?.reason).toContain('base_target_snapshot_hash does not match the current target snapshot hash');
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
      const second = await runAutoPromote({ engine, config: cfg, now: '2026-06-02T00:00:00Z', runnerExecutor: counting, contextLoader: stubContext, runner: { kind: 'claude_code' } as any });
      expect(calls).toBe(1);
      expect(second.audit.find((entry) => entry.candidate_id === 'cand-1')).toMatchObject({
        runner_kind: 'claude_code',
        prompt_version: expect.any(String),
        prompt_input_hash: expect.any(String),
        verdict: {
          decision: 'defer',
          confidence: 0.3,
          judged_at: NOW,
        },
      });
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

      const res = await runAutoPromote({
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
      expect(res.excluded).toEqual([]);
      const budgetAudit = res.audit.find((entry) => entry.gate_skip_reason === 'runner_budget_exhausted');
      expect(budgetAudit).toBeDefined();
      expect(['cand-1', 'cand-2']).toContain(budgetAudit!.candidate_id);
      expect(budgetAudit).toMatchObject({
        lane: 'low_risk',
        lane_reason: 'canonical_eligible',
        gate_skip_reason: 'runner_budget_exhausted',
        verdict: { decision: null, confidence: null, judged_at: null },
        patch_candidate_id: null,
        canonical_write_result: 'not_attempted',
      });
    });
  });
  it('excludes candidates when the auto-promote time budget is exhausted', async () => {
    await withEngine(async (engine) => {
      await seedTargetPage(engine);
      const candidate = await seedEligibleCandidate(engine);
      let calls = 0;

      const res = await runAutoPromote({
        engine,
        config: { ...defaultAutoPromoteConfig(), enabled: true, dry_run: false },
        now: NOW,
        runner: { kind: 'claude_code' } as any,
        runnerExecutor: async (request) => {
          calls += 1;
          return stubExecutor('promote', 0.95)(request);
        },
        contextLoader: (targetRef) => pageContext(engine, targetRef),
        scope_id: 'workspace:default',
        time_budget_ms: 0,
      });

      expect(calls).toBe(0);
      expect(res.excluded).toEqual([{ id: candidate.id, reason: 'time_budget_exceeded' }]);
      expect((await engine.getMemoryCandidateEntry(candidate.id))?.status).toBe('captured');
    });
  });
  it('tries the next runner when the first runner returns an unparsable verdict', async () => {
    await withEngine(async (engine) => {
      await seedTargetPage(engine);
      await seedEligibleCandidate(engine);
      const calls: string[] = [];

      const res = await runAutoPromote({
        engine,
        config: { ...defaultAutoPromoteConfig(), enabled: true },
        now: NOW,
        runner: { kind: 'claude_code' } as any,
        runners: [{ kind: 'claude_code' }, { kind: 'codex' }] as any,
        runnerExecutor: async (request) => {
          calls.push(request.runner.kind);
          if (request.runner.kind === 'claude_code') {
            return {
              status: 'succeeded' as const,
              output: 'MBRAIN-PASS: no durable signal',
              token_usage_json: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
              cost_estimate_usd: null,
            };
          }
          return stubExecutor('promote', 0.95)(request);
        },
        contextLoader: (targetRef) => pageContext(engine, targetRef),
        allow_canonical_page_writes: true,
      });

      expect(calls).toEqual(['claude_code', 'codex']);
      expect(res.counts.auto_promoted).toBe(1);
      expect((await engine.getMemoryCandidateEntry('cand-1'))?.status).toBe('promoted');
    });
  });
  it('audits candidates when runners fail to produce a parseable verdict', async () => {
    await withEngine(async (engine) => {
      await seedTargetPage(engine);
      const candidate = await seedEligibleCandidate(engine);
      const calls: string[] = [];

      const res = await runAutoPromote({
        engine,
        config: { ...defaultAutoPromoteConfig(), enabled: true },
        now: NOW,
        runner: { kind: 'claude_code' } as any,
        runners: [{ kind: 'claude_code' }, { kind: 'codex' }] as any,
        runnerExecutor: async (request) => {
          calls.push(request.runner.kind);
          return {
            status: 'succeeded' as const,
            output: 'MBRAIN-PASS: no durable signal',
            token_usage_json: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            cost_estimate_usd: null,
          };
        },
        contextLoader: (targetRef) => pageContext(engine, targetRef),
      });

      expect(calls).toEqual(['claude_code', 'codex']);
      expect(res.counts.auto_promoted).toBe(0);
      expect(res.excluded).toEqual([]);
      expect(res.audit.find((entry) => entry.candidate_id === candidate.id)).toMatchObject({
        lane: 'low_risk',
        lane_reason: 'canonical_eligible',
        runner_kind: 'codex',
        prompt_version: expect.any(String),
        prompt_input_hash: expect.any(String),
        gate_skip_reason: 'runner_no_verdict',
        verdict: { decision: null, confidence: null, judged_at: null },
        canonical_write_result: 'not_attempted',
      });
    });
  });
  it('lets the promote gate, not a dead prefilter, handle unresolved contradictions', async () => {
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

      expect(calls).toBe(1);
      expect(res.excluded.find((entry) => entry.id === candidate.id)?.reason).toBeDefined();
      expect((await engine.getMemoryCandidateEntry(candidate.id))?.status).toBe('captured');
      expect((await engine.getPage('concepts/acme'))?.compiled_truth).not.toContain('Acme raised a seed round.');
    });
  });
  it('excludes same-cycle dream candidates before runner judgment', async () => {
    await withEngine(async (engine) => {
      await seedTargetPage(engine);
      const dreamCandidate = await seedEligibleCandidate(engine, 'dream-this-cycle', {
        generated_by: 'dream_cycle',
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
        exclude_candidate_ids: [dreamCandidate.id],
      });

      expect(calls).toBe(0);
      expect(res.counts.excluded).toBe(1);
      expect(res.excluded).toEqual([
        { id: dreamCandidate.id, reason: 'dream_self_consumption_guard' },
      ]);
      expect((await engine.getMemoryCandidateEntry(dreamCandidate.id))?.status).toBe('captured');
      expect(await engine.listCanonicalHandoffEntries({ candidate_id: dreamCandidate.id })).toHaveLength(0);
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
        eligibility: {
          ...defaultAutoPromoteConfig().eligibility,
          allow_verified_risky_upgrade: false,
        },
      };

      await runAutoPromote({ engine, config: cfg, now: NOW, runnerExecutor: executor, contextLoader: stubContext, runner: { kind: 'claude_code' } as any });

      expect(models).toEqual(['escalation']);
    });
  });
  it('audits risky candidates when escalation is disabled', async () => {
    await withEngine(async (engine) => {
      const candidate = await seedEligibleCandidate(engine, 'risky-disabled', { candidate_type: 'open_question' });
      const res = await runAutoPromote({
        engine,
        config: {
          ...defaultAutoPromoteConfig(),
          enabled: true,
          escalation: { enabled: false, max_per_cycle: 20 },
        },
        now: NOW,
        runnerExecutor: stubExecutor('promote', 0.95),
        contextLoader: stubContext,
        runner: { kind: 'claude_code' } as any,
      });

      expect(res.counts.selected_risky).toBe(1);
      expect(res.counts.escalated).toBe(0);
      expect(res.excluded).toEqual([]);
      expect(res.audit.find((entry) => entry.candidate_id === candidate.id)).toMatchObject({
        lane: 'risky',
        lane_reason: 'candidate_type_handoff_only:open_question',
        gate_skip_reason: 'escalation_disabled',
        verdict: { decision: null, confidence: null, judged_at: null },
        canonical_write_result: 'not_attempted',
      });
    });
  });
  it('audits risky candidates beyond the escalation cycle limit', async () => {
    await withEngine(async (engine) => {
      await seedEligibleCandidate(engine, 'risky-1', { candidate_type: 'open_question' });
      await seedEligibleCandidate(engine, 'risky-2', { candidate_type: 'open_question' });
      const calls: string[] = [];
      const res = await runAutoPromote({
        engine,
        config: {
          ...defaultAutoPromoteConfig(),
          enabled: true,
          escalation: { enabled: true, max_per_cycle: 1 },
        },
        now: NOW,
        runnerExecutor: async (request) => {
          calls.push(request.runner.kind);
          return stubExecutor('defer', 0.3)(request);
        },
        contextLoader: stubContext,
        runner: { kind: 'claude_code' } as any,
      });

      expect(calls).toHaveLength(1);
      expect(res.counts.selected_risky).toBe(2);
      expect(res.counts.escalated).toBe(1);
      expect(res.excluded).toEqual([]);
      const limitAudit = res.audit.find((entry) => entry.gate_skip_reason === 'escalation_limit_exceeded');
      expect(limitAudit).toBeDefined();
      expect(['risky-1', 'risky-2']).toContain(limitAudit!.candidate_id);
      expect(limitAudit).toMatchObject({
        lane: 'risky',
        lane_reason: 'candidate_type_handoff_only:open_question',
        gate_skip_reason: 'escalation_limit_exceeded',
        verdict: { decision: null, confidence: null, judged_at: null },
        canonical_write_result: 'not_attempted',
      });
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
      expect(res.audit.find((entry) => entry.candidate_id === candidate.id)).toMatchObject({
        lane: 'risky',
        lane_reason: 'candidate_type_handoff_only:open_question',
        verdict: {
          decision: 'promote',
          confidence: 0.95,
          judged_at: NOW,
        },
        gate_skip_reason: 'canonical_policy_not_allowed',
        patch_candidate_id: null,
        canonical_page_writes_enabled: true,
        canonical_write_result: 'handoff_only',
      });
      expect((await engine.getPage('concepts/acme'))?.compiled_truth).not.toContain('Acme raised a seed round.');
    });
  });
  it('audits non-reportable gate skips without changing exclusion counts', async () => {
    await withEngine(async (engine) => {
      await seedTargetPage(engine);
      const candidate = await seedEligibleCandidate(engine);

      const res = await runAutoPromote({
        engine,
        config: { ...defaultAutoPromoteConfig(), enabled: true, confidence_threshold: 0.9 },
        now: NOW,
        runnerExecutor: stubExecutor('promote', 0.2),
        contextLoader: (targetRef) => pageContext(engine, targetRef),
        runner: { kind: 'claude_code' } as any,
        allow_canonical_page_writes: true,
      });

      expect(res.counts.auto_promoted).toBe(0);
      expect(res.counts.excluded).toBe(0);
      expect(res.excluded).toEqual([]);
      expect(res.audit.find((entry) => entry.candidate_id === candidate.id)).toMatchObject({
        lane: 'low_risk',
        gate_skip_reason: 'below_threshold',
        patch_candidate_id: null,
        canonical_write_result: 'skipped',
        verdict: {
          decision: 'promote',
          confidence: 0.2,
          judged_at: NOW,
        },
      });
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
