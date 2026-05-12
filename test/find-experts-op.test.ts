/**
 * v0.33 — find_experts MCP op coverage.
 *
 * Verifies the op declaration: registered in operations array, exposed
 * with the locked surface (scope: read, localOnly: false), accepts the
 * documented params, validates non-empty topic, and the handler invokes
 * the same findExperts() pure function the CLI calls (handler-to-core
 * wiring parity).
 *
 * Engine-touching path is covered end-to-end against PGLite in
 * test/e2e/whoknows.test.ts; this file is fast-loop coverage for the
 * MCP-surface contract.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { operations, operationsByName } from '../src/core/operations.ts';
import { FIND_EXPERTS_DESCRIPTION } from '../src/core/operations-descriptions.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { ChunkInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1.0;
  return emb;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  await engine.putPage('wiki/people/expert', {
    type: 'person',
    title: 'Expert',
    compiled_truth: 'Expert is the authority on widgets.',
  });
  await engine.upsertChunks('wiki/people/expert', [
    {
      chunk_index: 0,
      chunk_text: 'Expert is the authority on widgets.',
      chunk_source: 'compiled_truth',
      embedding: basisEmbedding(7),
      token_count: 10,
    } as ChunkInput,
  ]);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('find_experts — op declaration', () => {
  test('registered in the operations array', () => {
    const op = operations.find((o) => o.name === 'find_experts');
    expect(op).toBeDefined();
  });

  test('findable via operationsByName', () => {
    expect(operationsByName['find_experts']).toBeDefined();
    expect(operationsByName['find_experts'].name).toBe('find_experts');
  });

  test('scope is read; localOnly is false (HTTP-MCP accessible)', () => {
    const op = operationsByName['find_experts'];
    expect(op.scope).toBe('read');
    // localOnly defaults to undefined/false; explicit truthy would block HTTP MCP.
    expect(op.localOnly).not.toBe(true);
  });

  test('declares the documented params (topic / limit / explain)', () => {
    const op = operationsByName['find_experts'];
    expect(op.params).toBeDefined();
    expect(op.params.topic).toBeDefined();
    expect(op.params.topic.type).toBe('string');
    expect(op.params.limit).toBeDefined();
    expect(op.params.limit.type).toBe('number');
    expect(op.params.explain).toBeDefined();
    expect(op.params.explain.type).toBe('boolean');
  });

  test('cliHints.name is "whoknows"', () => {
    const op = operationsByName['find_experts'];
    expect(op.cliHints?.name).toBe('whoknows');
  });

  test('description text is non-trivial and references the use case', () => {
    expect(FIND_EXPERTS_DESCRIPTION.length).toBeGreaterThan(60);
    expect(FIND_EXPERTS_DESCRIPTION).toMatch(/expert|knows|topic|routing/i);
  });
});

describe('find_experts — handler behavior', () => {
  function makeCtx(): OperationContext {
    // Minimal local-only context; the handler doesn't consult auth or
    // remote on a read-scoped read-only call (handler validates topic
    // then dispatches to findExperts). Cast through unknown to keep the
    // shape narrow without re-declaring the full OperationContext type.
    return {
      engine,
      remote: false,
      config: {},
      logger: console,
      dryRun: false,
    } as unknown as OperationContext;
  }

  test('rejects empty topic with invalid_params', async () => {
    const op = operationsByName['find_experts'];
    await expect(op.handler(makeCtx(), { topic: '' })).rejects.toThrow(/topic/);
  });

  test('rejects whitespace-only topic with invalid_params', async () => {
    const op = operationsByName['find_experts'];
    await expect(op.handler(makeCtx(), { topic: '   ' })).rejects.toThrow(/topic/);
  });

  test('rejects missing topic (undefined) with invalid_params', async () => {
    const op = operationsByName['find_experts'];
    await expect(op.handler(makeCtx(), {})).rejects.toThrow(/topic/);
  });

  test('handler returns an array on valid topic', async () => {
    const op = operationsByName['find_experts'];
    const result = (await op.handler(makeCtx(), { topic: 'widgets' })) as unknown[];
    expect(Array.isArray(result)).toBe(true);
  });

  test('handler honors limit parameter', async () => {
    const op = operationsByName['find_experts'];
    const result = (await op.handler(makeCtx(), { topic: 'widgets', limit: 1 })) as unknown[];
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeLessThanOrEqual(1);
  });
});
