import { describe, test, expect } from 'bun:test';
import {
  QRELS_FILE_SCHEMA_VERSION,
  DEFAULT_QRELS_THRESHOLDS,
  QrelsParseError,
  makeRef,
  refKey,
  parseQrelsFile,
  computeRecallAtK,
  computeFirstRelevantHit,
  computeExpectedTop1Hit,
} from '../../src/core/bench/qrels-file.ts';

describe('qrels-file: parser', () => {
  test('parses the existing legacy fixture shape (relevant_slugs + first_relevant_slug)', () => {
    const legacy = {
      schema_version: 1,
      queries: [
        {
          query_id: 'q1',
          query: 'fintech founder',
          relevant_slugs: ['people/alice', 'companies/widget-co'],
          first_relevant_slug: 'people/alice',
        },
      ],
    };
    const parsed = parseQrelsFile(JSON.stringify(legacy));
    expect(parsed.queries).toHaveLength(1);
    expect(parsed.queries[0]!.query).toBe('fintech founder');
    // Legacy slugs promote to source_id='default'.
    expect(parsed.queries[0]!.relevant).toEqual([
      { source_id: 'default', slug: 'people/alice' },
      { source_id: 'default', slug: 'companies/widget-co' },
    ]);
    expect(parsed.queries[0]!.expected_top1).toEqual({ source_id: 'default', slug: 'people/alice' });
  });

  test('parses the federated shape (relevant + expected_top1 with explicit source_id)', () => {
    const federated = {
      schema_version: 1,
      queries: [
        {
          query_id: 'q1',
          query: 'fintech founder',
          relevant: [
            { source_id: 'host', slug: 'people/alice' },
            { source_id: 'team-a', slug: 'people/alice' },
          ],
          expected_top1: { source_id: 'host', slug: 'people/alice' },
        },
      ],
    };
    const parsed = parseQrelsFile(JSON.stringify(federated));
    expect(parsed.queries[0]!.relevant).toHaveLength(2);
    // Multi-source: same slug, different source_id, both treated as distinct.
    expect(refKey(parsed.queries[0]!.relevant[0]!)).toBe('host::people/alice');
    expect(refKey(parsed.queries[0]!.relevant[1]!)).toBe('team-a::people/alice');
  });

  test('rejects bare JSON array (must be object with schema_version)', () => {
    expect(() => parseQrelsFile('[]')).toThrow(QrelsParseError);
  });

  test('rejects missing queries field', () => {
    expect(() => parseQrelsFile(JSON.stringify({ schema_version: 1 }))).toThrow(/queries/);
  });

  test('rejects empty queries array', () => {
    expect(() => parseQrelsFile(JSON.stringify({ schema_version: 1, queries: [] }))).toThrow(
      /empty/,
    );
  });

  test('rejects entry with empty relevant set', () => {
    expect(() =>
      parseQrelsFile(
        JSON.stringify({
          schema_version: 1,
          queries: [{ query_id: 'q1', query: 'x', relevant_slugs: [] }],
        }),
      ),
    ).toThrow(/empty relevant/);
  });
});

describe('qrels-file: math', () => {
  test('computeRecallAtK perfect = 1.0', () => {
    expect(computeRecallAtK(['a', 'b', 'c'], ['a', 'b', 'c'], 10)).toBe(1.0);
  });

  test('computeRecallAtK zero = 0.0', () => {
    expect(computeRecallAtK(['x', 'y', 'z'], ['a', 'b'], 10)).toBe(0);
  });

  test('computeRecallAtK partial', () => {
    expect(computeRecallAtK(['a', 'x'], ['a', 'b'], 10)).toBe(0.5);
  });

  test('computeRecallAtK k smaller than retrieved truncates', () => {
    // Only top-1 is 'a'; relevant is 'a' + 'b'; k=1 → 1/2 = 0.5.
    expect(computeRecallAtK(['a', 'b', 'c'], ['a', 'b'], 1)).toBe(0.5);
  });

  test('computeRecallAtK empty relevant set returns 0 (defensive)', () => {
    expect(computeRecallAtK(['a'], [], 10)).toBe(0);
  });

  test('computeFirstRelevantHit retrieved[0] in relevant', () => {
    expect(computeFirstRelevantHit(['a', 'b'], ['a', 'c'])).toBe(1);
  });

  test('computeFirstRelevantHit retrieved[0] not in relevant', () => {
    expect(computeFirstRelevantHit(['x', 'a'], ['a', 'b'])).toBe(0);
  });

  test('computeFirstRelevantHit empty retrieved = 0', () => {
    expect(computeFirstRelevantHit([], ['a'])).toBe(0);
  });

  test('computeExpectedTop1Hit exact match = 1', () => {
    expect(computeExpectedTop1Hit(['default::a', 'default::b'], 'default::a')).toBe(1);
  });

  test('computeExpectedTop1Hit different source_id = 0 (multi-source guard)', () => {
    // Same slug, different source → NOT a hit (eng-D5 regression guard).
    expect(computeExpectedTop1Hit(['team-a::people/alice'], 'host::people/alice')).toBe(0);
  });

  test('makeRef/refKey format', () => {
    expect(makeRef('host', 'people/alice')).toBe('host::people/alice');
    expect(refKey({ source_id: 'host', slug: 'people/alice' })).toBe('host::people/alice');
  });

  test('DEFAULT_QRELS_THRESHOLDS shape and values', () => {
    expect(DEFAULT_QRELS_THRESHOLDS.recall_at_k).toBe(0.70);
    expect(DEFAULT_QRELS_THRESHOLDS.first_relevant_hit).toBe(0.60);
    expect(DEFAULT_QRELS_THRESHOLDS.expected_top1).toBe(0.50);
    expect(DEFAULT_QRELS_THRESHOLDS.k).toBe(10);
  });

  test('schema version constant matches parser expectation', () => {
    expect(QRELS_FILE_SCHEMA_VERSION).toBe(1);
  });
});
