/**
 * `gbrain engine swap --to pglite|postgres` (failback) through the CLI (docs/guides/engine-swap.md#failback).
 *
 * Authoring gate (docs/TESTING.md): (1) protects the user's view of failback: the plan shows what will be copied and
 * every accepted loss with its count before anything is written, a run needs the plan's hash, the target must be the
 * engine the brain swapped from, and an active writer of the Rust store stops failback before any write. (2) Fails
 * when the plan writes, hides a loss count or the rule names, when a run starts without approval, when failback runs
 * to the wrong engine, or when a second owner of the Rust store does not refuse it. (3) The copy itself is covered by
 * test/engine-swap-failback.test.ts and test/engine-swap-run.serial.test.ts. (4) Seams: a PGLite engine stands in for
 * the Rust engine (with the owner role the real engine reports), the route probe is injected; the config, the run
 * record lookup by store and the primary are real.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { runEngineSwap } from '../src/commands/engine-swap.ts';
import { fencePrimary, markPrimaryCutover, primaryFenced } from '../src/core/engine-swap/fence.ts';
import { writeSwapRecord, type SwapRecord } from '../src/core/engine-swap/record.ts';
import { withEnv } from './helpers/with-env.ts';

const RUN = '00000000-0000-4000-8000-00000000fc01';

interface World { home: string; primary: PGLiteEngine; rust: PGLiteEngine; store: string; out: string[]; errors: unknown[] }
let w: World | null = null;
afterEach(async () => {
  if (!w) return;
  await w.rust.disconnect().catch(() => undefined);
  await w.primary.disconnect().catch(() => undefined);
  rmSync(w.home, { recursive: true, force: true });
  w = null;
});

async function world(): Promise<World> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-failback-cli-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  const store = join(home, '.gbrain', 'shadow', 'pglite-abc', 'store');
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: store }));
  const primary = new PGLiteEngine();
  await primary.connect({});
  await primary.initSchema();
  const rust = new PGLiteEngine();
  await rust.connect({});
  await rust.initSchema();
  for (const e of [primary, rust]) await e.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: 'Before.', timeline: '' });
  for (const p of await primary.executeRaw<{ created_at: string; updated_at: string }>(`SELECT created_at::text AS created_at, updated_at::text AS updated_at FROM pages`)) {
    await rust.executeRaw('UPDATE pages SET created_at = $1::timestamptz, updated_at = $2::timestamptz', [p.created_at, p.updated_at]);
  }
  for (const s of await primary.executeRaw<{ created_at: string }>(`SELECT created_at::text AS created_at FROM sources`)) {
    await rust.executeRaw('UPDATE sources SET created_at = $1::timestamptz', [s.created_at]);
  }
  for (const c of await primary.executeRaw<{ key: string; value: string }>(`SELECT key, value FROM config WHERE key LIKE '%_at'`)) await rust.setConfig(c.key, c.value);
  await fencePrimary(primary, RUN, { hostId: '00000000-0000-4000-8000-00000000fc02', config: { engine: 'pglite' } as unknown as GBrainConfig });
  await markPrimaryCutover(primary, RUN);
  const at = '2026-11-24T20:00:00.000Z';
  const record: SwapRecord = {
    version: 1, run_id: RUN, plan_hash: 'swapplan', policy_hash: 'policy', brain: { key: 'pglite-abc', engine: 'pglite', database_path: join(home, 'old.pglite') },
    rust_store: store, shadow_dir: join(home, '.gbrain', 'shadow', 'pglite-abc'), state: 'succeeded', started_at: at, updated_at: at,
    switch: { previous: { engine: 'pglite', database_path: join(home, 'old.pglite') }, at }, error: null,
  };
  writeSwapRecord(join(home, '.gbrain', 'engine-swap', 'pglite-abc', 'run.json'), record);
  await rust.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: 'Edited on Rust.', timeline: '' });
  w = { home, primary, rust, store, out: [], errors: [] };
  return w;
}

function cli(x: World, args: string[], over: { ownerRole?: 'owner' | 'client' } = {}): Promise<number> {
  const rust = Object.assign(Object.create(x.rust) as BrainEngine, { ownerRole: over.ownerRole ?? 'owner', ownerStats: () => ({ active: 0, queued: 0, connections: 0, inflightBytes: 0 }) });
  return withEnv({ GBRAIN_HOME: x.home }, () => runEngineSwap(['swap', ...args], {
    cliBrain: null, resolveBrain: () => 'host', env: {}, home: x.home,
    out: t => { x.out.push(t); }, err: () => undefined,
    writeError: (e) => { x.errors.push(e); return e instanceof OperationError && (e.code === 'confirmation_required') ? 3 : e instanceof OperationError && e.code === 'invalid_params' ? 2 : 1; },
    failback: {
      openPrimary: async () => x.primary, openRust: async () => rust, keepOpen: true,
      prober: async () => ({ effective_engine: 'pglite', database_path: join(x.home, 'old.pglite'), ok: true }),
      primaryInUse: async () => null,
    },
  }));
}

const configEngine = (x: World): string => JSON.parse(readFileSync(join(x.home, '.gbrain', 'config.json'), 'utf8')).engine;
const lastError = (x: World): OperationError => x.errors[x.errors.length - 1] as OperationError;

describe('engine swap --to pglite (failback) CLI', () => {
  test('--plan shows the copy, every accepted loss with its count and the fingerprint rule, and writes nothing', async () => {
    const x = await world();
    expect(await cli(x, ['--to', 'pglite', '--plan'])).toBe(0);
    const text = x.out.join('\n');
    expect(text).toContain('Failback plan: rust -> pglite');
    expect(text).toMatch(/Pages: 1 changed, 0 added, 0 removed/);
    expect(text).toMatch(/Accepted loss page_version_collapse: 1/);
    expect(text).toMatch(/Accepted loss new_row_ids: 0/);
    expect(text).toContain('Not carried (no Rust read call)');
    expect(text).toContain('shadow digests');
    expect(text).toContain('Fingerprint rule');
    expect(text).toContain('Nothing was written.');
    expect((await x.primary.getPage('notes/example'))!.compiled_truth).toBe('Before.');
    expect(await primaryFenced(x.primary, RUN)).toBe(true);
    expect(configEngine(x)).toBe('rust');
  }, 120_000);

  test('a run without --yes gives confirmation_required with the plan hash', async () => {
    const x = await world();
    expect(await cli(x, ['--to', 'pglite'])).toBe(3);
    expect(lastError(x).code).toBe('confirmation_required');
    expect(lastError(x).message).toMatch(/plan [0-9a-f]{16}/);
    expect(configEngine(x)).toBe('rust');
  }, 120_000);

  test('failback runs only to the engine the brain swapped from', async () => {
    const x = await world();
    expect(await cli(x, ['--to', 'postgres', '--plan'])).toBe(2);
    expect(lastError(x).message).toContain('swapped from pglite');
  }, 120_000);

  test('another owner of the Rust store refuses failback with brain_in_use before any write', async () => {
    const x = await world();
    expect(await cli(x, ['--to', 'pglite', '--plan', '--json'])).toBe(0);
    const hash = JSON.parse(x.out[x.out.length - 1]!).plan_hash as string;
    expect(await cli(x, ['--to', 'pglite', '--yes', '--expect', hash], { ownerRole: 'client' })).toBe(1);
    expect(lastError(x).reason).toBe('brain_in_use');
    expect((await x.primary.getPage('notes/example'))!.compiled_truth).toBe('Before.');
    expect(configEngine(x)).toBe('rust');
  }, 120_000);

  test('--yes --expect <hash> copies back, verifies and moves authority to the old engine', async () => {
    const x = await world();
    expect(await cli(x, ['--to', 'pglite', '--plan', '--json'])).toBe(0);
    const hash = JSON.parse(x.out[x.out.length - 1]!).plan_hash as string;
    expect(await cli(x, ['--to', 'pglite', '--yes', '--expect', hash])).toBe(0);
    expect((await x.primary.getPage('notes/example'))!.compiled_truth).toBe('Edited on Rust.');
    expect(configEngine(x)).toBe('pglite');
    expect(x.out.join('\n')).toContain('The brain runs on the pglite engine again');
  }, 120_000);
});
