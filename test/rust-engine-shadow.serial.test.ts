/**
 * Rust engine shadow mode end to end (Phase S1 and the read half of S2): the CLI under a temporary GBRAIN_HOME, the
 * engine factory's off and on paths, the `rust_engine_addon` doctor check, and a real child process spawned by the
 * supervisor. Serial because it sets GBRAIN_HOME.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { runEngineShadow } from '../src/commands/engine-shadow.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { viewedEngine } from '../src/core/persistence/switches.ts';

const isEngineView = (engine: object): boolean => viewedEngine(engine) !== engine;
import { rustEngineAddonCheck } from '../src/commands/doctor/checks/rust-engine-addon.ts';
import { readShadowSummary } from '../src/shadow/ledger.ts';
import { readShadowState, shadowBrainKey, shadowDirFor } from '../src/shadow/state.ts';
import { ShadowSupervisor } from '../src/shadow/supervisor.ts';
import { encodeValue } from '../src/shadow/codec.ts';
import type { EngineConfig } from '../src/core/types.ts';

const REPO = join(import.meta.dir, '..');

async function inHome<T>(fn: (home: string, config: EngineConfig) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-home-'));
  const config: EngineConfig = { engine: 'pglite', database_path: join(home, 'brain.pglite') };
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_SHADOW_CHILD: undefined, GBRAIN_RUST_ENGINE_ADDON: undefined }, () => fn(home, config));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

const okAddon = async () => ({ ok: true as const, addon: { target: 'linux-x64-glibc', engineAbi: 1, engineBuild: 'b1' } as never });

async function startShadow(config: EngineConfig): Promise<string> {
  const plan = capture();
  expect(await runEngineShadow(['start', '--plan'], { ...plan.deps, config: () => config })).toBe(0);
  const hash = plan.out.find((l) => l.startsWith('plan_hash: '))!.slice('plan_hash: '.length);
  const go = capture();
  expect(await runEngineShadow(['start', '--yes', '--expect', hash], { ...go.deps, config: () => config, loadAddon: okAddon })).toBe(0);
  return hash;
}

describe('gbrain engine shadow', () => {
  test('start previews a plan and needs --yes with the matching hash', async () => {
    await inHome(async (_home, config) => {
      const preview = capture();
      expect(await runEngineShadow(['start'], { ...preview.deps, config: () => config })).toBe(3);
      expect(preview.out.join('\n')).toContain('never writes: the brain database, the brain config table, the brain repo');
      const wrong = capture();
      expect(await runEngineShadow(['start', '--yes', '--expect', 'nope'], { ...wrong.deps, config: () => config, loadAddon: okAddon })).toBe(3);
      expect(wrong.err.join('\n')).toContain('preview_changed');
      const dir = shadowDirFor(shadowBrainKey(config)!);
      expect(existsSync(dir)).toBe(false);
    });
  });

  test('a refused addon keeps shadow mode off and writes nothing', async () => {
    await inHome(async (_home, config) => {
      const plan = capture();
      await runEngineShadow(['start', '--plan'], { ...plan.deps, config: () => config });
      const hash = plan.out.find((l) => l.startsWith('plan_hash: '))!.slice(11);
      const go = capture();
      const code = await runEngineShadow(['start', '--yes', '--expect', hash], {
        ...go.deps, config: () => config,
        loadAddon: async () => ({ ok: false, code: 'rust_engine_addon_missing', reason: 'release_unavailable', message: 'Could not read the release.' }),
      });
      expect(code).toBe(1);
      expect(go.err[0]).toBe('engine shadow: rust_engine_addon_missing (release_unavailable): Could not read the release.');
      expect(existsSync(shadowDirFor(shadowBrainKey(config)!))).toBe(false);
    });
  });

  test('start, status, report and stop --delete', async () => {
    await inHome(async (home, config) => {
      const hash = await startShadow(config);
      const dir = shadowDirFor(shadowBrainKey(config)!);
      expect(dir.startsWith(join(home, '.gbrain', 'shadow'))).toBe(true);
      const state = readShadowState(dir)!;
      expect(state).toMatchObject({ enabled: true, plan_hash: hash, sample_rate: 0.1, primary_engine: 'pglite' });
      expect(statSync(join(dir, 'state.json')).mode & 0o777).toBe(0o600);
      // The brain itself is untouched: no PGLite directory was created.
      expect(existsSync(config.database_path!)).toBe(false);

      const st = capture();
      expect(await runEngineShadow(['status', '--json'], { ...st.deps, config: () => config })).toBe(0);
      expect(JSON.parse(st.out[0])).toMatchObject({ enabled: true, totals: {} });

      const rep = capture();
      expect(await runEngineShadow(['report', '--json'], { ...rep.deps, config: () => config })).toBe(0);
      expect(JSON.parse(rep.out[0]).verdict).toBe('NOT READY');
      expect(existsSync(join(dir, 'reports', 'provisional.md'))).toBe(true);

      const stop = capture();
      expect(await runEngineShadow(['stop'], { ...stop.deps, config: () => config })).toBe(0);
      expect(readShadowState(dir)!.enabled).toBe(false);
      expect(await runEngineShadow(['stop', '--delete'], { ...capture().deps, config: () => config })).toBe(0);
      expect(existsSync(dir)).toBe(false);
    });
  });

  test('an unknown subcommand or flag is a usage error', async () => {
    await inHome(async (_home, config) => {
      const c = capture();
      expect(await runEngineShadow(['status', '--nope'], { ...c.deps, config: () => config })).toBe(2);
      expect(await runEngineShadow(['frobnicate'], { ...c.deps, config: () => config })).toBe(2);
      expect(await runEngineShadow(['start', '--sample-rate', '2'], { ...c.deps, config: () => config })).toBe(2);
    });
  });
});

describe('engine factory', () => {
  test('off: the factory returns the bare engine', async () => {
    await inHome(async (_home, config) => {
      const engine = await createEngine(config);
      expect(isEngineView(engine)).toBe(false);
      expect(existsSync(join(process.env.GBRAIN_HOME!, '.gbrain', 'shadow'))).toBe(false);
    });
  });

  test('on: the factory returns a shadow view of the engine; another brain stays bare', async () => {
    await inHome(async (home, config) => {
      await startShadow(config);
      const engine = await createEngine(config);
      expect(isEngineView(engine)).toBe(true);
      const other = await createEngine({ engine: 'pglite', database_path: join(home, 'other.pglite') });
      expect(isEngineView(other)).toBe(false);
      await withEnv({ GBRAIN_SHADOW_CHILD: '1' }, async () => {
        expect(isEngineView(await createEngine(config))).toBe(false);
      });
    });
  });
});

describe('rust_engine_addon doctor check', () => {
  test('not applicable while shadow mode is off', async () => {
    await inHome(async (_home, config) => {
      const check = await rustEngineAddonCheck(config, okAddon);
      expect(check).toMatchObject({ name: 'rust_engine_addon', status: 'ok', readiness_state: 'not_applicable' });
    });
  });

  test('ok with the addon identity, or fail with the refusal code and reason', async () => {
    await inHome(async (_home, config) => {
      await startShadow(config);
      expect(await rustEngineAddonCheck(config, okAddon)).toMatchObject({ status: 'ok', details: { target: 'linux-x64-glibc', engine_abi: 1, engine_build: 'b1' } });
      const fail = await rustEngineAddonCheck(config, async () => ({ ok: false, code: 'rust_engine_addon_mismatch', reason: 'digest', message: 'Checksum differs.' }));
      expect(fail.status).toBe('fail');
      expect(fail.message).toStartWith('rust_engine_addon_mismatch (digest): Checksum differs.');
      expect(fail.details).toEqual({ code: 'rust_engine_addon_mismatch', reason: 'digest' });
    });
  });

  test('the default loader never fetches: with nothing installed it reports not_installed', async () => {
    await inHome(async (_home, config) => {
      await startShadow(config);
      const check = await rustEngineAddonCheck(config);
      expect(check.status).toBe('fail');
      expect(check.details).toEqual({ code: 'rust_engine_addon_missing', reason: 'not_installed' });
    });
  });
});

describe('real child process', () => {
  test('the supervisor spawns gbrain engine shadow __child, which records each read and exits on EOF', async () => {
    await inHome(async (_home, config) => {
      await startShadow(config);
      const dir = shadowDirFor(shadowBrainKey(config)!);
      const sup = new ShadowSupervisor({ dir, argv: [process.execPath, join(REPO, 'src', 'cli.ts'), 'engine', 'shadow', '__child', dir] });
      const line = JSON.stringify({ t: 'read', id: 1, at: Date.now(), op: 'getPage', primary_ms: 1, args: encodeValue(['a']), result: encodeValue({ slug: 'a' }) }) + '\n';
      expect(sup.send(line)).toBe(true);
      expect(sup.childPid).not.toBeNull();
      const pid = sup.childPid!;
      sup.stop();
      const deadline = Date.now() + 60_000;
      let summary = readShadowSummary(dir);
      while (Date.now() < deadline && !summary.by_op.getPage) {
        await new Promise((r) => setTimeout(r, 100));
        summary = readShadowSummary(dir);
      }
      // No addon is installed in this home, so the child records addon_unavailable, never a guess.
      expect(summary.by_op.getPage).toEqual({ addon_unavailable: 1 });
      const ledgerFile = readFileSync(join(dir, 'ledger', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8');
      expect(ledgerFile).toContain('rust_engine_addon_missing:not_installed');
      // The child exits once its stdin closes.
      const exitDeadline = Date.now() + 30_000;
      let alive = true;
      while (alive && Date.now() < exitDeadline) {
        try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { alive = false; }
      }
      expect(alive).toBe(false);
    });
  }, 120_000);
});
