/**
 * CLI→MCP gap-closure wave — get_job_stats op (`gbrain jobs stats` was the
 * one jobs verb with no MCP equivalent). Pins the payload shape, the shared
 * wedge derivation (queue.ts deriveWedgeSignal — same math as the CLI line
 * and the doctor wedged_queue check, #1801), and the relation-missing guard.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { deriveWedgeSignal } from '../src/core/minions/queue.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

const STDIO = { remote: true, transport: 'stdio' as const, sourceId: 'default' };

function parsed(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe('get_job_stats op', () => {
  test('returns the stats shape with the derived wedge signal (empty queue → not wedged)', async () => {
    const res = await dispatchToolCall(engine, 'get_job_stats', {}, { ...STDIO });
    expect(res.isError ?? false).toBe(false);
    const body = parsed(res);
    expect(body.schema_version).toBe(1);
    expect(body.window_hours).toBe(24);
    expect(typeof body.by_status).toBe('object');
    expect(Array.isArray(body.by_type)).toBe(true);
    expect(typeof body.queue_health.waiting).toBe('number');
    expect(body.wedge.queue).toBe('default');
    // Empty queue: nothing waiting → never wedged.
    expect(body.wedged).toBe(false);
    expect(body.wedge_threshold_minutes).toBeGreaterThan(0);
  });

  test('queue + since_hours params: wedge scopes to the named queue, window clamps', async () => {
    const res = await dispatchToolCall(engine, 'get_job_stats', { queue: 'reports', since_hours: 100000 }, { ...STDIO });
    const body = parsed(res);
    expect(body.wedge.queue).toBe('reports');
    expect(body.window_hours).toBe(720); // clamp ceiling
  });

  test('admin scope declared (jobs-family consistency)', () => {
    expect(operationsByName['get_job_stats'].scope).toBe('admin');
    expect(operationsByName['get_job_stats'].area).toBe('jobs');
  });

  test('missing minions schema → actionable unavailable, not a raw relation error', async () => {
    const bare = {
      executeRaw: async () => {
        throw new Error('relation "minion_jobs" does not exist');
      },
    } as unknown as BrainEngine;
    const res = await dispatchToolCall(bare, 'get_job_stats', {}, { ...STDIO });
    expect(res.isError).toBe(true);
    const body = parsed(res);
    expect(body.error).toBe('unavailable');
    expect(body.suggestion).toContain('apply-migrations');
  });
});

describe('deriveWedgeSignal (shared with the CLI line + doctor check)', () => {
  // deriveWedgeSignal reads GBRAIN_WEDGED_QUEUE_WARN_MINUTES per call — pin
  // it to unset so a tuned dev/CI host (e.g. =120) can't flip the 60-minute
  // fixtures below. The default threshold (15) is what these assertions pin.
  test('wedged: no healthy actives, work waiting, stale completion', async () => {
    await withEnv({ GBRAIN_WEDGED_QUEUE_WARN_MINUTES: undefined }, async () => {
      const { wedged } = deriveWedgeSignal({ active_healthy: 0, waiting: 3, minutes_since_completion: 60 });
      expect(wedged).toBe(true);
    });
  });

  test('wedged: no completions on record counts as stale', async () => {
    await withEnv({ GBRAIN_WEDGED_QUEUE_WARN_MINUTES: undefined }, async () => {
      expect(deriveWedgeSignal({ active_healthy: 0, waiting: 1, minutes_since_completion: null }).wedged).toBe(true);
    });
  });

  test('not wedged: live active row masks nothing, recent completion clears', async () => {
    await withEnv({ GBRAIN_WEDGED_QUEUE_WARN_MINUTES: undefined }, async () => {
      expect(deriveWedgeSignal({ active_healthy: 1, waiting: 5, minutes_since_completion: 60 }).wedged).toBe(false);
      expect(deriveWedgeSignal({ active_healthy: 0, waiting: 5, minutes_since_completion: 2 }).wedged).toBe(false);
      expect(deriveWedgeSignal({ active_healthy: 0, waiting: 0, minutes_since_completion: null }).wedged).toBe(false);
    });
  });
});
