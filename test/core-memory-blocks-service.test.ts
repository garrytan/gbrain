import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildCoreMemoryBlocks,
  CORE_MEMORY_BLOCK_PRIORITY,
  CORE_MEMORY_BLOCKS_CONFIG_KEY,
  CORE_MEMORY_BLOCKS_HARD_BUDGET_TOKENS,
  persistCoreMemoryBlocksSnapshot,
} from '../src/core/services/core-memory-blocks-service.ts';
import { runDreamCycle } from '../src/core/services/dream-cycle-runner-service.ts';
import { createMaintenanceRuntimeService } from '../src/core/services/maintenance-runtime-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

// Traces are inserted with a database-side created_at, so the deterministic "now"
// is pinned slightly in the future to keep seeded traces inside the 14-day window.
const NOW = new Date(Date.now() + 60_000);

async function withEngine<T>(run: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-core-memory-blocks-'));
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

describe('core memory blocks service (N-3)', () => {
  test('composes owner-profile, active-projects, and attention blocks with per-line provenance', async () => {
    await withEngine(async (engine) => {
      await seedCoreMemorySources(engine);

      const result = await buildCoreMemoryBlocks(engine, { now: NOW });

      expect(result.authority).toBe('not_answer_evidence');
      expect(result.budget_tokens).toBe(CORE_MEMORY_BLOCKS_HARD_BUDGET_TOKENS);
      expect(result.priority_order).toEqual([...CORE_MEMORY_BLOCK_PRIORITY]);
      expect(result.blocks.map((block) => block.name)).toEqual([...CORE_MEMORY_BLOCK_PRIORITY]);

      for (const block of result.blocks) {
        expect(block.authority).toBe('not_answer_evidence');
        expect(block.token_estimate).toBe(block.lines.reduce((total, line) => total + line.token_estimate, 0));
        for (const line of block.lines) {
          expect(line.text.length).toBeGreaterThan(0);
          expect(line.token_estimate).toBeGreaterThan(0);
          expect(line.source.kind.length).toBeGreaterThan(0);
          expect(Boolean(line.source.id ?? line.source.slug)).toBe(true);
        }
      }

      const profileBlock = result.blocks.find((block) => block.name === 'owner-profile')!;
      expect(profileBlock.lines[0]).toMatchObject({
        source: { kind: 'profile_memory', id: 'profile-memory:recent' },
      });
      expect(profileBlock.lines.map((line) => line.source.id)).not.toContain('profile-memory:superseded');

      const projectBlock = result.blocks.find((block) => block.name === 'active-projects')!;
      expect(projectBlock.lines).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: { kind: 'task_thread', id: 'task:core-blocks' } }),
        expect.objectContaining({ source: { kind: 'task_working_set', id: 'task:core-blocks' } }),
      ]));

      const attentionBlock = result.blocks.find((block) => block.name === 'attention')!;
      const pageLines = attentionBlock.lines.filter((line) => line.source.kind === 'page');
      expect(pageLines[0]).toMatchObject({ source: { kind: 'page', slug: 'systems/mbrain-architecture.md' } });
      expect(pageLines[0]!.text).toContain('2 confirmed reads');
      expect(pageLines[1]).toMatchObject({ source: { kind: 'page', slug: 'concepts/memory-blocks.md' } });
      expect(attentionBlock.lines).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: { kind: 'watched_question', id: 'watched:budget' } }),
      ]));

      expect(result.total_token_estimate).toBe(
        result.blocks.reduce((total, block) => total + block.token_estimate, 0),
      );
      expect(result.total_token_estimate).toBeLessThanOrEqual(result.budget_tokens);
      expect(result.generated_at).toBe(NOW.toISOString());
    });
  });

  test('enforces the token budget by trimming lowest-priority lines first', async () => {
    await withEngine(async (engine) => {
      await seedCoreMemorySources(engine);

      const tight = await buildCoreMemoryBlocks(engine, { now: NOW, budget_tokens: 30 });

      expect(tight.budget_tokens).toBe(30);
      expect(tight.total_token_estimate).toBeLessThanOrEqual(30);
      expect(tight.trimmed_line_count).toBeGreaterThan(0);

      const profileBlock = tight.blocks.find((block) => block.name === 'owner-profile')!;
      const attentionBlock = tight.blocks.find((block) => block.name === 'attention')!;
      expect(profileBlock.lines.length).toBeGreaterThan(0);
      expect(attentionBlock.lines).toEqual([]);

      const full = await buildCoreMemoryBlocks(engine, { now: NOW });
      // Priority order respected: everything the tight budget kept is a prefix of the full build.
      const flatten = (result: typeof full) => result.blocks.flatMap((block) => block.lines.map((line) => line.text));
      expect(flatten(full).slice(0, flatten(tight).length)).toEqual(flatten(tight));
    });
  });

  test('caps the budget at the 2000-token hard limit', async () => {
    await withEngine(async (engine) => {
      const result = await buildCoreMemoryBlocks(engine, { now: NOW, budget_tokens: 999_999 });
      expect(result.budget_tokens).toBe(CORE_MEMORY_BLOCKS_HARD_BUDGET_TOKENS);
    });
  });

  test('is deterministic for an injected now', async () => {
    await withEngine(async (engine) => {
      await seedCoreMemorySources(engine);

      const first = await buildCoreMemoryBlocks(engine, { now: NOW });
      const second = await buildCoreMemoryBlocks(engine, { now: NOW });

      expect(second).toEqual(first);
    });
  });

  test('degrades to empty blocks on engines without the source read methods', async () => {
    const result = await buildCoreMemoryBlocks({} as never, { now: NOW });

    expect(result.blocks.map((block) => block.name)).toEqual([...CORE_MEMORY_BLOCK_PRIORITY]);
    expect(result.blocks.every((block) => block.lines.length === 0)).toBe(true);
    expect(result.total_token_estimate).toBe(0);
  });

  test('persists a snapshot through the config store', async () => {
    await withEngine(async (engine) => {
      await seedCoreMemorySources(engine);

      const result = await buildCoreMemoryBlocks(engine, { now: NOW });
      const persisted = await persistCoreMemoryBlocksSnapshot(engine, result);

      expect(persisted).toBe(true);
      const stored = await engine.getConfig(CORE_MEMORY_BLOCKS_CONFIG_KEY);
      expect(JSON.parse(stored!)).toEqual(JSON.parse(JSON.stringify(result)));
    });
  });

  test('dream-cycle consolidation refreshes the snapshot in apply mode but not in dry-run', async () => {
    await withEngine(async (engine) => {
      await seedCoreMemorySources(engine);

      const dryRun = await runDreamCycle(engine, {
        scope_id: 'workspace:default',
        now: NOW.toISOString(),
        dry_run: true,
        limit: 10,
      });
      const dryConsolidation = dryRun.phases.find((phase) => phase.family === 'consolidation')!;
      expect(dryConsolidation.counts.core_memory_blocks_persisted).toBe(0);
      expect(await engine.getConfig(CORE_MEMORY_BLOCKS_CONFIG_KEY)).toBeNull();

      const applied = await runDreamCycle(engine, {
        scope_id: 'workspace:default',
        now: NOW.toISOString(),
        dry_run: false,
        write_candidates: true,
        limit: 10,
      }, {
        runtime: createMaintenanceRuntimeService({ now: () => NOW.toISOString() }),
        replayCanary: {
          run: async () => ({
            status: 'passed' as const,
            reason_codes: ['focused_replay_canary_passed'],
          }),
        },
      });
      const consolidation = applied.phases.find((phase) => phase.family === 'consolidation')!;
      expect(consolidation.counts.core_memory_blocks_persisted).toBe(1);
      expect(consolidation.counts.core_memory_block_lines).toBeGreaterThan(0);

      const stored = await engine.getConfig(CORE_MEMORY_BLOCKS_CONFIG_KEY);
      expect(stored).not.toBeNull();
      const snapshot = JSON.parse(stored!);
      expect(snapshot.authority).toBe('not_answer_evidence');
      expect(snapshot.generated_at).toBe(NOW.toISOString());
      expect(snapshot.total_token_estimate).toBeLessThanOrEqual(snapshot.budget_tokens);
    });
  });
});

async function seedCoreMemorySources(engine: SQLiteEngine): Promise<void> {
  await engine.upsertProfileMemoryEntry({
    id: 'profile-memory:recent',
    scope_id: 'personal:default',
    profile_type: 'preference',
    subject: 'implementation checkpoints',
    content: 'The user prefers concise implementation checkpoints.',
    sensitivity: 'personal',
    source_refs: ['source_item:profile-recent'],
    last_confirmed_at: new Date('2026-06-04T02:00:00.000Z'),
    export_status: 'private_only',
  });
  await engine.upsertProfileMemoryEntry({
    id: 'profile-memory:older',
    scope_id: 'personal:default',
    profile_type: 'routine',
    subject: 'morning review',
    content: 'The user reviews the daily memory report each morning.',
    sensitivity: 'personal',
    source_refs: ['source_item:profile-older'],
    last_confirmed_at: new Date('2026-06-01T02:00:00.000Z'),
    export_status: 'private_only',
  });
  await engine.upsertProfileMemoryEntry({
    id: 'profile-memory:superseded',
    scope_id: 'personal:default',
    profile_type: 'preference',
    subject: 'legacy preference',
    content: 'A superseded preference that must never surface.',
    sensitivity: 'personal',
    source_refs: ['source_item:profile-superseded'],
    last_confirmed_at: new Date('2026-06-05T02:00:00.000Z'),
    superseded_by: 'profile-memory:recent',
    export_status: 'private_only',
  });

  await engine.createTaskThread({
    id: 'task:core-blocks',
    scope: 'work',
    title: 'Core memory blocks',
    goal: 'Ship budgeted always-on context blocks.',
    status: 'active',
    current_summary: 'Deterministic block compiler in progress.',
  });
  await engine.upsertTaskWorkingSet({
    task_id: 'task:core-blocks',
    active_paths: ['src/core/services/core-memory-blocks-service.ts'],
    active_symbols: ['buildCoreMemoryBlocks'],
    blockers: [],
    open_questions: [],
    next_steps: ['Wire dream-cycle persistence', 'Extend activation planner'],
    verification_notes: [],
  });

  const traceRefs = [
    'page:workspace:default:systems/mbrain-architecture.md',
    'page:workspace:default:systems/mbrain-architecture.md',
    'page:workspace:default:concepts/memory-blocks.md',
  ];
  for (const [index, ref] of traceRefs.entries()) {
    await engine.putRetrievalTrace({
      id: `trace:core-blocks-${index}`,
      scope: 'work',
      route: ['read_context'],
      source_refs: [ref],
      write_outcome: 'no_durable_write',
      outcome: 'read_context returned canonical evidence',
    });
  }
  // A probe-only trace must not count as a confirmed read.
  await engine.putRetrievalTrace({
    id: 'trace:probe-only',
    scope: 'work',
    route: ['retrieve_context'],
    source_refs: ['page:workspace:default:concepts/probe-only.md'],
    write_outcome: 'no_durable_write',
    outcome: 'probe only',
  });

  await engine.upsertWatchedQuestion({
    id: 'watched:budget',
    scope_id: 'workspace:default',
    question: 'What is the current activation token budget?',
    enabled: true,
  });
  await engine.recordWatchedQuestionRun({
    question_id: 'watched:budget',
    scope_id: 'workspace:default',
    question: 'What is the current activation token budget?',
    changed: true,
    current_fingerprint: 'fp-2',
    previous_fingerprint: 'fp-1',
    created_at: new Date(NOW.getTime() - 60 * 60 * 1000),
  });
}
