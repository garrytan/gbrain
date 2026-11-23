import { describe, expect, test } from 'bun:test';
import { consumersWithoutHeartbeatCheck } from '../src/commands/doctor/checks/persistence-consumers.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// A Rust brain keeps no consumer heartbeat rows, so consumers_without_heartbeat gives the PGLite answer without a read.
describe('consumers_without_heartbeat on a Rust brain', () => {
  const noReads = new Proxy({ kind: 'rust' } as Record<string, unknown>, {
    get: (target, prop) => (prop in target ? target[prop as string] : () => { throw new Error(`unexpected read: ${String(prop)}`); }),
  }) as unknown as BrainEngine;

  test('reports the PGLite wording and reads nothing', async () => {
    const check = await consumersWithoutHeartbeatCheck(noReads, 'host-a');
    expect(check.status).toBe('ok');
    expect(check.message).toBe('PGLite admits one process; no consumer heartbeat rows are kept.');
    expect(check.details).toMatchObject({ count: 0, owners: [] });
  });
});
