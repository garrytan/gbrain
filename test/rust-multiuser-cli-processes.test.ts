/**
 * Multi-user mode, one short-lived CLI writer at a time (lane L5; the gbrain-evals multi-writer report): a
 * `gbrain call put_page` in its own process commits, and a `gbrain call get_page` in a NEW process reads the page back.
 * Every process gets an environment built from nothing (no inherited GBRAIN_* or HOME), so the run proves what a
 * fresh install sees, not what this test process happens to carry. With GBRAIN_RUST_MULTIUSER=1 in that environment
 * the brain the processes open is in multi-user mode; a probe process with the same environment asserts it, and the
 * same probe with the switch absent asserts it is off.
 *
 * Before the implicit-lease and dead-process takeover fixes, the put stayed `write_pending` (exit 10) and the page
 * was never found.
 *
 * Needs the addon `bun run rust:build` writes; skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error).
 */
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { rustArmAddonPath } from './engine-parity/rust-arm.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src/cli.ts');
const ADDON = rustArmAddonPath();
const HAVE_ADDON = detectAddonTarget() !== null && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

const WORK = mkdtempSync(join(process.env.TMPDIR || '/var/tmp', 'gbrain-mu-cli-'));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

interface Brain { home: string; user: string; }

function freshBrain(name: string): Brain {
  const home = join(WORK, name, 'gbrain-home');
  const user = join(WORK, name, 'user-home');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  mkdirSync(user, { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
    engine: 'rust', database_path: join(WORK, name, 'brain.rust'), embedding_disabled: true, schema_pack: 'gbrain-base-v2',
  }));
  return { home, user };
}

/** An environment built from nothing: only what a fresh shell on a clean machine would carry, plus the brain's paths. */
function bareEnv(brain: Brain, multiuser: boolean): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: process.env.TMPDIR || '/var/tmp', TZ: 'UTC', LANG: 'C.UTF-8', NO_COLOR: '1',
    GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_HOME: brain.home, HOME: brain.user, GBRAIN_RUST_ENGINE_ADDON: ADDON,
  };
  if (multiuser) env.GBRAIN_RUST_MULTIUSER = '1';
  return env;
}

interface Run { exit: number; stdout: string; stderr: string; ms: number; }

function run(brain: Brain, multiuser: boolean, args: string[]): Run {
  const t = performance.now();
  const p = Bun.spawnSync([process.execPath, ...args], { cwd: brain.home, env: bareEnv(brain, multiuser), stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
  return { exit: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString(), ms: Math.round(performance.now() - t) };
}

const cli = (brain: Brain, multiuser: boolean, ...args: string[]): Run => run(brain, multiuser, [CLI, ...args]);

/** A separate process with the same bare environment: opens the brain the way the CLI does and prints its mode. */
function probeMode(brain: Brain, multiuser: boolean): boolean {
  const script = `
    import { loadConfig } from ${JSON.stringify(join(ROOT, 'src/core/config.ts'))};
    import { createEngine } from ${JSON.stringify(join(ROOT, 'src/core/engine-factory.ts'))};
    const config = loadConfig();
    const engine = await createEngine(config);
    await engine.connect(config);
    const mode = engine.openStore('mode-probe').multiuser === true;
    await engine.disconnect();
    console.log(JSON.stringify({ multiuser: mode }));`;
  const r = run(brain, multiuser, ['-e', script]);
  if (r.exit !== 0) throw new Error(`mode probe exit ${r.exit}: ${r.stderr.slice(0, 2000)}`);
  return JSON.parse(r.stdout.trim().split('\n').pop()!).multiuser;
}

const detail = (r: Run): string => `exit ${r.exit} after ${r.ms} ms\nstdout: ${r.stdout.slice(0, 1500)}\nstderr: ${r.stderr.slice(0, 3000)}`;

withAddon('multi-user mode: one short-lived put_page process commits, and a new get_page process reads it back', () => {
  const brain = freshBrain('on');
  const init = cli(brain, true, 'init', '--migrate-only', '--non-interactive');
  expect(init.exit, detail(init)).toBe(0);
  expect(probeMode(brain, true)).toBe(true);

  const content = '---\ntitle: One writer\n---\nOne short-lived writer, then a reader in a new process.';
  const put = cli(brain, true, 'call', 'put_page', JSON.stringify({ slug: 'notes/one-writer', content }));
  expect(put.exit, detail(put)).toBe(0);
  expect(put.stdout + put.stderr).not.toContain('write_pending');

  const get = cli(brain, true, 'call', 'get_page', JSON.stringify({ slug: 'notes/one-writer' }));
  expect(get.exit, detail(get)).toBe(0);
  expect(get.stdout, detail(get)).toContain('One short-lived writer, then a reader in a new process.');

  // A second writer process after the first one exited is not blocked by the first one's registration.
  const second = cli(brain, true, 'call', 'put_page', JSON.stringify({ slug: 'notes/second-writer', content: '---\ntitle: Two\n---\nSecond.' }));
  expect(second.exit, detail(second)).toBe(0);
}, 600_000);

withAddon('the same bare environment without the switch opens the brain with multi-user mode off', () => {
  const brain = freshBrain('off');
  const init = cli(brain, false, 'init', '--migrate-only', '--non-interactive');
  expect(init.exit, detail(init)).toBe(0);
  expect(probeMode(brain, false)).toBe(false);
}, 300_000);
