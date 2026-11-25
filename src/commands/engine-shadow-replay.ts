/**
 * `gbrain engine shadow replay` (docs/guides/shadow-replay.md). The hidden `__replay-child <run dir>` is the isolated
 * child the replay spawns. Capture itself is `engine-shadow-capture.ts`.
 */
import { join } from 'node:path';
import { configDir } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { EngineConfig } from '../core/types.ts';
import { REPLAY_ERRORS, ReplayError } from '../shadow/replay-errors.ts';
import { spawnReplayChild } from '../shadow/replay-spawn.ts';

export { replayChildSpawn, spawnReplayChild } from '../shadow/replay-spawn.ts';

export interface ShadowReplayIo {
  out: (l: string) => void;
  err: (l: string) => void;
  now: () => Date;
  brain: { key: string; dir: string; engine: string };
  config: () => Pick<EngineConfig, 'engine' | 'database_path' | 'database_url'> | null;
  openPrimary: () => Promise<BrainEngine>;
}

export async function runShadowReplayCommand(sub: string, rest: string[], io: ShadowReplayIo): Promise<number> {
  const json = rest.includes('--json');
  if (sub === 'replay') {
    const budget = rest.indexOf('--budget-minutes');
    const budgetMinutes = budget >= 0 ? Number(rest[budget + 1]) : 120;
    if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0) throw new ReplayError('shadow_replay_budget', '--budget-minutes needs a positive number');
    const { runNightlyReplay } = await import('../shadow/replay-run.ts');
    try {
      const result = await runNightlyReplay(nightlyDeps(io), { budgetMinutes });
      io.out(json ? JSON.stringify(result, null, 2) : `replay: ${result.status}${result.replayed_epoch ? ` (epoch ${result.replayed_epoch}, coverage ${result.coverage})` : ''}${result.report ? `\nreport (local only): ${result.report}\nsummary (may leave this machine): ${result.summary}` : ''}`);
      return 0;
    } catch (e) {
      if (!(e instanceof ReplayError)) throw e;
      if (json) io.out(JSON.stringify({ schema_version: 1, status: 'error', code: e.code, ...REPLAY_ERRORS[e.code] }, null, 2));
      io.err(`engine shadow: ${e.message}`);
      return 1;
    }
  }

  if (sub === '__replay-child') {
    const runDir = rest[0];
    if (!runDir) throw new ReplayError('shadow_replay_no_epoch', '__replay-child needs the run directory');
    const { runReplayChild } = await import('../shadow/replay.ts');
    await runReplayChild(runDir, { openArm: openReplayArm });
    return 0;
  }
  return 2;
}

/** The real dependencies of the nightly replay (tests override single members). */
export function nightlyDeps(io: ShadowReplayIo): import('../shadow/replay-run.ts').NightlyDeps {
  return {
    shadowDir: io.brain.dir, brainKey: io.brain.key, primaryEngine: io.brain.engine as 'pglite' | 'postgres',
    env: process.env, home: configDir(), openPrimary: io.openPrimary, now: io.now,
    rustDir: join(configDir(), 'engines', 'rust'),
    loadAddon: async () => (await import('../core/rust-engine/addon-loader.ts')).loadRustEngineAddon(),
    openStore: async (addon, path) => (await import('../core/rust-engine/store.ts')).openRustStore(addon, path),
    openSql: async (kind, where) => {
      const { createEngine } = await import('../core/engine-factory.ts');
      const cfg = sqlConfig(kind, where);
      const e = await createEngine(cfg);
      await e.connect(cfg);
      return e;
    },
    spawnChild: (runDir, env) => {
      const { resolveServeGbrainCommand } = require('../core/serve-service.ts') as typeof import('../core/serve-service.ts');
      const { bunSpawn } = require('../core/spawn.ts') as typeof import('../core/spawn.ts');
      return spawnReplayChild([...resolveServeGbrainCommand({ which: () => null }), 'engine', 'shadow', '__replay-child', runDir], runDir, env, bunSpawn);
    },
  };
}

/** The engine config of a SQL copy: a PGLite brain at a path. */
function sqlConfig(kind: 'pglite', where: string): EngineConfig {
  return { engine: kind, database_path: where } as EngineConfig;
}

/** Opens one work copy in the replay child (no shadow, no capture: GBRAIN_SHADOW_CHILD=1). */
export async function openReplayArm(arm: 'pglite' | 'rust', spec: import('../shadow/replay.ts').RunSpec): Promise<BrainEngine> {
  const { createEngine } = await import('../core/engine-factory.ts');
  if (arm === 'rust') {
    const { loadRustEngineAddon } = await import('../core/rust-engine/addon-loader.ts');
    const load = await loadRustEngineAddon(spec.rust_dir ? { rustDir: spec.rust_dir } : {});
    if (!load.ok) throw new ReplayError('shadow_replay_addon_unavailable', `${load.code} (${load.reason})`);
    const { openRustEngine } = await import('../core/rust-engine.ts');
    const e = openRustEngine({ addon: load.addon as never, databasePath: spec.arms.rust });
    await e.connect({ engine: 'pglite', database_path: spec.arms.rust } as never);
    return e as unknown as BrainEngine;
  }
  const cfg = sqlConfig(arm, spec.arms.pglite);
  const e = await createEngine(cfg);
  await e.connect(cfg);
  return e;
}
