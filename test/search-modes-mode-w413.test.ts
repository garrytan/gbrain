/**
 * Wave 12 W4.13: `search modes --reset --mode <mode>` previews the reset;
 * `--source <mode>` (which names a brain source everywhere else) still works
 * with a deprecation notice. A missing value or conflicting `--mode` and
 * `--source` refuse (exit 2) and never fall through to deleting the overrides.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSearch } from '../src/commands/search.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { strictArgsProblem, STRICT_SUBCOMMANDS } from '../src/cli/strict-args.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  _resetCliExitVerdictForTests();
  await engine.setConfig('search.cache_enabled', 'false');
});

async function run(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const log = console.log;
  let stdout = '';
  let stderr = '';
  (process.stdout.write as unknown as (c: unknown) => boolean) = (c: unknown) => { stdout += String(c); return true; };
  (process.stderr.write as unknown as (c: unknown) => boolean) = (c: unknown) => { stderr += String(c); return true; };
  console.log = (...a: unknown[]) => { stdout += a.join(' ') + '\n'; };
  try { await runSearch(engine, ['modes', ...args]); } finally { process.stdout.write = out; process.stderr.write = err; console.log = log; }
  return { stdout, stderr };
}
const overrideKept = async () => (await engine.getConfig('search.cache_enabled')) === 'false';

describe('W4.13: search modes --reset --mode', () => {
  test('--mode previews and changes nothing', async () => {
    const r = await run('--reset', '--mode', 'tokenmax');
    expect(r.stdout).toContain('--mode tokenmax (dry run)');
    expect(currentExitCode()).toBe(0);
    expect(await overrideKept()).toBe(true);
  });

  test('--source still previews, with a deprecation notice', async () => {
    const r = await run('--reset', '--source', 'tokenmax');
    expect(r.stdout).toContain('(dry run)');
    expect(r.stderr).toContain('use --mode <mode>');
    expect(await overrideKept()).toBe(true);
  });

  test('a missing value refuses with exit 2 and never deletes the overrides', async () => {
    await run('--reset', '--mode');
    expect(currentExitCode()).toBe(2);
    expect(await overrideKept()).toBe(true);
    _resetCliExitVerdictForTests();
    await run('--reset', '--source', '--json');
    expect(currentExitCode()).toBe(2);
    expect(await overrideKept()).toBe(true);
  });

  test('conflicting --mode and --source refuse with exit 2', async () => {
    await run('--reset', '--mode', 'tokenmax', '--source', 'balanced');
    expect(currentExitCode()).toBe(2);
    expect(await overrideKept()).toBe(true);
  });

  test('plain --reset still clears the overrides', async () => {
    await run('--reset');
    expect(await overrideKept()).toBe(false);
  });

  test('the strict-args table accepts --mode and refuses its = form', () => {
    const spec = STRICT_SUBCOMMANDS['search modes']!;
    expect(strictArgsProblem(spec, ['--reset', '--mode', 'tokenmax'])).toBeNull();
    expect(strictArgsProblem(spec, ['--reset', '--mode=tokenmax'])).not.toBeNull();
    expect(spec.when?.(['--mode', 'tokenmax'])).toBe(true);
  });
});
