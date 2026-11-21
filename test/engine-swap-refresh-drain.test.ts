/**
 * Refresh drain before an engine swap (docs/designs/RUST_ENGINE.md row L7-1, TODOS rust-swap-refresh-drain).
 *
 * Authoring gate (docs/TESTING.md): (1) protects every brain an opt-in swap to Rust would carry: the Rust engine resumes
 * no worktree refresh, so a carried draining, fenced, merged, syncing or recovery_required row would fence its sources
 * for good with no resume, refusal or log. (2) Fails when `gbrain engine swap --to rust --plan` reads a readiness
 * criterion, or shows a plan, while such a row exists, or when the refusal loses its reason, row list or fix. (3) No
 * existing test covers the swap (S5a adds the command). (4) No seam: a real PGLite brain (Postgres too when
 * DATABASE_URL is set) and the real command; only the shadow status reader is injected, to prove it is never called.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { runEngineSwap } from '../src/commands/engine-swap.ts';
import { ACTIVE_REFRESH_STATES } from '../src/core/persistence/worktree-refresh-schema.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const ARGS = ['--to', 'rust', '--plan', '--json'];

interface Run { code: number; stdout: string; error: string; statusReads: number }

async function swapPlan(engine: BrainEngine): Promise<Run> {
  let stdout = '';
  let error = '';
  let statusReads = 0;
  const code = await runEngineSwap(ARGS, {
    openEngine: async () => Object.assign(Object.create(engine), { disconnect: async () => undefined }) as BrainEngine,
    readShadowStatus: async () => { statusReads++; return null; }, resolveBrain: () => 'host',
    env: {}, home: '', now: new Date('2026-11-21T00:00:00Z'),
    out: t => { stdout += t; },
    writeError: (e, o) => { const r = renderCliError(e, { json: o.json, command: 'engine swap', tty: false }); error = r.stdout ?? r.stderr ?? ''; return r.exitCode; },
  });
  return { code, stdout, error, statusReads };
}

async function addRefresh(engine: BrainEngine, state: string): Promise<{ id: string; worktree: string }> {
  const [wt] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees(owner_host_id) VALUES(gen_random_uuid()) RETURNING id::text AS id');
  const [row] = await engine.executeRaw<{ id: string }>(
    `INSERT INTO persistence_worktree_refreshes (worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref)
     VALUES ($1::uuid,ARRAY['default'],gen_random_uuid(),1,1,$2,'a','b','origin/main') RETURNING id::text AS id`, [wt!.id, state]);
  return { id: row!.id, worktree: wt!.id };
}

for (const kind of testBackends()) {
describe(`engine swap refuses a brain with an unfinished worktree refresh (L7-1, ${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const e = new PGLiteEngine(); await e.connect({}); await e.initSchema(); engine = e; close = () => e.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close(); });
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM persistence_worktree_refreshes');
  });

  test('a fenced refresh refuses the plan with the full refusal, before any criterion is read', async () => {
    const { id } = await addRefresh(engine, 'fenced');
    const run = await swapPlan(engine);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('');
    expect(run.statusReads).toBe(0);
    const env = JSON.parse(run.error);
    expect(env.code).toBe('engine_swap_refused');
    expect(env.reason).toBe('refresh_unsettled');
    expect(env.message).toBe(`The swap is refused: 1 worktree refresh row(s) are unfinished (${id} (fenced; sources default)).`);
    expect(env.why).toBe(`1 worktree refresh row(s) are not finished: ${id} (fenced; sources default). The Rust engine does not resume a worktree refresh, so a row carried into a Rust store would fence its sources with no resume and no log. Finish or abandon each refresh first, as the write journal is drained first.`);
    expect(env.docs).toBe('https://github.com/garrytan/gbrain/blob/master/docs/guides/engine-swap.md#refresh_unsettled');
    expect(env.fix.argv).toEqual(['gbrain', 'sources', 'refresh', 'default', '--resume']);
    expect(env.fix.verify.argv).toEqual(['gbrain', 'engine', 'swap', '--to', 'rust', '--plan', '--json']);
  });

  test('the human-readable refusal says what to do', async () => {
    const { id } = await addRefresh(engine, 'recovery_required');
    let text = '';
    const code = await runEngineSwap(['--to', 'rust', '--plan'], {
      openEngine: async () => Object.assign(Object.create(engine), { disconnect: async () => undefined }) as BrainEngine,
      env: {}, home: '', out: () => undefined, resolveBrain: () => 'host',
      writeError: (e, o) => { const r = renderCliError(e, { json: o.json, command: 'engine swap', tty: false }); text = r.stderr ?? ''; return r.exitCode; },
    });
    expect(code).toBe(1);
    expect(text).toContain(`Error [engine_swap_refused]: The swap is refused: 1 worktree refresh row(s) are unfinished (${id} (recovery_required; sources default)).`);
    expect(text).toContain('Fix: gbrain sources refresh default --resume');
    expect(text).toContain('Docs: https://github.com/garrytan/gbrain/blob/master/docs/guides/engine-swap.md#refresh_unsettled');
  });

  test.each([...ACTIVE_REFRESH_STATES])('a %s refresh refuses', async state => {
    await addRefresh(engine, state);
    const run = await swapPlan(engine);
    expect(run.code).toBe(1);
    expect(JSON.parse(run.error).reason).toBe('refresh_unsettled');
  });

  test.each(['completed', 'aborted'])('a %s refresh does not refuse', async state => {
    await addRefresh(engine, state);
    const run = await swapPlan(engine);
    expect(run.code).toBe(0);
    expect(run.statusReads).toBe(1);
    expect(JSON.parse(run.stdout).refreshes).toEqual({ unsettled: 0, checked: true });
  });

  test('the same brain plans once the refresh finishes', async () => {
    const { id } = await addRefresh(engine, 'syncing');
    expect((await swapPlan(engine)).code).toBe(1);
    await engine.executeRaw("UPDATE persistence_worktree_refreshes SET state='completed', completed_at=now() WHERE id=$1::uuid", [id]);
    const run = await swapPlan(engine);
    expect(run.code).toBe(0);
    const plan = JSON.parse(run.stdout);
    expect(plan.verdict).toBe('NOT READY');
    expect(plan.reason).toBe('writer_coverage_unknown');
  });

  test('several unfinished refreshes are all named, and a source-less one asks the user', async () => {
    const a = await addRefresh(engine, 'fenced');
    const [wt] = await engine.executeRaw<{ id: string }>('INSERT INTO persistence_worktrees(owner_host_id) VALUES(gen_random_uuid()) RETURNING id::text AS id');
    const [b] = await engine.executeRaw<{ id: string }>(
      `INSERT INTO persistence_worktree_refreshes (worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref)
       VALUES ($1::uuid,ARRAY[]::text[],gen_random_uuid(),1,1,'draining','a','b','origin/main') RETURNING id::text AS id`, [wt!.id]);
    const env = JSON.parse((await swapPlan(engine)).error);
    expect(env.message).toContain('2 worktree refresh row(s)');
    expect(env.message).toContain(a.id);
    expect(env.message).toContain(`${b!.id} (draining; sources none)`);
  });

  test('the plan writes nothing', async () => {
    await addRefresh(engine, 'merged');
    const count = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_worktree_refreshes'))[0]!.n;
    const before = await count();
    await swapPlan(engine);
    expect(await count()).toBe(before);
    const [row] = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_worktree_refreshes');
    expect(row!.state).toBe('merged');
  });
});
}
