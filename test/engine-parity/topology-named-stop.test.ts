/**
 * BrainEngine parity: the Rust stops for source topology changes. The owner's topology recovery
 * (topology-recovery.ts `recoverSourceTopologies`) still locks through raw SQL and refuses by name
 * (persistence/topology-stop.ts). The managed clone (topology-clone.ts `runManagedSourceClone`, reached by
 * `sources add --url` and `sources reclone`) reads, locks and writes through the typed `topologyStore` member, so it
 * commits on every engine.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite and Postgres the recovery scan reaches a recovering change under its topology locks and the
 *    clone runs its own checks; both arms agree. On the Rust engine the recovery scan refuses by name
 *    (`member=source_topology_recovery`, capability raw_sql, written=nothing) before any lock, and the typed status
 *    read (`readTopologyRecoveryStops`) names the stop for the change. A managed clone commits on every engine: the
 *    checkout is at its target with no staging directory left, the source is registered and bound to the clone's
 *    worktree, no change is recovering, and the receipt says `cloned`. Before its first write every engine
 *    runs the same checks: a loopback remote refuses `internal_target` and a reclone of a source this host does not
 *    own refuses `owner_unavailable`, with no lock or directory taken.
 *  - Regression: on the Rust engine the recovery scan reached topology-locks.ts `withTopologyLocks` and the clone its
 *    first raw read (topology-clone.ts), so each refused as the generic `member=executeRaw` before its own checks; doctor
 *    and status could not say why a recovering change never converged; then the clone stopped at its first
 *    clone-transaction write (the `persistence_worktrees` INSERT). Case 3 pins that the clone now commits there too.
 *  - Why existing coverage misses it: owner-recovery-scans.test.ts runs the scan with no recovering change, and
 *    journal-typed-sites.test.ts lists a recovering change without running the scan.
 *  - Seam: case 3 passes the `hooks.clone` seam (a local bare repository) instead of a network clone. Cases 1 and 2
 *    use the real scan and lifecycle.
 */
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { bigintToStringReplacer } from '../../src/core/utils.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runManagedSourceLifecycle } from '../../src/core/persistence/source-lifecycle.ts';
import { runManagedSourceClone } from '../../src/core/persistence/topology-clone.ts';
import { topologyPrincipal } from '../../src/core/persistence/topology-locks.ts';
import { largeBareRepository } from '../helpers/large-worktree.ts';
import { execFileSync } from 'node:child_process';
import { recoverSourceTopologies } from '../../src/core/persistence/topology-recovery.ts';
import { readTopologyRecoveryStops } from '../../src/core/persistence/topology-stop.ts';

const { parityTest } = parityArms(testBackends());

const RECOVERY = 'd0000000-0000-4000-8000-0000000000f1';
const WRITER = 'd0000000-0000-4000-8000-0000000000f2';
/** A loopback remote: every engine refuses it as an internal target before any lock, without DNS or the network. */
const CLOSED_REMOTE = 'https://127.0.0.1:9/none.git';

/** Runs `run` under a scratch GBRAIN_HOME with a plain checkout registered as source `work`. */
async function withCheckout<T>(engine: BrainEngine, backend: ParityBackend, run: (home: string, root: string) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-topology-stop-parity-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const root = join(home, 'checkout');
      await Bun.write(join(root, 'example.md'), 'generic example');
      await createSource(engine, backend, 'work', {}, root);
      try { return await run(home, root); } finally { await disposePersistenceConsumer(engine); }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** The refusal `run` threw, or null when it returned. */
async function caught(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(() => null, (error: unknown) => error);
}

/** The code and the named member of a capability refusal, as the Rust arm must report it. */
function named(error: unknown): { code: unknown; member: string | null; written: string | null } {
  const e = error as { code?: unknown; detail?: unknown } | null;
  const detail = typeof e?.detail === 'string' ? e.detail : '';
  return { code: e?.code, member: /member=(\w+)/.exec(detail)?.[1] ?? null, written: /written=(\w+)/.exec(detail)?.[1] ?? null };
}

describe('engine parity: the named Rust stop for source topology changes', () => {
  parityTest('the owner topology recovery stops by name on Rust before any lock, and leaves the recovering change as recorded', {
    methods: ['worktreeClaimStore', 'getWorktreeBinding', 'readLedgerSource', 'insertTopologyChange', 'listTopologyRecoveries'],
    requires: 'raw_sql',
    timeout: 60_000,
  }, async (engine, backend) => withCheckout(engine, backend, async (_home, root) => {
    await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, admin_intent: 'writer_claim', expected_state: await writerAdminState(engine) });
    const host = localHostId();
    const worktree = (await engine.getWorktreeBinding('work', host))!.worktree_id;
    const source = await engine.readLedgerSource('work');
    await engine.insertTopologyChange({ principalId: WRITER, requestId: RECOVERY, digest: 'e'.repeat(64), operation: 'writer_claim',
      sourceId: 'work', sourceIncarnation: source!.incarnation, worktreeIds: [worktree], state: 'recovering', recovery: { worktreeId: worktree, step: 1 },
      recoveryBytes: 12, intentBytes: 34, terminalBytes: 4096, outcome: null });
    const text = (rows: unknown) => JSON.stringify(rows, bigintToStringReplacer);
    const before = text(await engine.listTopologyRecoveries(host, null, 16));
    let recovered: number | null = null;
    const refusal = await caught(async () => { recovered = await recoverSourceTopologies(engine, { hostId: host }); });
    const after = await engine.listTopologyRecoveries(host, null, 16);
    const stops = await readTopologyRecoveryStops(engine, host);
    const listed = stops.recovering.map(row => ({ source: row.source_id, operation: row.operation, stop: row.stop }));
    if (backend === 'rust') {
      expect({ refusal: named(refusal), unchanged: text(after) === before, listed, stop: stops.stop }).toEqual({
        refusal: { code: 'engine_capability_missing', member: 'source_topology_recovery', written: 'nothing' }, unchanged: true,
        listed: [{ source: 'work', operation: 'writer_claim', stop: 'source_topology_recovery' }], stop: 'source_topology_recovery' });
      throw refusal;
    }
    if (refusal) throw refusal;
    expect({ listed, stop: stops.stop }).toEqual({ listed: after.map(() => ({ source: 'work', operation: 'writer_claim', stop: null })), stop: null });
    return { recovered, recovering: after.map(row => ({ source: row.source_id, state: row.state })), listed };
  }));

  parityTest('a clone from an internal remote and a reclone off the owner refuse before any lock or directory on every engine, and register nothing', {
    methods: ['topologyStore', 'readSourceMembership', 'listTopologyRecoveries'],
    timeout: 60_000,
  }, async (engine, backend) => withCheckout(engine, backend, async (home) => {
    await registerLocalWriter(engine, 'cli');
    const target = join(home, 'cloned');
    const add = await caught(() => runManagedSourceLifecycle(engine, { operation: 'add', sourceId: 'cloned', remoteUrl: CLOSED_REMOTE, path: target }));
    const reclone = await caught(() => runManagedSourceLifecycle(engine, { operation: 'reclone', sourceId: 'work' }));
    const left = { target: existsSync(target), staging: readdirSync(home).filter(name => name.startsWith('.gbrain-clone-') || name.includes('.gbrain-old-')),
      registered: (await engine.readSourceMembership('cloned')) !== null, recovering: (await engine.listTopologyRecoveries(localHostId(), null, 16)).length };
    expect(left).toEqual({ target: false, staging: [], registered: false, recovering: 0 });
    const code = (error: unknown) => (error as { code?: unknown } | null)?.code ?? null;
    return { add: code(add), reclone: code(reclone), left };
  }));

  parityTest('a managed clone commits the same source, checkout and receipt on every engine', {
    methods: ['topologyStore', 'addPersistenceCounters', 'readSourceMembership', 'listTopologyRecoveries'],
    timeout: 60_000,
  }, async (engine, backend) => withCheckout(engine, backend, async (home) => {
    await registerLocalWriter(engine, 'cli');
    const bare = largeBareRepository(home, 3);
    const target = join(home, 'cloned');
    const clone = async (_url: string, stage: string) => { execFileSync('git', ['clone', '--quiet', bare, stage], { stdio: ['ignore', 'ignore', 'pipe'] }); };
    const add = { operation: 'add' as const, sourceId: 'cloned', path: target, remoteUrl: 'https://example.invalid/example.git', requestId: RECOVERY };
    const result = await runManagedSourceClone(engine, add, await topologyPrincipal(engine), add.requestId, { ...add, requestId: undefined }, { clone });
    const binding = await engine.getWorktreeBinding('cloned', localHostId());
    const left = { target: existsSync(target), staging: readdirSync(home).filter(name => name.startsWith('.gbrain-clone-') || name.includes('.gbrain-old-')),
      registered: (await engine.readSourceMembership('cloned')) !== null, recovering: (await engine.listTopologyRecoveries(localHostId(), null, 16)).length,
      bound: binding ? { local_path: binding.local_path === target, state: binding.state, generation: String(binding.topology_generation) } : null };
    expect(left).toMatchObject({ target: true, staging: [], registered: true, recovering: 0 });
    return { state: result.state, cloned: result.cloned, local_path: result.local_path === target, left };
  }));
});
