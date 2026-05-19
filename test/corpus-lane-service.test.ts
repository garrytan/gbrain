import { describe, expect, test } from 'bun:test';
import {
  corpusLaneFromSourceRefs,
  corpusLaneSourceRefs,
  extractCorpusLaneMetadata,
  extractFrontmatterSourceRefs,
  mergeSourceRefs,
} from '../src/core/services/corpus-lane-service.ts';

describe('corpus lane service', () => {
  test('explicit frontmatter lane produces normalized metadata and citation refs', () => {
    const lane = extractCorpusLaneMetadata({
      corpus_lane: 'transcripts',
      source_record_id: 'source-record:meeting-42',
      import_origin: 'imports/meeting-42.md',
      artifact_kind: 'transcript',
    });

    expect(lane).toEqual({
      lane_id: 'transcripts',
      source_record: 'source-record:meeting-42',
      import_origin: 'imports/meeting-42.md',
      artifact_kind: 'transcript',
    });
    expect(corpusLaneSourceRefs(lane)).toEqual([
      'corpus_lane:transcripts',
      'source_record:source-record:meeting-42',
      'import_origin:imports/meeting-42.md',
    ]);
  });

  test('string and array source_refs are preserved', () => {
    expect(extractFrontmatterSourceRefs({
      corpus_lane_id: 'imports',
      source_refs: 'Source: imported transcript, 2026-05-19',
    })).toEqual([
      'Source: imported transcript, 2026-05-19',
      'corpus_lane:imports',
    ]);

    expect(extractFrontmatterSourceRefs({
      lane_id: 'worktree',
      source_refs: [
        'Source: worktree export, 2026-05-19',
        'Source: reviewer note, 2026-05-19',
      ],
    })).toEqual([
      'Source: worktree export, 2026-05-19',
      'Source: reviewer note, 2026-05-19',
      'corpus_lane:worktree',
    ]);
  });

  test('fallback import origin is used only when lane metadata is explicit', () => {
    expect(extractCorpusLaneMetadata({ corpus_lane: 'imports' }, 'imports/fallback.md')).toEqual({
      lane_id: 'imports',
      import_origin: 'imports/fallback.md',
    });

    expect(extractCorpusLaneMetadata({}, 'imports/fallback.md')).toBeUndefined();
    expect(extractFrontmatterSourceRefs({}, 'imports/fallback.md')).toEqual([]);
  });

  test('no explicit lane returns no lane metadata', () => {
    expect(extractCorpusLaneMetadata({
      source_record: 'source-record:meeting-42',
      import_origin: 'imports/meeting-42.md',
      artifact_kind: 'transcript',
    })).toBeUndefined();
  });

  test('standalone source records and import origins remain source refs without a lane', () => {
    expect(extractFrontmatterSourceRefs({
      source_record: 'source-record:meeting-42',
      import_origin: 'imports/meeting-42.md',
    })).toEqual([
      'source_record:source-record:meeting-42',
      'import_origin:imports/meeting-42.md',
    ]);
  });

  test('source refs can reconstruct lane metadata', () => {
    expect(corpusLaneFromSourceRefs([
      'Source: imported transcript, 2026-05-19',
      'corpus_lane:transcripts',
      'source_record:source-record:meeting-42',
      'import_origin:imports/meeting-42.md',
    ])).toEqual({
      lane_id: 'transcripts',
      source_record: 'source-record:meeting-42',
      import_origin: 'imports/meeting-42.md',
    });
  });

  test('mergeSourceRefs dedupes while preserving first occurrence order', () => {
    expect(mergeSourceRefs(
      ['Source: one', 'corpus_lane:imports'],
      ['Source: one', 'source_record:source-record:42'],
      undefined,
      ['corpus_lane:imports', 'import_origin:imports/42.md'],
    )).toEqual([
      'Source: one',
      'corpus_lane:imports',
      'source_record:source-record:42',
      'import_origin:imports/42.md',
    ]);
  });

  test('blank lane ids do not produce lane citation refs', () => {
    expect(corpusLaneSourceRefs({ lane_id: '   ', source_record: 'source-record:42' })).toEqual([]);
  });
});
