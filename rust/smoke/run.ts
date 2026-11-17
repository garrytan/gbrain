#!/usr/bin/env bun
/**
 * The Rust engine addon smoke test. A standalone script on purpose: it is not a `bun test`
 * file, so the repo's test preloads cannot strip GBRAIN_RUST_ENGINE_ADDON.
 *
 *   bun run rust:build
 *   export GBRAIN_RUST_ENGINE_ADDON=<path printed by the build>
 *   bun rust/smoke/run.ts
 *
 * It runs every case in cases.ts, then three process-level checks:
 *   1. a child process leaves with process.exit(0) while native tasks run (must exit 0, fast);
 *   2. the same child left to exit naturally (measured and reported, not a pass/fail gate);
 *   3. a `bun build --compile` executable loads the addon and passes its self-check.
 * Exit code 0 means every check passed.
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAddon } from './addon.ts';
import { cases } from './cases.ts';

const smokeDir = dirname(fileURLToPath(import.meta.url));
const addonPath = process.env.GBRAIN_RUST_ENGINE_ADDON;
if (!addonPath) {
  console.error('GBRAIN_RUST_ENGINE_ADDON is not set. Run `bun run rust:build` and export the path it prints.');
  process.exit(2);
}
const absoluteAddon = resolve(addonPath);

interface Outcome {
  name: string;
  ok: boolean;
  detail?: string;
}
const outcomes: Outcome[] = [];

async function check(name: string, body: () => Promise<void> | void): Promise<void> {
  const startedAt = performance.now();
  try {
    await body();
    outcomes.push({ name, ok: true });
    console.log(`  ok    ${name} (${(performance.now() - startedAt).toFixed(0)} ms)`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    outcomes.push({ name, ok: false, detail });
    console.log(`  FAIL  ${name}\n        ${detail.split('\n').join('\n        ')}`);
  }
}

interface ChildResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  ms: number;
  stdout: string;
  stderr: string;
}

async function runChild(cmd: string[], timeoutMs: number): Promise<ChildResult> {
  const startedAt = performance.now();
  const child = Bun.spawn(cmd, {
    cwd: smokeDir,
    env: { ...process.env, GBRAIN_RUST_ENGINE_ADDON: absoluteAddon },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  clearTimeout(timer);
  return {
    exitCode: child.exitCode,
    signal: child.signalCode,
    timedOut,
    ms: performance.now() - startedAt,
    stdout,
    stderr,
  };
}

console.log(`addon: ${absoluteAddon}`);
console.log(`bun:   ${Bun.version}`);
const addon = loadAddon(absoluteAddon);
console.log(`target ${addon.target}, abi ${addon.engineAbi}, build ${addon.engineBuild.slice(0, 12)}\n`);

console.log('in-process cases');
for (const testCase of cases) {
  await check(testCase.name, () => testCase.run(addon));
}

console.log('\nprocess-level checks');
await check('process.exit(0) while native tasks are running exits 0 without a crash', async () => {
  const result = await runChild([process.execPath, 'exit-child.ts', 'exit'], 20_000);
  assert.equal(result.timedOut, false, 'the child hung after process.exit(0)');
  assert.equal(result.exitCode, 0, `exit code ${result.exitCode}, signal ${result.signal}\n${result.stderr}`);
  assert.match(result.stdout, /ready running=2 queued=1/);
  assert.doesNotMatch(result.stderr, /panic|segmentation|crash|abort/i, result.stderr);
  // Native tasks run for 5 s; leaving while they run must not wait for them.
  assert.ok(result.ms < 4000, `child took ${result.ms.toFixed(0)} ms to exit`);
});

let naturalExit = 'not measured';
await check('natural exit with pending native tasks (measured, not a gate)', async () => {
  const result = await runChild([process.execPath, 'exit-child.ts', 'natural'], 25_000);
  assert.doesNotMatch(result.stderr, /panic|segmentation|crash/i, result.stderr);
  naturalExit = result.timedOut
    ? 'HUNG: still alive after 25 s and was killed'
    : `exited with code ${result.exitCode} after ${(result.ms / 1000).toFixed(1)} s ` +
      '(tasks were set to run 5 s, queued one 10 s)';
  console.log(`        ${naturalExit}`);
});

await check('a bun build --compile executable loads the addon and passes its self-check', async () => {
  const outDir = join(smokeDir, '..', 'target', 'smoke');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const exe = join(outDir, process.platform === 'win32' ? 'selfcheck.exe' : 'selfcheck');
  const compile = Bun.spawnSync(
    [process.execPath, 'build', '--compile', '--no-compile-autoload-bunfig', join(smokeDir, 'selfcheck.ts'), '--outfile', exe],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  assert.equal(compile.exitCode, 0, `compile failed:\n${compile.stderr.toString()}`);
  const result = await runChild([exe], 60_000);
  assert.equal(result.timedOut, false, 'the compiled executable hung');
  assert.equal(result.exitCode, 0, `exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /selfcheck ok: \d+ cases/);
  rmSync(outDir, { recursive: true, force: true });
});

const failed = outcomes.filter(o => !o.ok);
console.log(`\n${outcomes.length - failed.length}/${outcomes.length} checks passed. Natural exit: ${naturalExit}`);
process.exit(failed.length === 0 ? 0 : 1);
