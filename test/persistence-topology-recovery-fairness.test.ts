import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { runManagedSourceClone } from '../src/core/persistence/topology-clone.ts';
import { recoverSourceTopologies } from '../src/core/persistence/topology-recovery.ts';
import { topologyPrincipal } from '../src/core/persistence/topology-locks.ts';
import type { TopologyCloneRecovery } from '../src/core/persistence/topology-clone-model.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-topology-fairness-'));
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine?.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('bounded topology recovery rotates past a persistent conflict, wraps, and releases only settled reservations', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  await registerLocalWriter(engine, 'cli');
  await engine.setConfig('persistence.limits.worktree_recovery_bytes', '262144');
  await engine.setConfig('persistence.limits.brain_recovery_bytes', '1048576');
  const principal = await topologyPrincipal(engine);
  let providerCalls = 0;
  for (const name of ['first', 'second']) {
    const input = { operation: 'add' as const, sourceId: `recovery-${name}`, path: join(home, name),
      remoteUrl: 'https://example.invalid/brain.git', requestId: randomUUID() };
    await expect(runManagedSourceClone(engine, input, principal, input.requestId,
      { ...input, requestId: undefined, dryRun: undefined }, {
        clone: async (_url, stage) => {
          providerCalls++;
          writeFileSync(join(stage, 'example.md'), 'Canonical example\n');
        },
        boundary: async name => {
          if (name !== 'prepared') return;
          const [row] = await engine.executeRaw<{ recovery: TopologyCloneRecovery }>(
            'SELECT recovery FROM persistence_topology_changes WHERE request_id=$1::uuid', [input.requestId]);
          writeFileSync(join(row.recovery.stage, 'unexpected.md'), 'Uncoordinated staging edit\n');
          throw new Error('fixture interrupted clone');
        },
      })).rejects.toMatchObject({ code: 'recovery_required' });
  }
  const rows = await engine.executeRaw<{ id: string; recovery: TopologyCloneRecovery; recovery_bytes: string }>(
    'SELECT id,recovery,recovery_bytes::text FROM persistence_topology_changes WHERE recovery IS NOT NULL ORDER BY id');
  expect(rows).toHaveLength(2);
  const [blocked, later] = rows;
  const counters = async () => (await engine.executeRaw<{ recovery_bytes: string; outstanding_count: string }>(
    "SELECT recovery_bytes::text,outstanding_count::text FROM persistence_counters WHERE key='brain'"))[0];
  expect(await counters()).toEqual({ recovery_bytes: String(Number(blocked.recovery_bytes) + Number(later.recovery_bytes)), outstanding_count: '2' });
  rmSync(join(later.recovery.stage, 'unexpected.md'));

  expect(await recoverSourceTopologies(engine, { limit: 1 })).toBe(0);
  expect(existsSync(join(blocked.recovery.stage, 'unexpected.md'))).toBe(true);
  expect(await recoverSourceTopologies(engine, { limit: 1 })).toBe(1);
  expect(await counters()).toEqual({ recovery_bytes: blocked.recovery_bytes, outstanding_count: '1' });
  expect(existsSync(later.recovery.stage)).toBe(false);
  expect((await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_topology_changes WHERE id=$1::uuid', [later.id]))[0].state).toBe('failed');

  // The cursor is past the final row: this pass must wrap and retain the
  // earlier unresolved root, rather than incorrectly treating the scan as done.
  expect(await recoverSourceTopologies(engine, { limit: 1 })).toBe(0);
  expect(existsSync(join(blocked.recovery.stage, 'unexpected.md'))).toBe(true);
  rmSync(join(blocked.recovery.stage, 'unexpected.md'));
  expect(await recoverSourceTopologies(engine, { limit: 1 })).toBe(1);
  expect(await counters()).toEqual({ recovery_bytes: '0', outstanding_count: '0' });
  expect(await engine.executeRaw('SELECT id FROM persistence_topology_changes WHERE recovery IS NOT NULL')).toEqual([]);
  expect(await recoverSourceTopologies(engine, { limit: 1 })).toBe(0);
  expect(providerCalls).toBe(2);
  expect(existsSync(blocked.recovery.stage)).toBe(false);
}), 20_000);
