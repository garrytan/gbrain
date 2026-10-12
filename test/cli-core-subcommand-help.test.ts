/**
 * #6521 `gbrain core <subcommand> --help` must print the core usage without reading the engine.
 *
 * `core` is a SELF_HELP_WITHOUT_ENGINE entry (src/cli/main.ts): with a help flag present the CLI calls its handler with
 * a null engine, so every subcommand must answer help before touching it. `core --help` alone was already pinned by
 * test/cli-help-without-brain.test.ts; this pins the nested forms. It runs the real CLI with an empty GBRAIN_HOME and
 * no database URL, the same setup as that file, so a regression shows up as a null-engine internal error.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const SUBCOMMANDS = ['list', 'show', 'status', 'add', 'remove', 'diff', 'ack', 'init', 'suggest'] as const;
const USAGE_LINE = 'Usage: gbrain core <list|show|status|add|remove|diff|ack|init|suggest> [options]';

async function runCore(args: string[]): Promise<{ code: number; out: string }> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-core-help-'));
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home };
  // A configured database URL would let the CLI connect and make the positive assertions inert.
  delete env.GBRAIN_DATABASE_URL;
  delete env.DATABASE_URL;
  const proc = Bun.spawn(['bun', '--no-env-file', 'run', 'src/cli.ts', 'core', ...args], {
    cwd: REPO, env, stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out: stdout + stderr };
}

const NULL_ENGINE_SIGNS = ['null is not an object', 'internal_error', 'TypeError', 'Cannot read', 'No brain configured', 'needs a page slug'];

describe('#6521 core <subcommand> --help answers without a brain', () => {
  test('every subcommand prints the core usage, exit 0, and never reaches the engine', async () => {
    const results = await Promise.all(SUBCOMMANDS.map(async (sub) => ({ sub, ...(await runCore([sub, '--help'])) })));
    for (const r of results) {
      expect(r.code, `core ${r.sub} --help exit code`).toBe(0);
      expect(r.out, `core ${r.sub} --help output`).toContain(USAGE_LINE);
      for (const sign of NULL_ENGINE_SIGNS) expect(r.out, `core ${r.sub} --help must not contain "${sign}"`).not.toContain(sign);
    }
  }, 120_000);

  test('-h and a help flag after other options also answer with the usage', async () => {
    for (const args of [['list', '-h'], ['status', '--json', '--help'], ['init', '--source', 'default', '--help'], ['add', 'some-slug', '--help']]) {
      const r = await runCore(args);
      expect(r.code, `core ${args.join(' ')} exit code`).toBe(0);
      expect(r.out, `core ${args.join(' ')} output`).toContain(USAGE_LINE);
      for (const sign of NULL_ENGINE_SIGNS) expect(r.out).not.toContain(sign);
    }
  }, 120_000);

  // `core help` (the bare word) is not a help flag, so the CLI still connects for it; that is outside this issue.
  test('the existing top-level help flags are unchanged', async () => {
    for (const args of [['--help'], ['-h']]) {
      const r = await runCore(args);
      expect(r.code, `core ${args.join(' ')} exit code`).toBe(0);
      expect(r.out).toContain(USAGE_LINE);
    }
  }, 60_000);

  // Control: the early help answer must not swallow ordinary invocations. Without a help flag and without a brain,
  // `core status` still needs the engine, so it must NOT print the usage block.
  test('control: a normal invocation without a help flag does not print the usage block', async () => {
    const r = await runCore(['status']);
    expect(r.out).not.toContain(USAGE_LINE);
  }, 60_000);
});
