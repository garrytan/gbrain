/**
 * The managed_persistence hold on the recovery paths of a user's Rust brain (store-capabilities.ts HELD_FOR_CALLERS,
 * store-members/managed-hold.ts, persistence/topology-stop.ts).
 *
 * Lane LM typed the managed clone, the owner's topology recovery, the owner facts and the parked-push retry. A user's Rust
 * brain reports neither `managed_persistence` nor `raw_sql`, so with the hold ON each of those steps must refuse exactly as it
 * did before they were typed: the clone and the recovery by their own names (`managed_source_clone`,
 * `source_topology_recovery`, capability raw_sql), the `--pat-file` retry by its own name, the owner facts through the
 * engine's executeRaw, and the claim-owner list must answer as before (claims on no worktree only). Each refusal comes
 * before any principal, path, filesystem, credential or git clone side effect, and the store, the checkout and the home
 * directory are unchanged.
 *
 * Slice 2 lifted the hold: a single-host Rust engine reports `managed_persistence`. This file takes the capability off its
 * own engine instance, as a build that does not serve managed mode reports it, so each refusal is the managed gate's own and
 * every step must still refuse exactly as it did while the hold was on. Managed mode on a multi-user Rust store waits for
 * the multi-user branch (slice 3).
 *
 * Needs the Rust addon: runs with GBRAIN_TEST_RUST_ARM=1 (as the Rust CI job does), and is skipped otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openRustBrain, removeBrainDir, rustArmRequested, createRustSource, type RustBrainDir } from './engine-parity/rust-arm.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { recoverSourceTopologies } from '../src/core/persistence/topology-recovery.ts';
import { readTopologyRecoveryStops } from '../src/core/persistence/topology-stop.ts';
import { ownerActivity } from '../src/core/persistence/owner-activity.ts';
import { admitWrite, claimNextLaneHead, claimNextWrite, reclaimReleasedWrite } from '../src/core/persistence/journal.ts';
import { claimAndRecoverEffect } from '../src/core/persistence/effects.ts';
import { ownerHostStaleCheck } from '../src/commands/doctor/checks/owner-host-stale.ts';
import { hostIdFor, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { bigintToStringReplacer } from '../src/core/utils.ts';

const refusal = (run: () => Promise<unknown>) => run().then(() => null, (e: { code?: string; detail?: unknown }) => ({
  code: e?.code ?? String(e), member: /member=(.+?) capability=/.exec(String(e?.detail ?? ''))?.[1]?.split(' (')[0] ?? null, capability: /capability=(\w+)/.exec(String(e?.detail ?? ''))?.[1] ?? null,
  written: /written=(\w+)/.exec(String(e?.detail ?? ''))?.[1] ?? null }));
const stop = (member: string) => ({ code: 'engine_capability_missing', member, capability: 'raw_sql', written: 'nothing' });
const RAW = { code: 'engine_capability_missing', member: 'executeRaw', capability: 'raw_sql', written: 'nothing' };
const REMOTE = 'https://example.invalid/brain.git';
const CHANGE = 'd0000000-0000-4000-8000-0000000000f1';
const WRITER = 'd0000000-0000-4000-8000-0000000000f2';

describe.skipIf(!rustArmRequested())('a Rust brain without managed_persistence keeps refusing the recovery paths (hold on)', () => {
  let brain: RustBrainDir;
  let engine: BrainEngine;
  let home: string;
  beforeAll(async () => {
    brain = await openRustBrain();
    // The capability a build that does not serve managed mode lacks, taken off this engine instance.
    (brain.engine.capabilities as Set<string>).delete('managed_persistence');
    engine = brain.engine as unknown as BrainEngine;
    home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-rust-recovery-hold-')));
  }, 60_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
    removeBrainDir(brain.dir);
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  test('the clone, the recovery scan, the --pat-file retry and the owner facts refuse as before; nothing changed', () =>
    withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => {
      expect(engine.capabilities.has('managed_persistence')).toBe(false);
      expect(engine.capabilities.has('raw_sql')).toBe(false);
      const root = join(home, 'checkout');
      mkdirSync(join(root, 'notes'), { recursive: true });
      execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
      writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
      execFileSync('git', ['-C', root, 'add', '.']);
      execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes']);
      const remote = join(home, 'remote.git');
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
      execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
      execFileSync('git', ['-C', root, 'push', '-q', '-u', 'origin', 'main']);
      await createRustSource(engine, 'work', {}, root);
      const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
      const host = hostIdFor(engine);
      const binding = (await engine.getWorktreeBinding('work', host))!;
      const source = await engine.readLedgerSource('work');
      // A change recovering on this host, as a crash would leave it.
      await engine.insertTopologyChange({ principalId: WRITER, requestId: CHANGE, digest: 'e'.repeat(64), operation: 'writer_claim', sourceId: 'work',
        sourceIncarnation: source!.incarnation, worktreeIds: [binding.worktree_id], state: 'recovering', recovery: { worktreeId: binding.worktree_id, step: 1 },
        recoveryBytes: 12, intentBytes: 34, terminalBytes: 4096, outcome: null });
      const token = join(home, 'token');
      writeFileSync(token, 'ghp_exampleexampleexample\n', { mode: 0o600 });

      const text = (rows: unknown) => JSON.stringify(rows, bigintToStringReplacer);
      const snapshot = async () => ({ source: await engine.readSourceMembership('work'), cloned: await engine.readSourceMembership('cloned'),
        recoveries: text(await engine.listTopologyRecoveries(host, null, 16)), notes: readdirSync(join(root, 'notes')).sort(), home: readdirSync(home).sort(),
        gitConfig: readFileSync(join(root, '.git', 'config'), 'utf8'), credentials: existsSync(join(home, 'git-credentials')) });
      const before = await snapshot();

      const target = join(home, 'cloned');
      const out = {
        add: await refusal(() => runManagedSourceLifecycle(engine, { operation: 'add', sourceId: 'cloned', remoteUrl: REMOTE, path: target })),
        reclone: await refusal(() => runManagedSourceLifecycle(engine, { operation: 'reclone', sourceId: 'work' })),
        recovery: await refusal(() => recoverSourceTopologies(engine, { hostId: host })),
        patFile: await refusal(async () => runPersistenceAdministration(engine, 'writer_git_durability', { source_id: 'work', pat_file: token, ...await reviewed('writer_git_durability') })),
        ownerFacts: await refusal(() => ownerActivity(engine, [binding.worktree_id])),
        stores: await Promise.all([
          refusal(async () => (await engine.topologyStore()).readChange(CHANGE)),
          refusal(async () => (await engine.topologyStore()).ownerActivity([binding.worktree_id], 1000)),
          refusal(async () => (await engine.gitDurabilityStore()).parkedPushRequests(binding.worktree_id, ['git_push_unavailable'])),
          refusal(async () => (await engine.gitDurabilityStore()).requeueParkedEffect('1', {}, null)),
        ]),
      };
      expect(out).toEqual({ add: stop('managed_source_clone'), reclone: stop('managed_source_clone'), recovery: stop('source_topology_recovery'),
        patFile: stop('writer git-durability --pat-file'), ownerFacts: RAW, stores: [RAW, RAW, RAW, RAW] });
      // The clone refused before its principal, path and filesystem steps: no writer was registered for it, no directory exists.
      expect(existsSync(target)).toBe(false);
      expect(await snapshot()).toEqual(before);
      expect(before.recoveries).toContain('"state":"recovering"');

      // Writer status still names the stop for the recovering change.
      const status = await readTopologyRecoveryStops(engine, host);
      expect({ listed: status.recovering.map(row => ({ source: row.source_id, operation: row.operation, stop: row.stop })), stop: status.stop })
        .toEqual({ listed: [{ source: 'work', operation: 'writer_claim', stop: 'source_topology_recovery' }], stop: 'source_topology_recovery' });
    }), 120_000);

  test('the lane head claim, the reclaim, the effect recovery claim and the owner_host_stale read answer as before; nothing changed', () =>
    withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      expect(engine.capabilities.has('managed_persistence')).toBe(false);
      const host = hostIdFor(engine);
      const WORKTREE = 'd0000000-0000-4000-8000-0000000000f3';
      const REQUEST_ROW = 'd0000000-0000-4000-8000-0000000000f4';
      const stamp = { id: REQUEST_ROW, token: 'd0000000-0000-4000-8000-0000000000f5', leaseMs: 30_000, phaseJson: '{"phase":"preparing"}' };
      const before = { owners: await engine.listRunningClaimOwners(host), source: await engine.readSourceMembership('work') };
      const out = {
        // The three claim statements each went through executeRaw: the callers and the members refuse by it, before any read or write.
        laneHead: await refusal(() => claimNextLaneHead(engine, host, WORKTREE, 'run-a', 30_000, null)),
        reclaim: await refusal(() => reclaimReleasedWrite(engine, REQUEST_ROW)),
        members: await Promise.all([
          refusal(() => engine.selectClaimableLaneHead({ hostId: host, worktreeId: WORKTREE, run: 'run-a', seenSequence: null, nonce: 'n', priority: null })),
          refusal(() => engine.stampLaneHeadClaim(stamp)),
          refusal(() => engine.reclaimReleasedWrite(stamp)),
          refusal(() => engine.claimEffectRecovery({ id: '1', token: stamp.token, ownerJson: '{}' })),
        ]),
        // claimAndRecoverEffect has always answered a refused claim as no claim.
        effect: (await claimAndRecoverEffect(engine, 1, host)) ?? null,
      };
      expect(out).toEqual({ laneHead: RAW, reclaim: RAW, members: [RAW, RAW, RAW, RAW], effect: null });
      // owner_host_stale still skips by name (nothing can wait on a worktree while the hold is on), and says it is not a pass.
      expect(await ownerHostStaleCheck(engine)).toMatchObject({ name: 'owner_host_stale', status: 'ok', details: { outcome: 'skipped', reason: 'raw_sql', count: 'unknown' } });
      expect({ owners: await engine.listRunningClaimOwners(host), source: await engine.readSourceMembership('work') }).toEqual(before);
    }), 120_000);

  test('the claim-owner list answers as before: the claims on no worktree', () =>
    withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await registerLocalWriter(engine, 'cli');
      const host = hostIdFor(engine);
      expect(await engine.listRunningClaimOwners(host)).toEqual([]);
      const defaultSource = await engine.readSourceMembership('default');
      const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } } as OperationContext;
      const authority = await submissionAuthority(ctx, 'put_page', 'default', defaultSource!.incarnation, 'notes/claimed');
      await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: defaultSource!.incarnation,
        slug: 'notes/claimed', requestId: 'c0000000-0000-4000-8000-0000000000c9', callerIntent: { body: 'x' }, intent: { body: 'x' } });
      const claimed = await claimNextWrite(engine, host, 60_000);
      expect(claimed?.state).toBe('running');
      const owners = await engine.listRunningClaimOwners(host);
      expect(owners.map(row => ({ source: row.source_id, hasOwner: row.owner !== null && typeof row.owner === 'object', lapsed: row.lapsed })))
        .toEqual([{ source: 'default', hasOwner: true, lapsed: false }]);
    }), 120_000);
});
