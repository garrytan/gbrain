/**
 * GBRA-133 (600k soak): a managed pass wrote a round's holds in one transaction that took the drain-lease fence (the lock
 * row `FOR SHARE`) first. At 65 ms per round trip it stayed open for 14 minutes; the lease's own renewal waited on that row,
 * timed out three times, and the lease lapsed under the pass, which then stopped `drain_lease_held` without applying
 * anything; its release waited on the same row until the connection was killed. Fenced per-item writes now commit in
 * slices of at most `FENCED_SLICE_MS`, so a renewal waits for one slice at most.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SyncResult } from '../src/commands/sync.ts';
import { syncLockId } from '../src/core/db-lock.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { holdPassIdentities, newPassApplyState } from '../src/core/persistence/sync-pass-apply.ts';
import type { ShadowLevel, ShadowPath } from '../src/core/persistence/sync-pass.ts';
import { GIT_HOLD_OP } from '../src/core/persistence/sync-holds.ts';
import { withDrainLease } from '../src/core/persistence/sync-lease.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const HOLDS = 60;
const ROUND_TRIP_MS = 40;
/** A slice (`FENCED_SLICE_MS`, 5 s) plus the hold that crosses it; the whole round takes about twice that. */
const SLICE_BOUND_MS = 6_000;

/** `engine` whose transactions wait `ROUND_TRIP_MS` before each statement (a remote database) and record how long each stayed open. */
function remote(engine: BrainEngine, spans: number[]): BrainEngine {
  const slow = (tx: BrainEngine) => new Proxy(tx, { get: (target, prop) => {
    if (prop === 'executeRaw') return async (...args: Parameters<BrainEngine['executeRaw']>) => { await Bun.sleep(ROUND_TRIP_MS); return target.executeRaw(...args); };
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  return new Proxy(engine, { get: (target, prop) => {
    if (prop === 'transaction') return <T>(fn: (tx: BrainEngine) => Promise<T>) => target.transaction(async tx => {
      const began = performance.now();
      try { return await fn(slow(tx)); } finally { spans.push(performance.now() - began); }
    });
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`GBRA-133 [${backend}]: a round's holds commit in fenced slices, so the lease renews while they are written`, () => managedBrain(async ({ engine }) => {
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
    const level = { sourceId: 'default', incarnation, scope: '', slugMode: 'git-root', mode: 'committed' } as unknown as ShadowLevel;
    const items = Array.from({ length: HOLDS }, (_, i) => ({ slug: `notes/held-${i}`, ids: { page: `page-${i}`, file: `file-${i}` },
      entry: { path: `notes/held-${i}.md`, slug: `notes/held-${i}`, pageId: null, revision: null, state: { level: 'a'.repeat(40), levelSha256: null },
        result: { cls: 'import', settled: false, action: 'import' } } as unknown as ShadowPath }));
    const state = newPassApplyState();
    const spans: number[] = [];
    let renewalMs = -1;
    const result = await withDrainLease(engine, 'default', { holder: { kind: 'cli' } }, async () => {
      const holds = holdPassIdentities(remote(engine, spans), level, { passId: 'pass-example', observedAt: new Date().toISOString() }, state, items);
      await Bun.sleep(1_000);
      const asked = performance.now();
      const renewed = await engine.executeRaw('UPDATE gbrain_cycle_locks SET last_refreshed_at=now() WHERE id=$1 RETURNING id', [syncLockId('default')]);
      renewalMs = performance.now() - asked;
      expect(renewed).toHaveLength(1);
      await holds;
      return { status: 'synced' } as unknown as SyncResult;
    });
    expect(result.status).toBe('synced');
    expect(spans.length).toBeGreaterThan(1);
    expect(Math.max(...spans)).toBeLessThan(SLICE_BOUND_MS);
    expect(renewalMs).toBeLessThan(SLICE_BOUND_MS);
    expect(state.holds.page_identity_changed).toBe(HOLDS);
    expect(items.every(item => item.entry.result.cls === 'held' && item.entry.result.settled)).toBe(true);
    const [{ n }] = await engine.executeRaw<{ n: number | string }>('SELECT count(*) AS n FROM op_checkpoints WHERE op=$1 AND fingerprint LIKE $2', [GIT_HOLD_OP, `default:${incarnation}:notes/held-%`]);
    expect(Number(n)).toBe(HOLDS);
  }, { databaseUrl, setup: ({ root }) => {
    execFileSync('git', ['-C', root, 'init', '-q']);
    writeFileSync(join(root, 'a.md'), '---\ntype: concept\ntitle: a\n---\n\nA note.\n');
  } }), 120_000);
}
