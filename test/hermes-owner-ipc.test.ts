/** Native Unix socket coverage. Run with Bun against the complete checkout. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startResolveIpcServer, requestHermesStart, requestHermesStatus, IPC_UNAVAILABLE } from '../src/core/context/resolve-ipc.ts';
import { startDelegatedHermesMaintenance, getDelegatedHermesMaintenanceStatus, shutdownDelegatedHermesMaintenance,
  type HermesRunnerDependencies } from '../src/core/serve-hermes-runner.ts';
import type { BrainEngine } from '../src/core/engine.ts';

test('real local IPC rejects secret and source mismatches before owner work and attaches one intent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-hermes-ipc-'));
  const socket = join(root, 'owner.sock');
  const engine = {} as BrainEngine;
  const secret = 'synthetic-ipc-secret';
  const registration = { id: 'synthetic-cli', credential: 'synthetic-credential', lane: 'cli' as const };
  let runs = 0;
  const dependencies: HermesRunnerDependencies = {
    verify: async (_engine, _registration, task) => task({ remote: false, principal: { id: 'synthetic-cli', kind: 'local_cli' },
      grant: { scopes: ['read', 'write'], sourceIds: ['example'], operations: null, slugPrefixes: null } } as any),
    context: eng => ({ engine: eng, sourceId: 'example', remote: false } as any),
    run: async (eng, options) => {
      assert.equal(eng, engine); assert.equal(options.context.engine, engine); runs++;
      return { schema_version: 1, status: 'ok', source_id: 'example', duration_ms: 0,
        ingest: null, cycle: null, validation: { checked: 0, missing: [] }, reasons: [] };
    },
  };
  const server = await startResolveIpcServer(socket, { resolve: async () => null,
    hermes_start: req => startDelegatedHermesMaintenance(engine, req.options, req.clientToken, req.registration, 'example', dependencies),
    hermes_status: req => getDelegatedHermesMaintenanceStatus(engine, req.jobId, 'example'),
  }, { secret, boundSourceId: 'example' });
  try {
    assert.ok(server, 'Native IPC listener must bind; a missing prerequisite is not a passing test');
    const request = { secret, clientToken: 'one-intent', registration, options: { stateDb: '/synthetic/state.db', sourceId: 'example' } };
    const denied = await requestHermesStart(socket, { ...request, secret: 'wrong-secret' });
    assert.notEqual(denied, IPC_UNAVAILABLE);
    assert.equal((denied as any).error, 'unauthorized'); assert.equal(runs, 0);
    const wrongSource = await requestHermesStart(socket, { ...request, options: { ...request.options, sourceId: 'elsewhere' } });
    assert.equal((wrongSource as any).error, 'source_mismatch'); assert.equal(runs, 0);
    const start = await requestHermesStart(socket, request);
    assert.equal((start as any).ok, true);
    const retry = await requestHermesStart(socket, request);
    assert.equal((retry as any).jobId, (start as any).jobId); assert.equal(runs, 1);
    const status = await requestHermesStatus(socket, { secret, jobId: (start as any).jobId });
    assert.equal((status as any).state, 'done'); assert.equal((status as any).report.source_id, 'example');
  } finally {
    await shutdownDelegatedHermesMaintenance(engine);
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
