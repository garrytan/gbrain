import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runDreamCycle } from '../src/core/services/dream-cycle-runner-service.ts';
import {
  detectProceduralPatterns,
  proposeProceduralCandidates,
} from '../src/core/services/procedural-memory-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

async function makeEngine(): Promise<SQLiteEngine> {
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: ':memory:' });
  await engine.initSchema();
  return engine;
}

async function seedTaskWithDecision(
  engine: BrainEngine,
  taskId: string,
  decisionSummary: string,
): Promise<void> {
  await engine.createTaskThread({
    id: taskId,
    scope: 'work',
    title: `Task ${taskId}`,
    status: 'active',
  });
  await engine.recordTaskDecision({
    id: `decision:${taskId}`,
    task_id: taskId,
    summary: decisionSummary,
    rationale: 'repeated verification flow',
  });
}

describe('detectProceduralPatterns', () => {
  test('two occurrences stay below the threshold; three distinct tasks produce one merged proposal', async () => {
    const engine = await makeEngine();
    try {
      await seedTaskWithDecision(engine, 'task:1', 'Run tests via bun test test/x on 2026-07-01');
      await seedTaskWithDecision(engine, 'task:2', 'Run tests via bun test test/x on 2026-07-02');

      const below = await detectProceduralPatterns(engine, { min_occurrences: 3 });
      expect(below.proposals).toEqual([]);
      expect(below.scanned.tasks).toBe(2);
      expect(below.scanned.decisions).toBe(2);

      await seedTaskWithDecision(engine, 'task:3', 'Run  tests via bun test test/x on 2026-07-03');

      const detected = await detectProceduralPatterns(engine, { min_occurrences: 3 });
      expect(detected.proposals).toHaveLength(1);
      const proposal = detected.proposals[0]!;
      expect(proposal.pattern_kind).toBe('task_decision');
      expect(proposal.occurrences).toBe(3);
      expect(proposal.rule_text.toLowerCase()).toContain('run tests via bun test test/x');
      expect(proposal.rule_text.length).toBeLessThanOrEqual(200);
      expect(proposal.recurrence_score).toBeGreaterThan(0);
      expect(proposal.source_refs).toEqual(expect.arrayContaining([
        'task:task:1',
        'task:task:2',
        'task:task:3',
        'task_decision:decision:task:1',
        'task_decision:decision:task:2',
        'task_decision:decision:task:3',
      ]));
    } finally {
      await engine.disconnect();
    }
  });

  test('caps rule text at 200 characters', async () => {
    const engine = await makeEngine();
    try {
      const longDecision = `always ${'verify the generated migration output against the live schema snapshot '.repeat(6)}before shipping`;
      expect(longDecision.length).toBeGreaterThan(200);
      await seedTaskWithDecision(engine, 'task:long-1', longDecision);
      await seedTaskWithDecision(engine, 'task:long-2', longDecision);
      await seedTaskWithDecision(engine, 'task:long-3', longDecision);

      const detected = await detectProceduralPatterns(engine, { min_occurrences: 3 });
      expect(detected.proposals).toHaveLength(1);
      expect(detected.proposals[0]!.rule_text.length).toBeLessThanOrEqual(200);
    } finally {
      await engine.disconnect();
    }
  });

  test('detects repeated failure-to-fix attempt pairs across tasks', async () => {
    const engine = await makeEngine();
    try {
      for (const index of [1, 2, 3]) {
        const taskId = `task:attempt-${index}`;
        await engine.createTaskThread({
          id: taskId,
          scope: 'work',
          title: `Attempt task ${index}`,
          status: 'active',
        });
        await engine.recordTaskAttempt({
          id: `attempt:${index}-1-fail`,
          task_id: taskId,
          summary: 'bun test times out on pglite suite',
          outcome: 'failed',
        });
        await engine.recordTaskAttempt({
          id: `attempt:${index}-2-fix`,
          task_id: taskId,
          summary: 'set TEST_TIMEOUT_MS before running the suite',
          outcome: 'succeeded',
        });
      }

      const detected = await detectProceduralPatterns(engine, { min_occurrences: 3 });
      const pairProposal = detected.proposals.find((proposal) => proposal.pattern_kind === 'attempt_failure_fix');
      expect(pairProposal).toBeDefined();
      expect(pairProposal!.occurrences).toBe(3);
      expect(pairProposal!.rule_text.toLowerCase()).toContain('set test_timeout_ms before running the suite');
      expect(pairProposal!.rule_text.length).toBeLessThanOrEqual(200);
      expect(pairProposal!.source_refs).toEqual(expect.arrayContaining([
        'task_attempt:attempt:1-1-fail',
        'task_attempt:attempt:1-2-fix',
        'task_attempt:attempt:3-2-fix',
      ]));
    } finally {
      await engine.disconnect();
    }
  });

  test('detects repeated personal episode titles and marks them personal', async () => {
    const engine = await makeEngine();
    try {
      for (const index of [1, 2, 3]) {
        await engine.createPersonalEpisodeEntry({
          id: `episode:${index}`,
          scope_id: 'personal:default',
          title: `Weekly review with Alex 2026-07-0${index}`,
          start_time: new Date(),
          source_kind: 'meeting',
          summary: 'Weekly planning sync.',
          source_refs: [`calendar:weekly-review-${index}`],
          candidate_ids: [],
        });
      }

      const detected = await detectProceduralPatterns(engine, { min_occurrences: 3 });
      const episodeProposal = detected.proposals.find((proposal) => proposal.pattern_kind === 'episode');
      expect(episodeProposal).toBeDefined();
      expect(episodeProposal!.occurrences).toBe(3);
      expect(episodeProposal!.sensitivity).toBe('personal');
      expect(episodeProposal!.rule_text.toLowerCase()).toContain('weekly review with alex');
      expect(episodeProposal!.source_refs).toEqual(expect.arrayContaining([
        'personal_episode:episode:1',
        'personal_episode:episode:2',
        'personal_episode:episode:3',
      ]));
    } finally {
      await engine.disconnect();
    }
  });

  test('reports honest zero counts when the engine lacks operational memory surfaces', async () => {
    const detected = await detectProceduralPatterns({} as never, {});
    expect(detected.proposals).toEqual([]);
    expect(detected.scanned).toEqual({ tasks: 0, decisions: 0, attempts: 0, episodes: 0 });
  });
});

describe('proposeProceduralCandidates', () => {
  test('apply=false plans only and never mutates the inbox', async () => {
    const engine = await makeEngine();
    try {
      await seedTaskWithDecision(engine, 'task:plan-1', 'Run bun run lint before every commit');
      await seedTaskWithDecision(engine, 'task:plan-2', 'Run bun run lint before every commit');
      await seedTaskWithDecision(engine, 'task:plan-3', 'Run bun run lint before every commit');

      const detected = await detectProceduralPatterns(engine, { min_occurrences: 3 });
      const result = await proposeProceduralCandidates(engine, detected.proposals, { apply: false });

      expect(result.apply).toBe(false);
      expect(result.created).toBe(0);
      expect(result.planned).toBe(1);
      expect(result.outcomes[0]).toMatchObject({
        action: 'planned',
        candidate_id: null,
        route_decision: 'create_candidate',
      });
      const candidates = await engine.listMemoryCandidateEntries({ candidate_type: 'procedure' });
      expect(candidates).toHaveLength(0);
    } finally {
      await engine.disconnect();
    }
  });

  test('apply=true routes through the writeback router into procedure candidates', async () => {
    const engine = await makeEngine();
    try {
      await seedTaskWithDecision(engine, 'task:apply-1', 'Run bun run lint before every commit');
      await seedTaskWithDecision(engine, 'task:apply-2', 'Run bun run lint before every commit');
      await seedTaskWithDecision(engine, 'task:apply-3', 'Run bun run lint before every commit');

      const detected = await detectProceduralPatterns(engine, { min_occurrences: 3 });
      const result = await proposeProceduralCandidates(engine, detected.proposals, { apply: true });

      expect(result.created).toBe(1);
      expect(result.outcomes[0]!.action).toBe('created');
      expect(result.outcomes[0]!.candidate_id).toBeTruthy();

      const candidates = await engine.listMemoryCandidateEntries({ candidate_type: 'procedure' });
      expect(candidates).toHaveLength(1);
      const candidate = candidates[0]!;
      expect(candidate.candidate_type).toBe('procedure');
      expect(['captured', 'candidate']).toContain(candidate.status);
      expect(candidate.extraction_kind).toBe('inferred');
      expect(candidate.generated_by).toBe('agent');
      expect(candidate.review_reason).toContain('inferred_signal_requires_review');
      expect(candidate.review_reason).toContain('procedural_recurrence:task_decision:3');
      expect(candidate.source_refs).toEqual(expect.arrayContaining(['task:task:apply-1']));
      expect(candidate.recurrence_score).toBeGreaterThan(0);

      const events = await engine.listMemoryCandidateStatusEvents({ candidate_id: candidate.id });
      expect(events.length).toBeGreaterThan(0);
    } finally {
      await engine.disconnect();
    }
  });

  test('skips proposals that duplicate an existing open procedure candidate', async () => {
    const engine = await makeEngine();
    try {
      await seedTaskWithDecision(engine, 'task:dup-1', 'Run bun run lint before every commit');
      await seedTaskWithDecision(engine, 'task:dup-2', 'Run bun run lint before every commit');
      await seedTaskWithDecision(engine, 'task:dup-3', 'Run bun run lint before every commit');

      await engine.createMemoryCandidateEntry({
        id: 'candidate:existing-procedure',
        scope_id: 'workspace:default',
        candidate_type: 'procedure',
        proposed_content: 'Run bun run lint before every commit.',
        source_refs: ['task:task:dup-1'],
        generated_by: 'agent',
        extraction_kind: 'inferred',
        confidence_score: 0.6,
        importance_score: 0.5,
        recurrence_score: 0.5,
        sensitivity: 'work',
        status: 'candidate',
        target_object_type: null,
        target_object_id: null,
      });

      const detected = await detectProceduralPatterns(engine, { min_occurrences: 3 });
      const result = await proposeProceduralCandidates(engine, detected.proposals, { apply: true });

      expect(result.created).toBe(0);
      expect(result.skipped_duplicates).toBe(1);
      expect(result.outcomes[0]).toMatchObject({
        action: 'skipped_duplicate',
        candidate_id: null,
      });
      expect(result.outcomes[0]!.duplicate_review?.top_match?.id).toBe('candidate:existing-procedure');

      const candidates = await engine.listMemoryCandidateEntries({ candidate_type: 'procedure' });
      expect(candidates).toHaveLength(1);
    } finally {
      await engine.disconnect();
    }
  });
});

describe('dream-cycle consolidation wiring', () => {
  test('consolidation phase reports bounded procedural pattern counts without creating candidates', async () => {
    const engine = await makeEngine();
    try {
      await seedTaskWithDecision(engine, 'task:dream-1', 'Run bun run lint before every commit');
      await seedTaskWithDecision(engine, 'task:dream-2', 'Run bun run lint before every commit');
      await seedTaskWithDecision(engine, 'task:dream-3', 'Run bun run lint before every commit');

      const result = await runDreamCycle(engine, {
        scope_id: 'workspace:default',
        now: new Date().toISOString(),
        dry_run: true,
        limit: 10,
      });

      const consolidation = result.phases.find((phase) => phase.family === 'consolidation');
      expect(consolidation?.counts?.procedural_pattern_proposals).toBe(1);
      expect(consolidation?.status).toBe('warn');

      const candidates = await engine.listMemoryCandidateEntries({ candidate_type: 'procedure' });
      expect(candidates).toHaveLength(0);
    } finally {
      await engine.disconnect();
    }
  });
});
