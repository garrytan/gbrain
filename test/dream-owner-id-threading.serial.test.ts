/**
 * Owner-id threading from registerBuiltinHandlers into runCycle
 * (src/commands/jobs.ts): every cycle-running handler must pass
 * `privateQueueOwnerJobId: job.id` so phase-created dream-inline-* private
 * queues carry an owner and the orphan-recovery lanes can classify them.
 * Pins the three call sites:
 *   - 'autopilot-cycle'             (per-source / legacy cycle handler)
 *   - 'autopilot-global-maintenance' (brain-wide maintenance lane)
 *   - makePhaseHandler              (the dream-phase wrappers; exercised via
 *                                    'resolve_symbol_edges')
 *
 * Serial (*.serial.test.ts): mock.module replaces cycle.ts's runCycle with a
 * capturing stub (everything else re-exported real), which leaks across files
 * in a shared shard process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const realCycle = await import('../src/core/cycle.ts');

const capturedOpts: Array<Record<string, unknown>> = [];

mock.module('../src/core/cycle.ts', () => ({
  ...realCycle,
  runCycle: async (_engine: unknown, opts: Record<string, unknown>) => {
    capturedOpts.push(opts);
    // Minimal successful CycleReport shape: handlers read `report.status`
    // (and the maintenance handler stamps config when it is ok/clean/partial).
    return {
      schema_version: '1',
      timestamp: new Date().toISOString(),
      duration_ms: 0,
      status: 'ok',
      brain_dir: (opts.brainDir as string | null) ?? null,
      phases: [],
      totals: {},
    };
  },
}));

// Import AFTER the mock so the handlers' dynamic `import('../core/cycle.ts')`
// resolves to the capturing stub.
const { registerBuiltinHandlers } = await import('../src/commands/jobs.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let handlers: Map<string, (job: unknown) => Promise<Record<string, unknown>>>;
let repoPath: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  handlers = new Map();
  const fakeWorker = {
    register(name: string, fn: (job: unknown) => Promise<Record<string, unknown>>) {
      handlers.set(name, fn);
    },
  };
  await registerBuiltinHandlers(fakeWorker as never, engine, { quiet: true });
  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-owner-id-threading-'));
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(() => {
  capturedOpts.length = 0;
});

describe('privateQueueOwnerJobId === job.id threading', () => {
  test("'autopilot-cycle' threads its job id into runCycle", async () => {
    const handler = handlers.get('autopilot-cycle');
    expect(handler).toBeTruthy();
    const result = await handler!({
      id: 42,
      name: 'autopilot-cycle',
      data: { repoPath },
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('ok');
    expect(capturedOpts.length).toBe(1);
    expect(capturedOpts[0].privateQueueOwnerJobId).toBe(42);
  });

  test("'autopilot-global-maintenance' threads its job id into runCycle", async () => {
    const handler = handlers.get('autopilot-global-maintenance');
    expect(handler).toBeTruthy();
    const result = await handler!({
      id: 43,
      name: 'autopilot-global-maintenance',
      data: { repoPath },
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('ok');
    expect(capturedOpts.length).toBe(1);
    expect(capturedOpts[0].privateQueueOwnerJobId).toBe(43);
  });

  test('the dream-phase wrapper (makePhaseHandler) threads its job id into runCycle', async () => {
    const handler = handlers.get('resolve_symbol_edges');
    expect(handler).toBeTruthy();
    const result = await handler!({
      id: 44,
      name: 'resolve_symbol_edges',
      data: { repoPath },
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('ok');
    expect(capturedOpts.length).toBe(1);
    expect(capturedOpts[0].privateQueueOwnerJobId).toBe(44);
    expect(capturedOpts[0].phases).toEqual(['resolve_symbol_edges']);
  });
});
