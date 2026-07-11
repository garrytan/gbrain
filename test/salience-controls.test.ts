import { describe, expect, test } from 'bun:test';
import {
  buildSalienceQueryArgs,
  parseSalienceArgs,
  runSalience,
} from '../src/commands/salience.ts';
import {
  operations,
  type OperationContext,
} from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('salience CLI controls', () => {
  test('parses explicit recency and future controls', () => {
    expect(parseSalienceArgs([
      '--days', '7',
      '--limit', '12',
      '--slug-prefix', 'daily/',
      '--recency-bias', 'on',
      '--include-future',
      '--json',
    ])).toEqual({
      days: 7,
      limit: 12,
      slugPrefix: 'daily/',
      recencyBias: 'on',
      includeFuture: true,
      json: true,
    });
  });

  test('maps identical semantics to local camelCase and MCP snake_case', () => {
    const parsed = parseSalienceArgs([
      '--recency-bias', 'on',
      '--include-future',
    ]);
    if ('help' in parsed) throw new Error('unexpected help result');
    const mapped = buildSalienceQueryArgs(parsed);
    expect(mapped.engine.recency_bias).toBe('on');
    expect(mapped.engine.includeFuture).toBe(true);
    expect(mapped.remote.recency_bias).toBe('on');
    expect(mapped.remote.include_future).toBe(true);
  });

  test('invalid recency modes do not escape the typed control', () => {
    expect(parseSalienceArgs(['--recency-bias', 'turbo'])).toEqual({});
  });

  test('local CLI forwards both controls to the engine', async () => {
    let captured: unknown;
    const engine = {
      getRecentSalience: async (opts: unknown) => {
        captured = opts;
        return [];
      },
    } as unknown as BrainEngine;
    const originalLog = console.log;
    console.log = () => {};
    try {
      await runSalience(engine, [
        '--days', '3',
        '--recency-bias', 'on',
        '--include-future',
        '--json',
      ]);
    } finally {
      console.log = originalLog;
    }
    expect(captured).toMatchObject({
      days: 3,
      recency_bias: 'on',
      includeFuture: true,
    });
  });
});

describe('get_recent_salience operation contract', () => {
  const operation = operations.find(op => op.name === 'get_recent_salience');

  test('publishes include_future as a boolean parameter', () => {
    expect(operation).toBeDefined();
    expect(operation!.params.include_future).toMatchObject({ type: 'boolean' });
  });

  test('normalizes MCP parameters to engine options', async () => {
    let captured: unknown;
    const engine = {
      getRecentSalience: async (opts: unknown) => {
        captured = opts;
        return [];
      },
    } as unknown as BrainEngine;
    const ctx = {
      engine,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {} },
      dryRun: false,
      remote: true,
    } as unknown as OperationContext;

    await operation!.handler(ctx, {
      days: 5,
      limit: 9,
      slugPrefix: 'daily/',
      recency_bias: 'on',
      include_future: true,
    });

    expect(captured).toEqual({
      days: 5,
      limit: 9,
      slugPrefix: 'daily/',
      recency_bias: 'on',
      includeFuture: true,
    });
  });
});
