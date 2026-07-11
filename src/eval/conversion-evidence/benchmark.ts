import {
  canonicalJson,
  computeRequestHash,
  normalizeMimeType,
  normalizeSourceSha256,
  validateCoverage,
  validateFailedRanges,
  validateMapping,
  validateProducerCoupling,
  validateTimeRange,
  validateVisualObservation,
  deriveNormalizedVerdict,
  type OrdinalRange,
} from '../../core/conversion-manifest.ts';

export type BenchmarkSection = 'provenance' | 'multimodal-observation' | 'robustness';

export interface ConversionEvidenceObligation {
  id: string;
  section: BenchmarkSection;
  passed: boolean;
}

export interface ConversionEvidenceBenchmarkResult {
  benchmark: 'conversion-evidence-semantic';
  sections: Record<BenchmarkSection, ConversionEvidenceObligation[]>;
  obligations: ConversionEvidenceObligation[];
  counts: { total: number; passed: number; failed: number };
  score: number;
}

function succeeds<T>(fn: () => T): boolean {
  try { fn(); return true; } catch { return false; }
}

function fails(fn: () => unknown): boolean { return !succeeds(fn); }

function evaluate(): ConversionEvidenceObligation[] {
  const digest = 'a'.repeat(64);
  const base: Record<string, unknown> = {
    adapterKind: 'synthetic', sourceVisualKind: 'text', converter: 'fixture', converterVersion: '1',
    sourceSha256: digest, sourceMimeType: 'text/plain',
    coverage: { unitKind: 'document', total: 1, succeeded: 1, failed: 0, failedRanges: [] },
  };
  const out: ConversionEvidenceObligation[] = [];
  const add = (id: string, section: BenchmarkSection, passed: boolean) => out.push({ id, section, passed });

  add('provenance.sha256-normalization', 'provenance', normalizeSourceSha256(`SHA256:${digest.toUpperCase()}`) === digest && fails(() => normalizeSourceSha256('not-a-digest')));
  add('provenance.mime-normalization', 'provenance', normalizeMimeType(' Text/Plain; charset=UTF-8 ') === 'text/plain' && fails(() => normalizeMimeType('text plain')));
  const timestampRetry = computeRequestHash(base) === computeRequestHash({ ...base, startedAt: '2027-02-02T00:00:00Z', completedAt: '2027-02-02T00:00:01Z' });
  const semanticChange = computeRequestHash(base) !== computeRequestHash({ ...base, converterVersion: '2' });
  const sourceChange = computeRequestHash(base) !== computeRequestHash({ ...base, sourceSha256: 'b'.repeat(64) });
  add('provenance.request-hash-semantic-source-sensitivity', 'provenance', timestampRetry && semanticChange && sourceChange);
  add('provenance.text-observation-pass', 'provenance', succeeds(() => validateVisualObservation({ sourceVisualKind: 'text', risk: 'pass', reasonCodes: [] })));

  const unknown = validateVisualObservation({ sourceVisualKind: 'unknown', risk: 'pass', reasonCodes: [] });
  add('multimodal-observation.unknown-kind-warning-floor', 'multimodal-observation', unknown.risk === 'warning' && unknown.reasonCodes.includes('OBSERVATION_INCOMPLETE'));
  add('multimodal-observation.platform-byte-reason-discriminator', 'multimodal-observation', fails(() => validateVisualObservation({ sourceVisualKind: 'text', risk: 'pass', reasonCodes: ['checked_match'] })) && succeeds(() => validateVisualObservation({ sourceVisualKind: 'text', risk: 'pass', reasonCodes: ['COVERAGE_INVALID'] })));
  const failedRanges: OrdinalRange[] = [{ kind: 'ordinal', unitKind: 'page', start: 1, end: 3 }];
  const coverage = validateCoverage({ unitKind: 'page', total: 5, succeeded: 3, failed: 2, failedRanges });
  add('multimodal-observation.failed-range-coverage-span-algebra', 'multimodal-observation', coverage.failed === 2 && succeeds(() => validateFailedRanges('page', 5, failedRanges)) && fails(() => validateFailedRanges('page', 5, [{ kind: 'ordinal', unitKind: 'page', start: 0, end: 3 }, { kind: 'ordinal', unitKind: 'page', start: 2, end: 4 }])));
  const exactVerdict = deriveNormalizedVerdict({ sourceVisualKind: 'image', coverage: { failed: 1 }, unreadableRegions: [], warnings: [], candidates: { images: 1 }, confidence: null, ocr: { state: 'success', confidence: 1, textExtracted: true }, imageDimensions: { width: 1, height: 1 } });
  add('multimodal-observation.normalized-verdict-golden', 'multimodal-observation', exactVerdict.risk === 'visual_review_required' && JSON.stringify(exactVerdict.reasonCodes) === '["COVERAGE_LOSS","VISUAL_CANDIDATE"]');
  add('multimodal-observation.zero-candidate-neutral', 'multimodal-observation', deriveNormalizedVerdict({ sourceVisualKind: 'image', coverage: { failed: 0 }, unreadableRegions: [], warnings: [], candidates: { images: 0 }, confidence: null, ocr: { state: 'success', confidence: 1, textExtracted: true }, imageDimensions: { width: 1, height: 1 } }).reasonCodes.length === 0);

  add('robustness.unreadable-warning-reason-closure', 'robustness', succeeds(() => validateVisualObservation({ sourceVisualKind: 'image', risk: 'warning', reasonCodes: ['UNREADABLE_REGION'] })));
  add('robustness.converter-warning-reason-closure', 'robustness', succeeds(() => validateVisualObservation({ sourceVisualKind: 'text', risk: 'warning', reasonCodes: ['CONVERTER_WARNING'] })));
  add('robustness.mapping-range-boundary-rejection', 'robustness', succeeds(() => validateTimeRange({ kind: 'time_ms', start: 0, end: 10 }, 10)) && fails(() => validateTimeRange({ kind: 'time_ms', start: 2, end: 2 }, 10)) && fails(() => validateMapping({ sourceRange: { kind: 'ordinal', unitKind: 'page', start: 0, end: 1 }, chunkStart: 4, chunkEnd: 5, chunkCount: 4 })));
  add('robustness.producer-coupling', 'robustness', succeeds(() => validateProducerCoupling({ producerKind: 'oauth_client', producerId: 'synthetic.client' })) && fails(() => validateProducerCoupling({ producerKind: 'local_cli', producerId: 'caller-supplied' })));
  add('robustness.canonical-serialization-safety', 'robustness', fails(() => canonicalJson({ value: BigInt(1) })) && fails(() => canonicalJson({ value: Number.NaN })) && fails(() => canonicalJson({ value: Number.MAX_SAFE_INTEGER + 1 })));
  return out;
}

export function runConversionEvidenceBenchmark(): ConversionEvidenceBenchmarkResult {
  const obligations = evaluate();
  const passed = obligations.filter((item) => item.passed).length;
  const sections = {
    provenance: obligations.filter((item) => item.section === 'provenance'),
    'multimodal-observation': obligations.filter((item) => item.section === 'multimodal-observation'),
    robustness: obligations.filter((item) => item.section === 'robustness'),
  } satisfies Record<BenchmarkSection, ConversionEvidenceObligation[]>;
  return {
    benchmark: 'conversion-evidence-semantic', sections, obligations,
    counts: { total: obligations.length, passed, failed: obligations.length - passed },
    score: obligations.length === 0 ? 0 : passed / obligations.length,
  };
}
