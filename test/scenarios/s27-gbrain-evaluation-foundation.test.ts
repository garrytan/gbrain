/**
 * Scenario S27 - GBrain absorption GA-P2 evaluation foundation.
 *
 * GA-P2 must be a replayable evaluation slice, not new production behavior.
 * The scenario uses a hand-authored replay fixture and exercises existing
 * SQLite retrieval, Memory Inbox, task resume, scope gate, and derived
 * freshness surfaces.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { importFromContent } from '../../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { buildStructuralContextMapEntry } from '../../src/core/services/context-map-service.ts';
import { queryStructuralContextMap } from '../../src/core/services/context-map-query-service.ts';
import {
  advanceMemoryCandidateStatus,
  createMemoryCandidateEntryWithStatusEvent,
  rejectMemoryCandidateEntry,
} from '../../src/core/services/memory-inbox-service.ts';
import { selectRetrievalRoute } from '../../src/core/services/retrieval-route-selector-service.ts';
import type {
  MemoryActivationDecision,
  MemoryCandidateStatusEventKind,
  ReadContextResult,
  RetrievalRouteIntent,
  RetrieveContextResult,
} from '../../src/core/types.ts';
import { allocateSqliteBrain, seedWorkTaskThread } from './helpers.ts';

type ReplayCase = {
  case_id: string;
  fixture_id: string;
  query: string;
  requested_scope: 'work' | 'personal' | 'mixed';
  expected_intent: string;
  expected_surfaces: string[];
  expected_canonical_refs: string[];
  candidate_authority: 'answer_ground' | 'candidate_only' | 'historical' | 'not_expected';
  must_preserve: string[];
};

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/gbrain-absorption/ga-p2-evaluation-foundation.fixture.json', import.meta.url),
  'utf8',
)) as {
  stage_id: string;
  fixture_format: string;
  verification_commands: string[];
  replay_cases: ReplayCase[];
};

function opContext(engine: OperationContext['engine']): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: console,
    dryRun: false,
  };
}

function replayCase(caseId: string): ReplayCase {
  const found = fixture.replay_cases.find((entry) => entry.case_id === caseId);
  if (!found) throw new Error(`Missing GA-P2 replay case ${caseId}`);
  return found;
}

function expectedActivation(authority: ReplayCase['candidate_authority']): MemoryActivationDecision {
  if (authority !== 'answer_ground' && authority !== 'candidate_only') {
    throw new Error(`GA-P2 case authority ${authority} is not a runtime activation decision`);
  }
  return authority;
}

function expectedRouteIntent(intent: string): RetrievalRouteIntent {
  if (
    intent !== 'task_resume'
    && intent !== 'broad_synthesis'
    && intent !== 'precision_lookup'
    && intent !== 'mixed_scope_bridge'
    && intent !== 'personal_profile_lookup'
    && intent !== 'personal_episode_lookup'
  ) {
    throw new Error(`GA-P2 case intent ${intent} is not a retrieval route intent`);
  }
  return intent;
}

describe('S27 - gbrain evaluation foundation', () => {
  test('defines replay fixture families for every GA-P2 regression surface', () => {
    expect(fixture.stage_id).toBe('GA-P2');
    expect(fixture.fixture_format).toBe('gbrain_absorption_replay_v1');
    expect(fixture.verification_commands).toContain(
      'bun test test/gbrain-absorption-docs-contract.test.ts test/scenarios/s27-gbrain-evaluation-foundation.test.ts',
    );

    const requiredCases = [
      'retrieval_regression',
      'candidate_lifecycle_regression',
      'task_resume_fidelity',
      'scope_leak_regression',
      'derived_refresh_regression',
    ];
    expect(fixture.replay_cases.map((entry) => entry.case_id).sort()).toEqual(requiredCases.sort());

    for (const entry of fixture.replay_cases) {
      expect(entry.fixture_id.startsWith('ga-p2-')).toBe(true);
      expect(entry.query.length).toBeGreaterThan(0);
      expect(['work', 'personal', 'mixed']).toContain(entry.requested_scope);
      expect(entry.expected_intent.length).toBeGreaterThan(0);
      expect(entry.expected_surfaces.length).toBeGreaterThan(0);
      expect(['answer_ground', 'candidate_only', 'historical', 'not_expected']).toContain(
        entry.candidate_authority,
      );
      expect(entry.must_preserve.length).toBeGreaterThan(0);
    }
  });

  test('replays retrieval regression through retrieve_context then read_context', async () => {
    const replay = replayCase('retrieval_regression');
    const handle = await allocateSqliteBrain(replay.fixture_id);

    try {
      await importFromContent(handle.engine, 'concepts/ga-p2-retrieval', [
        '---',
        'type: concept',
        'title: GA-P2 Retrieval Fixture',
        '---',
        '# Compiled Truth',
        'The GA P2 retrieval canonical needle is answerable only after read_context.',
        '[Source: Scenario S27]',
      ].join('\n'), { path: 'concepts/ga-p2-retrieval.md' });

      const retrieve = await operationsByName.retrieve_context.handler(opContext(handle.engine), {
        query: replay.query,
        requested_scope: replay.requested_scope,
        include_orientation: false,
        limit: 5,
      }) as RetrieveContextResult;

      expect(retrieve.answerability.answerable_from_probe).toBe(false);
      expect(retrieve.answerability.reason_codes).toContain('probe_candidates_are_not_answer_ground');
      expect(retrieve.required_reads[0]?.selector_id).toBe(replay.expected_canonical_refs[0]);
      expect(retrieve.candidates[0]?.activation).toBe(expectedActivation(replay.candidate_authority));

      const read = await operationsByName.read_context.handler(opContext(handle.engine), {
        selectors: retrieve.required_reads,
        token_budget: 400,
      }) as ReadContextResult;

      expect(read.answer_ready.ready).toBe(true);
      expect(read.canonical_reads[0]?.text).toContain('GA P2 retrieval canonical needle');
    } finally {
      await handle.teardown();
    }
  });

  test('replays candidate lifecycle regression through status events and audit visibility', async () => {
    const replay = replayCase('candidate_lifecycle_regression');
    const handle = await allocateSqliteBrain(replay.fixture_id);

    try {
      await createMemoryCandidateEntryWithStatusEvent(handle.engine, {
        id: 'candidate-ga-p2-rejected',
        scope_id: 'workspace:default',
        candidate_type: 'fact',
        proposed_content: 'GA-P2 rejected candidates must remain auditable.',
        source_refs: ['Scenario S27 candidate lifecycle source'],
        generated_by: 'manual',
        extraction_kind: 'manual',
        confidence_score: 0.9,
        importance_score: 0.8,
        recurrence_score: 0.1,
        sensitivity: 'work',
        status: 'captured',
        target_object_type: 'curated_note',
        target_object_id: 'concepts/ga-p2-candidate-target',
      });
      await advanceMemoryCandidateStatus(handle.engine, {
        id: 'candidate-ga-p2-rejected',
        next_status: 'candidate',
      });
      await advanceMemoryCandidateStatus(handle.engine, {
        id: 'candidate-ga-p2-rejected',
        next_status: 'staged_for_review',
        review_reason: 'Prepare GA-P2 lifecycle replay.',
      });
      const rejected = await rejectMemoryCandidateEntry(handle.engine, {
        id: 'candidate-ga-p2-rejected',
        review_reason: 'Rejected by GA-P2 replay fixture.',
      });

      expect(rejected.status).toBe('rejected');
      expect(rejected.source_refs).toContain('Scenario S27 candidate lifecycle source');
      const events = await handle.engine.listMemoryCandidateStatusEvents({
        candidate_id: 'candidate-ga-p2-rejected',
        limit: 20,
      });
      const expectedEvents: MemoryCandidateStatusEventKind[] = [
        'created',
        'advanced',
        'advanced',
        'rejected',
      ];
      expect(events.map((event) => event.event_kind).sort()).toEqual(expectedEvents.sort());

      const rejectedList = await handle.engine.listMemoryCandidateEntries({
        status: 'rejected',
        limit: 10,
      });
      expect(rejectedList.map((entry) => `memory_candidate:${entry.id}`)).toContain(
        replay.expected_canonical_refs[0],
      );
    } finally {
      await handle.teardown();
    }
  });

  test('replays task resume fidelity with goal, blockers, failed attempts, decisions, and warnings', async () => {
    const replay = replayCase('task_resume_fidelity');
    const handle = await allocateSqliteBrain(replay.fixture_id);

    try {
      const repoPath = join(handle.rootDir, 'repo');
      mkdirSync(join(repoPath, 'src'), { recursive: true });
      writeFileSync(join(repoPath, 'src/evaluation.ts'), 'export const gaP2Evaluation = true;\n');

      await seedWorkTaskThread(handle.engine, 'task-ga-p2', {
        title: 'GA-P2 evaluation foundation',
        repoPath,
        branchName: 'ga-p2-evaluation',
        workingSet: {
          active_paths: ['src/evaluation.ts'],
          active_symbols: ['gaP2Evaluation'],
          blockers: ['Need replay fixture before GA-P3 work'],
          open_questions: ['Does GA-P2 cover scope leaks?'],
          next_steps: ['Run focused S27 scenario.'],
          verification_notes: ['Working set has not been verified in the current workspace.'],
        },
      });
      await handle.engine.recordTaskAttempt({
        id: 'attempt-ga-p2',
        task_id: 'task-ga-p2',
        summary: 'Tried to skip fixture-first coverage',
        outcome: 'failed',
        applicability_context: {},
        evidence: ['GA-P2 requires replayable fixtures first.'],
      });
      await handle.engine.recordTaskDecision({
        id: 'decision-ga-p2',
        task_id: 'task-ga-p2',
        summary: 'Keep GA-P2 on existing surfaces only',
        rationale: 'Roadmap says build measurement before powerful behavior.',
        consequences: ['Do not add GA-P3 corpus lane services.'],
        validity_context: {},
      });

      const result = await selectRetrievalRoute(handle.engine, {
        intent: expectedRouteIntent(replay.expected_intent),
        task_id: 'task-ga-p2',
        persist_trace: true,
      });

      expect(result.selected_intent).toBe('task_resume');
      const card = result.route?.payload as {
        task_id: string;
        goal: string;
        blockers: string[];
        failed_attempts: string[];
        active_decisions: string[];
        verification_warnings: string[];
      };
      expect(card.task_id).toBe('task-ga-p2');
      expect(card.goal).toContain('Validate scenario behavior end to end.');
      expect(card.blockers).toContain('Need replay fixture before GA-P3 work');
      expect(card.failed_attempts).toContain('Tried to skip fixture-first coverage');
      expect(card.active_decisions).toContain('Keep GA-P2 on existing surfaces only');
      expect(card.verification_warnings).toContain('Working set has not been verified in the current workspace.');

      const traces = await handle.engine.listRetrievalTraces('task-ga-p2', { limit: 5 });
      expect(traces[0]?.route).toEqual([
        'task_thread',
        'working_set',
        'attempt_decision_history',
        'focused_source_reads',
      ]);
      expect(traces[0]?.verification.some((entry) => entry.startsWith('intent:task_resume'))).toBe(true);
    } finally {
      await handle.teardown();
    }
  });

  test('replays scope leak regression by denying personal exact selectors from work scope', async () => {
    const replay = replayCase('scope_leak_regression');
    const handle = await allocateSqliteBrain(replay.fixture_id);

    try {
      const retrieve = await operationsByName.retrieve_context.handler(opContext(handle.engine), {
        query: replay.query,
        requested_scope: replay.requested_scope,
        selectors: [{
          kind: 'compiled_truth',
          scope_id: 'personal:default',
          slug: 'profile/private-ga-p2',
        }],
      }) as RetrieveContextResult;

      expect(retrieve.scope_gate?.policy).not.toBe('allow');
      expect(retrieve.required_reads).toEqual([]);
      expect(retrieve.candidates).toEqual([]);
      expect(retrieve.answerability.answerable_from_probe).toBe(false);
      expect(retrieve.answerability.reason_codes).toContain(`scope_gate_${retrieve.scope_gate!.policy}`);
    } finally {
      await handle.teardown();
    }
  });

  test('replays derived refresh regression through stale context-map freshness', async () => {
    const replay = replayCase('derived_refresh_regression');
    const handle = await allocateSqliteBrain(replay.fixture_id);

    try {
      await importFromContent(handle.engine, 'systems/ga-p2-derived', [
        '---',
        'type: system',
        'title: GA-P2 Derived',
        '---',
        '# Overview',
        'See [[concepts/ga-p2-derived-target]].',
      ].join('\n'), { path: 'systems/ga-p2-derived.md' });
      await importFromContent(handle.engine, 'concepts/ga-p2-derived-target', [
        '---',
        'type: concept',
        'title: GA-P2 Derived Target',
        '---',
        '# Purpose',
        'GA P2 derived freshness target starts current.',
      ].join('\n'), { path: 'concepts/ga-p2-derived-target.md' });

      const built = await buildStructuralContextMapEntry(handle.engine);
      expect(built.id).toBe(replay.expected_canonical_refs[0]);
      await importFromContent(handle.engine, 'concepts/ga-p2-derived-target', [
        '---',
        'type: concept',
        'title: GA-P2 Derived Target',
        '---',
        '# Purpose',
        'GA P2 derived freshness target changed after the map build.',
      ].join('\n'), { path: 'concepts/ga-p2-derived-target.md' });

      const result = await queryStructuralContextMap(handle.engine, {
        map_id: built.id,
        query: replay.query,
      });

      expect(result.selection_reason).toBe('direct_map_id');
      expect(result.result?.status).toBe('stale');
      expect(result.result?.summary_lines).toContain('Context map status is stale.');
      expect(result.result?.summary_lines).toContain(
        'Rebuild the context map before trusting this query result for broad routing.',
      );
    } finally {
      await handle.teardown();
    }
  });

  test('README registers S27 in the scenario contract table', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');

    expect(readme).toContain('| S27 | `s27-gbrain-evaluation-foundation.test.ts` | GA-P2, E1, L5, L6, L7, G1 | ✅ green |');
  });
});
