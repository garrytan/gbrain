import { describe, expect, test } from 'bun:test';
import { getCliCommandCatalog } from '../src/cli.ts';
import { evaluateRetrievalQualityQrelsGate } from '../src/core/evaluation/retrieval-quality-gate.ts';
import { operations, operationsByName } from '../src/core/operations.ts';
import {
  buildConformanceScorecard,
  buildOperationGoldenManifest,
  formatConformanceScorecardSummary,
  retrievalQualityScorecardInputFromGateReport,
} from '../src/core/services/operation-conformance-service.ts';

describe('conformance scorecard', () => {
  test('emits deterministic dimension JSON and separates hard failures from scores', () => {
    const manifest = buildOperationGoldenManifest({
      operations,
      cliCatalog: getCliCommandCatalog(),
    });
    const retrievalReport = evaluateRetrievalQualityQrelsGate({
      fixture_id: 'scorecard-smoke',
      thresholds: {
        top1_match_rate: 1,
        recall_at_10: 1,
      },
      cases: [{
        id: 'scorecard-retrieval',
        query: 'scorecard retrieval gate',
        gold_slugs: ['systems/source-aware-retrieval'],
        candidate_slugs: ['systems/source-aware-retrieval'],
      }],
    });
    const scorecard = buildConformanceScorecard({
      manifest,
      operationsByName,
      retrievalQuality: retrievalQualityScorecardInputFromGateReport(retrievalReport),
    });

    expect(scorecard.schema_version).toBe(1);
    expect(scorecard.hard_failures).toEqual([]);
    expect(scorecard.dimensions.map(dimension => dimension.id)).toEqual([
      'operation_catalog_integrity',
      'mcp_cli_compatibility',
      'capability_filtering',
      'retrieval_quality',
      'memory_authority',
      'writeback_governance',
      'mutation_control_plane',
      'replay_evaluation',
    ]);
    expect(scorecard.dimensions.every(dimension => dimension.denominator > 0)).toBe(true);
    expect(JSON.stringify(scorecard)).toContain('"retrieval_quality"');
    expect(scorecard.dimensions.find(dimension => dimension.id === 'capability_filtering')?.notes).toEqual([]);
    expect(scorecard.dimensions.find(dimension => dimension.id === 'replay_evaluation')?.notes).toContain('source-aware retrieval qrels gate executed');

    const summary = formatConformanceScorecardSummary(scorecard);
    expect(summary).toContain('MBrain conformance scorecard: pass');
    expect(summary).toContain('operation_catalog_integrity: pass');
    expect(summary).toContain('retrieval_quality: pass');
    expect(summary).toContain('hard_failures: none');
  });
});
