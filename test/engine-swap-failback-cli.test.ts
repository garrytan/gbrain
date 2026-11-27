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
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { runEngineSwap } from '../src/commands/engine-swap.ts';
import { primaryFenced } from '../src/core/engine-swap/fence.ts';
import { openFailbackCliWorld, type CliWorld } from './helpers/failback-world.ts';
import { withEnv } from './helpers/with-env.ts';

const RUN = '00000000-0000-4000-8000-00000000fc01';

type World = CliWorld;

/** One world per test, opened in beforeAll and closed in afterAll. */
function scenario(name: string, body: (x: World) => Promise<void>): void {
  describe(name, () => {
    let x: World;
    beforeAll(async () => { x = await openFailbackCliWorld(RUN); }, 120_000);
    afterAll(async () => {
      await x?.rust.disconnect().catch(() => undefined);
      await x?.primary.disconnect().catch(() => undefined);
      if (x) rmSync(x.home, { recursive: true, force: true });
    });
    test(name, () => body(x), 120_000);
  });
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
  scenario('--plan shows the copy, every accepted loss with its count and the fingerprint rule, and writes nothing', async x => {
    expect(await cli(x, ['--to', 'pglite', '--plan'])).toBe(0);
    const text = x.out.join('\n');
    expect(text).toContain('Failback plan: rust -> pglite');
    expect(text).toMatch(/Pages: 1 changed, 0 added, 0 removed/);
    expect(text).toMatch(/Accepted loss page_version_collapse: 1/);
    expect(text).toMatch(/Accepted loss new_row_ids: 0/);
    expect(text).toContain('Not carried by failback (no Rust read call returns it, or failback does not write it back)');
    expect(text).toContain('shadow digests');
    expect(text).toContain('Fingerprint rule');
    expect(text).toContain('Nothing was written.');
    expect((await x.primary.getPage('notes/example'))!.compiled_truth).toBe('Before.');
    expect(await primaryFenced(x.primary, RUN)).toBe(true);
    expect(configEngine(x)).toBe('rust');
  });

  scenario('a run without --yes gives confirmation_required with the plan hash', async x => {
    expect(await cli(x, ['--to', 'pglite'])).toBe(3);
    expect(lastError(x).code).toBe('confirmation_required');
    expect(lastError(x).message).toMatch(/plan [0-9a-f]{16}/);
    expect(configEngine(x)).toBe('rust');
  });

  scenario('failback runs only to the engine the brain swapped from', async x => {
    expect(await cli(x, ['--to', 'postgres', '--plan'])).toBe(2);
    expect(lastError(x).message).toContain('swapped from pglite');
  });

  scenario('another owner of the Rust store refuses failback with brain_in_use before any write', async x => {
    expect(await cli(x, ['--to', 'pglite', '--plan', '--json'])).toBe(0);
    const hash = JSON.parse(x.out[x.out.length - 1]!).plan_hash as string;
    expect(await cli(x, ['--to', 'pglite', '--yes', '--expect', hash], { ownerRole: 'client' })).toBe(1);
    expect(lastError(x).reason).toBe('brain_in_use');
    expect((await x.primary.getPage('notes/example'))!.compiled_truth).toBe('Before.');
    expect(configEngine(x)).toBe('rust');
  });

  scenario('--yes --expect <hash> copies back, verifies and moves authority to the old engine', async x => {
    expect(await cli(x, ['--to', 'pglite', '--plan', '--json'])).toBe(0);
    const hash = JSON.parse(x.out[x.out.length - 1]!).plan_hash as string;
    expect(await cli(x, ['--to', 'pglite', '--yes', '--expect', hash])).toBe(0);
    expect((await x.primary.getPage('notes/example'))!.compiled_truth).toBe('Edited on Rust.');
    expect(configEngine(x)).toBe('pglite');
    expect(x.out.join('\n')).toContain('The brain runs on the pglite engine again');
  });
});
