import { describe, expect, test } from 'bun:test';
import { runConversionEvidenceBenchmark } from '../src/eval/conversion-evidence/benchmark.ts';

describe('conversion-evidence semantic benchmark', () => {
  test('covers every deterministic semantic obligation with no retrieval metric', () => {
    const result = runConversionEvidenceBenchmark();
    const expectedIds = [
      'provenance.sha256-normalization',
      'provenance.mime-normalization',
      'provenance.request-hash-semantic-source-sensitivity',
      'provenance.text-observation-pass',
      'multimodal-observation.unknown-kind-warning-floor',
      'multimodal-observation.platform-byte-reason-discriminator',
      'multimodal-observation.failed-range-coverage-span-algebra',
      'multimodal-observation.normalized-verdict-golden',
      'multimodal-observation.zero-candidate-neutral',
      'robustness.unreadable-warning-reason-closure',
      'robustness.converter-warning-reason-closure',
      'robustness.mapping-range-boundary-rejection',
      'robustness.producer-coupling',
      'robustness.canonical-serialization-safety',
    ];
    expect(result.benchmark).toBe('conversion-evidence-semantic');
    expect(result.obligations).toHaveLength(expectedIds.length);
    expect(result.obligations.map(({ id }) => id)).toEqual(expectedIds);
    expect(result.counts).toEqual({ total: expectedIds.length, passed: expectedIds.length, failed: 0 });
    expect(result.score).toBe(1);
    expect(result.obligations.every((obligation) => (
      obligation.passed
      && expectedIds.includes(obligation.id as (typeof expectedIds)[number])
      && Object.keys(obligation).sort().join(',') === 'id,passed,section'
    ))).toBe(true);
    expect(Object.keys(result)).not.toContain('retrieval');
    expect(Object.keys(result.sections).sort()).toEqual(['multimodal-observation', 'provenance', 'robustness']);
    expect(result.sections.provenance).toHaveLength(4);
    expect(result.sections['multimodal-observation']).toHaveLength(5);
    expect(result.sections.robustness).toHaveLength(5);
    expect(Object.values(result.sections).reduce((total, section) => total + section.length, 0)).toBe(expectedIds.length);
    for (const section of Object.values(result.sections)) {
      expect(section.every((obligation) => obligation.passed)).toBe(true);
    }
  });

  test('has stable case IDs and output across repeated runs', () => {
    const first = runConversionEvidenceBenchmark();
    const second = runConversionEvidenceBenchmark();
    expect(second).toEqual(first);
    expect(first.obligations.map(({ id }) => id)).toEqual([
      'provenance.sha256-normalization',
      'provenance.mime-normalization',
      'provenance.request-hash-semantic-source-sensitivity',
      'provenance.text-observation-pass',
      'multimodal-observation.unknown-kind-warning-floor',
      'multimodal-observation.platform-byte-reason-discriminator',
      'multimodal-observation.failed-range-coverage-span-algebra',
      'multimodal-observation.normalized-verdict-golden',
      'multimodal-observation.zero-candidate-neutral',
      'robustness.unreadable-warning-reason-closure',
      'robustness.converter-warning-reason-closure',
      'robustness.mapping-range-boundary-rejection',
      'robustness.producer-coupling',
      'robustness.canonical-serialization-safety',
    ]);
  });
});
