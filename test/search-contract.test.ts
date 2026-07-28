import { describe, expect, test } from 'bun:test';
import { resolveSearchMode, knobsHash } from '../src/core/search/mode.ts';
import {
  buildSearchContractV1,
  diffSearchContracts,
  embeddingInputSemantics,
  parseSearchContractV1,
  searchContractFingerprint,
  serializeSearchContractV1,
} from '../src/core/search/search-contract.ts';

const column = {
  name: 'embedding',
  type: 'vector' as const,
  dimensions: 2560,
  embeddingModel: 'zeroentropyai:zembed-1',
};
const balanced = resolveSearchMode({ mode: 'balanced' });

function contract() {
  return buildSearchContractV1(column, balanced);
}

describe('Search Contract v1', () => {
  test('captures zembed-1 2560d asymmetric retrieval and zerank-2', () => {
    const value = contract();
    expect(value).toMatchObject({
      version: 1,
      embedding: {
        model: 'zeroentropyai:zembed-1',
        dimensions: 2560,
        column: 'embedding',
        representation: 'vector',
        metric: 'cosine',
        input_semantics: 'query_document',
      },
      retrieval: { mode: 'balanced' },
      reranker: {
        enabled: true,
        model: 'zeroentropyai:zerank-2',
        top_n_in: 25,
        timeout_ms: 5000,
        failure_policy: 'fail_open',
      },
    });
  });

  test('round-trips canonical JSON and produces a stable fingerprint', () => {
    const value = contract();
    const raw = serializeSearchContractV1(value);
    expect(parseSearchContractV1(raw)).toEqual(value);
    expect(searchContractFingerprint(parseSearchContractV1(raw))).toBe(
      searchContractFingerprint(value),
    );
  });

  test('detects model, dimensions, representation, and reranker drift', () => {
    const pinned = contract();
    const current = structuredClone(pinned);
    current.embedding.model = 'openai:text-embedding-3-large';
    current.embedding.dimensions = 3072;
    current.embedding.representation = 'halfvec';
    current.reranker.model = 'zeroentropyai:zerank-1';
    const differences = diffSearchContracts(pinned, current);
    expect(differences.some((d) => d.startsWith('embedding.model:'))).toBe(true);
    expect(differences.some((d) => d.startsWith('embedding.dimensions:'))).toBe(true);
    expect(differences.some((d) => d.startsWith('embedding.representation:'))).toBe(true);
    expect(differences.some((d) => d.startsWith('reranker.model:'))).toBe(true);
  });

  test('classifies provider input semantics explicitly', () => {
    expect(embeddingInputSemantics('zeroentropyai:zembed-1')).toBe('query_document');
    expect(embeddingInputSemantics('voyage:voyage-3-large')).toBe('query_document');
    expect(embeddingInputSemantics('nvidia:nvidia/nv-embed-v1')).toBe('query_passage');
    expect(embeddingInputSemantics('openai:text-embedding-3-large')).toBe('symmetric');
  });

  test('rejects malformed or unsupported pins', () => {
    expect(() => parseSearchContractV1('{bad')).toThrow('invalid JSON');
    const value = contract() as unknown as Record<string, unknown>;
    value.version = 2;
    expect(() => parseSearchContractV1(JSON.stringify(value))).toThrow('unsupported version');
  });

  test('contract fingerprint participates in query-cache identity', () => {
    const first = contract();
    const changed = structuredClone(first);
    changed.embedding.dimensions = 1280;
    const firstHash = knobsHash(balanced, {
      embeddingColumn: 'embedding',
      embeddingModel: first.embedding.model,
      searchContractFingerprint: searchContractFingerprint(first),
    });
    const changedHash = knobsHash(balanced, {
      embeddingColumn: 'embedding',
      embeddingModel: changed.embedding.model,
      searchContractFingerprint: searchContractFingerprint(changed),
    });
    expect(changedHash).not.toBe(firstHash);
  });
});
