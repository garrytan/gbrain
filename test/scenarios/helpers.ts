/**
 * Test helpers for the scenario-based test suite.
 *
 * See docs/superpowers/specs/2026-04-23-mbrain-scenario-test-design.md
 * for the design contract these scenarios validate.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../../src/core/sqlite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { TaskStatus } from '../../src/core/types.ts';

export interface ScenarioEngineHandle {
  engine: BrainEngine;
  rootDir: string;
  teardown: () => Promise<void>;
}

/**
 * Allocate a fresh SQLite brain in a temp directory.
 *
 * Scenario tests must not share DB state across test blocks. Every test
 * that needs an engine creates its own via this helper and tears it down
 * in a `finally`.
 */
export async function allocateSqliteBrain(label: string): Promise<ScenarioEngineHandle> {
  const rootDir = mkdtempSync(join(tmpdir(), `mbrain-scenario-${label}-`));
  const databasePath = join(rootDir, 'brain.db');
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();

  return {
    engine,
    rootDir,
    teardown: async () => {
      await engine.disconnect();
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

/**
 * Seed a work-scoped task thread with a fully populated working set so
 * scenario tests can exercise the task_resume path.
 */
export async function seedWorkTaskThread(
  engine: BrainEngine,
  taskId: string,
  overrides: {
    title?: string;
    scope?: 'work' | 'personal' | 'mixed';
    status?: TaskStatus;
    repoPath?: string | null;
    branchName?: string | null;
    workingSet?: {
      active_paths?: string[];
      active_symbols?: string[];
      blockers?: string[];
      open_questions?: string[];
      next_steps?: string[];
      verification_notes?: string[];
    };
  } = {},
): Promise<void> {
  await engine.createTaskThread({
    id: taskId,
    scope: overrides.scope ?? 'work',
    title: overrides.title ?? `Scenario task ${taskId}`,
    goal: 'Validate scenario behavior end to end.',
    status: overrides.status ?? 'active',
    repo_path: overrides.repoPath ?? '/fixture/repo',
    branch_name: overrides.branchName ?? 'scenario-branch',
    current_summary: 'Seeded from the scenario-test helper for contract validation.',
  });
  await engine.upsertTaskWorkingSet({
    task_id: taskId,
    active_paths: overrides.workingSet?.active_paths ?? ['src/core/operations.ts'],
    active_symbols: overrides.workingSet?.active_symbols ?? ['selectRetrievalRoute'],
    blockers: overrides.workingSet?.blockers ?? ['Waiting on baseline fixture'],
    open_questions: overrides.workingSet?.open_questions ?? ['How should mixed intent decompose?'],
    next_steps: overrides.workingSet?.next_steps ?? [
      'Re-read the spec invariants before writing more assertions.',
    ],
    verification_notes: overrides.workingSet?.verification_notes ?? [],
    last_verified_at: null,
  });
}

/**
 * Seed a memory candidate with the given status, advancing through the
 * real service-layer transitions so governance invariants are preserved.
 */
export async function seedMemoryCandidate(
  engine: BrainEngine,
  opts: {
    id: string;
    status?: 'captured' | 'candidate' | 'staged_for_review';
    scope_id?: string;
    source_refs?: string[];
    target_object_type?: 'curated_note' | 'procedure' | 'profile_memory' | 'personal_episode' | 'other' | null;
    target_object_id?: string | null;
    candidate_type?: 'fact' | 'relationship' | 'note_update' | 'procedure' | 'profile_update' | 'open_question' | 'rationale';
    proposed_content?: string;
  },
): Promise<void> {
  const status = opts.status ?? 'captured';
  await engine.createMemoryCandidateEntry({
    id: opts.id,
    scope_id: opts.scope_id ?? 'workspace:default',
    candidate_type: opts.candidate_type ?? 'fact',
    proposed_content: opts.proposed_content ?? `Scenario candidate ${opts.id} proposes a fact.`,
    source_refs: opts.source_refs ?? ['User, direct message, 2026-04-23 2:00 PM KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.9,
    importance_score: 0.8,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: 'captured',
    target_object_type: opts.target_object_type ?? 'curated_note',
    target_object_id: opts.target_object_id ?? 'concepts/scenario-target',
    reviewed_at: null,
    review_reason: null,
  });

  if (status === 'captured') return;

  const { advanceMemoryCandidateStatus } = await import(
    '../../src/core/services/memory-inbox-service.ts'
  );
  await advanceMemoryCandidateStatus(engine, {
    id: opts.id,
    next_status: 'candidate',
  });
  if (status === 'candidate') return;

  await advanceMemoryCandidateStatus(engine, {
    id: opts.id,
    next_status: 'staged_for_review',
    review_reason: 'Scenario seeded to staged_for_review.',
  });
}
