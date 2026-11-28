/**
 * Shared `gbrain engine shadow seed` budget scenarios for test/shadow-seed.test.ts (PGLite) and
 * test/e2e/shadow-seed.test.ts (Postgres): the command runs against a real primary and writes a real Rust store, and
 * a clock that moves 10 minutes per reading stops a default (30-minute) seed after a few relations.
 */
import { expect } from 'bun:test';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { openRustStore } from '../../src/core/rust-engine/store.ts';
import { runEngineShadow, type EngineShadowDeps } from '../../src/commands/engine-shadow.ts';
import { readSeedRecord, seedRecordPath } from '../../src/shadow/seed.ts';
import { shadowBrainKey, shadowDirFor } from '../../src/shadow/state.ts';
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
  return withEnv({ GBRAIN_HOME: c.home, ...env }, () => fn(shadowDirFor(shadowBrainKey(c.config)!)));
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
  expect(existsSync(join(dir, 'store'))).toBe(true);
  expect(readSeedRecord(dir)).toBeNull();
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
}

function rmSeedRecord(dir: string): void {
  rmSync(seedRecordPath(dir));
}
