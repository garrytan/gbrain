import { describe, test, expect } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { vectorRetrievalHealthCheck } from '../src/commands/doctor.ts';

function engineWithVectorSearch(
  searchVector: BrainEngine['searchVector'],
): BrainEngine {
  return { searchVector } as unknown as BrainEngine;
}

const healthyVectorProbe = {
  embedQuery: async () => new Float32Array(1536),
  expectedDimensions: 1536,
};

describe('vectorRetrievalHealthCheck', () => {
  test('fails closed when live query embedding fails', async () => {
    const secretBearingError = 'provider-sensitive-marker';
    const engine = engineWithVectorSearch(async () => []);
    const result = await vectorRetrievalHealthCheck(engine, {
      embedQuery: async () => { throw new Error(secretBearingError); },
      expectedDimensions: 1024,
    });

    expect(result.name).toBe('vector_retrieval');
    expect(result.status).toBe('fail');
    expect(result.code).toBe('embedding_probe_failed');
    expect(result.message).toContain('keyword-only');
    expect(result.message).not.toContain(secretBearingError);
    expect(result.message).not.toContain('provider-sensitive-marker');
  });

  test('validates dimensions and executes vector search', async () => {
    let vectorSearchCalls = 0;
    const engine = engineWithVectorSearch(async () => {
      vectorSearchCalls++;
      return [];
    });

    const result = await vectorRetrievalHealthCheck(engine, healthyVectorProbe);

    expect(result.status).toBe('ok');
    expect(result.code).toBe('vector_probe_ok');
    expect(result.message).toContain('1536');
    expect(result.message).toContain('vector search succeeded');
    expect(vectorSearchCalls).toBe(1);
  });

  test('fails closed when an embedded corpus returns no vector result', async () => {
    const engine = engineWithVectorSearch(async () => []);

    const result = await vectorRetrievalHealthCheck(engine, {
      ...healthyVectorProbe,
      requireResult: true,
    });

    expect(result.status).toBe('fail');
    expect(result.code).toBe('vector_probe_no_results');
    expect(result.message).not.toContain('timed out');
  });

  test('fails before vector search on an embedding dimension mismatch', async () => {
    let vectorSearchCalls = 0;
    const engine = engineWithVectorSearch(async () => {
      vectorSearchCalls++;
      return [];
    });

    const result = await vectorRetrievalHealthCheck(engine, {
      embedQuery: async () => new Float32Array(1024),
      expectedDimensions: 1536,
    });

    expect(result.status).toBe('fail');
    expect(result.code).toBe('embedding_dimension_mismatch');
    expect(result.message).toContain('1536');
    expect(vectorSearchCalls).toBe(0);
  });

  test('bounds a slow embedding probe and reports a stable timeout code', async () => {
    const engine = engineWithVectorSearch(async () => []);
    const result = await vectorRetrievalHealthCheck(engine, {
      embedQuery: async () => {
        await Bun.sleep(50);
        return new Float32Array(1536);
      },
      expectedDimensions: 1536,
      timeoutMs: 5,
    });

    expect(result.status).toBe('fail');
    expect(result.code).toBe('embedding_probe_timeout');
  });

  test('bounds a slow vector-search probe and reports a stable timeout code', async () => {
    const engine = engineWithVectorSearch(async () => {
      await Bun.sleep(50);
      return [];
    });
    const result = await vectorRetrievalHealthCheck(engine, {
      ...healthyVectorProbe,
      timeoutMs: 5,
    });

    expect(result.status).toBe('fail');
    expect(result.code).toBe('vector_search_probe_timeout');
  });

  test('reports vector-search failures without leaking DB errors', async () => {
    const secretBearingError = 'db-sensitive-marker';
    const engine = engineWithVectorSearch(async () => {
      throw new Error(secretBearingError);
    });

    const result = await vectorRetrievalHealthCheck(engine, healthyVectorProbe);

    expect(result.status).toBe('fail');
    expect(result.code).toBe('vector_search_probe_failed');
    expect(result.message).not.toContain(secretBearingError);
    expect(result.message).not.toContain('db-sensitive-marker');
  });
});
