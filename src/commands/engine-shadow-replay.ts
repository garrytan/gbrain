/**
 * `gbrain engine shadow capture on|off|status|delete` and `gbrain engine shadow replay` (docs/guides/shadow-replay.md).
 * The hidden `__replay-child <run dir>` is the isolated child the replay spawns.
 */
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { EngineConfig } from '../core/types.ts';
import {
  captureDir, captureKilledByEnv, captureOffMarker, captureIsOn, readCaptureState, writePrivateJson, CAPTURE_STATE_VERSION,
} from '../shadow/capture-state.ts';
import { REPLAY_ERRORS, ReplayError } from '../shadow/replay-errors.ts';

export interface ShadowReplayIo {
  out: (l: string) => void;
  err: (l: string) => void;
  now: () => Date;
  brain: { key: string; dir: string; engine: string };
  config: () => Pick<EngineConfig, 'engine' | 'database_path' | 'database_url'> | null;
  openPrimary: () => Promise<BrainEngine>;
}

function captureStatus(cap: string) {
  const { invalidateIfPurged, readEpoch, epochDir, basesDir } = require('../shadow/capture.ts') as typeof import('../shadow/capture.ts');
  const purged = invalidateIfPurged(cap);
  const epoch = readEpoch(cap);
  const dir = epoch ? epochDir(cap, epoch.id) : null;
  const files = dir && existsSync(dir) ? readdirSync(dir) : [];
  return {
    schema_version: 1,
    on: captureIsOn(cap),
    killed_by_env: captureKilledByEnv(),
    off_marker: existsSync(captureOffMarker(cap)),
    epoch: epoch ? { id: epoch.id, state: epoch.state, started_at: epoch.started_at, seeded: existsSync(join(basesDir(cap, epoch.id), 'manifest.json')) } : null,
    invalidated_now: purged,
    scratch_drop_pending: existsSync(join(cap, 'scratch-drop-pending')),
    recording_processes: files.filter(f => f.startsWith('proc-')).length,
    segment_bytes: files.filter(f => f.endsWith('.jsonl')).reduce((n, f) => n + statSync(join(dir!, f)).size, 0),
    directory: cap,
  };
}

export async function runShadowReplayCommand(sub: string, rest: string[], io: ShadowReplayIo): Promise<number> {
  const cap = captureDir(io.brain.dir);
  const json = rest.includes('--json');
  if (sub === 'capture') {
    const [action, ...flags] = rest;
    if (action === 'on') {
      if (!flags.includes('--yes')) {
        io.out(`Capture records every call this brain makes to its storage engine (reads and writes, with their arguments) into\n${cap}/ (owner-only files). Nothing leaves this machine. It starts at the next \`gbrain engine shadow replay\`, which\nseeds the private copies. Restart long-running gbrain processes (serve, MCP) afterwards: only engines opened after\ncapture is on record. Run again with --yes to turn it on.`);
        return 1;
      }
      writePrivateJson(join(cap, 'state.json'), { version: CAPTURE_STATE_VERSION, enabled: true, turned_on_at: io.now().toISOString() });
      rmSync(captureOffMarker(cap), { force: true });
      io.out(captureKilledByEnv() ? 'Capture is on, but GBRAIN_SHADOW_CAPTURE=off in this environment keeps it off for processes started with it.' : `Capture is on. Run gbrain engine shadow replay once to seed the copies; recording starts then.`);
      return 0;
    }
    if (action === 'off') {
      const prev = readCaptureState(cap);
      writePrivateJson(join(cap, 'state.json'), { version: CAPTURE_STATE_VERSION, enabled: false, turned_on_at: prev?.turned_on_at ?? io.now().toISOString(), turned_off_at: io.now().toISOString() });
      writeFileSync(captureOffMarker(cap), `${io.now().toISOString()}\n`, { mode: 0o600 });
      io.out(`Capture is off. Every recording process stops at its next flush. Nothing was deleted; recordings and copies stay in ${cap}. To delete them: gbrain engine shadow capture delete --yes`);
      return 0;
    }
    if (action === 'status') {
      const s = captureStatus(cap);
      if (s.invalidated_now || s.scratch_drop_pending) s.scratch_drop_pending = !await (await import('../shadow/capture.ts')).scratchCleared(cap);
      if (json) io.out(JSON.stringify(s, null, 2));
      else io.out(`capture: ${s.on ? 'on' : 'off'}${s.killed_by_env ? ' (GBRAIN_SHADOW_CAPTURE=off)' : ''}\nepoch: ${s.epoch ? `${s.epoch.id} ${s.epoch.state}${s.epoch.seeded ? ', copies seeded' : ', not seeded'}` : 'none'}\nrecording processes: ${s.recording_processes}\nrecorded bytes: ${s.segment_bytes}\ndirectory: ${s.directory}`);
      return 0;
    }
    if (action === 'delete') {
      if (!flags.includes('--yes')) { io.out(`This deletes every recording, seeded copy and replay report under ${cap} and ${join(io.brain.dir, 'replay')}. Run again with --yes.`); return 1; }
      const { scheduleScratchDrop } = await import('../shadow/capture.ts');
      if (!await scheduleScratchDrop(cap)) { io.err('engine shadow: the scratch Postgres copy could not be dropped; nothing was deleted. Make the scratch database reachable and run this again.'); return 1; }
      const gone: string[] = [];
      if (existsSync(cap)) for (const f of readdirSync(cap)) if (f !== 'state.json' && f !== 'off') { rmSync(join(cap, f), { recursive: true, force: true }); gone.push(join(cap, f)); }
      const runs = join(io.brain.dir, 'replay');
      if (existsSync(runs)) { rmSync(runs, { recursive: true, force: true }); gone.push(runs); }
      io.out(gone.length ? `Deleted:\n${gone.join('\n')}` : 'Nothing to delete.');
      return 0;
    }
    throw new ReplayError('shadow_capture_off', `unknown capture action ${action ?? '(none)'}; use on, off, status or delete`);
  }

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
  const config = io.config();
  return {
    shadowDir: io.brain.dir, brainKey: io.brain.key, primaryEngine: io.brain.engine as 'pglite' | 'postgres', primaryUrl: config?.database_url ?? null,
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
      const proc = bunSpawn([...resolveServeGbrainCommand({ which: () => null }), 'engine', 'shadow', '__replay-child', runDir], { env, stdout: 'ignore', stderr: 'inherit' });
      return { exited: proc.exited, kill: () => proc.kill('SIGKILL') };
    },
  };
}

/** The engine config of a SQL copy: a PGLite path or a Postgres URL. */
function sqlConfig(kind: 'pglite' | 'postgres', where: string): EngineConfig {
  switch (kind) {
    case 'pglite': return { engine: kind, database_path: where } as EngineConfig;
    case 'postgres': return { engine: kind, database_url: where, poolSize: 2 } as EngineConfig; // own pool, never the module singleton
    default: { const unreachable: never = kind; return unreachable; }
  }
}

/** Opens one work copy in the replay child (no shadow, no capture: GBRAIN_SHADOW_CHILD=1). */
export async function openReplayArm(arm: 'pglite' | 'postgres' | 'rust', spec: import('../shadow/replay.ts').RunSpec): Promise<BrainEngine> {
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
  const cfg = sqlConfig(arm, arm === 'postgres' ? process.env[spec.arms.postgres!.url_env] ?? '' : spec.arms.pglite);
  const e = await createEngine(cfg);
  await e.connect(cfg);
  if (arm === 'postgres') {
    // Replay writes only into the copy this brain's seed made: its owner marker must name this brain.
    const { scratchOwner } = await import('../shadow/replay-copy.ts');
    if (await scratchOwner(e) !== spec.brain_key) { await e.disconnect(); throw new ReplayError('shadow_replay_postgres_not_owned', 'the replay Postgres arm is not this brain\'s seeded copy'); }
  }
  return e;
}
