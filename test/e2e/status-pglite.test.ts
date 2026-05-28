/**
 * E2E `gbrain status` against a real PGLite brain.
 *
 * Seeds:
 *   - 1 source row
 *   - 1 `autopilot-cycle` completed row with `result.report.totals`
 *   - 1 `autopilot-embed` completed row (newer; covers the dual-row
 *     "Last full" + "Last targeted" output per D3)
 *   - 1 active gbrain_cycle_locks row
 *   - some minion_jobs counts (waiting/active/dead)
 *
 * Asserts:
 *   - dual cycle rows surface (full < targeted in timestamp)
 *   - cycle totals come from `result.report.totals`, NOT `result.totals`
 *     (codex MINOR-3)
 *   - JSON envelope shape (schema_version: 1)
 *   - active lock surfaces
 *   - live queue counts (NO time-window filter — codex MAJOR-6)
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runStatus } from '../../src/commands/status.ts';

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

async function seedAutopilotCycle(engine: PGLiteEngine, opts: {
  name: string;
  finishedAt: string;
  totals?: Record<string, unknown>;
}) {
  const result = opts.totals
    ? { partial: false, status: 'ok', report: { totals: opts.totals } }
    : { partial: false, status: 'ok', report: {} };
  await engine.executeRaw(
    `INSERT INTO minion_jobs (queue, name, data, status, started_at, finished_at, result)
     VALUES ('default', $1, '{}'::jsonb, 'completed',
             $2::timestamptz - INTERVAL '5 seconds', $2::timestamptz, $3::jsonb)`,
    [opts.name, opts.finishedAt, JSON.stringify(result)],
  );
}

async function seedSource(engine: PGLiteEngine, id: string) {
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [id, id],
  );
}

describe('gbrain status E2E (PGLite)', () => {
  test('JSON envelope shape includes schema_version + sync + cycle + locks + workers + queue + autopilot', async () => {
    await seedSource(engine, 'default');
    let jsonOut = '';
    const r = await runStatus(engine, ['--json'], {
      stdout: (s) => {
        jsonOut += s;
      },
      stderr: () => {},
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(jsonOut.trim());
    expect(parsed.schema_version).toBe(1);
    expect(parsed.mode).toBe('local');
    expect(parsed).toHaveProperty('sync');
    expect(parsed).toHaveProperty('cycle');
    expect(parsed).toHaveProperty('locks');
    expect(parsed).toHaveProperty('workers');
    expect(parsed).toHaveProperty('queue');
    expect(parsed).toHaveProperty('autopilot');
  });

  test('dual cycle rows: last_full + last_targeted surface independently', async () => {
    await seedSource(engine, 'default');
    // Older full cycle row + newer targeted (embed) row.
    await seedAutopilotCycle(engine, {
      name: 'autopilot-cycle',
      finishedAt: '2026-05-20T10:00:00Z',
      totals: { synth_pages_written: 7, facts_consolidated: 12 },
    });
    await seedAutopilotCycle(engine, {
      name: 'autopilot-embed',
      finishedAt: '2026-05-26T22:30:00Z',
      totals: { chunks_embedded: 100 },
    });

    let jsonOut = '';
    await runStatus(engine, ['--json'], {
      stdout: (s) => {
        jsonOut += s;
      },
      stderr: () => {},
    });
    const parsed = JSON.parse(jsonOut.trim());
    expect(parsed.cycle.last_full).toBeDefined();
    expect(parsed.cycle.last_full.name).toBe('autopilot-cycle');
    expect(parsed.cycle.last_full.totals).toEqual({
      synth_pages_written: 7,
      facts_consolidated: 12,
    });
    expect(parsed.cycle.last_targeted).toBeDefined();
    // Last targeted should be the newer autopilot-embed row (since it
    // matches `name LIKE 'autopilot-%'` and is newer than autopilot-cycle).
    expect(parsed.cycle.last_targeted.name).toBe('autopilot-embed');
    expect(parsed.cycle.last_targeted.totals).toEqual({ chunks_embedded: 100 });
  });

  test('cycle totals come from result.report.totals, NOT result.totals (codex MINOR-3)', async () => {
    await seedSource(engine, 'default');
    // Hand-craft a row where totals are mis-placed at the top level — the
    // status renderer should IGNORE them (returns null), not silently surface
    // the wrong shape.
    await engine.executeRaw(
      `INSERT INTO minion_jobs (queue, name, data, status, started_at, finished_at, result)
       VALUES ('default', 'autopilot-cycle', '{}'::jsonb, 'completed',
               NOW() - INTERVAL '5 seconds', NOW(),
               '{"totals":{"wrong_place":42}}'::jsonb)`,
    );
    let jsonOut = '';
    await runStatus(engine, ['--json'], {
      stdout: (s) => {
        jsonOut += s;
      },
      stderr: () => {},
    });
    const parsed = JSON.parse(jsonOut.trim());
    expect(parsed.cycle.last_full).toBeDefined();
    // totals at the WRONG path should NOT be surfaced.
    expect(parsed.cycle.last_full.totals).toBeNull();
  });

  test('active lock surfaces in the locks section', async () => {
    await seedSource(engine, 'default');
    await engine.executeRaw(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ('gbrain-cycle', 1234, 'test-host', NOW(), NOW() + INTERVAL '30 minutes', NOW())`,
    );
    let jsonOut = '';
    await runStatus(engine, ['--json'], {
      stdout: (s) => {
        jsonOut += s;
      },
      stderr: () => {},
    });
    const parsed = JSON.parse(jsonOut.trim());
    expect(Array.isArray(parsed.locks)).toBe(true);
    expect(parsed.locks).toHaveLength(1);
    expect(parsed.locks[0].id).toBe('gbrain-cycle');
    expect(parsed.locks[0].holder_pid).toBe(1234);
  });

  test('live queue counts include OLD waiting/active jobs (no time window — codex MAJOR-6)', async () => {
    await seedSource(engine, 'default');
    // Seed an OLD waiting job (created 10 days ago). The status query MUST
    // surface it — that's exactly the kind of stuck job operators want to see.
    await engine.executeRaw(
      `INSERT INTO minion_jobs (queue, name, data, status, created_at)
       VALUES ('default', 'stale-waiting', '{}'::jsonb, 'waiting',
               NOW() - INTERVAL '10 days')`,
    );
    let jsonOut = '';
    await runStatus(engine, ['--json'], {
      stdout: (s) => {
        jsonOut += s;
      },
      stderr: () => {},
    });
    const parsed = JSON.parse(jsonOut.trim());
    expect(parsed.queue.waiting).toBe(1);
  });

  test('--section sync emits only the sync section (filter works)', async () => {
    await seedSource(engine, 'default');
    let jsonOut = '';
    await runStatus(engine, ['--json', '--section', 'sync'], {
      stdout: (s) => {
        jsonOut += s;
      },
      stderr: () => {},
    });
    const parsed = JSON.parse(jsonOut.trim());
    expect(parsed.sync).toBeDefined();
    expect(parsed.cycle).toBeUndefined();
    expect(parsed.locks).toBeUndefined();
    expect(parsed.workers).toBeUndefined();
    expect(parsed.queue).toBeUndefined();
    expect(parsed.autopilot).toBeUndefined();
  });
});
