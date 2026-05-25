import { describe, test, expect } from 'bun:test';
import {
  BASELINE_FILE_SCHEMA_VERSION,
  DEFAULT_THRESHOLDS,
  BaselineParseError,
  computeQueryHash,
  computeSourceHash,
  normalizeQueryForHash,
  parseBaselineFile,
  serializeBaselineFile,
  type BaselineFile,
  type BaselineRow,
} from '../../src/core/bench/baseline-file.ts';

function makeRow(query: string, idx: number): BaselineRow {
  return {
    tool_name: 'query',
    query,
    query_hash: computeQueryHash(query),
    retrieved_slugs: [`slug-${idx}`],
    retrieved_chunk_ids: [idx],
    source_ids: ['default'],
    expand_enabled: false,
    detail: 'medium',
    detail_resolved: 'medium',
    vector_enabled: true,
    expansion_applied: false,
    latency_ms: 100 + idx,
    remote: false,
    job_id: null,
    subagent_id: null,
  };
}

function makeFile(rows: BaselineRow[]): BaselineFile {
  return {
    metadata: {
      schema_version: BASELINE_FILE_SCHEMA_VERSION,
      _kind: 'baseline_metadata',
      label: 'test-label',
      published_at: '2026-05-24T00:00:00Z',
      source_hash: computeSourceHash(rows),
      thresholds: { ...DEFAULT_THRESHOLDS },
      row_count: rows.length,
      baseline_mean_latency_ms:
        rows.length === 0 ? 0 : rows.reduce((s, r) => s + r.latency_ms, 0) / rows.length,
    },
    rows,
  };
}

describe('baseline-file', () => {
  test('round-trip parse/serialize preserves metadata and rows', () => {
    const rows = [makeRow('hello world', 0), makeRow('lorem ipsum', 1)];
    const file = makeFile(rows);
    const serialized = serializeBaselineFile(file);
    const parsed = parseBaselineFile(serialized);

    expect(parsed.metadata.label).toBe('test-label');
    expect(parsed.metadata.schema_version).toBe(BASELINE_FILE_SCHEMA_VERSION);
    expect(parsed.metadata._kind).toBe('baseline_metadata');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows.map(r => r.query).sort()).toEqual(['hello world', 'lorem ipsum']);
  });

  test('threshold defaults match the documented values', () => {
    expect(DEFAULT_THRESHOLDS.jaccard).toBe(0.85);
    expect(DEFAULT_THRESHOLDS.top1).toBe(0.80);
    expect(DEFAULT_THRESHOLDS.latency_multiplier).toBe(2.0);
  });

  test('source_hash is deterministic across runs of the same input', () => {
    const rows1 = [makeRow('alpha', 0), makeRow('beta', 1), makeRow('gamma', 2)];
    const rows2 = [makeRow('beta', 1), makeRow('gamma', 2), makeRow('alpha', 0)]; // different order
    expect(computeSourceHash(rows1)).toBe(computeSourceHash(rows2));
  });

  test('reject metadata header missing required fields', () => {
    const bad = JSON.stringify({ schema_version: 1, _kind: 'baseline_metadata', label: 'x' }) + '\n';
    expect(() => parseBaselineFile(bad)).toThrow(BaselineParseError);
  });

  test('serializeBaselineFile produces byte-identical output on same input', () => {
    const rows = [makeRow('foo', 0), makeRow('bar', 1), makeRow('baz', 2)];
    const file = makeFile(rows);
    expect(serializeBaselineFile(file)).toBe(serializeBaselineFile(file));
  });

  test('normalizeQueryForHash is idempotent across whitespace and case', () => {
    expect(normalizeQueryForHash('  Hello   World  ')).toBe('hello world');
    expect(computeQueryHash('  Hello   World  ')).toBe(computeQueryHash('hello world'));
  });

  test('reject schema_version mismatch with a clear message', () => {
    const bad = JSON.stringify({
      schema_version: 999,
      _kind: 'baseline_metadata',
      label: 'x',
      published_at: 'z',
      source_hash: 'h',
      row_count: 0,
      baseline_mean_latency_ms: 0,
      thresholds: { jaccard: 0.85, top1: 0.8, latency_multiplier: 2.0 },
    }) + '\n';
    expect(() => parseBaselineFile(bad)).toThrow(/schema_version/);
  });

  test('reject empty file with no metadata', () => {
    expect(() => parseBaselineFile('')).toThrow(BaselineParseError);
    expect(() => parseBaselineFile('\n\n\n')).toThrow(BaselineParseError);
  });

  test('reject row missing query_hash (was it written by bench publish?)', () => {
    const meta = JSON.stringify({
      schema_version: 1,
      _kind: 'baseline_metadata',
      label: 'x',
      published_at: '2026-01-01T00:00:00Z',
      source_hash: 'h',
      row_count: 1,
      baseline_mean_latency_ms: 100,
      thresholds: { jaccard: 0.85, top1: 0.8, latency_multiplier: 2.0 },
    });
    const row = JSON.stringify({
      tool_name: 'query',
      query: 'hi',
      retrieved_slugs: ['x'],
      source_ids: ['default'],
    });
    expect(() => parseBaselineFile(meta + '\n' + row + '\n')).toThrow(/query_hash/);
  });
});
