import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPromoteGate } from '../../src/core/auto-promote/promote-gate.ts';
import { defaultAutoPromoteConfig } from '../../src/core/auto-promote/config.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

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

async function seedTargetPage(engine: BrainEngine) {
  return engine.putPage('concepts/acme', {
    type: 'concept',
    title: 'Acme',
    compiled_truth: 'Acme is tracked in MBrain. [Source: User, direct message, 2026-04-20 9:00 AM KST]',
    timeline: '- **2026-04-20** | Initial Acme note. [Source: User, direct message, 2026-04-20 9:00 AM KST]',
    frontmatter: {},
  });
}

async function withEngine(fn: (engine: PGLiteEngine) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-gate-'));
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

describe('runPromoteGate', () => {
  it('dry_run promotes nothing but lists would-promote', async () => {
    await withEngine(async (engine) => {
      const cfg = { ...defaultAutoPromoteConfig(), dry_run: true };
      const candidate = await seedEligibleCandidate(engine);
      const res = await runPromoteGate({ engine, verdicts: [{ candidate_id: candidate.id, decision: 'promote' as const, confidence: 0.95, reasoning: 'ok', source_refs: [] }], candidates: [candidate], config: cfg, now: '2026-06-01T00:00:00Z', actor: 'mbrain:auto_promote' });
      expect(res.promoted).toEqual([]);
      expect(res.would_promote).toContain(candidate.id);
      expect((await engine.getMemoryCandidateEntry(candidate.id))?.status).not.toBe('promoted');
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
      const events = await engine.listMemoryMutationEvents({ operation: 'put_page', target_id: 'concepts/acme' });
      expect(events.some((event) => event.source_refs.includes(`canonical_handoff:${handoffs[0]!.id}`))).toBe(true);
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
      });
      expect(res.promoted).toContain(candidate.id);
      expect(res.canonical_handoffs).toContain(candidate.id);
      expect(res.canonical_writes).toEqual([]);
      expect(res.skipped.find((s) => s.id === candidate.id)?.reason).toContain('content hash mismatch');
      expect((await engine.getPage('concepts/acme'))?.compiled_truth).not.toContain('Acme raised a seed round.');
    });
  });
  it('skips verdicts below the confidence threshold', async () => {
    await withEngine(async (engine) => {
      const cfg = { ...defaultAutoPromoteConfig(), confidence_threshold: 0.9 };
      const candidate = await seedEligibleCandidate(engine);
      const res = await runPromoteGate({ engine, verdicts: [{ candidate_id: candidate.id, decision: 'promote' as const, confidence: 0.5, reasoning: 'meh', source_refs: [] }], candidates: [candidate], config: cfg, now: '2026-06-01T00:00:00Z', actor: 'mbrain:auto_promote' });
      expect(res.promoted).toEqual([]);
      expect(res.skipped.find((s) => s.id === candidate.id)?.reason).toContain('below_threshold');
    });
  });
  it('skips verdicts carrying a proposed_patch (not yet supported)', async () => {
    await withEngine(async (engine) => {
      const candidate = await seedEligibleCandidate(engine);
      const res = await runPromoteGate({ engine, verdicts: [{ candidate_id: candidate.id, decision: 'promote' as const, confidence: 0.99, reasoning: 'ok', source_refs: [], proposed_patch: { body: 'x' } }], candidates: [candidate], config: { ...defaultAutoPromoteConfig(), dry_run: false }, now: '2026-06-01T00:00:00Z', actor: 'mbrain:auto_promote' });
      expect(res.skipped.find((s) => s.id === candidate.id)?.reason).toBe('patch_apply_not_yet_supported');
    });
  });
});
