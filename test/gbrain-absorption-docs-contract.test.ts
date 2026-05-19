import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('personal gbrain absorption docs contracts', () => {
  test('records a GA-P0 upstream classification checkpoint', () => {
    const doc = readRepoFile('docs/UPSTREAM_SYNC.md');

    expect(doc).toContain('## Roadmap 2026-05-19 - GA-P0 personal gbrain absorption classification checkpoint');
    expect(doc).toContain('03947665e4dbfeaf8a5542d160a0f4b89e4ae747');
    expect(doc).toContain('| Reference area | Decision | MBrain-shaped action | Boundary rationale |');
    expect(doc).toContain('| System-of-record and reconciler discipline | adapt |');
    expect(doc).toContain('| HTTP MCP, OAuth, admin UI, teammate-scoped writes | reject |');
    expect(doc).toContain('| Minions, durable job runtime, hosted agent runtime | reject |');
    expect(doc).toContain('| Eval capture and replay | adapt |');
    expect(doc).toContain('| Code intelligence and tree-sitter symbol graph | later |');
    expect(doc).toContain('### Direct-port denylist');
    expect(doc).toContain('### Useful upstream evidence ledger');
  });

  test('anchors authority routing in the memory-loop protocol owner', () => {
    const doc = readRepoFile('docs/architecture/redesign/02-memory-loop-and-protocols.md');

    expect(doc).toContain('## GBrain Absorption Authority Routing Contract');
    expect(doc).toContain('| Session signal | First routing question | Allowed destination | Forbidden shortcut |');
    expect(doc).toContain('Domain-specific write homes are selected before candidate or canonical write selection.');
    expect(doc).toContain('## Personal Maintenance Phase Contract');
    expect(doc).toContain('Maintenance phases produce reports, candidates, or governed apply requests.');
  });

  test('anchors corpus lanes and code lane in the context-map owner', () => {
    const doc = readRepoFile('docs/architecture/redesign/05-workstream-context-map.md');

    expect(doc).toContain('## Personal Corpus Lane Metadata Contract');
    expect(doc).toContain('A corpus lane is not a scope.');
    expect(doc).toContain('Corpus lanes are source and artifact metadata inside an already resolved scopeId.');
    expect(doc).toContain('Corpus lanes never replace Source Records, imported-artifact boundaries, retrieval traces, or Scope Gate decisions.');
    expect(doc).toContain('## Code Lane Derived Artifact Contract');
    expect(doc).toContain('Graph expansion is opt-in until evaluation proves it improves code retrieval.');
    expect(doc).toContain('reindex and invalidation plan');
  });

  test('anchors maintenance apply controls in the governance owner', () => {
    const doc = readRepoFile('docs/architecture/redesign/06-workstream-governance-and-inbox.md');

    expect(doc).toContain('## Personal Maintenance Apply Boundary');
    expect(doc).toContain('active realm and session');
    expect(doc).toContain('mutation ledger');
    expect(doc).toContain('target snapshot');
    expect(doc).toContain('dry-run and apply paths must perform the same validation');
  });

  test('anchors corpus lane scope boundaries in the profile/scope owner', () => {
    const doc = readRepoFile('docs/architecture/redesign/07-workstream-profile-memory-and-scope.md');

    expect(doc).toContain('## Corpus Lane Scope Boundary');
    expect(doc).toContain('The lane resolver runs after the Scope Gate.');
    expect(doc).toContain('A lane cannot turn work retrieval into personal retrieval.');
    expect(doc).toContain('Profile Memory routing still follows the Scope Gate and write isolation rules.');
  });

  test('anchors replay fixtures and gates in the evaluation owner', () => {
    const doc = readRepoFile('docs/architecture/redesign/08-evaluation-and-acceptance.md');

    expect(doc).toContain('## GBrain Absorption Replay Fixture Contract');
    expect(doc).toContain('GA-P fixture namespace');
    expect(doc).toContain('candidate_authority');
    expect(doc).toContain('lane_scope_decision');
    expect(doc).toContain('code_verification');
    expect(doc).toContain('maintenance_apply_result');
  });

  test('updates the install verification runbook for GA-P0 and GA-P1', () => {
    const doc = readRepoFile('docs/MBRAIN_VERIFY.md');

    expect(doc).toContain('## GBrain Absorption GA-P0/GA-P1 Verification');
    expect(doc).toContain('bun test test/gbrain-absorption-docs-contract.test.ts test/scenarios/s26-gbrain-absorption-contracts.test.ts');
    expect(doc).toContain('bun run test:scenarios');
  });

  test('anchors GA-P2 evaluation foundation in the evaluation owner', () => {
    const doc = readRepoFile('docs/architecture/redesign/08-evaluation-and-acceptance.md');

    expect(doc).toContain('## GBrain Absorption GA-P2 Evaluation Foundation');
    expect(doc).toContain('| Fixture family | Existing verification surface | Regression guarded |');
    expect(doc).toContain('| retrieval_regression | `retrieve_context` + `read_context` |');
    expect(doc).toContain('| candidate_lifecycle_regression | Memory Inbox status events |');
    expect(doc).toContain('| task_resume_fidelity | `resume_task` / task working set |');
    expect(doc).toContain('| scope_leak_regression | Scope Gate exact-selector denial |');
    expect(doc).toContain('| derived_refresh_regression | context-map stale freshness checks |');
  });

  test('updates the install verification runbook for GA-P2', () => {
    const doc = readRepoFile('docs/MBRAIN_VERIFY.md');

    expect(doc).toContain('## GBrain Absorption GA-P2 Verification');
    expect(doc).toContain('bun test test/gbrain-absorption-docs-contract.test.ts test/scenarios/s27-gbrain-evaluation-foundation.test.ts');
    expect(doc).toContain('replay fixture families cover retrieval, candidate lifecycle, task resume, scope leak, and derived refresh regressions');
  });

  test('anchors GA-P3 corpus-lane implementation in context-map, scope, and evaluation docs', () => {
    const contextMap = readRepoFile('docs/architecture/redesign/05-workstream-context-map.md');
    const scope = readRepoFile('docs/architecture/redesign/07-workstream-profile-memory-and-scope.md');
    const evaluation = readRepoFile('docs/architecture/redesign/08-evaluation-and-acceptance.md');

    expect(contextMap).toContain('## GA-P3 Corpus Lane Runtime Contract');
    expect(contextMap).toContain('Corpus lanes are post-scope metadata only.');
    expect(contextMap).toContain('retrievalSelectorId');
    expect(contextMap).toContain('include lane ids');
    expect(scope).toContain('GA-P3 keeps the lane resolver after the Scope Gate');
    expect(scope).toContain('`route_memory_writeback` must');
    expect(scope).toContain('defer ambiguous imported source-extracted writes');
    expect(evaluation).toContain('## GBrain Absorption GA-P3 Corpus Lanes');
    expect(evaluation).toContain('ga-p3-corpus-lanes.fixture.json');
    expect(evaluation).toContain('lane_grants_authority: false');
  });

  test('updates the install verification runbook for GA-P3', () => {
    const doc = readRepoFile('docs/MBRAIN_VERIFY.md');

    expect(doc).toContain('## GBrain Absorption GA-P3 Verification');
    expect(doc).toContain('bun test test/corpus-lane-service.test.ts test/import-file.test.ts test/read-context-service.test.ts test/retrieval-context-operations.test.ts test/memory-writeback-router-service.test.ts test/gbrain-absorption-docs-contract.test.ts test/scenarios/s29-gbrain-corpus-lanes.test.ts');
    expect(doc).toContain('corpus lanes remain post-scope provenance metadata and never become scopes, authority, or storage roots');
  });

  test('anchors GA-P4 memory authority in the protocol owner', () => {
    const doc = readRepoFile('docs/architecture/redesign/02-memory-loop-and-protocols.md');

    expect(doc).toContain('## GA-P4 Memory Artifact Authority Matrix');
    expect(doc).toContain('| Profile Memory | `answer_ground` only after Scope Gate `allow` | `profile_memory` |');
    expect(doc).toContain('| Personal Episode | `answer_ground` only after Scope Gate `allow` | `personal_episode` |');
    expect(doc).toContain('Derived projections are never the system of record.');
  });

  test('anchors GA-P4 candidate activation and handoff invariants in governance', () => {
    const doc = readRepoFile('docs/architecture/redesign/06-workstream-governance-and-inbox.md');

    expect(doc).toContain('## GA-P4 Candidate Authority and Handoff Invariants');
    expect(doc).toContain('Candidate activation is `candidate_only`, never `answer_ground`.');
    expect(doc).toContain('Canonical handoff preserves source refs, target object identity, scope, sensitivity, and expected target snapshot evidence.');
  });

  test('anchors GA-P4 profile-vs-compiled-truth routing in profile scope', () => {
    const doc = readRepoFile('docs/architecture/redesign/07-workstream-profile-memory-and-scope.md');

    expect(doc).toContain('## GA-P4 Profile-vs-Compiled-Truth Routing');
    expect(doc).toContain('Profile Memory reports `profile_memory` authority, not `canonical_compiled_truth`.');
    expect(doc).toContain('Personal Episodes report `personal_episode` authority, not `canonical_compiled_truth`.');
  });

  test('anchors GA-P4 replay and derived projection rules in evaluation', () => {
    const doc = readRepoFile('docs/architecture/redesign/08-evaluation-and-acceptance.md');

    expect(doc).toContain('## GBrain Absorption GA-P4 Memory Authority');
    expect(doc).toContain('ga-p4-memory-authority.fixture.json');
    expect(doc).toContain('authority_cases');
    expect(doc).toContain('writeback_cases');
    expect(doc).toContain('derived projection system-of-record and rebuild rules');
  });

  test('updates the install verification runbook for GA-P4', () => {
    const doc = readRepoFile('docs/MBRAIN_VERIFY.md');

    expect(doc).toContain('## GBrain Absorption GA-P4 Verification');
    expect(doc).toContain('bun test test/memory-activation-policy-service.test.ts test/memory-writeback-router-service.test.ts test/gbrain-absorption-docs-contract.test.ts test/scenarios/s28-gbrain-memory-authority.test.ts');
    expect(doc).toContain('profile memory and personal episodes report their own authority after scope allow');
  });

  test('anchors GA-P5 code-lane runtime in context-map and evaluation docs', () => {
    const contextMap = readRepoFile('docs/architecture/redesign/05-workstream-context-map.md');
    const evaluation = readRepoFile('docs/architecture/redesign/08-evaluation-and-acceptance.md');

    expect(contextMap).toContain('## GA-P5 Code Lane Runtime Contract');
    expect(contextMap).toContain('Code-lane runtime entries are derived orientation, not current code truth.');
    expect(contextMap).toContain('Chunk-grain metadata is required before graph-walk retrieval can become default.');
    expect(contextMap).toContain('Symbol graph expansion is opt-in, depth-limited, fanout-capped, and bounded.');
    expect(contextMap).toContain('Extractor/chunker version changes must invalidate or rebuild derived code-lane artifacts.');
    expect(contextMap).toContain('Current code claims require live file, symbol, branch, and content-hash verification.');
    expect(evaluation).toContain('## GBrain Absorption GA-P5 Code Lane');
    expect(evaluation).toContain('ga-p5-code-lane.fixture.json');
    expect(evaluation).toContain('code_lane_cases');
    expect(evaluation).toContain('content_hash_mismatch');
    expect(evaluation).toContain('lane_grants_authority: false');
  });

  test('updates the install verification runbook for GA-P5', () => {
    const doc = readRepoFile('docs/MBRAIN_VERIFY.md');

    expect(doc).toContain('## GBrain Absorption GA-P5 Verification');
    expect(doc).toContain('bun test test/gbrain-absorption-docs-contract.test.ts test/scenarios/s30-gbrain-code-lane.test.ts');
    expect(doc).toContain('code lane stays derived orientation and current code claims require live');
    expect(doc).toContain('stale `expected_content_hash` claims fail through `reverify_code_claims` with');
  });

  test('anchors GA-P6 personal maintenance cycle in governance and evaluation docs', () => {
    const governance = readRepoFile('docs/architecture/redesign/06-workstream-governance-and-inbox.md');
    const evaluation = readRepoFile('docs/architecture/redesign/08-evaluation-and-acceptance.md');

    expect(governance).toContain('## GA-P6 Personal Maintenance Cycle Runtime Contract');
    expect(governance).toContain('GA-P6 makes personal maintenance report-first.');
    expect(governance).toContain('Apply is optional and may only run through the existing memory operations');
    expect(governance).toContain('control plane. It requires an active write-capable realm/session');
    expect(governance).toContain('active write-capable realm/session');
    expect(governance).toContain('Dry-run and apply validation must stay parity-checked');
    expect(governance).toContain('Redaction and sensitive maintenance operations fail closed');
    expect(evaluation).toContain('## GBrain Absorption GA-P6 Personal Maintenance Cycle');
    expect(evaluation).toContain('ga-p6-personal-maintenance-cycle.fixture.json');
    expect(evaluation).toContain('maintenance_report_cases');
    expect(evaluation).toContain('maintenance_apply_control_cases');
    expect(evaluation).toContain('Phase 8 accepts report and suggestion quality');
    expect(evaluation).toContain('Phase 9 accepts apply only through the existing memory operations control');
    expect(evaluation).toContain('plane; maintenance does not define a parallel write path.');
  });

  test('updates the install verification runbook and scenario registry for GA-P6', () => {
    const verify = readRepoFile('docs/MBRAIN_VERIFY.md');
    const scenarios = readRepoFile('test/scenarios/README.md');

    expect(verify).toContain('## GBrain Absorption GA-P6 Verification');
    expect(verify).toContain('bun test test/dream-cycle-maintenance-service.test.ts test/dream-cycle-maintenance-operations.test.ts test/gbrain-absorption-docs-contract.test.ts test/scenarios/s31-gbrain-personal-maintenance-cycle.test.ts');
    expect(verify).toContain('personal maintenance defaults to report and suggestion output');
    expect(verify).toContain('optional apply requires the existing control plane with active realm/session');
    expect(scenarios).toContain('| S31 | `s31-gbrain-personal-maintenance-cycle.test.ts` | GA-P6, G1, G2, L5, L6 | ✅ green |');
  });

  test('anchors GA-P7 consolidation and upstream discipline in upstream and evaluation docs', () => {
    const upstream = readRepoFile('docs/UPSTREAM_SYNC.md');
    const evaluation = readRepoFile('docs/architecture/redesign/08-evaluation-and-acceptance.md');

    expect(upstream).toContain('## Roadmap 2026-05-19 - GA-P7 consolidation and upstream discipline checkpoint');
    expect(upstream).toContain('| Upstream area | GA-P7 classification | MBrain implementation state | Discipline rule |');
    expect(upstream).toContain('| Source-aware ranking | adopted |');
    expect(upstream).toContain('| Replay fixture discipline | adopted |');
    expect(upstream).toContain('| System-of-record discipline | adopted |');
    expect(upstream).toContain('| Eval capture and replay | reinterpreted |');
    expect(upstream).toContain('| Facts/takes hot-cold memory | reinterpreted |');
    expect(upstream).toContain('| HTTP MCP, OAuth, admin UI, teammate-scoped writes | rejected |');
    expect(upstream).toContain('| Minions and hosted agent runtime | rejected |');
    expect(upstream).toContain('| Supabase/TUS hosted storage | rejected |');
    expect(upstream).toContain('| Frontmatter guards and resolver warnings | deferred |');
    expect(upstream).toContain('| Parallel incremental sync | deferred |');
    expect(upstream).toContain('No GA-P7 row grants permission to port upstream production runtime code directly.');
    expect(evaluation).toContain('## GBrain Absorption GA-P7 Consolidation And Upstream Discipline');
    expect(evaluation).toContain('ga-p7-upstream-discipline.fixture.json');
    expect(evaluation).toContain('consolidation_cases');
    expect(evaluation).toContain('adopted, reinterpreted, rejected, and deferred upstream areas remain explicit');
    expect(evaluation).toContain('no production runtime change');
  });

  test('updates the install verification runbook and scenario registry for GA-P7', () => {
    const verify = readRepoFile('docs/MBRAIN_VERIFY.md');
    const scenarios = readRepoFile('test/scenarios/README.md');

    expect(verify).toContain('## GBrain Absorption GA-P7 Verification');
    expect(verify).toContain('bun test test/gbrain-absorption-docs-contract.test.ts test/scenarios/s32-gbrain-upstream-discipline.test.ts');
    expect(verify).toContain('test/fixtures/gbrain-absorption/ga-p7-upstream-discipline.fixture.json');
    expect(verify).toContain('upstream_checkpoint_lists_adopted_areas');
    expect(verify).toContain('reinterpreted_vs_rejected_rationale_present');
    expect(verify).toContain('verification_checklist_covers_ga_p2_through_ga_p6');
    expect(verify).toContain('deferred_surfaces_remain_explicit');
    expect(verify).toContain('docs_and_tests_match_implementation_state');
    expect(verify).toContain('test/scenarios/s27-gbrain-evaluation-foundation.test.ts');
    expect(verify).toContain('test/scenarios/s28-gbrain-memory-authority.test.ts');
    expect(verify).toContain('test/scenarios/s29-gbrain-corpus-lanes.test.ts');
    expect(verify).toContain('test/scenarios/s30-gbrain-code-lane.test.ts');
    expect(verify).toContain('test/scenarios/s31-gbrain-personal-maintenance-cycle.test.ts');
    expect(scenarios).toContain('| S32 | `s32-gbrain-upstream-discipline.test.ts` | GA-P7, E1, L4, L6, G1 | ✅ green |');
  });
});
