import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { planAgentSessionActivation } from '../src/core/services/agent-session-activation-planner-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

async function withEngine<T>(run: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-agent-session-activation-'));
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    return await run(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('agent session activation planner', () => {
  test('selects profile memory and candidates with authority labels', async () => {
    await withEngine(async (engine) => {
      await seedProfileAndCandidate(engine);

      const plan = await planAgentSessionActivation(engine, {
        query: 'continue implementation planning work',
        requested_scope: 'personal',
        scenario: 'personal_recall',
        limit: 5,
      });

      expect(plan.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artifact_kind: 'profile_memory',
          id: 'profile-memory:planning',
          scope_policy: 'allow',
        }),
        expect.objectContaining({
          artifact_kind: 'memory_candidate',
          id: 'memory-candidate:candidate:planning-review',
          scope_policy: 'allow',
        }),
      ]));
      expect(plan.policy.decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artifact_id: 'profile-memory:planning',
          decision: 'answer_ground',
          authority: 'profile_memory',
        }),
        expect.objectContaining({
          artifact_id: 'memory-candidate:candidate:planning-review',
          decision: 'candidate_only',
          authority: 'unreviewed_candidate',
        }),
      ]));
      expect(plan.policy.trace_required).toBe(true);
    });
  });

  test('denies personal profile activation when the requested scope is work', async () => {
    await withEngine(async (engine) => {
      await seedProfileAndCandidate(engine);

      const plan = await planAgentSessionActivation(engine, {
        query: 'implementation planning',
        requested_scope: 'work',
        scenario: 'coding_continuation',
        limit: 5,
      });

      expect(plan.policy.decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artifact_id: 'profile-memory:planning',
          decision: 'ignore',
          authority: 'scope_denied',
        }),
      ]));
    });
  });

  test('adds task decisions as operational memory artifacts', async () => {
    await withEngine(async (engine) => {
      await engine.createTaskThread({
        id: 'task:activation',
        scope: 'work',
        title: 'Agent session activation follow-up',
        status: 'active',
      });
      await engine.recordTaskDecision({
        id: 'decision:deterministic-compression',
        task_id: 'task:activation',
        summary: 'Keep session compression deterministic.',
        rationale: 'Default capture must not require LLM credentials.',
      });

      const plan = await planAgentSessionActivation(engine, {
        query: 'continue deterministic compression work',
        requested_scope: 'work',
        scenario: 'coding_continuation',
        task_id: 'task:activation',
        limit: 5,
      });

      expect(plan.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artifact_kind: 'task_decision',
          id: 'task-decision:decision:deterministic-compression',
        }),
      ]));
      expect(plan.policy.decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artifact_id: 'task-decision:decision:deterministic-compression',
          decision: 'answer_ground',
          authority: 'operational_memory',
        }),
      ]));
    });
  });

  test('filters a wider profile scan window before applying the output limit', async () => {
    await withEngine(async (engine) => {
      await engine.upsertProfileMemoryEntry({
        id: 'profile-memory:zz-planning-match',
        scope_id: 'personal:default',
        profile_type: 'preference',
        subject: 'implementation planning',
        content: 'The user prefers concise implementation checkpoints.',
        sensitivity: 'personal',
        source_refs: ['source_item:profile-match', 'source_chunk:profile-match-1'],
        last_confirmed_at: new Date('2026-06-04T01:00:00.000Z'),
        export_status: 'private_only',
      });
      for (let index = 0; index < 8; index += 1) {
        await engine.upsertProfileMemoryEntry({
          id: `profile-memory:aa-irrelevant-${index}`,
          scope_id: 'personal:default',
          profile_type: 'preference',
          subject: `irrelevant ${index}`,
          content: `The user prefers unrelated topic ${index}.`,
          sensitivity: 'personal',
          source_refs: [`source_item:irrelevant-${index}`],
          last_confirmed_at: new Date(`2026-06-04T02:0${index}:00.000Z`),
          export_status: 'private_only',
        });
      }

      const plan = await planAgentSessionActivation(engine, {
        query: 'implementation planning',
        requested_scope: 'personal',
        scenario: 'personal_recall',
        limit: 5,
      });

      expect(plan.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artifact_kind: 'profile_memory',
          id: 'profile-memory:zz-planning-match',
        }),
      ]));
    });
  });

  test('keeps explicit task decisions when profile matches fill the output limit', async () => {
    await withEngine(async (engine) => {
      await engine.createTaskThread({
        id: 'task:priority',
        scope: 'work',
        title: 'Agent session activation priority',
        status: 'active',
      });
      await engine.recordTaskDecision({
        id: 'decision:priority',
        task_id: 'task:priority',
        summary: 'Keep explicit task memory ahead of incidental profile matches.',
        rationale: 'Task continuation must not lose operational memory.',
      });
      for (let index = 0; index < 5; index += 1) {
        await engine.upsertProfileMemoryEntry({
          id: `profile-memory:planning-${index}`,
          scope_id: 'personal:default',
          profile_type: 'preference',
          subject: `implementation planning ${index}`,
          content: `The user prefers implementation planning checkpoint ${index}.`,
          sensitivity: 'personal',
          source_refs: [`source_item:planning-${index}`],
          last_confirmed_at: new Date(`2026-06-04T03:0${index}:00.000Z`),
          export_status: 'private_only',
        });
      }

      const plan = await planAgentSessionActivation(engine, {
        query: 'implementation planning',
        requested_scope: 'personal',
        scenario: 'coding_continuation',
        task_id: 'task:priority',
        limit: 5,
      });

      expect(plan.artifacts[0]).toMatchObject({
        artifact_kind: 'task_decision',
        id: 'task-decision:decision:priority',
      });
      expect(plan.policy.decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artifact_id: 'task-decision:decision:priority',
          decision: 'answer_ground',
          authority: 'operational_memory',
        }),
      ]));
    });
  });

  test('always includes budgeted core memory blocks labeled not_answer_evidence', async () => {
    await withEngine(async (engine) => {
      await seedProfileAndCandidate(engine);
      const now = new Date('2026-06-05T00:00:00.000Z');

      const plan = await planAgentSessionActivation(engine, {
        query: 'continue implementation planning work',
        requested_scope: 'personal',
        scenario: 'personal_recall',
        limit: 5,
        now,
      });

      const blocks = plan.core_memory_blocks;
      expect(blocks.authority).toBe('not_answer_evidence');
      expect(blocks.generated_at).toBe(now.toISOString());
      expect(blocks.total_token_estimate).toBeLessThanOrEqual(blocks.budget_tokens);
      expect(blocks.budget_tokens).toBeLessThanOrEqual(2000);
      expect(blocks.blocks.map((block) => block.name)).toEqual([
        'owner-profile',
        'active-projects',
        'attention',
      ]);
      const profileBlock = blocks.blocks.find((block) => block.name === 'owner-profile')!;
      expect(profileBlock.lines).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: { kind: 'profile_memory', id: 'profile-memory:planning' },
        }),
      ]));
      for (const block of blocks.blocks) {
        expect(block.authority).toBe('not_answer_evidence');
        for (const line of block.lines) {
          expect(Boolean(line.source.id ?? line.source.slug)).toBe(true);
        }
      }
    });
  });
});

async function seedProfileAndCandidate(engine: SQLiteEngine): Promise<void> {
  await engine.upsertProfileMemoryEntry({
    id: 'profile-memory:planning',
    scope_id: 'personal:default',
    profile_type: 'preference',
    subject: 'implementation planning',
    content: 'The user prefers concise implementation checkpoints.',
    sensitivity: 'personal',
    source_refs: ['source_item:profile', 'source_chunk:profile-1'],
    last_confirmed_at: new Date('2026-06-04T01:00:00.000Z'),
    export_status: 'private_only',
  });
  await engine.createMemoryCandidateEntry({
    id: 'candidate:planning-review',
    scope_id: 'personal:default',
    candidate_type: 'profile_update',
    target_object_type: 'profile_memory',
    target_object_id: 'profile-memory:planning',
    proposed_content: 'The user may prefer concise implementation planning checkpoints.',
    source_refs: ['source_item:candidate', 'source_chunk:candidate-1'],
    extraction_kind: 'inferred',
    sensitivity: 'personal',
    confidence_score: 0.7,
    importance_score: 0.6,
    recurrence_score: 0.2,
    generated_by: 'agent',
    status: 'candidate',
  });
}
