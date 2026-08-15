/**
 * `gbrain jobs [--help]` + `gbrain jobs <subcommand> --help` guard.
 *
 * Regression test for two defects:
 *  1. `jobs` was in CLI_ONLY but not CLI_ONLY_SELF_HELP, so `jobs --help`
 *     printed the generic one-line stub — the real help block in jobs.ts was
 *     unreachable, and the worker entry point (`jobs work`) was undiscoverable
 *     from the CLI during an incident.
 *  2. With the stub gone, a help token AFTER the subcommand name would have
 *     fallen through into the subcommand body — `jobs work --help` would have
 *     started a REAL worker daemon (same defect class the bootstrap
 *     subcommand-help guard fixed). The guard in runJobs intercepts before
 *     the thin-client refusal and the switch.
 *
 * Each case spawns the actual CLI with an empty GBRAIN_HOME and no database
 * env (the cli-help-without-brain env hygiene), so a pass proves the whole
 * dispatch path answers engine-free AND exits — a started daemon would hang
 * the spawn until the test timeout.
 *
 * Serial: spawns the CLI; keeps its wall clock out of the parallel shards.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const STUB_MARKER = 'run gbrain --help for the full command list';

async function runJobsHelp(args: string[]): Promise<{ code: number; out: string }> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-jobshelp-'));
  // Empty GBRAIN_HOME is not enough: loadConfig also honours
  // GBRAIN_DATABASE_URL / DATABASE_URL, and bun auto-loads .env from cwd —
  // both would let the CLI connect an engine and mask a broken guard.
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home };
  delete env.GBRAIN_DATABASE_URL;
  delete env.DATABASE_URL;
  const proc = Bun.spawn(['bun', '--no-env-file', 'run', 'src/cli.ts', 'jobs', ...args], {
    cwd: REPO,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out: stdout + stderr };
}

describe('jobs --help and jobs <subcommand> --help print real help, never the stub, never a daemon', () => {
  test('jobs --help: full help block, not the stub', async () => {
    const { code, out } = await runJobsHelp(['--help']);
    expect(code).toBe(0);
    expect(out).toContain('Minions job queue');
    expect(out).toContain('jobs work');
    expect(out).toContain('jobs supervisor');
    expect(out).toContain('jobs watch');
    expect(out).not.toContain(STUB_MARKER);
    expect(out).not.toContain('No brain configured');
  }, 30_000);

  test('jobs -h: short-flag parity', async () => {
    const { code, out } = await runJobsHelp(['-h']);
    expect(code).toBe(0);
    expect(out).toContain('Minions job queue');
    expect(out).not.toContain(STUB_MARKER);
  }, 30_000);

  test('jobs work --help: worker flags documented; NO worker daemon starts (fast exit proves it)', async () => {
    const { code, out } = await runJobsHelp(['work', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('--max-rss');
    expect(out).toContain('--health-interval');
    expect(out).toContain('GBRAIN_WORKER_CONCURRENCY');
    // issue #5 process isolation: flag + env fallback documented.
    expect(out).toContain('--job-isolation');
    expect(out).toContain('GBRAIN_JOB_ISOLATION');
    expect(out).not.toContain(STUB_MARKER);
    // A real `jobs work` on this fixture would refuse (thin-client/engine
    // path) or start a daemon; either output would differ from the help.
    expect(out).not.toContain('needs a local engine');
  }, 30_000);

  test('jobs supervisor --help: supervisor flags + exit codes', async () => {
    const { code, out } = await runJobsHelp(['supervisor', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('--max-crashes');
    expect(out).toContain('--pid-file');
    expect(out).not.toContain(STUB_MARKER);
  }, 30_000);

  test('jobs submit -h: submit flags documented', async () => {
    const { code, out } = await runJobsHelp(['submit', '-h']);
    expect(code).toBe(0);
    expect(out).toContain('--idempotency-key');
    expect(out).toContain('--max-waiting');
    expect(out).not.toContain(STUB_MARKER);
  }, 30_000);

  test('jobs watch --help: documents the equals-only --refresh-ms form', async () => {
    const { code, out } = await runJobsHelp(['watch', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('--refresh-ms=N');
    expect(out).not.toContain(STUB_MARKER);
  }, 30_000);

  test('jobs prune --help: prune flags documented, nothing pruned', async () => {
    const { code, out } = await runJobsHelp(['prune', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('--older-than');
    expect(out).not.toContain(STUB_MARKER);
  }, 30_000);

  test('jobs stats --help: no dedicated entry → falls back to the full help block', async () => {
    const { code, out } = await runJobsHelp(['stats', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('Minions job queue');
    expect(out).toContain('--cluster-errors');
    expect(out).not.toContain(STUB_MARKER);
  }, 30_000);

  test('jobs constructor --help: prototype key falls back to the full help, never Object.prototype garbage', async () => {
    // Red-team finding: a plain-object lookup resolves inherited keys, so
    // without Object.hasOwn this printed `function Object() { ... }`.
    const { code, out } = await runJobsHelp(['constructor', '--help']);
    expect(code).toBe(0);
    expect(out).toContain('Minions job queue');
    expect(out).not.toContain('native code');
    expect(out).not.toContain('function Object');
    expect(out).not.toContain(STUB_MARKER);
  }, 30_000);
});
