/**
 * Rust engine shadow mode end to end (Phase S1 and the read half of S2): the CLI under a temporary GBRAIN_HOME, the
 * engine factory's off and on paths, the `rust_engine_addon` doctor check, and a real child process spawned by the
 * supervisor. Serial because it sets GBRAIN_HOME.
 */
import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { runShadowChild } from '../src/shadow/child.ts';
import { Readable } from 'node:stream';
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

/** A stand-in for the brain `start` opens once to read its storage mode, so these tests do not open a real database. */
const unmanagedBrain = { openPrimary: async () => ({ executeRaw: async () => [{ enabled: false }], disconnect: async () => undefined }) as never };

const okAddon = async () => ({ ok: true as const, addon: { target: 'linux-x64-glibc', engineAbi: 1, engineBuild: 'b1' } as never });

async function startShadow(config: EngineConfig): Promise<string> {
  const plan = capture();
  expect(await runEngineShadow(['start', '--plan'], { ...plan.deps, config: () => config, ...unmanagedBrain })).toBe(0);
  const hash = plan.out.find((l) => l.startsWith('plan_hash: '))!.slice('plan_hash: '.length);
  const go = capture();
  expect(await runEngineShadow(['start', '--yes', '--expect', hash], { ...go.deps, config: () => config, ...unmanagedBrain, loadAddon: okAddon })).toBe(0);
  return hash;
}

describe('gbrain engine shadow', () => {
  test('start previews a plan and needs --yes with the matching hash', async () => {
    await inHome(async (_home, config) => {
      const preview = capture();
      expect(await runEngineShadow(['start'], { ...preview.deps, config: () => config, ...unmanagedBrain })).toBe(3);
      expect(preview.out.join('\n')).toContain('never writes: brain content (pages, chunks, facts, links), the brain config table, the brain repo');
      const wrong = capture();
      expect(await runEngineShadow(['start', '--yes', '--expect', 'nope'], { ...wrong.deps, config: () => config, ...unmanagedBrain, loadAddon: okAddon })).toBe(3);
      expect(wrong.err.join('\n')).toContain('preview_changed');
      const dir = shadowDirFor(shadowBrainKey(config)!);
      expect(existsSync(dir)).toBe(false);
    });
  });

  test('a refused addon keeps shadow mode off and writes nothing', async () => {
    await inHome(async (_home, config) => {
      const plan = capture();
      await runEngineShadow(['start', '--plan'], { ...plan.deps, config: () => config, ...unmanagedBrain });
      const hash = plan.out.find((l) => l.startsWith('plan_hash: '))!.slice(11);
      const go = capture();
      const code = await runEngineShadow(['start', '--yes', '--expect', hash], {
        ...go.deps, config: () => config, ...unmanagedBrain,
        loadAddon: async () => ({ ok: false, code: 'rust_engine_addon_missing', reason: 'release_unavailable', message: 'Could not read the release.' }),
      });
      expect(code).toBe(1);
      expect(go.err[0]).toBe('engine shadow: rust_engine_addon_missing (release_unavailable): Could not read the release.');
      expect(existsSync(shadowDirFor(shadowBrainKey(config)!))).toBe(false);
    });
  });

  test('start with no addon installed refuses with the install command and keeps shadow mode off', async () => {
    await inHome(async (_home, config) => {
      const plan = capture();
      await runEngineShadow(['start', '--plan'], { ...plan.deps, config: () => config, ...unmanagedBrain });
      const hash = plan.out.find((l) => l.startsWith('plan_hash: '))!.slice(11);
      const go = capture();
      expect(await runEngineShadow(['start', '--yes', '--expect', hash], { ...go.deps, config: () => config, ...unmanagedBrain })).toBe(1);
      expect(go.err[0]).toStartWith('engine shadow: rust_engine_addon_missing (');
      expect(go.err[0]).toContain('gbrain engine install rust');
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
      // An unmanaged brain's shadow is the opt-in swap's evidence: it compares every write (rate 1.0, D26 / ask D).
      expect(state.write_sample_rate).toBe(1);
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

describe('brain selection', () => {
  test('a command that selects a mounted brain refuses and leaves the host brain alone, stop --delete included', async () => {
    await inHome(async (_home, config) => {
      await startShadow(config);
      const dir = shadowDirFor(shadowBrainKey(config)!);
      for (const sub of [['status'], ['report'], ['start', '--plan'], ['stop'], ['stop', '--delete']]) {
        const c = capture();
        expect(await runEngineShadow(sub, { ...c.deps, config: () => config, brainId: () => 'team' }), sub.join(' ')).toBe(2);
        expect(c.err.join('\n')).toContain('host brain only');
      }
      expect(existsSync(dir)).toBe(true);
      expect(readShadowState(dir)?.enabled).toBe(true);
      const ok = capture();
      expect(await runEngineShadow(['status'], { ...ok.deps, config: () => config, brainId: () => 'host' })).toBe(0);
      // The default resolver reads GBRAIN_BRAIN_ID the way every command does.
      await withEnv({ GBRAIN_BRAIN_ID: 'team' }, async () => {
        const env = capture();
        expect(await runEngineShadow(['stop', '--delete'], { ...env.deps, config: () => config })).toBe(2);
        expect(env.err.join('\n')).toContain('selects the brain team');
      });
      expect(existsSync(dir)).toBe(true);
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

describe('a short-lived parent', () => {
  const readLine = (op: string) => JSON.stringify({ t: 'read', id: 1, at: Date.now(), op, primary_ms: 1, args: encodeValue(['a']), result: encodeValue({ slug: 'a' }) }) + '\n';
  const childArgv = (dir: string) => [join(REPO, 'src', 'cli.ts'), 'engine', 'shadow', '__child', dir];
  const gone = async (pid: number, ms: number): Promise<boolean> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 100)); } catch { return true; }
    }
    return false;
  };
  const ledgerRows = (dir: string): number => {
    const file = join(dir, 'ledger', new Date().toISOString().slice(0, 10) + '.jsonl');
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
  };

  test('a CLI-shaped parent that queues reads and closes its end of the pipe still gets ledger rows, not a SIGPIPE exit', async () => {
    await inHome(async (_home, config) => {
      await startShadow(config);
      const dir = shadowDirFor(shadowBrainKey(config)!);
      const child = spawn(process.execPath, childArgv(dir), { stdio: ['pipe', 'pipe', 'ignore'] });
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
      child.stdin!.write(readLine('getPage') + readLine('getPage'));
      child.stdout!.destroy(); // the parent's read end closes first, as when a CLI call ends
      child.stdin!.end();
      const result = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 60_000))]);
      expect(result).not.toBeNull();
      expect(result).toEqual({ code: 0, signal: null });
      expect(ledgerRows(dir)).toBeGreaterThanOrEqual(1);
    });
  }, 120_000);

  test('a child whose parent has exited still records its reads and exits', async () => {
    await inHome(async (home, config) => {
      await startShadow(config);
      const dir = shadowDirFor(shadowBrainKey(config)!);
      const script = join(home, 'parent.mjs');
      writeFileSync(script, `import { spawn } from 'node:child_process';
const c = spawn(process.argv[2], JSON.parse(process.argv[3]), { stdio: ['pipe', 'pipe', 'ignore'] });
c.stdin.write(${JSON.stringify(readLine('getPage'))});
console.log(c.pid);
process.exit(0);
`);
      const parent = spawn(process.execPath, [script, process.execPath, JSON.stringify(childArgv(dir))], { stdio: ['ignore', 'pipe', 'inherit'] });
      let printed = '';
      parent.stdout!.on('data', (d) => { printed += d; });
      await new Promise((r) => parent.once('exit', r));
      const pid = Number(printed.trim());
      expect(pid).toBeGreaterThan(0);
      expect(await gone(pid, 60_000)).toBe(true);
      expect(ledgerRows(dir)).toBeGreaterThanOrEqual(1);
    });
  }, 120_000);

  test('a child stuck in a call after its input ends flushes what it has and exits at the deadline', async () => {
    await inHome(async (_home, config) => {
      await startShadow(config);
      const dir = shadowDirFor(shadowBrainKey(config)!);
      const never = new Promise<never>(() => {});
      let calls = 0;
      let exitCode = null as number | null;
      const input = Readable.from([readLine('getPage'), readLine('getPage'), readLine('getPage')]);
      const done = runShadowChild(dir, {
        input,
        writeControl: () => {},
        loadAddon: async () => ({ ok: true as const, addon: {} as never }),
        openEngine: () => ({ connect: async () => {}, disconnect: async () => {}, getPage: () => (calls++ === 0 ? Promise.resolve({ slug: 'a' }) : never) }) as never,
        timeoutMs: 60_000,
        exitDeadlineMs: 300,
        exit: (code) => { exitCode = code; },
      });
      const until = Date.now() + 10_000;
      while (exitCode === null && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      expect(exitCode).toBe(0);
      expect(ledgerRows(dir)).toBe(1); // the finished comparison was flushed before the exit, not lost with the stuck one
      expect(readShadowSummary(dir).child_shed).toBe(1); // the read still queued behind the stuck one is counted as dropped, not silently lost
      void done;
    });
  }, 60_000);

  test('a child whose Rust store never finishes opening still exits at the deadline, recording its reads as unavailable', async () => {
    await inHome(async (_home, config) => {
      await startShadow(config);
      const dir = shadowDirFor(shadowBrainKey(config)!);
      let exitCode = null as number | null;
      const done = runShadowChild(dir, {
        input: Readable.from([readLine('getPage')]),
        writeControl: () => {},
        loadAddon: async () => ({ ok: true as const, addon: {} as never }),
        openEngine: () => ({ connect: () => new Promise<void>(() => {}), disconnect: async () => {} }) as never,
        exitDeadlineMs: 300,
        exit: (code) => { exitCode = code; },
      });
      const until = Date.now() + 10_000;
      while (exitCode === null && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      expect(exitCode).toBe(0);
      expect(ledgerRows(dir)).toBe(1);
      void done;
    });
  }, 60_000);

  test('a child that gave up on opening its store closes the store if the open finishes later, and sends no heartbeat so it is restarted', async () => {
    await inHome(async (_home, config) => {
      await startShadow(config);
      const dir = shadowDirFor(shadowBrainKey(config)!);
      let finishOpen = () => {};
      let disconnected = 0;
      let heartbeats = 0;
      let exitCode = null as number | null;
      const input = new Readable({ read() {} });
      const done = runShadowChild(dir, {
        input,
        writeControl: () => { heartbeats++; },
        loadAddon: async () => ({ ok: true as const, addon: {} as never }),
        openEngine: () => ({ connect: () => new Promise<void>((r) => { finishOpen = r; }), disconnect: async () => { disconnected++; } }) as never,
        exitDeadlineMs: 200,
        heartbeatMs: 25,
        exit: (code) => { exitCode = code; },
      });
      // gstack-timing-ok: the contract is the 200 ms open deadline, so the test must wait past it (3x) with input still open
      await new Promise((r) => setTimeout(r, 600)); // past the open deadline, input still open
      expect(heartbeats).toBe(0);
      finishOpen(); // the open completes after the child gave up on it
      const until = Date.now() + 5_000;
      while (disconnected === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      expect(disconnected).toBe(1);
      expect(heartbeats).toBe(0);
      input.push(null);
      await done;
      expect(exitCode === null || exitCode === 0).toBe(true);
    });
  }, 60_000);

  test('a completed comparison reaches the ledger on a timer, without waiting for more reads or the end of input', async () => {
    await inHome(async (_home, config) => {
      await startShadow(config);
      const dir = shadowDirFor(shadowBrainKey(config)!);
      const input = new Readable({ read() {} });
      input.push(readLine('getPage'));
      const done = runShadowChild(dir, {
        input,
        writeControl: () => {},
        loadAddon: async () => ({ ok: true as const, addon: {} as never }),
        openEngine: () => ({ connect: async () => {}, disconnect: async () => {}, getPage: async () => ({ slug: 'a' }) }) as never,
        flushMs: 100,
      });
      const until = Date.now() + 10_000;
      while (ledgerRows(dir) === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
      const flushedWhileOpen = ledgerRows(dir);
      input.push(null);
      await done;
      expect(flushedWhileOpen).toBe(1);
    });
  }, 60_000);
});
