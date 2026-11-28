/**
 * Shared `gbrain engine shadow seed` budget scenarios for test/shadow-seed.test.ts (PGLite) and
 * test/e2e/shadow-seed.test.ts (Postgres): the command runs against a real primary and writes a real Rust store, and
 * a clock that moves 10 minutes per reading stops a default (30-minute) seed after a few relations.
 */
import { expect } from 'bun:test';
import { existsSync, lstatSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { openRustStore } from '../../src/core/rust-engine/store.ts';
import { runEngineShadow, type EngineShadowDeps } from '../../src/commands/engine-shadow.ts';
import { readSeedRecord, seedRecordPath } from '../../src/shadow/seed.ts';
import { SHADOW_STATE_VERSION, shadowBrainKey, shadowDirFor, writeShadowState } from '../../src/shadow/state.ts';
import { withEnv } from './with-env.ts';
import { expectSeedReadParity } from './shadow-seed-fixture.ts';

type BrainConfig = NonNullable<ReturnType<NonNullable<EngineShadowDeps['config']>>>;

export interface SeedBudgetCase {
  /** The filled primary; the command gets a view whose disconnect does nothing. */
  primary: BrainEngine;
  addon: RustAddon;
  /** A new GBRAIN_HOME for this case. */
  home: string;
  config: BrainConfig;
}

/** A clock that moves 10 minutes each time it is read, from a fixed start. */
export function steppingClock(stepMs = 10 * 60_000): () => Date {
  let t = Date.parse('2026-11-28T19:20:00.000Z');
  return () => new Date((t += stepMs));
}

export interface SeedRun { code: number; out: string; err: string }

/** Runs `gbrain engine shadow <args>` on the case's brain with the real addon and the real Rust store. */
export async function runSeedCommand(c: SeedBudgetCase, args: string[], extra: Partial<EngineShadowDeps> = {}): Promise<SeedRun> {
  const out: string[] = [];
  const err: string[] = [];
  const kept = Object.create(c.primary, { disconnect: { value: async () => undefined } }) as BrainEngine;
  const code = await runEngineShadow(args, {
    config: () => c.config,
    loadAddon: async () => ({ ok: true as const, addon: c.addon as never }),
    openPrimary: async () => kept,
    out: l => out.push(l),
    err: l => err.push(l),
    ...extra,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** Runs `fn` with GBRAIN_HOME (and any other variables) set for the case; returns its shadow directory too. */
export function inSeedHome<T>(c: SeedBudgetCase, env: Record<string, string | undefined>, fn: (dir: string) => Promise<T>): Promise<T> {
  // The budget variable is cleared first: a value exported in the developer's shell must not change a default-budget case.
  return withEnv({ GBRAIN_HOME: c.home, GBRAIN_SHADOW_SEED_BUDGET_MINUTES: undefined, ...env }, () => fn(shadowDirFor(shadowBrainKey(c.config)!)));
}

/** A seed that runs past the default budget stops with a partial store, and a plain rerun refuses that store. */
export async function expectDefaultBudgetStop(c: SeedBudgetCase, dir: string): Promise<SeedRun> {
  const stopped = await runSeedCommand(c, ['seed'], { now: steppingClock() });
  expect(stopped.code).toBe(1);
  expect(stopped.err).toContain('ran past its 30-minute budget');
  expect(readSeedRecord(dir)).toBeNull();
  expect(existsSync(join(dir, 'store'))).toBe(true);
  const again = await runSeedCommand(c, ['seed'], { now: steppingClock() });
  expect(again.code).toBe(1);
  expect(again.err).toContain('the Rust store already holds data');
  expect(readSeedRecord(dir)).toBeNull();
  return stopped;
}

/** The stop names the flag that raises the budget and the restart that clears the partial store. */
export function expectBudgetStopNamesTheWayOut(stopped: SeedRun): void {
  expect(stopped.err).toContain('--budget-minutes <n>');
  expect(stopped.err).toContain('GBRAIN_SHADOW_SEED_BUDGET_MINUTES');
  expect(stopped.err).toContain('gbrain engine shadow seed --restart');
  expect(stopped.err).not.toContain('stop --delete');
}

/** The seed finished: seed.json exists and the store answers the fixture reads as the primary does. */
export async function expectFinishedSeed(c: SeedBudgetCase, dir: string, run: SeedRun): Promise<void> {
  expect(run.code).toBe(0);
  expect(run.out).toContain('Seeded the Rust store from brain');
  expect(readSeedRecord(dir)?.relations.pages?.imported).toBe(2);
  await expectSeedReadParity(c.primary, c.addon, join(dir, 'store'));
}

/** `--restart` refuses while another process holds the store and puts the store back; once it is free, it reseeds. */
export async function expectRestartRefusesAHeldStore(c: SeedBudgetCase, dir: string): Promise<void> {
  const holder = await openRustStore(c.addon, join(dir, 'store'));
  let refused: SeedRun;
  try {
    refused = await runSeedCommand(c, ['seed', '--restart', '--budget-minutes', 'none'], { now: steppingClock() });
  } finally {
    await holder.close();
  }
  expect(refused.code).toBe(1);
  expect(refused.err).toContain('--restart deleted nothing: another process holds the Rust store');
  // A holder may be a running seed, so the message must not send the owner to the command that deletes every shadow file.
  expect(refused.err).not.toContain('stop --delete');
  expect(existsSync(join(dir, 'store'))).toBe(true);
  expect(readSeedRecord(dir)).toBeNull();
}

/**
 * `--restart` deletes the store it holds the lock of. It must not unlink the locked file in place: the lock belongs to that
 * file, so while the path still named it another process could open a new file there and have it deleted too. The store
 * is renamed away first (the lock moves with the file), so the path is free before anything is deleted and only the
 * renamed copy goes. Returns the run, which reseeds.
 */
export async function runRestartWatchingTheLockedStore(c: SeedBudgetCase, dir: string): Promise<SeedRun> {
  let opened = 0;
  let atClose: { storeExists: boolean; renamed: string[] } | undefined;
  const run = await runSeedCommand(c, ['seed', '--restart', '--budget-minutes', 'none'], {
    now: steppingClock(),
    openStore: async (addon, path) => {
      const real = await openRustStore(addon as RustAddon, path);
      if (++opened > 1) return real;
      // The first open is the lock probe; its close comes right after the store was removed from the path.
      return Object.create(real, { close: { value: async () => {
        const renamed = readdirSync(dir).filter(n => n.startsWith('store.'));
        atClose = { storeExists: existsSync(join(dir, 'store')), renamed: renamed.filter(n => readdirSync(join(dir, n)).length > 0) };
        await real.close();
      } } });
    },
  });
  expect(atClose).toEqual({ storeExists: false, renamed: [expect.stringMatching(/^store\.deleting-/)] });
  // Nothing is left behind once the old store is gone.
  expect(readdirSync(dir).filter(n => n.startsWith('store.'))).toEqual([]);
  return run;
}

/** The store's files, to prove a refused --restart deleted nothing. */
function storeFiles(dir: string): string[] {
  return readdirSync(join(dir, 'store'), { recursive: true }).map(String).sort();
}

/**
 * `--restart` never deletes a store while any seed.json exists: not a damaged one this build cannot read, and not one a
 * seed wrote while this command waited for the store (the store open is the wait). Call after a budget stop.
 */
export async function expectRestartKeepsAStoreWithASeedRecord(c: SeedBudgetCase, dir: string): Promise<void> {
  const files = storeFiles(dir);
  writeFileSync(seedRecordPath(dir), '{"damaged":', { mode: 0o600 });
  expect(readSeedRecord(dir)).toBeNull();
  const damaged = await runSeedCommand(c, ['seed', '--restart', '--budget-minutes', 'none'], { now: steppingClock() });
  expect(damaged.code).toBe(1);
  expect(damaged.err).toContain('this seed finished (seed.json exists)');
  expect(storeFiles(dir)).toEqual(files);

  rmSeedRecord(dir);
  // Another seed finishes (writes seed.json, then closes the store) while --restart waits to open the store.
  const finishedMeanwhile = await runSeedCommand(c, ['seed', '--restart', '--budget-minutes', 'none'], {
    now: steppingClock(),
    openStore: async (addon, path) => {
      writeFileSync(seedRecordPath(dir), '{}', { mode: 0o600 });
      return openRustStore(addon as RustAddon, path);
    },
  });
  expect(finishedMeanwhile.code).toBe(1);
  expect(finishedMeanwhile.err).toContain('--restart deleted nothing: a seed finished while it waited');
  expect(storeFiles(dir)).toEqual(files);
  rmSeedRecord(dir);

  // Shadow mode is turned on while --restart waits to open the store: nothing is deleted and no seed starts.
  const state = { version: SHADOW_STATE_VERSION, enabled: true, started_at: 'x', sample_rate: 0.1, queue_bound: 1, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' };
  const enabledMeanwhile = await runSeedCommand(c, ['seed', '--restart', '--budget-minutes', 'none'], {
    now: steppingClock(),
    openStore: async (addon, path) => {
      writeShadowState(dir, state);
      return openRustStore(addon as RustAddon, path);
    },
  });
  expect(enabledMeanwhile.code).toBe(1);
  expect(enabledMeanwhile.err).toContain('--restart deleted nothing: shadow mode was turned on while it waited');
  expect(readSeedRecord(dir)).toBeNull();
  expect(storeFiles(dir)).toEqual(files);
  writeShadowState(dir, { ...state, enabled: false });
}

/** `--restart` refuses a store path that is a symbolic link: removing the link would leave the data it points to. */
export async function expectRestartRefusesALinkedStore(c: SeedBudgetCase, dir: string): Promise<void> {
  const real = join(dir, 'store');
  const moved = join(dir, 'moved-store');
  renameSync(real, moved);
  symlinkSync(moved, real);
  try {
    const refused = await runSeedCommand(c, ['seed', '--restart', '--budget-minutes', 'none'], { now: steppingClock() });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('--restart deleted nothing: the Rust store path is a symbolic link');
    expect(lstatSync(real).isSymbolicLink()).toBe(true);
    expect(readdirSync(moved).length).toBeGreaterThan(0);
  } finally {
    rmSync(real);
    renameSync(moved, real);
  }
}

function rmSeedRecord(dir: string): void {
  rmSync(seedRecordPath(dir));
}
