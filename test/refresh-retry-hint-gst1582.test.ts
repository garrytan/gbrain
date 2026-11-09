/**
 * GST-1582: a write refused because `gbrain sources refresh` holds its checkout (`worktree_refreshing`, the barrier off or
 * a consumer without it) is told when to retry from the refresh's actual state, never a fixed 1 s, and the CLI says on
 * one line that nothing was saved and when to retry.
 *
 * Protects: `retry_after_ms` is the typical duration of the worktree's recent completed refreshes minus how long this one
 * has run, never below its phase's floor (syncing 15 s, the fenced phases 2 s), the same for a managed sync the refresh
 * refused; the message says the write was not saved and when to retry; the CLI's human output ends with one line that
 * says nothing was saved and when to retry, so it survives `| tail -1`.
 * Regression it catches: a refresh tick of several minutes answered "retry after retry_after_ms: 1000", so a caller that
 * obeyed retried inside the same tick, was refused again and gave up.
 * Seams: refresh rows inserted at a chosen age (the refresh state machine is not driven); the fence wait test seam.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { assertManagedSyncAllowed } from '../src/core/persistence/worktree-refresh.ts';
import { _setRefreshFenceWaitForTests } from '../src/core/persistence/admission-retry.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { page, setupRefreshFixture, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});
afterEach(() => _setRefreshFenceWaitForTests(null));

const each = (fn: (f: RefreshFixture) => Promise<void>) => withEnv({ GBRAIN_REFRESH_BARRIER: '0' }, async () => {
  for (const engine of engines) await withRefreshFixture(engine, fn);
});

/** Completed refreshes of the worktree that each took `seconds`, finished in the past hour. */
async function history(engine: BrainEngine, f: Pick<RefreshFixture, 'worktreeId' | 'alpha' | 'beta' | 'head'>, seconds: number[]): Promise<void> {
  const [w] = await engine.executeRaw<{ e: string }>('SELECT owner_epoch::text AS e FROM persistence_worktrees WHERE id=$1::uuid', [f.worktreeId]);
  const [b] = await engine.executeRaw<{ g: string }>('SELECT topology_generation::text AS g FROM persistence_source_bindings WHERE source_id=$1', [f.alpha]);
  for (const [i, s] of seconds.entries()) {
    await engine.executeRaw(`INSERT INTO persistence_worktree_refreshes (worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref,created_at,completed_at)
      VALUES($1::uuid,$2::text[],gen_random_uuid(),$3,$4,'completed',$5,$5,'origin/main',now()-(($6::integer+$7::integer)*interval '1 second'),now()-($7::integer*interval '1 second'))`,
    [f.worktreeId, [f.alpha, f.beta], w!.e, b!.g, f.head(), s, 600 + i * 900]);
  }
}
/** An active refresh in `state`, started `ageSeconds` ago, short of its target so it keeps the fence. */
async function activeRefresh(engine: BrainEngine, f: Pick<RefreshFixture, 'worktreeId' | 'alpha' | 'beta' | 'head' | 'push'>, state: string, ageSeconds: number): Promise<void> {
  const target = f.push('alpha/two.md', page('Alpha two', 'upstream'));
  const [w] = await engine.executeRaw<{ e: string }>('SELECT owner_epoch::text AS e FROM persistence_worktrees WHERE id=$1::uuid', [f.worktreeId]);
  const [b] = await engine.executeRaw<{ g: string }>('SELECT topology_generation::text AS g FROM persistence_source_bindings WHERE source_id=$1', [f.alpha]);
  await engine.executeRaw(`INSERT INTO persistence_worktree_refreshes (worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref,created_at)
    VALUES($1::uuid,$2::text[],gen_random_uuid(),$3,$4,$5,$6,$7,'origin/main',now()-($8::integer*interval '1 second'))`,
  [f.worktreeId, [f.alpha, f.beta], w!.e, b!.g, state, f.head(), target, ageSeconds]);
}
async function refused(f: RefreshFixture) {
  const result = await dispatchToolCall(f.engine, 'put_page', { slug: 'notes/refused', content: page('Refused', 'body') },
    { remote: true, transport: 'stdio', sourceId: f.alpha, admissionOrigin: 'interactive' });
  const body = JSON.parse(result.content[0]!.text) as Record<string, any>;
  expect(result.isError).toBe(true);
  expect(body.code).toBe('worktree_refreshing');
  return { body, retryAfterMs: Number(/^retry_after_ms=(\d+)$/.exec(String(body.detail))?.[1]) };
}

test('a write refused during a syncing refresh is told the time its refresh typically has left, not 1 s', () => each(async f => {
  _setRefreshFenceWaitForTests(0);
  await history(f.engine, f, [200, 240, 220]);
  await activeRefresh(f.engine, f, 'syncing', 20);
  const { body, retryAfterMs } = await refused(f);
  expect(retryAfterMs).toBeGreaterThanOrEqual(190_000);
  expect(retryAfterMs).toBeLessThanOrEqual(201_000);
  expect(body.message).toContain('not saved');
  expect(body.message).toMatch(/[Rr]etry the same request_id in about (19\d|200|201) s/);
  expect(body.message).not.toContain('\n');
}), 120_000);

test('with no refresh history, or past its typical duration, the hint is the phase floor, never 1 s', () => each(async f => {
  _setRefreshFenceWaitForTests(0);
  await activeRefresh(f.engine, f, 'syncing', 5);
  expect((await refused(f)).retryAfterMs).toBe(15_000);
  await f.engine.executeRaw("UPDATE persistence_worktree_refreshes SET state='fenced' WHERE state='syncing'");
  expect((await refused(f)).retryAfterMs).toBe(2_000);
  await history(f.engine, f, [3]);
  await f.engine.executeRaw("UPDATE persistence_worktree_refreshes SET state='syncing',created_at=now()-interval '60 seconds' WHERE state='fenced'");
  expect((await refused(f)).retryAfterMs).toBe(15_000);
}), 120_000);

test('a refresh that waited in recovery_required does not stretch the typical duration', () => each(async f => {
  _setRefreshFenceWaitForTests(0);
  await history(f.engine, f, [200, 240, 220, 7200, 7200, 7200, 7200]);
  await f.engine.executeRaw(`UPDATE persistence_worktree_refreshes SET outcome='{"refusal":{"code":"refresh_recovery_required"}}'::jsonb
    WHERE state='completed' AND completed_at-created_at>interval '1000 seconds'`);
  await activeRefresh(f.engine, f, 'syncing', 20);
  const { retryAfterMs } = await refused(f);
  expect(retryAfterMs).toBeGreaterThanOrEqual(190_000);
  expect(retryAfterMs).toBeLessThanOrEqual(201_000);
}), 120_000);

test('a managed sync the refresh refused gets the same derived hint', () => each(async f => {
  await history(f.engine, f, [120]);
  await activeRefresh(f.engine, f, 'fenced', 30);
  const error = await assertManagedSyncAllowed(f.engine, f.worktreeId, f.alpha).then(() => null, e => e as OperationError);
  expect(error?.code).toBe('worktree_refreshing');
  const hinted = Number(/^retry_after_ms=(\d+)$/.exec(String(error!.detail))?.[1]);
  expect(hinted).toBeGreaterThanOrEqual(85_000);
  expect(hinted).toBeLessThanOrEqual(91_000);
}), 120_000);

test('CLI text output ends with one line saying nothing was saved and when to retry', async () => {
  if (!backends.includes('pglite')) return;
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-gst1582-'));
  const home = join(dir, 'home');
  try {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const cfg = { engine: 'pglite' as const, database_path: join(home, '.gbrain', 'brain.pglite') };
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify(cfg));
    const alpha = await withEnv({ GBRAIN_HOME: home }, async () => {
      const engine = await createEngine(cfg);
      await engine.connect(cfg); await engine.initSchema();
      try {
        const f = await setupRefreshFixture(engine, dir);
        await history(engine, f, [200, 240, 220]);
        await activeRefresh(engine, f, 'syncing', 20);
        return f.alpha;
      } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    });
    const out = spawnSync('bun', ['run', 'src/cli.ts', 'put', 'notes/refused', '--source-id', alpha], { cwd: process.cwd(), encoding: 'utf8', input: page('Refused', 'body'), timeout: 120_000,
      env: { ...process.env, GBRAIN_HOME: home, DATABASE_URL: '', GBRAIN_DATABASE_URL: '', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_REFRESH_BARRIER: '0' } });
    expect(out.status).toBe(1);
    const last = out.stderr.trimEnd().split('\n').at(-1)!;
    expect(last).toMatch(/^Nothing was saved; retry the same command in about \d+ s \(retry_after_ms=\d+\)\.$/);
    expect(Number(/retry_after_ms=(\d+)/.exec(last)![1])).toBeGreaterThanOrEqual(150_000);
    expect(out.stderr).toContain('This write was not saved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 240_000);
