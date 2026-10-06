/**
 * D-N1 (fix wave 9) — `gbrain eval <sub> --help` must print that
 * subcommand's own usage, not the generic `gbrain eval --qrels` block.
 *
 * The subcommand list is read from `gbrain eval --help` itself, so a new
 * subcommand added to the eval usage block is covered without editing this
 * file. Hermetic no-brain env: help must work before a brain exists.
 */

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const CLI_ENTRY = join(process.cwd(), 'src/cli.ts');
const GENERIC_EVAL_USAGE = 'gbrain eval — measure and compare retrieval quality';

function runCli(args: string[]): { out: string; status: number } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GBRAIN_HOME: '/tmp/gbrain-test-help-dn1-nonexistent',
  };
  delete env.GBRAIN_DATABASE_URL;
  delete env.DATABASE_URL;
  const result = spawnSync('bun', ['--no-env-file', 'run', CLI_ENTRY, ...args], { encoding: 'utf8', env });
  return { out: `${result.stdout ?? ''}${result.stderr ?? ''}`, status: result.status ?? -1 };
}

function listedSubcommands(): string[] {
  const { out } = runCli(['eval', '--help']);
  const section = out.split('SUBCOMMANDS')[1]?.split('\nOPTIONS')[0] ?? '';
  const names: string[] = [];
  for (const line of section.split('\n')) {
    const m = /^\s{2}([a-z][a-z0-9-]*(?:\s\/\s[a-z][a-z0-9-]*)*)\s{2,}/.exec(line);
    if (m) names.push(...m[1].split(' / '));
  }
  return names;
}

describe('D-N1 — every eval subcommand answers --help with its own usage', () => {
  const subs = listedSubcommands();

  test('the eval usage block lists the subcommands this test iterates', () => {
    expect(subs.length).toBeGreaterThanOrEqual(15);
    expect(subs).toContain('replay');
    expect(subs).toContain('suspected-contradictions');
  }, 60000);

  for (const sub of subs) {
    test(`eval ${sub} --help`, () => {
      const { out, status } = runCli(['eval', sub, '--help']);
      expect(status).not.toBe(-1);
      expect(out).not.toContain(GENERIC_EVAL_USAGE);
      expect(out).toContain(sub);
    }, 60000);
  }

  test('an unknown subcommand still gets the generic eval usage', () => {
    const { out, status } = runCli(['eval', 'not-a-real-sub', '--help']);
    expect(status).toBe(0);
    expect(out).toContain(GENERIC_EVAL_USAGE);
  }, 60000);
});
