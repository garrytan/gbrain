/**
 * Scenario S29 - GBrain absorption GA-P3 corpus lanes.
 *
 * GA-P3 accepts corpus lanes only as post-scope provenance metadata. Lanes
 * decorate imports, retrieval citations, reads, and traces without granting
 * authority or changing selector identity.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { importFromContent } from '../../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import type { ReadContextResult, RetrieveContextResult } from '../../src/core/types.ts';
import { allocateSqliteBrain } from './helpers.ts';

type LaneCase = {
  case_id: string;
  lane_id: string;
  lane_grants_authority: boolean;
  scope_gate: string;
  source_record: string;
  import_origin: string;
  retrieval_trace: string;
  canonical_selector: string;
};

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/gbrain-absorption/ga-p3-corpus-lanes.fixture.json', import.meta.url),
  'utf8',
)) as {
  stage_id: string;
  fixture_format: string;
  verification_commands: string[];
  lane_cases: LaneCase[];
};

function opContext(engine: OperationContext['engine']): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: console,
    dryRun: false,
  };
}

function laneCase(caseId: string): LaneCase {
  const found = fixture.lane_cases.find((entry) => entry.case_id === caseId);
  if (!found) throw new Error(`Missing GA-P3 lane case ${caseId}`);
  return found;
}

describe('S29 - gbrain corpus lanes', () => {
  test('defines non-authoritative lane cases for every GA-P3 corpus family', () => {
    expect(fixture.stage_id).toBe('GA-P3');
    expect(fixture.fixture_format).toBe('gbrain_absorption_replay_v1');
    expect(fixture.verification_commands).toContain(
      'bun test test/corpus-lane-service.test.ts test/import-file.test.ts test/read-context-service.test.ts test/retrieval-context-operations.test.ts test/memory-writeback-router-service.test.ts test/gbrain-absorption-docs-contract.test.ts test/scenarios/s29-gbrain-corpus-lanes.test.ts',
    );
    expect(fixture.lane_cases.map((entry) => entry.lane_id).sort()).toEqual([
      'derived',
      'imports',
      'notes',
      'transcripts',
      'worktree',
    ]);
    for (const entry of fixture.lane_cases) {
      expect(entry.lane_grants_authority).toBe(false);
      expect(entry.scope_gate).toBe('required_before_lane_resolution');
      expect(entry.source_record.length).toBeGreaterThan(0);
      expect(entry.import_origin.length).toBeGreaterThan(0);
      expect(entry.retrieval_trace).toContain('lane refs');
      expect(entry.canonical_selector.length).toBeGreaterThan(0);
    }
  });

  test('replays import, retrieve, read, trace, and ambiguous-writeback lane behavior', async () => {
    const handle = await allocateSqliteBrain('s29-corpus-lanes');

    try {
      const transcript = laneCase('transcripts_lane');
      await importFromContent(handle.engine, 'sources/ga-p3-transcript', [
        '---',
        'type: source',
        'title: GA-P3 Transcript',
        'corpus_lane: transcripts',
        `source_record: ${transcript.source_record}`,
        `import_origin: ${transcript.import_origin}`,
        'artifact_kind: transcript',
        'source_refs:',
        '  - Source: imported transcript, 2026-05-19',
        '---',
        '# Summary',
        'GA-P3 lane provenance metadata only canonical needle.',
      ].join('\n'), { path: transcript.import_origin });

      const manifest = await handle.engine.getNoteManifestEntry('workspace:default', 'sources/ga-p3-transcript');
      expect(manifest?.source_refs).toEqual(expect.arrayContaining([
        'Source: imported transcript, 2026-05-19',
        'corpus_lane:transcripts',
        `source_record:${transcript.source_record}`,
        `import_origin:${transcript.import_origin}`,
      ]));
      const sections = await handle.engine.listNoteSectionEntries({
        scope_id: 'workspace:default',
        page_slug: 'sources/ga-p3-transcript',
        limit: 10,
      });
      expect(sections[0]?.source_refs).toEqual(expect.arrayContaining([
        'corpus_lane:transcripts',
        `source_record:${transcript.source_record}`,
        `import_origin:${transcript.import_origin}`,
      ]));

      const ctx = opContext(handle.engine);
      const retrieve = await operationsByName.retrieve_context.handler(ctx, {
        query: 'GA-P3 lane provenance metadata only canonical needle',
        requested_scope: 'work',
        include_orientation: false,
        persist_trace: true,
      }) as RetrieveContextResult;

      expect(retrieve.scope_gate?.policy).toBe('allow');
      expect(retrieve.required_reads[0]?.selector_id).toBe(transcript.canonical_selector);
      expect(retrieve.required_reads[0]?.corpus_lane?.lane_id).toBe('transcripts');
      expect(retrieve.candidates[0]?.canonical_target.corpus_lane?.lane_id).toBe('transcripts');
      expect(retrieve.candidates[0]?.matched_chunks[0]?.corpus_lane?.lane_id).toBe('transcripts');
      expect(retrieve.trace?.source_refs).toEqual(expect.arrayContaining([
        transcript.canonical_selector,
        'corpus_lane:transcripts',
        `source_record:${transcript.source_record}`,
        `import_origin:${transcript.import_origin}`,
      ]));
      expect(retrieve.trace?.verification).toContain('corpus_lane:transcripts:post_scope_metadata');

      const read = await operationsByName.read_context.handler(ctx, {
        selectors: retrieve.required_reads,
        token_budget: 400,
        persist_trace: true,
      }) as ReadContextResult;

      expect(read.answer_ready.ready).toBe(true);
      expect(read.canonical_reads[0]?.authority).toBe('canonical_compiled_truth');
      expect(read.canonical_reads[0]?.corpus_lane?.lane_id).toBe('transcripts');
      expect(read.canonical_reads[0]?.source_refs).toEqual(expect.arrayContaining([
        'corpus_lane:transcripts',
        `source_record:${transcript.source_record}`,
        `import_origin:${transcript.import_origin}`,
      ]));
      expect(read.trace?.source_refs).toEqual(expect.arrayContaining([
        transcript.canonical_selector,
        'corpus_lane:transcripts',
      ]));

      const ambiguous = await operationsByName.route_memory_writeback.handler(ctx, {
        content: 'Imported source-extracted writeback should not pick a lane silently.',
        source_kind: 'import',
        evidence_kind: 'source_extracted',
        source_refs: ['Source: imported transcript, 2026-05-19'],
      }) as { decision: string; intended_operation: string; reasons: string[]; missing_requirements: string[] };

      expect(ambiguous.decision).toBe('defer');
      expect(ambiguous.intended_operation).toBe('none');
      expect(ambiguous.reasons).toContain('import_lane_required');
      expect(ambiguous.missing_requirements).toContain('corpus_lane');
    } finally {
      await handle.teardown();
    }
  });

  test('README registers S29 in the scenario contract table', () => {
    const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');

    expect(readme).toContain('| S29 | `s29-gbrain-corpus-lanes.test.ts` | GA-P3, I5, L6, G1 | ✅ green |');
  });
});
