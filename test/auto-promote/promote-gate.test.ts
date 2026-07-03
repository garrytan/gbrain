import { describe, it, expect } from 'bun:test';
import { SQLiteEngine } from '../../src/core/sqlite-engine.ts';
import { runPromoteGate } from '../../src/core/auto-promote/promote-gate.ts';
import { defaultAutoPromoteConfig } from '../../src/core/auto-promote/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

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
    verification_evidence: `Verified ${candidate.id} for auto-promote gate testing.`,
    verification_source_refs: [`Source: auto-promote gate fixture for ${candidate.id}`],
    verified_at: '2026-06-16T00:00:00Z',
  });
  return updated ?? candidate;
}

async function seedTargetPage(engine: BrainEngine) {
  return engine.putPage('concepts/acme', {
    type: 'concept',
    title: 'Acme',
    compiled_truth: 'Acme is tracked in MBrain. [Source: User, direct message, 2026-04-20 9:00 AM KST]',
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

describe('runPromoteGate', () => {
  it('dry_run promotes nothing but lists would-promote', async () => {
    await withEngine(async (engine) => {
      const cfg = { ...defaultAutoPromoteConfig(), dry_run: true };
      const candidate = await seedEligibleCandidate(engine);
      const res = await runPromoteGate({
        engine,
        verdicts: [{ candidate_id: candidate.id, decision: 'promote' as const, confidence: 0.95, reasoning: 'ok', source_refs: [] }],
        candidates: [candidate],
        config: cfg,
        now: '2026-06-01T00:00:00Z',
        actor: 'mbrain:auto_promote',
        canonical_write_candidate_ids: new Set([candidate.id]),
      });
      expect(res.promoted).toEqual([]);
      expect(res.would_promote).toContain(candidate.id);
      expect(res.audit.find((entry) => entry.candidate_id === candidate.id)).toMatchObject({
        gate_skip_reason: null,
        patch_candidate_id: null,
        canonical_write_result: 'not_attempted',
      });
      expect((await engine.getMemoryCandidateEntry(candidate.id))?.status).not.toBe('promoted');
    });
  });
  it('does not let caller-provided audit metadata override actual verdict facts', async () => {
    await withEngine(async (engine) => {
      const cfg = { ...defaultAutoPromoteConfig(), dry_run: true };
      const candidate = await seedEligibleCandidate(engine);
      const res = await runPromoteGate({
        engine,
        verdicts: [{ candidate_id: candidate.id, decision: 'promote' as const, confidence: 0.95, reasoning: 'ok', source_refs: [], runner_kind: 'claude_code', prompt_version: 'prompt-v-real', judged_at: '2026-06-01T00:00:00Z' }],
        candidates: [candidate],
        config: cfg,
        now: '2026-06-01T00:00:00Z',
        actor: 'mbrain:auto_promote',
        canonical_write_candidate_ids: new Set([candidate.id]),
        audit_metadata: new Map([[candidate.id, {
          runner_kind: 'metadata-runner',
          prompt_version: 'metadata-prompt',
          prompt_input_hash: 'metadata-hash',
          verdict: { decision: 'reject', confidence: 0, judged_at: '1999-01-01T00:00:00Z' },
        } as any]]),
      });

      expect(res.audit.find((entry) => entry.candidate_id === candidate.id)).toMatchObject({
        runner_kind: 'claude_code',
        prompt_version: 'prompt-v-real',
        verdict: {
          decision: 'promote',
          confidence: 0.95,
          judged_at: '2026-06-01T00:00:00Z',
        },
      });
    });
  });
  it('promotes a confident verdict', async () => {
    await withEngine(async (engine) => {
      const target = await seedTargetPage(engine);
      const cfg = { ...defaultAutoPromoteConfig(), dry_run: false };
      const candidate = await seedEligibleCandidate(engine);
      const res = await runPromoteGate({
        engine,
        verdicts: [{ candidate_id: candidate.id, decision: 'promote' as const, confidence: 0.95, reasoning: 'ok', source_refs: [] }],
        candidates: [candidate],
        config: cfg,
        now: '2026-06-01T00:00:00Z',
        actor: 'mbrain:auto_promote',
        target_snapshot_hashes: new Map([[candidate.id, target.content_hash ?? null]]),
        allow_canonical_page_writes: true,
        canonical_write_candidate_ids: new Set([candidate.id]),
      });
      expect(res.promoted).toContain(candidate.id);
      expect(res.canonical_handoffs).toContain(candidate.id);
      expect(res.canonical_writes).toContain('concepts/acme');
      expect((await engine.getMemoryCandidateEntry(candidate.id))?.status).toBe('promoted');
      const page = await engine.getPage('concepts/acme');
      expect(page?.compiled_truth).toContain('Acme raised a seed round.');
      expect(page?.compiled_truth).toContain('[Source: User, direct message, 2026-04-22 3:01 PM KST]');
      const handoffs = await engine.listCanonicalHandoffEntries({ candidate_id: candidate.id });
      expect(handoffs).toHaveLength(1);
      expect(handoffs[0]!.completed_at?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
      expect(handoffs[0]!.completion_kind).toBe('patch_applied');
      expect(handoffs[0]!.completion_ref).toBe(`auto-promote-patch:${candidate.id}`);
      const events = await engine.listMemoryMutationEvents({ operation: 'apply_memory_patch_candidate', target_id: 'concepts/acme' });
      expect(events.some((event) => event.source_refs.includes(`canonical_handoff:${handoffs[0]!.id}`))).toBe(true);
    });
  });
  it('preflights unverified candidates before staging them for promotion', async () => {
    await withEngine(async (engine) => {
      const cfg = { ...defaultAutoPromoteConfig(), dry_run: false };
      const candidate = await seedEligibleCandidate(engine, 'unverified-candidate', {
        status: 'candidate',
        verification_status: 'unverified',
      });

      const res = await runPromoteGate({
        engine,
        verdicts: [{ candidate_id: candidate.id, decision: 'promote' as const, confidence: 0.95, reasoning: 'ok', source_refs: [] }],
        candidates: [candidate],
        config: cfg,
        now: '2026-06-01T00:00:00Z',
        actor: 'mbrain:auto_promote',
        canonical_write_candidate_ids: new Set([candidate.id]),
      });

      expect(res.promoted).toEqual([]);
      expect(res.skipped).toContainEqual({ id: candidate.id, reason: 'candidate_requires_verification' });
      expect((await engine.getMemoryCandidateEntry(candidate.id))?.status).toBe('candidate');
      const events = await engine.listMemoryCandidateStatusEvents({ candidate_id: candidate.id });
      expect(events.filter((event) => event.event_kind === 'advanced')).toHaveLength(0);
    });
  });
  it('preserves existing canonical page tags when applying an auto-promote patch', async () => {
    await withEngine(async (engine) => {
      const target = await seedTargetPage(engine);
      await engine.addTag('concepts/acme', 'customer');
      await engine.addTag('concepts/acme', 'priority');
      const cfg = { ...defaultAutoPromoteConfig(), dry_run: false };
      const candidate = await seedEligibleCandidate(engine);

      await runPromoteGate({
        engine,
        verdicts: [{ candidate_id: candidate.id, decision: 'promote' as const, confidence: 0.95, reasoning: 'ok', source_refs: [] }],
        candidates: [candidate],
        config: cfg,
        now: '2026-06-01T00:00:00Z',
        actor: 'mbrain:auto_promote',
        target_snapshot_hashes: new Map([[candidate.id, target.content_hash ?? null]]),
        allow_canonical_page_writes: true,
        canonical_write_candidate_ids: new Set([candidate.id]),
      });

      expect(await engine.getTags('concepts/acme')).toEqual(['customer', 'priority']);
    });
  });
  it('writes canonical page changes through the reviewable patch candidate lifecycle', async () => {
    await withEngine(async (engine) => {
      const target = await seedTargetPage(engine);
      const cfg = { ...defaultAutoPromoteConfig(), dry_run: false };
      const candidate = await seedEligibleCandidate(engine);

      const res = await runPromoteGate({
        engine,
        verdicts: [{ candidate_id: candidate.id, decision: 'promote' as const, confidence: 0.95, reasoning: 'ok', source_refs: [] }],
        candidates: [candidate],
        config: cfg,
        now: '2026-06-01T00:00:00Z',
        actor: 'mbrain:auto_promote',
        target_snapshot_hashes: new Map([[candidate.id, target.content_hash ?? null]]),
        allow_canonical_page_writes: true,
        canonical_write_candidate_ids: new Set([candidate.id]),
      });

      expect(res.promoted).toContain(candidate.id);
      expect(res.canonical_writes).toContain('concepts/acme');
      expect(res.audit).toEqual(expect.arrayContaining([
        expect.objectContaining({
          candidate_id: candidate.id,
          gate_skip_reason: null,
          target_snapshot_hash: target.content_hash,
          patch_candidate_id: `auto-promote-patch:${candidate.id}`,
          canonical_page_writes_enabled: true,
          canonical_write_result: 'applied',
        }),
      ]));

      const directPageWrites = await engine.listMemoryMutationEvents({
        operation: 'put_page',
        target_kind: 'page',
        target_id: 'concepts/acme',
      });
      expect(directPageWrites).toHaveLength(0);

      const createEvents = await engine.listMemoryMutationEvents({
        operation: 'create_memory_patch_candidate',
        target_kind: 'memory_candidate',
        result: 'staged_for_review',
      });
      expect(createEvents).toHaveLength(1);
      const patchCandidateId = createEvents[0]!.target_id;
      expect(createEvents[0]!.source_refs).toContain(`memory_candidate:${candidate.id}`);

      const reviewEvents = await engine.listMemoryMutationEvents({
        operation: 'review_memory_patch_candidate',
        target_kind: 'memory_candidate',
        target_id: patchCandidateId,
        result: 'approved',
      });
      expect(reviewEvents).toHaveLength(1);

      const applyEvents = await engine.listMemoryMutationEvents({
        operation: 'apply_memory_patch_candidate',
        target_kind: 'page',
        target_id: 'concepts/acme',
        result: 'applied',
      });
      expect(applyEvents).toHaveLength(1);
      expect(applyEvents[0]!.metadata.candidate_id).toBe(patchCandidateId);

      const patchCandidate = await engine.getMemoryCandidateEntry(patchCandidateId);
      expect(patchCandidate?.status).toBe('promoted');
      expect(patchCandidate?.patch_operation_state).toBe('applied');
      expect(patchCandidate?.patch_target_kind).toBe('page');
      expect(patchCandidate?.patch_target_id).toBe('concepts/acme');
      expect(patchCandidate?.patch_ledger_event_ids).toHaveLength(3);
    });
  });
  it('creates a missing canonical page through the reviewable patch candidate lifecycle', async () => {
    await withEngine(async (engine) => {
      const cfg = { ...defaultAutoPromoteConfig(), dry_run: false };
      const candidate = await seedEligibleCandidate(engine);
      const res = await runPromoteGate({
        engine,
        verdicts: [{ candidate_id: candidate.id, decision: 'promote' as const, confidence: 0.95, reasoning: 'ok', source_refs: [] }],
        candidates: [candidate],
        config: cfg,
        now: '2026-06-01T00:00:00Z',
        actor: 'mbrain:auto_promote',
        target_snapshot_hashes: new Map([[candidate.id, null]]),
        allow_canonical_page_writes: true,
        canonical_write_candidate_ids: new Set([candidate.id]),
      });
      expect(res.canonical_writes).toContain('concepts/acme');
      expect((await engine.getPage('concepts/acme'))?.compiled_truth).toContain('Acme raised a seed round.');
      expect(await engine.getTags('concepts/acme')).toEqual([]);

      const directPageWrites = await engine.listMemoryMutationEvents({
        operation: 'put_page',
        target_kind: 'page',
        target_id: 'concepts/acme',
      });
      expect(directPageWrites).toHaveLength(0);

      const appliedPatchEvents = await engine.listMemoryMutationEvents({
        operation: 'apply_memory_patch_candidate',
        target_kind: 'page',
        target_id: 'concepts/acme',
        result: 'applied',
      });
      expect(appliedPatchEvents).toHaveLength(1);
      expect(appliedPatchEvents[0]!.expected_target_snapshot_hash).toBeNull();
    });
  });
  it('requires explicit permission before writing canonical pages', async () => {
    await withEngine(async (engine) => {
      const target = await seedTargetPage(engine);
      const candidate = await seedEligibleCandidate(engine);
      const res = await runPromoteGate({
        engine,
        verdicts: [{ candidate_id: candidate.id, decision: 'promote' as const, confidence: 0.95, reasoning: 'ok', source_refs: [] }],
        candidates: [candidate],
        config: { ...defaultAutoPromoteConfig(), dry_run: false },
        now: '2026-06-01T00:00:00Z',
        actor: 'mbrain:auto_promote',
        target_snapshot_hashes: new Map([[candidate.id, target.content_hash ?? null]]),
        allow_canonical_page_writes: false,
        canonical_write_candidate_ids: new Set([candidate.id]),
      });

      expect(res.promoted).toContain(candidate.id);
      expect(res.canonical_handoffs).toContain(candidate.id);
      expect(res.canonical_writes).toEqual([]);
      expect(res.skipped.find((s) => s.id === candidate.id)?.reason).toBe('canonical_page_writes_not_allowed');
      expect(res.audit.find((entry) => entry.candidate_id === candidate.id)).toMatchObject({
        gate_skip_reason: 'canonical_page_writes_not_allowed',
        target_snapshot_hash: target.content_hash,
        patch_candidate_id: null,
        canonical_page_writes_enabled: false,
        canonical_write_result: 'handoff_only',
      });
      expect((await engine.getMemoryCandidateEntry(candidate.id))?.status).toBe('promoted');
      expect((await engine.getPage('concepts/acme'))?.compiled_truth).not.toContain('Acme raised a seed round.');
    });
  });
  it('records handoff but blocks page write for handoff-only candidates', async () => {
    await withEngine(async (engine) => {
      const target = await seedTargetPage(engine);
      const candidate = await seedEligibleCandidate(engine, 'handoff-only', { extraction_kind: 'inferred' });
      const res = await runPromoteGate({
        engine,
        verdicts: [{ candidate_id: candidate.id, decision: 'promote' as const, confidence: 0.95, reasoning: 'ok', source_refs: [] }],
        candidates: [candidate],
        config: { ...defaultAutoPromoteConfig(), dry_run: false },
        now: '2026-06-01T00:00:00Z',
        actor: 'mbrain:auto_promote',
        target_snapshot_hashes: new Map([[candidate.id, target.content_hash ?? null]]),
        allow_canonical_page_writes: true,
        canonical_write_candidate_ids: new Set(),
      });

      expect(res.promoted).toContain(candidate.id);
      expect(res.canonical_handoffs).toContain(candidate.id);
      expect(res.canonical_writes).toEqual([]);
      expect(res.skipped.find((s) => s.id === candidate.id)?.reason).toBe('canonical_policy_not_allowed');
      expect(res.audit.find((entry) => entry.candidate_id === candidate.id)).toMatchObject({
        lane: 'risky',
        lane_reason: 'unknown',
        gate_skip_reason: 'canonical_policy_not_allowed',
        target_snapshot_hash: target.content_hash,
        patch_candidate_id: null,
        canonical_page_writes_enabled: true,
        canonical_write_result: 'handoff_only',
      });
      expect((await engine.getPage('concepts/acme'))?.compiled_truth).not.toContain('Acme raised a seed round.');
    });
  });
  it('skips canonical write when the target changed after the judge snapshot', async () => {
    await withEngine(async (engine) => {
      const target = await seedTargetPage(engine);
      const candidate = await seedEligibleCandidate(engine);
      await engine.putPage('concepts/acme', {
        type: 'concept',
        title: 'Acme',
        compiled_truth: 'Acme changed after judgment. [Source: User, direct message, 2026-04-21 9:00 AM KST]',
        timeline: '',
        frontmatter: {},
      });
      const res = await runPromoteGate({
        engine,
        verdicts: [{ candidate_id: candidate.id, decision: 'promote' as const, confidence: 0.95, reasoning: 'ok', source_refs: [] }],
        candidates: [candidate],
        config: { ...defaultAutoPromoteConfig(), dry_run: false },
        now: '2026-06-01T00:00:00Z',
        actor: 'mbrain:auto_promote',
        target_snapshot_hashes: new Map([[candidate.id, target.content_hash ?? null]]),
        allow_canonical_page_writes: true,
        canonical_write_candidate_ids: new Set([candidate.id]),
      });
      expect(res.promoted).toContain(candidate.id);
      expect(res.canonical_handoffs).toContain(candidate.id);
      expect(res.canonical_writes).toEqual([]);
      expect(res.skipped.find((s) => s.id === candidate.id)?.reason).toContain('base_target_snapshot_hash does not match the current target snapshot hash');
      expect(res.audit.find((entry) => entry.candidate_id === candidate.id)).toMatchObject({
        gate_skip_reason: expect.stringContaining('base_target_snapshot_hash does not match the current target snapshot hash'),
        target_snapshot_hash: target.content_hash,
        patch_candidate_id: null,
        canonical_write_result: 'skipped',
      });
      expect((await engine.getPage('concepts/acme'))?.compiled_truth).not.toContain('Acme raised a seed round.');
      expect(await engine.listMemorySessions({ actor_ref: 'mbrain:auto_promote' })).toHaveLength(0);
      expect(await engine.listMemoryMutationEvents({ operation: 'create_memory_patch_candidate' })).toHaveLength(0);
    });
  });
  it('skips verdicts below the confidence threshold', async () => {
    await withEngine(async (engine) => {
      const cfg = { ...defaultAutoPromoteConfig(), confidence_threshold: 0.9 };
      const candidate = await seedEligibleCandidate(engine);
      const res = await runPromoteGate({
        engine,
        verdicts: [{ candidate_id: candidate.id, decision: 'promote' as const, confidence: 0.5, reasoning: 'meh', source_refs: [] }],
        candidates: [candidate],
        config: cfg,
        now: '2026-06-01T00:00:00Z',
        actor: 'mbrain:auto_promote',
        canonical_write_candidate_ids: new Set([candidate.id]),
      });
      expect(res.promoted).toEqual([]);
      expect(res.skipped.find((s) => s.id === candidate.id)?.reason).toContain('below_threshold');
      expect(res.audit.find((entry) => entry.candidate_id === candidate.id)).toMatchObject({
        gate_skip_reason: 'below_threshold',
        patch_candidate_id: null,
        canonical_page_writes_enabled: false,
        canonical_write_result: 'skipped',
      });
    });
  });
  it('skips verdicts carrying a proposed_patch (not yet supported)', async () => {
    await withEngine(async (engine) => {
      const candidate = await seedEligibleCandidate(engine);
      const res = await runPromoteGate({
        engine,
        verdicts: [{ candidate_id: candidate.id, decision: 'promote' as const, confidence: 0.99, reasoning: 'ok', source_refs: [], proposed_patch: { body: 'x' } }],
        candidates: [candidate],
        config: { ...defaultAutoPromoteConfig(), dry_run: false },
        now: '2026-06-01T00:00:00Z',
        actor: 'mbrain:auto_promote',
        canonical_write_candidate_ids: new Set([candidate.id]),
      });
      expect(res.skipped.find((s) => s.id === candidate.id)?.reason).toBe('patch_apply_not_yet_supported');
      expect(res.audit.find((entry) => entry.candidate_id === candidate.id)).toMatchObject({
        gate_skip_reason: 'patch_apply_not_yet_supported',
        patch_candidate_id: null,
        canonical_write_result: 'skipped',
      });
    });
  });
});
