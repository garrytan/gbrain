/**
 * The engine swap refuses a managed brain only where this build's Rust destination cannot hold it
 * (docs/guides/engine-swap.md#managed_storage).
 *
 * Authoring gate (docs/TESTING.md): (1) protects a managed brain from a swap the Rust engine cannot finish: a build whose
 * Rust engine does not serve managed_persistence would fail the cutover after the write fence is up. This build's Rust
 * engine serves managed mode on a single host (lane LM slice 2), so a managed brain gets its plan like any other; managed
 * mode on a multi-user Rust store waits for the multi-user branch (slice 3). (2) Fails when, on a build that holds
 * managed_persistence back, `gbrain engine swap --to rust --plan` shows a plan, reads a readiness criterion or writes
 * anything for a brain whose `persistence_brain.enabled` is true, when the refusal loses its reason, exit code, next step
 * or guide anchor, or when a managed brain on a build that serves managed mode is refused. (3) No existing test sets
 * managed storage on a swap. (4) No seam: a real PGLite brain (Postgres too when DATABASE_URL is set) and the real
 * command; only the shadow status reader is injected, to prove it is never called, and the build that does not serve
 * managed mode is the real HELD_FOR_CALLERS table with the entry the lift removed put back for the test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { runEngineSwap } from '../src/commands/engine-swap.ts';
import { HELD_FOR_CALLERS } from '../src/core/rust-engine/store-capabilities.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

interface Run { code: number; stdout: string; error: string; statusReads: number }

async function swapPlan(engine: BrainEngine, json = true, env: Record<string, string> = {}): Promise<Run> {
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
describe(`engine swap refuses a managed brain only where this build's Rust cannot hold it (${kind})`, () => {
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

  /** Runs `body` as a build whose Rust engine does not serve managed_persistence (the table entry the lift removed, put back). */
  async function withoutManagedMode<T>(body: () => Promise<T>): Promise<T> {
    HELD_FOR_CALLERS.managed_persistence = ['a build that does not serve managed mode (test)'];
    try { return await body(); } finally { delete HELD_FOR_CALLERS.managed_persistence; }
  }

  test('on a build that does not serve managed mode, a managed brain is refused with managed_storage, before any criterion is read, and nothing is written', async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before = await persistenceSnapshot(engine);
    const run = await withoutManagedMode(() => swapPlan(engine));
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
    expect(String(env.fix.user_message)).toContain("this build's Rust engine cannot hold a managed brain");
    expect(String(env.detail)).toContain('The current engine keeps authority; nothing was written.');
    expect(await persistenceSnapshot(engine)).toBe(before);
  });

  test('the human-readable refusal names managed storage and the guide', async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const run = await withoutManagedMode(() => swapPlan(engine, false));
    expect(run.code).toBe(3);
    expect(run.stdout).toBe('');
    expect(run.error).toContain('Error [engine_swap_refused]: The swap is refused: this brain uses managed storage, which this build of the Rust engine does not support.');
    expect(run.error).toContain('Docs: https://github.com/garrytan/gbrain/blob/master/docs/guides/engine-swap.md#managed_storage');
  });

  test('on a build that serves managed mode, a managed brain gets its plan: the Rust engine holds managed storage on one host', async () => {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before = await persistenceSnapshot(engine);
    const run = await swapPlan(engine);
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
