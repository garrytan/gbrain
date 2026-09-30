/**
 * #5673: a per-source autopilot cycle for a connector source never uses the
 * connector's `local_path` as its brain directory, never resolves the global
 * `sync.repo_path`, and runs only the connector database-phase allowlist.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const calls: Array<Record<string, unknown>> = [];
const cycle = await import('../src/core/cycle.ts');
mock.module('../src/core/cycle.ts', () => ({
  ...cycle,
  runCycle: async (_engine: unknown, opts: Record<string, unknown>) => { calls.push(opts); return { status: 'ok' }; },
}));
const { makeAutopilotCycleHandler } = await import('../src/core/minions/handlers/autopilot-cycle.ts');
const { CONNECTOR_SOURCE_PHASES } = await import('../src/core/cycle/phase-scope.ts');

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('#5673 connector per-source cycle', () => {
  test('runs with no brain directory, never reads sync.repo_path, and only database phases', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name, local_path, config) VALUES ('gmail-a', 'gmail-a', '/stale/checkout', '{\"kind\":\"google\"}'::jsonb)");
    await engine.setConfig('sync.repo_path', '/global/brain');
    const reads: string[] = [];
    const getConfig = engine.getConfig.bind(engine);
    (engine as { getConfig: unknown }).getConfig = async (key: string) => { reads.push(key); return getConfig(key); };
    const handler = makeAutopilotCycleHandler(engine);
    await handler({ id: 1, data: { source_id: 'gmail-a', repoPath: null, phases: ['lint', 'sync', 'extract', 'recompute_emotional_weight'] } } as never);
    expect(calls.length).toBe(1);
    expect(calls[0].brainDir).toBeNull();
    expect(calls[0].phases).toEqual(['extract', 'recompute_emotional_weight']);
    expect(reads).not.toContain('sync.repo_path');
    for (const phase of calls[0].phases as string[]) expect(CONNECTOR_SOURCE_PHASES as string[]).toContain(phase);
  });
});
