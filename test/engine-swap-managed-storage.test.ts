/**
 * The engine swap refuses a managed brain only where the Rust destination cannot hold it
 * (docs/guides/engine-swap.md#managed_storage).
 *
 * Authoring gate (docs/TESTING.md): (1) protects a managed brain from a swap the Rust engine cannot finish: a
 * multi-user Rust store withholds managed mode (single-host file locks until slice 3's I-5 leases), so with
 * GBRAIN_RUST_MULTIUSER=1 the swap would fail after the write fence is up. With the switch off the Rust engine holds
 * managed storage (lane LM slice 2), so a managed brain gets its plan like any other. (2) Fails when, with the switch
 * on, `gbrain engine swap --to rust --plan` shows a plan, reads a readiness criterion or writes anything for a brain
 * whose `persistence_brain.enabled` is true, when the refusal loses its reason, exit code, next step or guide anchor,
 * or when a managed brain with the switch off is refused. (3) No existing test sets managed storage on a swap. (4) No
 * seam: a real PGLite brain (Postgres too when DATABASE_URL is set) and the real command; only the shadow status
 * reader is injected, to prove it is never called.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { runEngineSwap } from '../src/commands/engine-swap.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

interface Run { code: number; stdout: string; error: string; statusReads: number }

async function swapPlan(engine: BrainEngine, json = true, env: Record<string, string> = { GBRAIN_RUST_MULTIUSER: '1' }): Promise<Run> {
  let stdout = '';
  let error = '';
  let statusReads = 0;
  const code = await runEngineSwap(['--to', 'rust', '--plan', ...(json ? ['--json'] : [])], {
    openEngine: async () => Object.assign(Object.create(engine), { disconnect: async () => undefined }) as BrainEngine,
    readShadowStatus: async () => { statusReads++; return null; }, resolveBrain: () => 'host',
    env, home: '', now: new Date('2026-11-22T00:00:00Z'),
    out: t => { stdout += t; },
    writeError: (e, o) => {
      const r = renderCliError(e, { json: o.json, command: 'engine swap', tty: false });
      error = (o.json ? r.stdout : r.stderr) ?? r.stdout ?? r.stderr ?? '';
      return r.exitCode;
    },
  });
  return { code, stdout, error, statusReads };
}

/** Every persistence row the swap could touch, as text, so "nothing was written" is checked, not assumed. */
async function persistenceSnapshot(engine: BrainEngine): Promise<string> {
  const rows = await engine.executeRaw<{ t: string }>(
    `SELECT (SELECT to_jsonb(b)::text FROM persistence_brain b WHERE singleton=1) AS t
     UNION ALL SELECT count(*)::text FROM persistence_worktree_refreshes`);
  return rows.map(r => r.t).join('|');
}

for (const kind of testBackends()) {
describe(`engine swap refuses a managed brain only where Rust cannot hold it (${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const e = new PGLiteEngine(); await e.connect({}); await e.initSchema(); engine = e; close = () => e.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close(); });
  beforeEach(async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  });

  test('with multi-user mode on, a managed brain is refused with managed_storage, before any criterion is read, and nothing is written', async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before = await persistenceSnapshot(engine);
    const run = await swapPlan(engine);
    expect(run.code).toBe(3);
    expect(run.stdout).toBe('');
    expect(run.statusReads).toBe(0);
    const env = JSON.parse(run.error);
    expect(env.code).toBe('engine_swap_refused');
    expect(env.reason).toBe('managed_storage');
    expect(env.class).toBe('consent');
    expect(env.docs).toBe('https://github.com/garrytan/gbrain/blob/master/docs/guides/engine-swap.md#managed_storage');
    expect(env.fix.next).toBe('ask_user');
    expect(env.fix.verify.argv).toEqual(['gbrain', 'engine', 'swap', '--to', 'rust', '--plan', '--json']);
    expect(String(env.fix.user_message)).toContain('managed storage');
    expect(String(env.fix.user_message)).toContain('in multi-user mode');
    expect(String(env.detail)).toContain('The current engine keeps authority; nothing was written.');
    expect(await persistenceSnapshot(engine)).toBe(before);
  });

  test('the human-readable refusal names managed storage and the guide', async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const run = await swapPlan(engine, false);
    expect(run.code).toBe(3);
    expect(run.stdout).toBe('');
    expect(run.error).toContain('Error [engine_swap_refused]: The swap is refused: this brain uses managed storage, which the Rust engine does not support in multi-user mode');
    expect(run.error).toContain('Docs: https://github.com/garrytan/gbrain/blob/master/docs/guides/engine-swap.md#managed_storage');
  });

  test('with multi-user mode off, a managed brain gets its plan: the Rust engine holds managed storage on one host', async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before = await persistenceSnapshot(engine);
    const run = await swapPlan(engine, true, {});
    expect(run.error).toBe('');
    expect(run.code).toBe(0);
    expect(run.statusReads).toBe(1);
    expect(JSON.parse(run.stdout).from).toBe(kind);
    expect(await persistenceSnapshot(engine)).toBe(before);
  });

  test('an unmanaged brain still gets its plan', async () => {
    const run = await swapPlan(engine);
    expect(run.code).toBe(0);
    expect(run.statusReads).toBe(1);
    expect(JSON.parse(run.stdout).from).toBe(kind);
  });
});
}
