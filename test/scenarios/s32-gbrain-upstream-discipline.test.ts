/**
 * Scenario S32 - GBrain absorption GA-P7 upstream discipline.
 *
 * GA-P7 is a consolidation checkpoint. It proves the GA-P2 through GA-P6
 * absorption work is documented, classified, and executable without adding a
 * production runtime surface.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';

type ConsolidationCase = {
  case_id: string;
  classification: string;
  required_terms: string[];
  expected_doc: string;
  expected_runtime_change: boolean;
};

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/gbrain-absorption/ga-p7-upstream-discipline.fixture.json', import.meta.url),
  'utf8',
)) as {
  stage_id: string;
  fixture_format: string;
  verification_commands: string[];
  coverage: Record<string, { fixture: string; scenario: string; verification: string }>;
  consolidation_cases: ConsolidationCase[];
};

function readRepoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

function consolidationCase(caseId: string): ConsolidationCase {
  const found = fixture.consolidation_cases.find((entry) => entry.case_id === caseId);
  if (!found) throw new Error(`Missing GA-P7 consolidation case ${caseId}`);
  return found;
}

function expectCaseTermsInDeclaredDoc(entry: ConsolidationCase): void {
  const doc = readRepoFile(entry.expected_doc).toLowerCase();
  for (const term of entry.required_terms) {
    expect(doc, `${entry.case_id} missing "${term}" in ${entry.expected_doc}`).toContain(term.toLowerCase());
  }
}

describe('S32 - gbrain upstream discipline', () => {
  test('defines the GA-P7 consolidation fixture and required cases', () => {
    expect(fixture.stage_id).toBe('GA-P7');
    expect(fixture.fixture_format).toBe('gbrain_absorption_replay_v1');
    expect(fixture.verification_commands).toEqual(expect.arrayContaining([
      'bun test test/gbrain-absorption-docs-contract.test.ts test/scenarios/s32-gbrain-upstream-discipline.test.ts',
      'bun run test:scenarios',
      'bunx tsc --noEmit --pretty false',
      'git diff --check',
    ]));

    expect(fixture.consolidation_cases.map((entry) => entry.case_id).sort()).toEqual([
      'deferred_surfaces_remain_explicit',
      'docs_and_tests_match_implementation_state',
      'reinterpreted_vs_rejected_rationale_present',
      'upstream_checkpoint_lists_adopted_areas',
      'verification_checklist_covers_ga_p2_through_ga_p6',
    ]);

    for (const entry of fixture.consolidation_cases) {
      expect(entry.expected_runtime_change).toBe(false);
      expect(entry.expected_doc.length).toBeGreaterThan(0);
      expect(entry.required_terms.length).toBeGreaterThan(0);
      expectCaseTermsInDeclaredDoc(entry);
    }
  });

  test('documents explicit adopted, reinterpreted, rejected, and deferred upstream areas', () => {
    const upstream = readRepoFile('docs/UPSTREAM_SYNC.md');

    expect(upstream).toContain(
      '## Roadmap 2026-05-19 - GA-P7 consolidation and upstream discipline checkpoint',
    );
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
    expect(upstream).toContain('| Tree-sitter Code Cathedral default graph retrieval | deferred |');

    for (const caseId of [
      'upstream_checkpoint_lists_adopted_areas',
      'reinterpreted_vs_rejected_rationale_present',
      'deferred_surfaces_remain_explicit',
    ]) {
      const entry = consolidationCase(caseId);
      expectCaseTermsInDeclaredDoc(entry);
    }
  });

  test('calls out GA-P2 through GA-P6 verification and scenario coverage', () => {
    const verify = readRepoFile('docs/MBRAIN_VERIFY.md');
    const evaluation = readRepoFile('docs/architecture/redesign/08-evaluation-and-acceptance.md');
    const readme = readRepoFile('test/scenarios/README.md');

    expect(verify).toContain('## GBrain Absorption GA-P7 Verification');
    expect(evaluation).toContain('## GBrain Absorption GA-P7 Consolidation And Upstream Discipline');
    expect(readme).toContain('| S32 | `s32-gbrain-upstream-discipline.test.ts` | GA-P7, E1, L4, L6, G1 | ✅ green |');

    for (const stage of ['ga_p2', 'ga_p3', 'ga_p4', 'ga_p5', 'ga_p6']) {
      const coverage = fixture.coverage[stage];
      expect(coverage, `missing ${stage} coverage`).toBeDefined();
      expect(verify).toContain(coverage.fixture);
      expect(verify).toContain(coverage.scenario);
      expect(evaluation).toContain(coverage.fixture);
      expect(evaluation).toContain(coverage.scenario);
    }

    const verificationCase = consolidationCase('verification_checklist_covers_ga_p2_through_ga_p6');
    expectCaseTermsInDeclaredDoc(verificationCase);
    for (const term of verificationCase.required_terms) {
      expect(`${verify}\n${evaluation}\n${readme}`).toContain(term);
    }
  });

  test('keeps docs and tests aligned with a docs-only implementation state', () => {
    const evaluation = readRepoFile('docs/architecture/redesign/08-evaluation-and-acceptance.md');
    const verify = readRepoFile('docs/MBRAIN_VERIFY.md');
    const upstream = readRepoFile('docs/UPSTREAM_SYNC.md');

    expect(evaluation).toContain('GA-P7 is docs, fixture, and scenario consolidation only.');
    expect(evaluation).toContain('no production runtime change');
    expect(verify).toContain('No network, database, or production runtime service is required for S32.');
    expect(upstream).toContain('No GA-P7 row grants permission to port upstream production runtime code directly.');

    const alignmentCase = consolidationCase('docs_and_tests_match_implementation_state');
    expectCaseTermsInDeclaredDoc(alignmentCase);
    for (const term of alignmentCase.required_terms) {
      expect(`${evaluation}\n${verify}`).toContain(term);
    }
  });
});
