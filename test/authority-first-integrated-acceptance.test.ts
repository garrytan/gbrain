import { readFileSync } from 'fs';
import { describe, expect, test } from 'bun:test';
import {
  AUTHORITY_FIRST_ZERO_COUNTER_KEYS,
  runAuthorityFirstIntegratedAcceptance,
  type AuthorityFirstIntegratedAcceptanceFixture,
} from '../src/core/evaluation/authority-first-integrated-acceptance.ts';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/authority-first/phase8-integrated-acceptance.fixture.json', import.meta.url),
  'utf8',
)) as AuthorityFirstIntegratedAcceptanceFixture;

describe('authority-first integrated acceptance runner', () => {
  test('passes the deterministic fixture with all safety counters at zero', () => {
    const report = runAuthorityFirstIntegratedAcceptance(fixture);

    expect(report.fixture_id).toBe('phase8-integrated-acceptance');
    expect(report.status).toBe('passed');
    expect(report.failures).toEqual([]);
    for (const key of AUTHORITY_FIRST_ZERO_COUNTER_KEYS) {
      expect(report.counters[key]).toBe(0);
    }
    expect(report.counters).toEqual(fixture.expected_zero_counters);
  });

  test('keeps probe, candidate, graph, raw episode, and Dream surfaces out of answer evidence', () => {
    const report = runAuthorityFirstIntegratedAcceptance(fixture);

    expect(report.retrieval_probe.must_read_context).toBe(true);
    expect(report.retrieval_probe.probe_answer_evidence_count).toBe(0);
    expect(report.answer_evidence.by_surface).toEqual({
      read_context_canonical: 1,
      retrieve_context_probe: 0,
      search_result: 0,
      memory_candidate: 0,
      graph_path: 0,
      raw_episode: 0,
      dream_candidate: 0,
    });
    expect(report.surface_counts.search_hint_count).toBeGreaterThan(0);
    expect(report.surface_counts.retrieve_candidate_hint_count).toBeGreaterThan(0);
    expect(report.surface_counts.graph_planning_count).toBe(1);
    expect(report.surface_counts.raw_episode_provenance_count).toBe(1);
    expect(report.surface_counts.dream_candidate_count).toBeGreaterThan(0);
  });

  test('confirms trust metadata, projections, writeback router, and proof are deterministic', () => {
    const report = runAuthorityFirstIntegratedAcceptance(fixture);

    for (const decision of report.trust_decisions) {
      expect(decision.reason_codes.length).toBeGreaterThan(0);
      expect(decision.policy_version_hash).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(decisionById(report, 'code:src/core/operations.ts')?.activation).toBe('verify_first');
    expect(decisionById(report, 'personal-episode:allowed')?.activation).toBe('answer_ground');
    expect(decisionById(report, 'personal-episode:denied')?.activation).toBe('ignore');
    expect(decisionById(report, 'candidate:phase8-inbox')?.activation).toBe('candidate_only');
    expect(decisionById(report, 'graph_path:phase8-recall')?.activation).toBe('orientation_only');

    expect(report.projections.decision_packets[0]).toMatchObject({
      activation: 'answer_ground',
      authority: 'canonical_compiled_truth',
    });
    expect(report.projections.negative_memory[0]).toMatchObject({
      activation: 'suppress_if_valid',
      suppression_applies: true,
    });
    expect(report.episode_capture.provenance_only_count).toBe(report.episode_capture.decisions.length);
    expect(report.writeback_routes).toEqual([
      expect.objectContaining({
        id: 'canonical-router-allowed',
        decision: 'canonical_write_allowed',
        intended_operation: 'put_page',
        applied: false,
      }),
      expect.objectContaining({
        id: 'agent-inferred-candidate-only',
        decision: 'create_candidate',
        intended_operation: 'create_memory_candidate_entry',
        applied: false,
      }),
    ]);
    expect(report.proof).toEqual({
      status: 'pass',
      scenario_ids: fixture.expected_proof_scenario_ids,
      authority_violations: 0,
      mutations: 0,
    });
  });

  test('keeps graph frontier safety metrics at the Phase 7 boundary', () => {
    const report = runAuthorityFirstIntegratedAcceptance(fixture);

    expect(report.graph.status).toBe('passed');
    expect(report.graph.aggregate.false_bridge_rate).toBe(0);
    expect(report.graph.aggregate.graph_as_answer_evidence_count).toBe(0);
    expect(report.graph.aggregate.scope_leak_count).toBe(0);
    expect(report.graph.aggregate.stale_graph_leakage_count).toBe(0);
    expect(report.graph.aggregate.unsupported_edge_traversal_count).toBe(0);
  });

  test('counts candidate answer evidence as both candidate and noncanonical evidence', () => {
    const bad = cloneFixture();
    bad.answer_evidence_refs.push({
      ref: 'candidate:phase8-inbox',
      surface: 'memory_inbox_candidate',
      authority: 'unreviewed_candidate',
      factual_answer_evidence: true,
    });

    const report = runAuthorityFirstIntegratedAcceptance(bad);
    expect(report.status).toBe('failed');
    expect(report.counters.candidate_answer_evidence_count).toBe(1);
    expect(report.counters.noncanonical_answer_evidence_count).toBe(1);
  });

  test('counts graph paths used as answer evidence', () => {
    const bad = cloneFixture();
    bad.answer_evidence_refs.push({
      ref: 'graph_path:phase8-recall',
      surface: 'graph_path',
      authority: 'derived_orientation',
      factual_answer_evidence: true,
    });

    const report = runAuthorityFirstIntegratedAcceptance(bad);
    expect(report.status).toBe('failed');
    expect(report.counters.graph_as_answer_evidence_count).toBe(1);
  });

  test('counts scope-denied personal episodes used as answer evidence', () => {
    const bad = cloneFixture();
    bad.answer_evidence_refs.push({
      ref: 'personal-episode:denied',
      surface: 'personal_episode',
      authority: 'personal_episode',
      factual_answer_evidence: true,
      scope_allowed: false,
    });

    const report = runAuthorityFirstIntegratedAcceptance(bad);
    expect(report.status).toBe('failed');
    expect(report.counters.scope_leak_count).toBe(1);
  });

  test('counts stale code artifacts used as answer evidence without verify-first', () => {
    const bad = cloneFixture();
    bad.answer_evidence_refs.push({
      ref: 'code:src/core/operations.ts',
      surface: 'current_artifact',
      authority: 'verified_current_artifact',
      factual_answer_evidence: true,
      stale: true,
    });

    const report = runAuthorityFirstIntegratedAcceptance(bad);
    expect(report.status).toBe('failed');
    expect(report.counters.stale_verify_first_miss_count).toBe(1);
  });

  test('counts Dream same-run promotion and canonical writes', () => {
    const bad = cloneFixture();
    bad.dream.same_cycle_promoted_candidate_ids.push('candidate:dream-phase8');
    bad.dream.canonical_write_attempt_ids.push('write:dream-put-page');
    bad.candidate_promotions.push({
      candidate_id: 'candidate:dream-phase8',
      governed_path: false,
      same_run: true,
    });

    const report = runAuthorityFirstIntegratedAcceptance(bad);
    expect(report.status).toBe('failed');
    expect(report.counters.dream_canonical_write_attempt_count).toBe(1);
    expect(report.counters.dream_self_consumption_count).toBe(2);
    expect(report.counters.promotion_bypass_count).toBe(1);
  });
});

function cloneFixture(): AuthorityFirstIntegratedAcceptanceFixture {
  return JSON.parse(JSON.stringify(fixture)) as AuthorityFirstIntegratedAcceptanceFixture;
}

function decisionById(
  report: ReturnType<typeof runAuthorityFirstIntegratedAcceptance>,
  artifactId: string,
) {
  return report.trust_decisions.find((decision) => decision.artifact_id === artifactId);
}
