import { describe, expect, test } from 'bun:test';
import type { Operation } from '../src/core/operations.ts';
import {
  classifyMcpToolExecution,
  createMcpToolExecutionLimiter,
} from '../src/mcp/server.ts';

function operation(name: string, mutating = false): Operation {
  return {
    name,
    description: name,
    params: {},
    mutating,
    handler: async () => ({}),
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('MCP tool execution classification', () => {
  test('classifies mutating operations, heavy reads, and light operations', () => {
    expect(classifyMcpToolExecution(operation('put_page', true))).toBe('mutating');
    expect(classifyMcpToolExecution(operation('search'))).toBe('heavy_read');
    expect(classifyMcpToolExecution(operation('read_context'))).toBe('heavy_read');
    expect(classifyMcpToolExecution(operation('get_page'))).toBe('heavy_read');
    expect(classifyMcpToolExecution(operation('get_raw_data'))).toBe('heavy_read');
    expect(classifyMcpToolExecution(operation('get_chunks'))).toBe('heavy_read');
    expect(classifyMcpToolExecution(operation('get_context_map_report'))).toBe('heavy_read');
    expect(classifyMcpToolExecution(operation('get_workspace_orientation_bundle'))).toBe('heavy_read');
    expect(classifyMcpToolExecution(operation('get_health'))).toBe('light');
  });
});

describe('MCP tool execution limiter', () => {
  test('serializes mutating tool calls', async () => {
    const limiter = createMcpToolExecutionLimiter({ heavyReadConcurrency: 1 });
    const mutating = operation('put_page', true);
    const firstCanFinish = deferred();
    const firstStarted = deferred();
    const events: string[] = [];

    const first = limiter.run(mutating, async () => {
      events.push('first-start');
      firstStarted.resolve();
      await firstCanFinish.promise;
      events.push('first-end');
      return 'first';
    });
    await firstStarted.promise;

    const second = limiter.run(mutating, async () => {
      events.push('second-start');
      return 'second';
    });
    await Promise.resolve();

    expect(events).toEqual(['first-start']);
    firstCanFinish.resolve();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(events).toEqual(['first-start', 'first-end', 'second-start']);
  });

  test('reports foreground pressure while mutating work is active or queued', async () => {
    const limiter = createMcpToolExecutionLimiter({ heavyReadConcurrency: 1 });
    const mutating = operation('put_page', true);
    const firstCanFinish = deferred();
    const firstStarted = deferred();

    const first = limiter.run(mutating, async () => {
      firstStarted.resolve();
      await firstCanFinish.promise;
      return 'first';
    });
    await firstStarted.promise;
    expect(limiter.getForegroundPressure()).toEqual({
      active: 1,
      queued: 0,
      hasPressure: true,
    });

    const second = limiter.run(mutating, async () => 'second');
    await Promise.resolve();
    expect(limiter.getForegroundPressure()).toEqual({
      active: 1,
      queued: 1,
      hasPressure: true,
    });

    firstCanFinish.resolve();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(limiter.getForegroundPressure()).toEqual({
      active: 0,
      queued: 0,
      hasPressure: false,
    });
  });

  test('reports foreground pressure while heavy read work is active or queued', async () => {
    const limiter = createMcpToolExecutionLimiter({ heavyReadConcurrency: 1 });
    const heavy = operation('read_context');
    const firstCanFinish = deferred();
    const firstStarted = deferred();

    const first = limiter.run(heavy, async () => {
      firstStarted.resolve();
      await firstCanFinish.promise;
      return 'first';
    });
    await firstStarted.promise;
    expect(limiter.getForegroundPressure()).toEqual({
      active: 1,
      queued: 0,
      hasPressure: true,
    });

    const second = limiter.run(heavy, async () => 'second');
    await Promise.resolve();
    expect(limiter.getForegroundPressure()).toEqual({
      active: 1,
      queued: 1,
      hasPressure: true,
    });

    firstCanFinish.resolve();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(limiter.getForegroundPressure()).toEqual({
      active: 0,
      queued: 0,
      hasPressure: false,
    });
  });

  test('does not block light tools behind heavy reads', async () => {
    const limiter = createMcpToolExecutionLimiter({ heavyReadConcurrency: 1 });
    const heavy = operation('read_context');
    const light = operation('get_health');
    const firstHeavyCanFinish = deferred();
    const firstHeavyStarted = deferred();
    const events: string[] = [];

    const firstHeavy = limiter.run(heavy, async () => {
      events.push('heavy-1-start');
      firstHeavyStarted.resolve();
      await firstHeavyCanFinish.promise;
      events.push('heavy-1-end');
      return 'heavy-1';
    });
    await firstHeavyStarted.promise;

    const secondHeavy = limiter.run(heavy, async () => {
      events.push('heavy-2-start');
      return 'heavy-2';
    });
    const lightCall = limiter.run(light, async () => {
      events.push('light-start');
      return 'light';
    });

    await expect(lightCall).resolves.toBe('light');
    expect(events).toEqual(['heavy-1-start', 'light-start']);

    firstHeavyCanFinish.resolve();
    await expect(firstHeavy).resolves.toBe('heavy-1');
    await expect(secondHeavy).resolves.toBe('heavy-2');
    expect(events).toEqual(['heavy-1-start', 'light-start', 'heavy-1-end', 'heavy-2-start']);
  });
});
