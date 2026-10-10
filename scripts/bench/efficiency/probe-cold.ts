#!/usr/bin/env bun
/**
 * Cold CLI start breakdown (GBRA-66). Opt-in, never run in CI.
 *
 *   bun scripts/bench/efficiency/probe-cold.ts [--label synth-full] [--engine postgres] [--n 20]
 *
 * Splits a fresh-process CLI call into: bun start (`bun -e 1`), module graph
 * (`import('src/cli.ts')` timed in-process), `gbrain --version`, and real reads,
 * each with stdout piped (what an agent shelling out sees) and with
 * GBRAIN_FLUSH_GRACE_MS=0 (the exit-flush grace that cli-force-exit.ts holds when
 * stdout is not a TTY). Prints a markdown table; with --label it also runs
 * `list` and `call get_page` against engines/<engine>-<label>.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLI, REPO, WORK, flag, machine, pct } from './lib.ts';

const N = Number(flag('n', '20'));
const label = flag('label');
const engine = flag('engine', 'postgres')!;
const home = label ? join(WORK, 'engines', `${engine}-${label}`) : undefined;
if (home && !existsSync(home)) throw new Error(`no brain at ${home}`);

async function time(argv: string[], env: Record<string, string> = {}): Promise<number> {
  const t = performance.now();
  const p = Bun.spawn(argv, { cwd: REPO, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...(home ? { GBRAIN_HOME: home } : {}), ...env } });
  await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return performance.now() - t;
}

async function row(name: string, argv: string[], env: Record<string, string> = {}) {
  await time(argv, env);
  const ms: number[] = [];
  for (let i = 0; i < N; i++) ms.push(await time(argv, env));
  console.log(`| ${name} | ${N} | ${pct(ms, 0.5).toFixed(0)} | ${pct(ms, 0.95).toFixed(0)} |`);
}

const bun = process.execPath;
const importProbe = `const t=performance.now(); await import(${JSON.stringify(CLI.replace(/cli\.ts$/, 'core/operations.ts'))}); console.log(performance.now()-t)`;
console.log(`machine: ${machine()}  engine: ${home ? engine : 'none'}  brain: ${label ?? 'none'}  mode: cold (fresh process, stdout piped)\n`);
console.log('| step | N | p50 ms | p95 ms |\n|---|---|---|---|');
await row('bun -e 1', [bun, '-e', '1']);
await row('import src/core/operations.ts (module graph only)', [bun, '-e', importProbe]);
await row('gbrain --version', [bun, CLI, '--version']);
await row('gbrain --version, GBRAIN_FLUSH_GRACE_MS=0', [bun, CLI, '--version'], { GBRAIN_FLUSH_GRACE_MS: '0' });
if (home) {
  await row('gbrain list --limit 5', [bun, CLI, 'list', '--limit', '5']);
  await row('gbrain list --limit 5, GBRAIN_FLUSH_GRACE_MS=0', [bun, CLI, 'list', '--limit', '5'], { GBRAIN_FLUSH_GRACE_MS: '0' });
  await row('gbrain call get_page (missing slug)', [bun, CLI, 'call', 'get_page', '{"slug":"bench/missing"}']);
  await row('gbrain call get_page, GBRAIN_FLUSH_GRACE_MS=0', [bun, CLI, 'call', 'get_page', '{"slug":"bench/missing"}'], { GBRAIN_FLUSH_GRACE_MS: '0' });
}
