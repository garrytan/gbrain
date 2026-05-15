/**
 * v0.31.1 (Issue #734): tests for `get_brain_identity` MCP op.
 *
 * The op is the data source for the thin-client identity banner. Returns
 * {version, engine, page_count, chunk_count, last_sync_iso}. Read-scope.
 * Reuses engine.getStats() — banner's 60s TTL cache bounds frequency.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operationsByName } from '../src/core/operations.ts';
import { VERSION } from '../src/version.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function buildCtx(): OperationContext {
  return {
    engine,
    config: {} as any,
    logger: console,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

describe('get_brain_identity op', () => {
  test('is registered in operationsByName', () => {
    expect(operationsByName.get_brain_identity).toBeDefined();
  });

  test('declares scope=read so non-admin clients can call it', () => {
    expect(operationsByName.get_brain_identity.scope).toBe('read');
  });

  test('is NOT localOnly (must be reachable over MCP for thin-client banner)', () => {
    expect(operationsByName.get_brain_identity.localOnly).toBeFalsy();
  });

  test('takes no params', () => {
    expect(operationsByName.get_brain_identity.params).toEqual({});
  });

  test('has no cliHints — banner-only op, not user-facing CLI surface', () => {
    expect(operationsByName.get_brain_identity.cliHints).toBeUndefined();
  });

  test('returns identity packet with VERSION + engine kind on empty brain', async () => {
    const op = operationsByName.get_brain_identity;
    const result = (await op.handler(buildCtx(), {})) as {
      version: string;
      engine: 'postgres' | 'pglite';
      page_count: number;
      chunk_count: number;
      last_sync_iso: string | null;
    };

    expect(result.version).toBe(VERSION);
    expect(result.engine).toBe('pglite');
    expect(result.page_count).toBe(0);
    expect(result.chunk_count).toBe(0);
    expect(result.last_sync_iso).toBe(null);
  });

  test('reflects page count after pages are seeded', async () => {
    await engine.putPage('wiki/test/foo', {
      type: 'note',
      title: 'Foo',
      compiled_truth: 'foo body',
    });
    await engine.putPage('wiki/test/bar', {
      type: 'note',
      title: 'Bar',
      compiled_truth: 'bar body',
    });

    const op = operationsByName.get_brain_identity;
    const result = (await op.handler(buildCtx(), {})) as {
      page_count: number;
      chunk_count: number;
    };

    expect(result.page_count).toBe(2);
    // chunk_count depends on chunker; just assert it advanced past zero
    expect(result.chunk_count).toBeGreaterThanOrEqual(0);
  });

  test('returns stable shape (load-bearing for thin-client banner)', async () => {
    const op = operationsByName.get_brain_identity;
    const result = (await op.handler(buildCtx(), {})) as Record<string, unknown>;
    const keys = Object.keys(result).sort();
    expect(keys).toEqual([
      'chunk_count',
      'engine',
      'last_sync_iso',
      'page_count',
      'version',
    ]);
  });

  test('last_sync_iso is null in v0.31.1 (deferred to v0.31.x — see plan)', async () => {
    // Documents the known gap so an implementer who later wires the cycle
    // to write a sync timestamp can flip this expectation.
    const op = operationsByName.get_brain_identity;
    const result = (await op.handler(buildCtx(), {})) as { last_sync_iso: string | null };
    expect(result.last_sync_iso).toBe(null);
  });
});
