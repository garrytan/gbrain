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

function slugFromSelector(selector: string): string {
  const compiledTruthPrefix = 'compiled_truth:workspace:default:';
  const sectionPrefix = 'section:workspace:default:';
  if (selector.startsWith(compiledTruthPrefix)) {
    return selector.slice(compiledTruthPrefix.length);
  }
  if (selector.startsWith(sectionPrefix)) {
    return selector.slice(sectionPrefix.length).split('#')[0] ?? '';
  }
  throw new Error(`Unsupported GA-P3 selector: ${selector}`);
}

function artifactKindForLane(lane: LaneCase): string {
  switch (lane.lane_id) {
    case 'notes':
      return 'note';
    case 'worktree':
      return 'worktree';
    case 'transcripts':
      return 'transcript';
    case 'imports':
      return 'import';
    case 'derived':
      return 'derived';
    default:
      throw new Error(`Unsupported GA-P3 lane id: ${lane.lane_id}`);
  }
}

function laneNeedle(lane: LaneCase): string {
  return `GA-P3 ${lane.lane_id} lane provenance metadata only canonical needle.`;
}

async function importLanePage(engine: OperationContext['engine'], lane: LaneCase): Promise<void> {
  const slug = slugFromSelector(lane.canonical_selector);
  const body = lane.canonical_selector.startsWith('section:')
    ? ['# Summary', laneNeedle(lane)]
    : [laneNeedle(lane)];

  await importFromContent(engine, slug, [
    '---',
    'type: source',
    `title: GA-P3 ${lane.lane_id} Lane`,
    `corpus_lane: ${lane.lane_id}`,
    `source_record: ${lane.source_record}`,
    `import_origin: ${lane.import_origin}`,
    `artifact_kind: ${artifactKindForLane(lane)}`,
    'source_refs:',
    `  - Source: imported ${lane.lane_id}, 2026-05-19`,
    '---',
    ...body,
  ].join('\n'), { path: lane.import_origin });
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

  test('replays every lane through import, retrieve, read, trace, and writeback boundaries', async () => {
    const handle = await allocateSqliteBrain('s29-corpus-lanes');

    try {
      for (const lane of fixture.lane_cases) {
        await importLanePage(handle.engine, lane);
      }

      const ctx = opContext(handle.engine);
      for (const lane of fixture.lane_cases) {
        const slug = slugFromSelector(lane.canonical_selector);
        const manifest = await handle.engine.getNoteManifestEntry('workspace:default', slug);
        expect(manifest?.source_refs).toEqual(expect.arrayContaining([
          `Source: imported ${lane.lane_id}, 2026-05-19`,
          `corpus_lane:${lane.lane_id}`,
          `source_record:${lane.source_record}`,
          `import_origin:${lane.import_origin}`,
        ]));

        const sections = await handle.engine.listNoteSectionEntries({
          scope_id: 'workspace:default',
          page_slug: slug,
          limit: 10,
        });
        if (sections.length > 0) {
          expect(sections[0]?.source_refs).toEqual(expect.arrayContaining([
            `corpus_lane:${lane.lane_id}`,
            `source_record:${lane.source_record}`,
            `import_origin:${lane.import_origin}`,
          ]));
        }

        const retrieve = await operationsByName.retrieve_context.handler(ctx, {
          query: laneNeedle(lane),
          requested_scope: 'work',
          include_orientation: false,
          persist_trace: true,
        }) as RetrieveContextResult;

        expect(retrieve.scope_gate?.policy).toBe('allow');
        expect(retrieve.required_reads[0]?.selector_id).toBe(lane.canonical_selector);
        expect(retrieve.required_reads[0]?.corpus_lane?.lane_id).toBe(lane.lane_id);
        expect(retrieve.candidates[0]?.canonical_target.corpus_lane?.lane_id).toBe(lane.lane_id);
        expect(retrieve.candidates[0]?.matched_chunks[0]?.corpus_lane?.lane_id).toBe(lane.lane_id);
        expect(retrieve.trace?.source_refs).toEqual(expect.arrayContaining([
          lane.canonical_selector,
          `corpus_lane:${lane.lane_id}`,
          `source_record:${lane.source_record}`,
          `import_origin:${lane.import_origin}`,
        ]));
        expect(retrieve.trace?.verification).toContain(`corpus_lane:${lane.lane_id}:post_scope_metadata`);

        const read = await operationsByName.read_context.handler(ctx, {
          selectors: retrieve.required_reads,
          token_budget: 400,
          persist_trace: true,
        }) as ReadContextResult;

        expect(read.answer_ready.ready).toBe(true);
        expect(read.canonical_reads[0]?.authority).toBe('canonical_compiled_truth');
        expect(read.canonical_reads[0]?.corpus_lane?.lane_id).toBe(lane.lane_id);
        expect(read.canonical_reads[0]?.source_refs).toEqual(expect.arrayContaining([
          `corpus_lane:${lane.lane_id}`,
          `source_record:${lane.source_record}`,
          `import_origin:${lane.import_origin}`,
        ]));
        expect(read.trace?.source_refs).toEqual(expect.arrayContaining([
          lane.canonical_selector,
          `corpus_lane:${lane.lane_id}`,
        ]));

        const laneWriteback = await operationsByName.route_memory_writeback.handler(ctx, {
          content: `Imported ${lane.lane_id} source-extracted writeback stays candidate-only.`,
          source_kind: 'import',
          evidence_kind: 'source_extracted',
          source_refs: [`Source: imported ${lane.lane_id}, 2026-05-19`],
          corpus_lane: {
            lane_id: lane.lane_id,
            source_record: lane.source_record,
            import_origin: lane.import_origin,
            artifact_kind: artifactKindForLane(lane),
          },
        }) as {
          decision: string;
          intended_operation: string;
          candidate_input?: { source_refs: string[] };
          canonical_write_requirements?: unknown;
        };

        expect(laneWriteback.decision).toBe('create_candidate');
        expect(laneWriteback.intended_operation).toBe('create_memory_candidate_entry');
        expect(laneWriteback.candidate_input?.source_refs).toEqual(expect.arrayContaining([
          `corpus_lane:${lane.lane_id}`,
          `source_record:${lane.source_record}`,
          `import_origin:${lane.import_origin}`,
        ]));
        expect(laneWriteback.canonical_write_requirements).toBeUndefined();
      }

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
