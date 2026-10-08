/**
 * #6278 R1: the `owner_unavailable` reasons matrix. One reason per owner
 * condition, in a fixed order; each with its message, `why`, actor, next
 * step and read-only verify; `host_mismatch` prints both host ids' first 8
 * characters and, for local callers only, the observed `host.json` path, and
 * is never retryable; the in-progress reasons render `next: wait`.
 * `maintenancePreflight` refuses every condition with its own reason and
 * never claims or transfers ownership to get past it; the HTTP envelope of
 * each refusal carries no local path.
 * Fails when: a condition loses its reason, falls back to the generic text,
 * leaks the identity path to a remote caller, or lets an agent retry a host
 * mismatch forever.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { cliRenderContext, deriveNext, toAgentError, type RenderContext } from '../src/core/agent-output.ts';
import { CODES } from '../src/core/error-registry.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { checkOwner, ownerRefusal, ownerUnavailableError, OWNER_UNAVAILABLE_REASONS, OWNER_WAIT_SECONDS, type OwnerUnavailableReason } from '../src/core/persistence/owner-refusal.ts';
import { claimWorktree, getWorktreeBinding, type WorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId, persistenceHome } from '../src/core/persistence/identity.ts';
import { maintenancePreflight } from '../src/core/persistence/prepared-maintenance.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { FENCE_REASONS } from '../src/core/fence-repair/reasons.ts';
import { fenceHoldStatus } from '../src/core/fence-repair/hold-fix.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const OWNER = 'aaaaaaaa-1111-4111-8111-111111111111', LOCAL = 'bbbbbbbb-2222-4222-8222-222222222222';
const INCARNATION = 'cccccccc-3333-4333-8333-333333333333';
const binding = (over: Partial<WorktreeBinding> = {}): WorktreeBinding => ({ worktree_id: randomUUID(), source_id: 'src', source_incarnation: INCARNATION, relative_path: '',
  topology_generation: 1, owner_host_id: LOCAL, owner_epoch: 1, state: 'active', local_path: '/srv/brain', coordination_path: '/srv/brain/.gbrain-coordination', ...over });
const http: RenderContext = { transport: 'http', surface: 'full', isCallable: () => false, preapproved: () => false, principal: 'client-example' };

describe('the matrix', () => {
  test('checks the conditions in one order and names the first that fails', () => {
    const at = (b: WorktreeBinding | null, incarnation = INCARNATION) => checkOwner(b, incarnation, LOCAL).reason;
    expect(at(null)).toBe('binding_missing');
    expect(at(binding({ owner_host_id: OWNER, state: 'draining' }), randomUUID())).toBe('incarnation_changed');
    expect(at(binding({ owner_host_id: OWNER, state: 'draining' }))).toBe('host_mismatch');
    expect(at(binding({ state: 'draining', local_path: null }))).toBe('transfer_in_progress');
    expect(at(binding({ state: 'recovering', local_path: null }))).toBe('clone_in_progress');
    expect(at(binding({ local_path: null, coordination_path: null }))).toBe('local_path_missing');
    expect(at(binding({ coordination_path: null }))).toBe('coordination_path_missing');
    const ok = checkOwner(binding(), INCARNATION, LOCAL);
    expect(ok.reason).toBeNull();
    if (ok.reason === null) expect(ok.binding.local_path).toBe('/srv/brain');
  });

  test('every reason is in the registry vocabulary, has a fence reason the hold routes as owner, and a read-only writer-status verify', () => {
    const registry = CODES.owner_unavailable.reasons!;
    for (const reason of OWNER_UNAVAILABLE_REASONS) {
      expect(registry).toContain(reason);
      const row = ownerRefusal({ sourceId: 'src', reason, binding: binding({ owner_host_id: OWNER }), incarnation: INCARNATION, hostId: LOCAL, remote: true, work: 'maintenance' });
      expect(row.fix.verify?.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'src', '--json']);
      expect(row.fix.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', 'src', '--json']);
      expect(row.fix.consent).toEqual([]);
      expect(row.why).toContain('never claims or transfers ownership');
      if (reason !== 'binding_missing') {
        expect(FENCE_REASONS[reason].actor).toBe('host_admin');
        expect(fenceHoldStatus({ reason: 'invalid_fence', fence_repair: { reason, tier: null, at: '2026-10-08T00:00:00Z', next_attempt_after: null } } as never).state).toBe('owner');
      }
    }
  });

  test('in-progress work is a wait with its delay; the rest is a host administrator decision; host_mismatch is never retryable', () => {
    const cli = cliRenderContext();
    const next = (reason: OwnerUnavailableReason) => deriveNext(ownerRefusal({ sourceId: 'src', reason, binding: binding(), incarnation: INCARNATION, hostId: LOCAL, remote: false, work: 'maintenance' }).fix, cli);
    expect(next('transfer_in_progress')).toBe('wait');
    expect(next('clone_in_progress')).toBe('wait');
    expect(ownerRefusal({ sourceId: 'src', reason: 'clone_in_progress', binding: binding(), incarnation: INCARNATION, hostId: LOCAL, remote: false, work: 'maintenance' }).fix.why).toContain(`Wait ${OWNER_WAIT_SECONDS} seconds`);
    for (const reason of ['host_mismatch', 'binding_missing', 'incarnation_changed', 'local_path_missing', 'coordination_path_missing'] as const) expect(next(reason)).toBe('tell_user_to_run');
    const retryable = Object.fromEntries(OWNER_UNAVAILABLE_REASONS.map(reason => [reason,
      ownerRefusal({ sourceId: 'src', reason, binding: binding(), incarnation: INCARNATION, hostId: LOCAL, remote: false, work: 'maintenance' }).retryable]));
    expect(retryable).toEqual({ host_mismatch: false, transfer_in_progress: true, clone_in_progress: true, binding_missing: false, incarnation_changed: false, coordination_path_missing: false, local_path_missing: false });
  });

  test('host_mismatch prints both ids\' first 8 characters, and the observed host.json path to local callers only', async () => {
    await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-owner-refusal-')) }, async () => {
      const path = join(persistenceHome(), 'host.json');
      const local = ownerUnavailableError({ sourceId: 'src', reason: 'host_mismatch', binding: binding({ owner_host_id: OWNER }), incarnation: INCARNATION, hostId: LOCAL, remote: false, work: 'fence repair' });
      expect(local.message).toContain('aaaaaaaa'); expect(local.message).toContain('bbbbbbbb');
      expect(local.message).not.toContain(OWNER); expect(local.message).not.toContain(LOCAL);
      expect(local.why).toContain(path);
      expect(local.reason).toBe('host_mismatch');
      expect(local.retryable).toBe(false);
      const envelope = toAgentError(local, { transport: 'cli', command: 'repair', render: cliRenderContext() });
      expect(envelope).toMatchObject({ code: 'owner_unavailable', reason: 'host_mismatch', class: 'retryable', retryable: false, fix: { next: 'tell_user_to_run', actor: 'host_admin' } });
      const remote = ownerUnavailableError({ sourceId: 'src', reason: 'host_mismatch', binding: binding({ owner_host_id: OWNER }), incarnation: INCARNATION, hostId: LOCAL, remote: true, work: 'fence repair' });
      const rendered = JSON.stringify(toAgentError(remote, { transport: 'http', op: 'chronicle_day', render: http }));
      expect(rendered).not.toContain(path); expect(rendered).not.toContain(persistenceHome()); expect(rendered).not.toContain('read its identity from');
      expect(rendered).toContain('aaaaaaaa'); expect(rendered).toContain('bbbbbbbb');
      expect(JSON.parse(rendered)).toMatchObject({ reason: 'host_mismatch', retryable: false });
      // The in-progress reasons keep the code's retryable class.
      const wait = toAgentError(ownerUnavailableError({ sourceId: 'src', reason: 'transfer_in_progress', binding: binding({ state: 'draining' }), incarnation: INCARNATION, hostId: LOCAL, remote: false, work: 'maintenance' }),
        { transport: 'cli', command: 'chronicle', render: cliRenderContext() });
      expect(wait).toMatchObject({ reason: 'transfer_in_progress', retryable: true, fix: { next: 'wait' } });
    });
  });
});

describe('maintenancePreflight', () => {
  const backends = testBackends();
  const engines: BrainEngine[] = [];
  let closePostgres: (() => Promise<void>) | undefined;
  const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-owner-preflight-'));

  beforeAll(async () => {
    if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({ database_path: join(dataDir, 'pglite') }); await engine.initSchema(); engines.push(engine); }
    if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.(); rmSync(dataDir, { recursive: true, force: true });
  });

  async function topology(engine: BrainEngine, sql: string, params: unknown[]) {
    await engine.transaction(async tx => { await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)"); await tx.executeRaw(sql, params); });
  }

  async function fixture(run: (engine: BrainEngine, sourceId: string, root: string) => Promise<void>) {
    for (const engine of engines) {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-preflight-src-'));
      const root = join(dir, 'brain'); mkdirSync(root);
      const sourceId = `owner-${randomUUID().slice(0, 8)}`;
      try {
        await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
          await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
          await engine.setConfig('sync.write_through', 'true');
          await claimWorktree(engine, sourceId, root);
          await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
          await run(engine, sourceId, root);
        });
      } finally {
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  const refusal = async (engine: BrainEngine, sourceId: string): Promise<OperationError> => {
    try { await maintenancePreflight(engine, sourceId); } catch (error) { if (error instanceof OperationError) return error; throw error; }
    throw new Error('preflight did not refuse');
  };

  test('each owner condition refuses owner_unavailable with its own reason, never claims ownership, and the remote envelope carries no local path', () => fixture(async (engine, sourceId) => {
    const before = (await getWorktreeBinding(engine, sourceId))!;
    const worktree = before.worktree_id;
    expect(await maintenancePreflight(engine, sourceId)).toMatchObject({ binding: { worktree_id: worktree } });
    const stranger = randomUUID();
    const seen: Record<string, OperationError> = {};
    await topology(engine, 'UPDATE persistence_worktrees SET owner_host_id=$2::uuid WHERE id=$1::uuid', [worktree, stranger]);
    seen.host_mismatch = await refusal(engine, sourceId);
    await topology(engine, 'UPDATE persistence_worktrees SET owner_host_id=$2::uuid, state=$3 WHERE id=$1::uuid', [worktree, localHostId(), 'draining']);
    seen.transfer_in_progress = await refusal(engine, sourceId);
    await topology(engine, 'UPDATE persistence_worktrees SET state=$2 WHERE id=$1::uuid', [worktree, 'recovering']);
    seen.clone_in_progress = await refusal(engine, sourceId);
    await topology(engine, 'UPDATE persistence_worktrees SET state=$2 WHERE id=$1::uuid', [worktree, 'active']);
    await topology(engine, "UPDATE persistence_host_bindings SET coordination_path='' WHERE worktree_id=$1::uuid", [worktree]);
    seen.coordination_path_missing = await refusal(engine, sourceId);
    await topology(engine, 'DELETE FROM persistence_host_bindings WHERE worktree_id=$1::uuid', [worktree]);
    seen.local_path_missing = await refusal(engine, sourceId);
    await topology(engine, 'INSERT INTO persistence_host_bindings(worktree_id,host_id,local_path,coordination_path) VALUES($1::uuid,$2::uuid,$3,$4)',
      [worktree, localHostId(), before.local_path, before.coordination_path]);
    await topology(engine, 'UPDATE persistence_source_bindings SET source_incarnation=$2::uuid WHERE source_id=$1', [sourceId, randomUUID()]);
    seen.incarnation_changed = await refusal(engine, sourceId);
    await topology(engine, 'DELETE FROM persistence_source_bindings WHERE source_id=$1', [sourceId]);
    seen.binding_missing = await refusal(engine, sourceId);
    for (const [reason, error] of Object.entries(seen)) {
      expect([reason, error.code, error.reason]).toEqual([reason, 'owner_unavailable', reason]);
      expect(error.fix?.argv).toEqual(['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json']);
      expect(error.why).toContain('never claims or transfers ownership');
      const remote = JSON.stringify(toAgentError(error, { transport: 'http', op: 'chronicle_day', render: http }));
      expect(remote).not.toContain(persistenceHome());
    }
    expect(seen.host_mismatch!.message).toContain(stranger.slice(0, 8));
    expect(seen.host_mismatch!.message).toContain(localHostId().slice(0, 8));
    expect(seen.host_mismatch!.why).toContain(join(persistenceHome(), 'host.json'));
    expect(seen.host_mismatch!.retryable).toBe(false);
    expect(seen.transfer_in_progress!.fix?.actor).toBe('provider');
    expect(seen.clone_in_progress!.fix?.actor).toBe('provider');
    // Nothing above claimed or transferred: the worktree still has no source binding and the stranger's host id never became this host's.
    expect(await getWorktreeBinding(engine, sourceId)).toBeNull();
    const [row] = await engine.executeRaw<{ owner_host_id: string; state: string }>('SELECT owner_host_id,state FROM persistence_worktrees WHERE id=$1::uuid', [worktree]);
    expect(row).toMatchObject({ owner_host_id: localHostId(), state: 'active' });
  }), 60_000);
});
