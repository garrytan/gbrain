import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ExportStage, EXPORT_MARKER } from '../src/core/export-stage.ts';
import { publishExport } from '../src/core/export-publish.ts';
import { removeCompiledSmokeDirectory } from '../scripts/native/compiled-smoke-cleanup.ts';

await import('./export-publication.test.ts');

/** An awaited child: a `Bun.spawnSync` wait is where oven-sh/bun#34069 poisons Bun 1.4.0 to 1.4.2 (test/helpers/git-publication.ts). */
async function run(argv: string[], options: { cwd: string; env: Record<string, string> }) {
  const proc = Bun.spawn(argv, { ...options, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, signalCode: proc.signalCode, stdout, stderr };
}

test('native filesystem case aliases refuse before publication and preserve occupied bytes', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'export-native-case-')));
  const stage = new ExportStage();
  try {
    writeFileSync(join(root, 'Case-Probe.md'), 'operator bytes');
    const caseInsensitive = existsSync(join(root, 'case-probe.md'));
    if (process.env.GBRAIN_TEST_REQUIRE_CASE_INSENSITIVE === '1') expect(caseInsensitive).toBe(true);
    console.log(`Native export fixture: platform=${process.platform} caseInsensitive=${caseInsensitive}`);
    stage.add('case-probe.md', 'file', 'must not replace');
    await expect(publishExport(stage, root)).rejects.toThrow();
    expect(readFileSync(join(root, 'Case-Probe.md'), 'utf8')).toBe('operator bytes');
    expect(readdirSync(root)).toEqual(['Case-Probe.md']);
  } finally { stage.close(); rmSync(root, { recursive: true, force: true }); }
});

test('compiled publisher outside the checkout completes, refuses repeats and survives process death honestly', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'export-native-compiled-')));
  const binary = join(base, process.platform === 'win32' ? 'publisher.exe' : 'publisher');
  const out = join(base, 'out'), partial = join(base, 'partial');
  const env: Record<string, string> = { GBRAIN_HOME: join(base, 'home') };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  mkdirSync(env.GBRAIN_HOME);
  try {
    const built = await run([process.execPath, '--no-env-file', 'build', '--compile', '--no-compile-autoload-bunfig',
      '--outfile', binary, resolve('test/fixtures/export-native-publish.ts')], { cwd: process.cwd(), env });
    expect({ status: built.exitCode, stderr: built.stderr }).toEqual({ status: 0, stderr: expect.any(String) });
    const completed = await run([binary, out], { cwd: base, env });
    expect({ status: completed.exitCode, stderr: completed.stderr }).toEqual({ status: 0, stderr: '' });
    expect(completed.stdout).toContain('EXPORT_FIXTURE_COMPLETE');
    expect(readFileSync(join(out, EXPORT_MARKER), 'utf8')).toBe('GBRAIN EXPORT INCOMPLETE\nCOMPLETE\n');
    const bytes = readFileSync(join(out, 'first.md'), 'utf8');
    const repeated = await run([binary, out], { cwd: base, env });
    expect(repeated.exitCode).not.toBe(0);
    expect(repeated.stdout).not.toContain('EXPORT_FIXTURE_COMPLETE');
    expect(readFileSync(join(out, 'first.md'), 'utf8')).toBe(bytes);
    const killed = await run([binary, partial, 'kill'], { cwd: base, env });
    expect(killed.exitCode).not.toBe(0);
    expect(killed.stdout).toContain('EXPORT_FIXTURE_KILLING');
    expect(killed.stderr).toBe('');
    if (process.platform !== 'win32') expect(killed.signalCode).toBe('SIGKILL');
    expect(killed.stdout).not.toContain('EXPORT_FIXTURE_COMPLETE');
    expect(readFileSync(join(partial, 'first.md'), 'utf8')).toBe('Synthetic first page\n');
    expect(existsSync(join(partial, 'nested/second.md'))).toBe(false);
    expect(readFileSync(join(partial, EXPORT_MARKER), 'utf8')).not.toContain('\nCOMPLETE\n');
  } finally { await removeCompiledSmokeDirectory(base); }
}, 180000);
