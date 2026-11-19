/**
 * BrainEngine parity — the owner's managed-checkout recovery scans: the consumer's recovery scan
 * (persistence/consumer.ts `readOwnerRecoveryHeads`), the topology recovery that first converges interrupted refreshes
 * (persistence/topology-recovery.ts `recoverSourceTopologies`, worktree-refresh.ts `resumeWorktreeRefreshes`) and the
 * deferred-write expiry (persistence/refresh-barrier.ts `expireDeferredWrites`), and the idle probe an owner tick asks
 * before its full fan-out (persistence/consumer.ts `hasWork`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: with a plain queued write and no managed worktree, every scan finds nothing to do on every arm and the
 *    write stays queued and unchanged. On every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm
 *    through test/engine-parity/harness.ts). The idle probe answers idle on an empty journal and work once a plain write
 *    is queued.
 *  - Regression: each scan is one owner tick phase. On the Rust engine each read raw SQL, refused raw_sql, and ended the
 *    tick before the claim, so a CLI put on a Rust brain stayed write_pending. The idle probe is one raw statement over
 *    the whole journal; on the Rust engine it failed every idle tick, which cost a report and a backoff each time.
 *  - Why existing coverage misses it: no parity case ran an owner tick phase; the scans were only reached by a CLI put.
 *  - Seam: none. The real scans and typed members only (no executeRaw: D18). Generated ids are compared by equality
 *    with another member's answer.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { PersistenceConsumer, readOwnerRecoveryHeads } from '../../src/core/persistence/consumer.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import { hostIdFor, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { expireDeferredWrites } from '../../src/core/persistence/refresh-barrier.ts';
import { recoverSourceTopologies } from '../../src/core/persistence/topology-recovery.ts';
import { resumeWorktreeRefreshes } from '../../src/core/persistence/worktree-refresh.ts';

const { parityTest } = parityArms(testBackends());

const REQUEST = 'c0000000-0000-4000-8000-0000000000c1';
const IDLE_REQUEST = 'c0000000-0000-4000-8000-0000000000c2';

/** The owner's idle probe (`hasWork`, private): what an idle tick asks before it runs the full fan-out. */
function idleProbe(engine: BrainEngine): () => Promise<boolean> {
  const consumer = new PersistenceConsumer(engine, { engine: engine.kind } as GBrainConfig,
    async () => { throw new Error('the idle probe prepares nothing'); }, { hostId: hostIdFor(engine) });
  return () => (consumer as unknown as { hasWork(): Promise<boolean> }).hasWork();
}

/** Admits one put_page request through the real admission path, as a CLI put does. */
async function admitPut(engine: BrainEngine, slug: string, requestId: string) {
  const source = await engine.readSourceMembership('default');
  const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source!.incarnation, slug);
  return admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source!.incarnation, slug, requestId, callerIntent: { body: slug }, intent: { body: slug } });
}

describe('engine parity: owner recovery scans', () => {
  parityTest('with no managed worktree, the owner recovery scans find nothing and leave a queued plain write unchanged', {
    methods: ['declarePersistence', 'transaction', 'readSourceMembership', 'insertWriteRequest', 'readWriteRequest'],
    timeout: 60_000,
  }, async (engine) => {
    await registerLocalWriter(engine, 'cli');
    const queued = await admitPut(engine, 'notes/parity-owner-scan', REQUEST);
    const host = hostIdFor(engine);
    const heads = await readOwnerRecoveryHeads(engine, engine, host, []);
    const refreshes = await resumeWorktreeRefreshes(engine, { hostId: host });
    const topologies = await recoverSourceTopologies(engine, { hostId: host });
    const expired = await expireDeferredWrites(engine, host);
    const after = await engine.readWriteRequest(queued.principal_kind, queued.principal_id, REQUEST);
    expect(after?.id).toBe(queued.id);
    return { heads: heads.length, refreshes, topologies, expired: expired.length, state: after?.state,
      unchanged: after?.updated_at === queued.updated_at };
  });

  parityTest('an idle owner probe answers idle on an empty journal and work once a plain write is queued', {
    methods: ['declarePersistence', 'transaction', 'readSourceMembership', 'insertWriteRequest'],
    timeout: 60_000,
  }, async (engine) => {
    await registerLocalWriter(engine, 'cli');
    const probe = idleProbe(engine);
    const before = await probe();
    await admitPut(engine, 'notes/parity-idle-probe', IDLE_REQUEST);
    const after = await probe();
    expect([before, after]).toEqual([false, true]);
    return { before, after };
  });
});
