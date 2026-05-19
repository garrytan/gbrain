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
});
