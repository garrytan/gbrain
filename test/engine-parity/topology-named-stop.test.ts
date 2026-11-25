/**
 * BrainEngine parity: the owner's topology recovery (topology-recovery.ts `recoverSourceTopologies`) and the managed
 * clone (topology-clone.ts `runManagedSourceClone`, reached by `sources add --url` and `sources reclone`) on the Rust
 * engine. Both used to stop by name on an engine without `raw_sql` (`source_topology_recovery`, `managed_source_clone`);
 * they now run on the typed topology store, so no step refuses by name and the file keeps its name for the history.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: with the managed hold lifted on the Rust test engine, a recovering change on this host is reached by the
 *    recovery scan under its topology locks: a change whose record is not a clone's is retained, exactly as recorded
 *    (the scan finishes nothing and moves nothing), and the status read lists it with no stop. A clone and a reclone run
 *    their own checks, register nothing and leave no staging directory when they refuse. Equal on every arm.
 *  - Regression: on the Rust engine the scan and the clone refused `engine_capability_missing` with `member=
 *    source_topology_recovery` / `managed_source_clone`; that refusal must be gone, not reworded.
 *  - Why existing coverage misses it: managed-recovery-on-rust.test.ts finishes real clones; this file pins the refusals
 *    and the retained change the scan leaves, which no clone run reaches.
 *  - Seam: none. The real scan, lifecycle and typed members; the clone remote is a closed local port, so the clone fails
 *    its URL check on every arm without the network.
 */
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { liftManagedHold } from './rust-managed.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { bigintToStringReplacer } from '../../src/core/utils.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runManagedSourceLifecycle } from '../../src/core/persistence/source-lifecycle.ts';
import { recoverSourceTopologies } from '../../src/core/persistence/topology-recovery.ts';
import { readTopologyRecoveryStops } from '../../src/core/persistence/topology-stop.ts';

const { parityTest } = parityArms(testBackends());

const RECOVERY = 'd0000000-0000-4000-8000-0000000000f1';
const WRITER = 'd0000000-0000-4000-8000-0000000000f2';
/** A closed local port: the SQL arms' clone fails at once, without DNS or the network. */
const CLOSED_REMOTE = 'https://127.0.0.1:9/none.git';

/** Runs `run` under a scratch GBRAIN_HOME with a plain checkout registered as source `work`. */
async function withCheckout<T>(engine: BrainEngine, backend: ParityBackend, run: (home: string, root: string) => Promise<T>): Promise<T> {
  if (backend === 'rust') liftManagedHold(engine);
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

describe('engine parity: topology recovery and the managed clone on the Rust engine', () => {
  parityTest('the owner topology recovery retains a change whose record is no clone, exactly as recorded', {
    methods: ['worktreeClaimStore', 'getWorktreeBinding', 'readLedgerSource', 'insertTopologyChange', 'listTopologyRecoveries'],
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
    const recovered = await recoverSourceTopologies(engine, { hostId: host });
    const after = await engine.listTopologyRecoveries(host, null, 16);
    const stops = await readTopologyRecoveryStops(engine, host);
    const listed = stops.recovering.map(row => ({ source: row.source_id, operation: row.operation, stop: row.stop }));
    const out = { recovered, unchanged: text(after) === before, recovering: after.map(row => ({ source: row.source_id, state: row.state })), listed, stop: stops.stop };
    expect(out).toEqual({ recovered: 0, unchanged: true, recovering: [{ source: 'work', state: 'recovering' }], listed: [{ source: 'work', operation: 'writer_claim', stop: null }], stop: null });
    return out;
  }));

  parityTest('a managed clone and reclone run their own checks, and a refusal registers nothing and leaves no directory', {
    methods: ['readSourceMembership', 'listTopologyRecoveries'],
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
    const out = { add: code(add), reclone: code(reclone), left };
    // The refusal is the clone's own (the URL check, the unmanaged checkout), never a capability stop.
    expect(out.add).not.toBe('engine_capability_missing');
    expect(out.reclone).not.toBe('engine_capability_missing');
    return out;
  }));
});
