/**
 * Agent contract v1 D3/D4 through the real CLI, on a machine with no brain.
 *
 * Protects: `gbrain <cmd> --help` / `-h` for the 7 ops-critical commands
 * prints the curated spec (usage, every curated flag, examples) engine-free,
 * instead of the generic one-line stub or a "No brain configured" error;
 * `--help --json` prints exactly that spec as one JSON document on stdout;
 * a bad typed value exits 2 with `invalid_params` (one envelope under
 * `--json`) before any engine work; an unknown flag on a curated command gets
 * a did-you-mean drawn from the curated flags.
 * Fails when: the --help short-circuit stops reaching the curated renderer,
 * help opens an engine, the JSON document is mixed with other stdout, or the
 * curated validation call in main() is dropped.
 * Why new: the unit test (test/cli-help-curated.test.ts) covers the pure
 * renderer/validator; only a subprocess proves dispatch order and exit codes.
 * Seam: none (empty GBRAIN_HOME, database URLs stripped, --no-env-file).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCuratedHelp } from '../src/cli/help/render.ts';

const REPO = new URL('..', import.meta.url).pathname;
const CURATED = ['doctor', 'import', 'serve', 'apply-migrations', 'autopilot', 'status', 'onboard'];

async function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-curated-help-'));
  const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home, HOME: home };
  delete env.GBRAIN_DATABASE_URL;
  delete env.DATABASE_URL;
  const proc = Bun.spawn(['bun', '--no-env-file', 'run', 'src/cli.ts', ...args], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

describe('curated --help without a brain (D3)', () => {
  test('--help and -h print the curated spec engine-free for every ops-critical command', async () => {
    const runs = await Promise.all(CURATED.flatMap(c => [['--help'], ['-h']].map(async flag => ({ c, flag: flag[0], ...(await cli([c, ...flag])) }))));
    for (const r of runs) {
      const spec = (await loadCuratedHelp(r.c))!;
      expect(r.code, `${r.c} ${r.flag}: ${r.stderr}`).toBe(0);
      expect(r.stdout + r.stderr).not.toContain('No brain configured');
      expect(r.stdout).not.toContain('run gbrain --help for the full command list');
      expect(r.stdout).toContain(`Usage: gbrain ${r.c}`);
      for (const f of spec.flags) expect(r.stdout, `${r.c} help lists ${f.name}`).toContain(f.name);
      expect(r.stdout).toContain(spec.examples[0]!);
    }
  }, 90_000);

  test('--help --json prints the spec as one JSON document', async () => {
    const runs = await Promise.all(['doctor', 'serve'].map(async c => ({ c, ...(await cli([c, '--help', '--json'])) })));
    for (const r of runs) {
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout);
      expect(doc).toEqual({ command: r.c, ...(await loadCuratedHelp(r.c))!, contract_version: 1 });
    }
  }, 60_000);
});

describe('typed flag values from the curated spec (D4)', () => {
  test('a non-numeric number flag exits 2 with invalid_params before any engine work', async () => {
    const r = await cli(['doctor', '--remediate', '--max-usd', 'abc']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Error [invalid_params]: --max-usd must be a number; got 'abc'.");
    expect(r.stderr).toContain('Pass a number, e.g. --max-usd 5.');
    expect(r.stderr).not.toContain('No brain configured');
  }, 30_000);

  test('under --json the bad value is one envelope on stdout', async () => {
    const r = await cli(['status', '--section', 'bogus', '--json']);
    expect(r.code).toBe(2);
    const env = JSON.parse(r.stdout);
    expect(env.code).toBe('invalid_params');
    expect(env.message).toContain("--section must be one of sync|cycle|locks|workers|queue|autopilot; got 'bogus'");
    expect(env.suggestion).toContain('--section sync');
  }, 30_000);

  test('an unknown flag on a curated command suggests the curated flag', async () => {
    const r = await cli(['doctor', '--remediat']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('did you mean --remediate?');
  }, 30_000);
});
