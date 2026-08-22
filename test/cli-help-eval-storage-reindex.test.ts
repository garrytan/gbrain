/**
 * #3686 (the #578 residue) — `eval` / `storage` / `reindex` --help must print
 * real usage, not the generic one-line CLI_ONLY stub.
 *
 * Pre-fix, all three exited 0 with `gbrain <cmd> - run gbrain --help for the
 * full command list.` — for eval that hid a 15-subcommand surface whose help
 * block already shipped in the binary and was reachable ONLY via the
 * missing-required-arg error path.
 *
 * Same subprocess pattern as test/cli-help-discoverability.test.ts: hermetic
 * no-brain env, so these also pin that help works on a machine with no brain
 * configured (the state a --help reader is most likely in).
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CLI_ENTRY = join(process.cwd(), 'src/cli.ts');

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GBRAIN_HOME: '/tmp/gbrain-test-help-3686-nonexistent',
  };
  delete env.GBRAIN_DATABASE_URL;
  delete env.DATABASE_URL;
  const result = spawnSync('bun', ['--no-env-file', 'run', CLI_ENTRY, ...args], {
    encoding: 'utf8',
    env,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status ?? -1,
  };
}

const GENERIC_STUB = 'run gbrain --help for the full command list';

describe('#3686 — gbrain eval --help prints the real usage block', () => {
  test('reaches eval.ts printHelp with the subcommand surface, engine-free', () => {
    const { stdout, status } = runCli(['eval', '--help']);
    expect(status).toBe(0);
    expect(stdout).not.toContain(GENERIC_STUB);
    // The qrels A/B core plus subcommands the old stub hid.
    expect(stdout).toContain('--qrels');
    expect(stdout).toContain('replay');
    expect(stdout).toContain('brainbench');
  }, 60000);

  test('eval brainbench --help still prints brainbench usage, not the eval block', () => {
    const { stdout, stderr, status } = runCli(['eval', 'brainbench', '--help']);
    // brainbench owns its 0/1/2 CI exit contract and (pre-existing on this
    // branch) exits 2 on --help; this test pins WHICH usage wins, not the
    // exit code. Its own usage must beat the generic eval block.
    expect(status).not.toBe(-1);
    const out = stdout + stderr;
    expect(out).not.toContain(GENERIC_STUB);
    expect(out).toContain('gbrain eval brainbench');
    expect(out).not.toContain('--qrels');
  }, 60000);
});

describe('#3686 — gbrain storage --help prints the real usage block', () => {
  test('names the status subcommand and its flags, engine-free', () => {
    const { stdout, status } = runCli(['storage', '--help']);
    expect(status).toBe(0);
    expect(stdout).not.toContain(GENERIC_STUB);
    expect(stdout).toContain('status');
    expect(stdout).toContain('--repo');
    expect(stdout).toContain('--json');
  }, 60000);
});

describe('#3686 — gbrain reindex --help prints the real usage block', () => {
  test('names all three targets incl. the dispatcher-parsed --multimodal flags, engine-free', () => {
    const { stdout, status } = runCli(['reindex', '--help']);
    expect(status).toBe(0);
    expect(stdout).not.toContain(GENERIC_STUB);
    expect(stdout).toContain('--markdown');
    expect(stdout).toContain('--multimodal');
    expect(stdout).toContain('--aliases');
    // The --multimodal flags that were parsed only in cli.ts's dispatcher
    // and documented nowhere.
    expect(stdout).toContain('--cost-estimate');
    expect(stdout).toContain('--workers');
  }, 60000);
});
