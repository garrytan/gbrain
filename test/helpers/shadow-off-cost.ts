/**
 * Shared by test/shadow-off-cost.test.ts (PGLite) and test/e2e/shadow-off-cost.test.ts (Postgres): runs
 * test/helpers/shadow-off-cost-probe.ts in a fresh process and holds the assertions that define "shadow off costs nothing".
 */
import { expect } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEED_RECORD_VERSION, writeSeedRecord } from '../../src/shadow/seed.ts';
import { shadowBrainKey, writeShadowState, SHADOW_STATE_VERSION } from '../../src/shadow/state.ts';
import type { EngineConfig } from '../../src/core/types.ts';

export type ProbeKind = 'pglite' | 'postgres';

export interface ProbeResult {
  arm: 'factory' | 'direct';
  kind: ProbeKind;
  isProxy: boolean;
  samePrototypeAsDirect: boolean;
  constructorName: string;
  ownKeys: string[];
  protoNames: string[];
  shadowModulesAfterOpen: string[];
  shadowModulesAfterWrites: string[];
  wire: string[];
}

/** The shadow modules that hold the follow hook and the wrapper that carries it. state.ts is the factory's own off-switch check and is allowed. */
export const HOOK_MODULES = ['attach.ts', 'wrapper.ts', 'follow.ts', 'follower.ts', 'invalidations.ts'] as const;

const PROBE = join(import.meta.dir, 'shadow-off-cost-probe.ts');

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-shadow-off-cost-'));
}

/**
 * What `gbrain engine shadow start` leaves behind for the brain `config` opens: state.json with shadow on. With
 * `seeded`, also a seed.json, which is what makes attachShadow start the follow hook (src/shadow/attach.ts).
 */
export function turnShadowOn(home: string, config: EngineConfig, opts: { seeded?: boolean } = {}): void {
  const brain = shadowBrainKey(config)!;
  const dir = join(home, '.gbrain', 'shadow', brain); // GBRAIN_HOME is the parent of .gbrain (src/core/config.ts configDir)
  mkdirSync(dir, { recursive: true });
  writeShadowState(dir, {
    version: SHADOW_STATE_VERSION, enabled: true, started_at: new Date().toISOString(),
    sample_rate: 0.1, queue_bound: 256, plan_hash: 'shadow-off-cost-control', brain, primary_engine: config.engine ?? 'pglite',
  });
  if (opts.seeded) {
    const now = new Date().toISOString();
    writeSeedRecord(dir, {
      version: SEED_RECORD_VERSION, seed_id: 'shadow-off-cost-control', started_at: now, finished_at: now,
      primary_engine: config.engine ?? 'pglite', relations: {}, losses: { values: {}, not_copied: [], gaps: {} },
      unseeded_gap_rows: {}, unseeded_gap_rows_total: 0, non_terminal_jobs: 0, segmented_pages: 0, digests: true,
    });
  }
}

export async function runProbe(arm: 'factory' | 'direct', kind: ProbeKind, env: Record<string, string>): Promise<ProbeResult> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('GBRAIN_') && key !== 'DATABASE_URL') clean[key] = value;
  const child = Bun.spawn(['bun', PROBE, arm, kind], { env: { ...clean, GBRAIN_HOME: env.GBRAIN_HOME!, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const line = out.split('\n').find((l) => l.startsWith('PROBE_RESULT '));
  if (code !== 0 || !line) throw new Error(`probe ${arm}/${kind} exited ${code}\n${err.slice(-2000)}`);
  return JSON.parse(line.slice('PROBE_RESULT '.length)) as ProbeResult;
}

/** Shadow modules from the hook set that a probe run loaded, by file name. */
export function loadedHookModules(paths: string[]): string[] {
  return HOOK_MODULES.filter((name) => paths.some((p) => p.endsWith(`/src/shadow/${name}`)));
}

/**
 * The claim: with shadow off, the factory's engine is the primary's own engine and the writes cost what they cost without it.
 * Three pins, each throwing (via expect) when `factory` is anything else. The one field the factory adds to every engine,
 * shadow or not, is its own `disconnect` (chat-usage sink bookkeeping, src/core/engine-factory.ts); anything beyond that fails.
 */

/** 1. Not a Proxy, and the same kind of object as a direct construction. */
export function expectSameEngineObject(factory: ProbeResult, direct: ProbeResult): void {
  expect(factory.isProxy).toBe(false);
  expect(direct.isProxy).toBe(false);
  expect(factory.samePrototypeAsDirect).toBe(true);
  expect(factory.constructorName).toBe(direct.constructorName);
  expect(factory.protoNames).toEqual(direct.protoNames);
  expect(factory.ownKeys.filter((key) => !direct.ownKeys.includes(key))).toEqual(['disconnect']);
  expect(direct.ownKeys.filter((key) => !factory.ownKeys.includes(key))).toEqual([]);
  // `listSharedSkillFollowSources` is the shared-skill catalog's list of followed sources, a member of the trunk's engine that has nothing to do with shadow follow.
  for (const name of [...factory.ownKeys, ...factory.protoNames].filter((n) => n !== 'listSharedSkillFollowSources')) expect(name).not.toMatch(/shadow|follow/i);
}

/** 2. None of the hook modules was ever loaded in the process, not at open and not after the writes. */
export function expectNoHookModules(factory: ProbeResult): void {
  expect(loadedHookModules(factory.shadowModulesAfterOpen)).toEqual([]);
  expect(loadedHookModules(factory.shadowModulesAfterWrites)).toEqual([]);
  expect(factory.shadowModulesAfterWrites.map((p) => p.split('/src/shadow/')[1])).toEqual(['state.ts']);
}

/** 3. Same SQL to the database for the same writes: same count, same text, same parameters, same order. */
export function expectSameSql(factory: ProbeResult, direct: ProbeResult): void {
  expect(factory.wire.length).toBeGreaterThan(50); // the batch really ran (page, link, delete and a transaction all issue SQL)
  expect(factory.wire.some((m) => m.startsWith('P:') && /INSERT INTO pages/i.test(m))).toBe(true);
  expect(factory.wire.some((m) => m.startsWith('P:') && /INSERT INTO links/i.test(m))).toBe(true);
  expect(direct.wire.length).toBe(factory.wire.length);
  expect(factory.wire).toEqual(direct.wire);
}

export function expectNoShadowCost(factory: ProbeResult, direct: ProbeResult): void {
  expectSameEngineObject(factory, direct);
  expectNoHookModules(factory);
  expectSameSql(factory, direct);
}

/** The three arms every twin runs: shadow off through the factory, a direct engine, and the two shadow-ON controls. */
export interface Arms { off: ProbeResult; direct: ProbeResult; onUnseeded: ProbeResult; onSeeded: ProbeResult }

/**
 * The control rows. Unseeded shadow-on wraps the engine and loads the hook modules but its follow hook stays idle, so only
 * pins 1 and 2 can see it. Seeded shadow-on starts the follow hook, which reads the primary after each commit, so pin 3 sees it.
 */
export function expectControlsAreCaught({ direct, onUnseeded, onSeeded }: Arms): void {
  expect(onUnseeded.isProxy).toBe(true);
  expect(loadedHookModules(onUnseeded.shadowModulesAfterOpen)).toEqual([...HOOK_MODULES]);
  expect(() => expectSameEngineObject(onUnseeded, direct)).toThrow();
  expect(() => expectNoHookModules(onUnseeded)).toThrow();
  expect(onSeeded.isProxy).toBe(true);
  expect(onSeeded.wire.length).toBeGreaterThan(direct.wire.length);
  expect(() => expectSameSql(onSeeded, direct)).toThrow();
  expect(() => expectNoShadowCost(onSeeded, direct)).toThrow();
}
