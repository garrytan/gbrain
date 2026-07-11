import { describe, expect, test } from 'bun:test';
import {
  canonicalJson,
  computeRequestHash,
  normalizeMimeType,
  normalizeSourceSha256,
  sanitizeManifest,
  validateCoverage,
  validateFailedRanges,
  validateMapping,
  validateProducerCoupling,
  validateTimeRange,
  validateVisualObservation,
  validateObservations,
} from '../src/core/conversion-manifest';
import type { ConversionRange, UnitKind } from '../src/core/conversion-manifest';

describe('conversion manifest data-foundation contract', () => {
  test('canonicalizes recursively with lexicographic object keys and stable arrays', () => {
    expect(canonicalJson({ z: 1, nested: { b: true, a: [3, 2] }, a: 'x' })).toBe(
      '{"a":"x","nested":{"a":[3,2],"b":true},"z":1}',
    );
    expect(() => canonicalJson({ value: BigInt(1) })).toThrow();
    expect(() => canonicalJson({ value: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => canonicalJson({ value: Number.NaN })).toThrow();
    expect(() => canonicalJson({ value: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => canonicalJson({ value: Number.NEGATIVE_INFINITY })).toThrow();
  });

  test('normalizes and validates source SHA-256 snapshots', () => {
    const digest = 'a'.repeat(64);
    expect(normalizeSourceSha256(digest)).toBe(digest);
    expect(normalizeSourceSha256(`sha256:${digest.toUpperCase()}`)).toBe(digest);
    expect(normalizeSourceSha256(`SHA256:${digest.toUpperCase()}`)).toBe(digest);
    expect(() => normalizeSourceSha256('sha256:not-a-digest')).toThrow();
    expect(() => normalizeSourceSha256('b'.repeat(63))).toThrow();
  });

  test('canonicalizes MIME tokens and rejects invalid values', () => {
    expect(normalizeMimeType('  Text/Plain; charset=UTF-8  ')).toBe('text/plain');
    expect(normalizeMimeType('APPLICATION/X-SYNTHETIC')).toBe('application/x-synthetic');
    expect(() => normalizeMimeType('text plain')).toThrow();
    expect(() => normalizeMimeType('text/')).toThrow();
    expect(() => normalizeMimeType('text/plain,evil')).toThrow();
  });

  const coverageCases: Array<[UnitKind, { total: number; succeeded: number; failed: number; failedRanges: ConversionRange[] }]> = [
    ['document', { total: 1, succeeded: 1, failed: 0, failedRanges: [] }],
    ['document', { total: 1, succeeded: 0, failed: 1, failedRanges: [{ kind: 'document' }] }],
    ['page', { total: 5, succeeded: 3, failed: 2, failedRanges: [{ kind: 'ordinal', unitKind: 'page', start: 1, end: 3 }] }],
    ['frame', { total: 4, succeeded: 2, failed: 2, failedRanges: [{ kind: 'ordinal', unitKind: 'frame', start: 0, end: 2 }] }],
    ['segment', { total: 6, succeeded: 4, failed: 2, failedRanges: [{ kind: 'ordinal', unitKind: 'segment', start: 4, end: 6 }] }],
  ];
  test.each(coverageCases)('validates %s coverage algebra', (unitKind, coverage) => {
    expect(validateCoverage({ unitKind, ...coverage })).toEqual({ unitKind, ...coverage });
  });

  test('rejects overlapping, unsorted, out-of-bounds, and overflowing failed ranges', () => {
    expect(() => validateFailedRanges('page', 5, [
      { kind: 'ordinal', unitKind: 'page', start: 0, end: 3 },
      { kind: 'ordinal', unitKind: 'page', start: 2, end: 4 },
    ])).toThrow();
    expect(() => validateFailedRanges('page', 5, [
      { kind: 'ordinal', unitKind: 'page', start: 3, end: 4 },
      { kind: 'ordinal', unitKind: 'page', start: 1, end: 2 },
    ])).toThrow();
    expect(() => validateFailedRanges('page', 5, [{ kind: 'ordinal', unitKind: 'page', start: 0, end: 6 }])).toThrow();
    expect(() => validateFailedRanges('segment', Number.MAX_SAFE_INTEGER, [
      { kind: 'ordinal', unitKind: 'segment', start: 0, end: Number.MAX_SAFE_INTEGER },
      { kind: 'ordinal', unitKind: 'segment', start: Number.MAX_SAFE_INTEGER - 1, end: Number.MAX_SAFE_INTEGER },
    ])).toThrow();
  });
  test('enforces document failed-range equivalence and context ranges', () => {
    expect(() => validateCoverage({ unitKind: 'document', total: 1, succeeded: 0, failed: 1, failedRanges: [] })).toThrow();
    expect(() => validateCoverage({ unitKind: 'document', total: 1, succeeded: 1, failed: 0, failedRanges: [{ kind: 'document' }] })).toThrow();
    expect(() => validateFailedRanges('page', 2, [{ kind: 'ordinal', unitKind: 'frame', start: 0, end: 1 }])).toThrow();
  });

  test('enforces time_ms duration rules and mapping chunk bounds', () => {
    expect(validateTimeRange({ kind: 'time_ms', start: 0, end: 10 }, 10)).toEqual({ kind: 'time_ms', start: 0, end: 10 });
    expect(() => validateTimeRange({ kind: 'time_ms', start: 0, end: 10 }, null)).toThrow();
    expect(() => validateTimeRange({ kind: 'time_ms', start: 2, end: 2 }, 10)).toThrow();
    expect(() => validateTimeRange({ kind: 'time_ms', start: 0, end: 11 }, 10)).toThrow();
    expect(() => validateMapping({ sourceRange: { kind: 'ordinal', unitKind: 'page', start: 0, end: 1 }, unitKind: 'page', chunkStart: 2, chunkEnd: 4, chunkCount: 4 })).not.toThrow();
    expect(() => validateMapping({ sourceRange: { kind: 'ordinal', unitKind: 'page', start: 0, end: 1 }, unitKind: 'page', chunkStart: 4, chunkEnd: 5, chunkCount: 4 })).toThrow();
    expect(() => validateMapping({ sourceRange: { kind: 'ordinal', unitKind: 'page', start: 0, end: 1 }, unitKind: 'page', chunkStart: 1, chunkEnd: 1, chunkCount: 4 })).toThrow();
    expect(() => validateMapping({ sourceRange: { kind: 'ordinal', unitKind: 'page', start: 0, end: 1 }, unitKind: 'document' })).toThrow();
    expect(() => validateMapping({ sourceRange: { kind: 'time_ms', start: 0, end: 10 }, unitKind: 'page', durationMs: 10 })).toThrow();
  });

  test('unknown visual kind has warning floor and completeness reason', () => {
    expect(validateVisualObservation({ sourceVisualKind: 'unknown', risk: 'pass', reasonCodes: [] })).toMatchObject({
      risk: 'warning', reasonCodes: expect.arrayContaining(['OBSERVATION_INCOMPLETE']),
    });
  });

  test('keeps PlatformReason closed and ByteCheck reasons separate', () => {
    expect(() => validateVisualObservation({ sourceVisualKind: 'text', risk: 'pass', reasonCodes: ['checked_match'] })).toThrow();
    expect(() => validateVisualObservation({ sourceVisualKind: 'text', risk: 'pass', reasonCodes: ['COVERAGE_INVALID'] })).not.toThrow();
  });
  test('rejects lossy settings and warning sanitization', () => {
    expect(() => sanitizeManifest({ settings: { safe: 'yes', secret: 'drop', nested: { x: 1 } }, warnings: [] })).toThrow();
    expect(() => sanitizeManifest({ settings: { safe: 'yes' }, warnings: Array.from({ length: 33 }, () => 'synthetic-warning') })).toThrow();
    expect(() => sanitizeManifest({ settings: { safe: 'yes' }, warnings: ['synthetic-warning', 4] as unknown as string[] })).toThrow();
    expect(() => sanitizeManifest({ settings: { safe: 'yes' }, warnings: ['x'.repeat(8193)] })).toThrow();
    expect(sanitizeManifest({ settings: { safe: 'yes' }, warnings: ['synthetic-warning'] })).toEqual({ settings: { safe: 'yes' }, warnings: ['synthetic-warning'] });
  });

  test('rejects bounded values rather than truncating', () => {
    expect(() => sanitizeManifest({ settings: { values: Array.from({ length: 129 }, () => 1) }, warnings: [] })).toThrow();
    let nested: unknown = 1;
    for (let depth = 0; depth < 9; depth += 1) nested = { nested };
    expect(() => sanitizeManifest({ settings: nested as Record<string, unknown>, warnings: [] })).toThrow();
  });

  test('validates closed observation objects', () => {
    expect(() => validateObservations({ sourceVisualKind: 'image', candidates: { other: 1 }, confidence: null, ocr: {}, imageDimensions: null })).toThrow();
    expect(() => validateObservations({ sourceVisualKind: 'image', candidates: {}, confidence: { overall: 0.5, extra: 1 }, ocr: {}, imageDimensions: null })).toThrow();
    expect(() => validateObservations({ sourceVisualKind: 'scan', candidates: {}, confidence: null, ocr: { text: 'secret' }, imageDimensions: null })).toThrow();
    expect(() => validateObservations({ sourceVisualKind: 'image', candidates: {}, confidence: null, ocr: {}, imageDimensions: { width: 0 } })).toThrow();
    expect(validateObservations({ sourceVisualKind: 'image', candidates: {}, confidence: null, ocr: {}, imageDimensions: null }).reasons).toContain('OBSERVATION_INCOMPLETE');
  });

  test('request hash is stable across timestamp-only retries but changes with semantics and source snapshot', () => {
    const base = { adapterKind: 'synthetic', sourceVisualKind: 'text', converter: 'fixture', converterVersion: '1', sourceSha256: 'a'.repeat(64), sourceMimeType: 'text/plain', coverage: { unitKind: 'document', total: 1, succeeded: 1, failed: 0, failedRanges: [] }, startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z' };
    expect(computeRequestHash(base)).toBe(computeRequestHash({ ...base, startedAt: '2027-02-02T00:00:00Z', completedAt: '2027-02-02T00:00:01Z' }));
    expect(computeRequestHash(base)).not.toBe(computeRequestHash({ ...base, converterVersion: '2' }));
    expect(computeRequestHash(base)).not.toBe(computeRequestHash({ ...base, sourceSha256: 'b'.repeat(64) }));
    expect(computeRequestHash(base)).toBe(computeRequestHash({ ...base, risk: 'warning', reasonCodes: ['COVERAGE_LOSS'] }));
  });

  test('enforces producer coupling', () => {
    expect(validateProducerCoupling({ producerKind: 'oauth_client', producerId: 'synthetic.client' })).toBeTruthy();
    expect(() => validateProducerCoupling({ producerKind: 'oauth_client', producerId: null })).toThrow();
    expect(() => validateProducerCoupling({ producerKind: 'local_cli', producerId: 'caller-supplied' })).toThrow();
  });
});
