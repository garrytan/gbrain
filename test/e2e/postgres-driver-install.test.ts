import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { keylessBrainEnv } from '../helpers/provider-env.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const enabled = process.env.GBRAIN_TEST_PACKAGE_SMOKE === '1' && !!process.env.DATABASE_URL;

test.skipIf(!enabled)('packed, global, upgraded and compiled distributions use vendored cancellation bytes and complete a harmless job', async () => {
  const root = resolve(import.meta.dir, '../..');
  const scratch = await mkdtemp(join(tmpdir(), 'gbrain-driver-package-'));
  const url = process.env.DATABASE_URL!;
  assertSafeE2eDatabaseUrl(url);
  const started = performance.now();
  const env = keylessBrainEnv(process.env, join(scratch, 'home'), {
    DATABASE_URL: url,
    GBRAIN_DATABASE_URL: undefined,
    GBRAIN_DIRECT_DATABASE_URL: undefined,
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    BUN_INSTALL: join(scratch, 'bun'),
    BUN_INSTALL_CACHE_DIR: join(scratch, 'cache'),
  });
  const run = async (args: string[], cwd: string) => {
    const child = Bun.spawn(args, { cwd, env, stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code, `${args[1]} failed: ${stderr.slice(-3000)}`).toBe(0);
      return stdout;
    } finally { clearTimeout(timer); }
  };
  try {
    await mkdir(env.HOME, { recursive: true });
    const packed = join(scratch, 'gbrain.tgz');
    await run([process.execPath, 'pm', 'pack', '--ignore-scripts', '--quiet', '--filename', packed], root);
    const install = join(scratch, 'install');
    await mkdir(install);
    await run([process.execPath, 'add', '--ignore-scripts', packed], install);
    const installed = join(install, 'node_modules/gbrain');
    expect(await readFile(join(installed, 'vendor/postgres/src/index.js'), 'utf8')).toBe(await readFile(join(root, 'vendor/postgres/src/index.js'), 'utf8'));
    expect(JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).dependencies.postgres).toBeUndefined();
    for (const [mode, cwd] of [['checkout', root], ['packed', installed]]) {
      const output = await run([process.execPath, '--no-env-file', 'test/fixtures/postgres-package-smoke.ts'], cwd);
      expect(output).toContain('"job_status":"completed"');
      console.log(`${mode}: ${output.trim()}`);
    }
    const globalPackage = process.env.GBRAIN_TEST_GITHUB_PACKAGE ?? packed;
    await run([process.execPath, 'add', '--ignore-scripts', '--global', globalPackage], install);
    const globalRoot = join(env.BUN_INSTALL, 'install/global/node_modules/gbrain');
    const globalOutput = await run([process.execPath, '--no-env-file', 'test/fixtures/postgres-package-smoke.ts'], globalRoot);
    expect(globalOutput).toContain('"job_status":"completed"');
    console.log(`${process.env.GBRAIN_TEST_GITHUB_PACKAGE ? 'github-global' : 'tarball-global'}: ${globalOutput.trim()}`);
    await run([process.execPath, 'add', '--ignore-scripts', 'postgres@3.4.9'], install);
    expect(await run([process.execPath, '--no-env-file', '-e', `
      import assert from 'node:assert/strict';
      import stock from '../postgres/src/index.js';
      import { PostgresEngine } from './src/core/postgres-engine.ts';
      import { assertWorkerDbReadiness } from './src/core/minions/db-probe.ts';
      import { isLocalConfigurationError } from './src/core/minions/configuration-error.ts';
      const sql = stock(process.env.DATABASE_URL, { max: 1 });
      const engine = new PostgresEngine();
      Object.defineProperty(engine, '_sql', { value: sql });
      try {
        assert.equal((await engine.executeRaw('SELECT 1::int AS n'))[0].n, 1);
        await assert.rejects(assertWorkerDbReadiness(engine), isLocalConfigurationError);
        console.log('STOCK_DRIVER_REJECTED');
      } finally { await sql.end({ timeout: 1 }); }
    `], installed)).toContain('STOCK_DRIVER_REJECTED');
    const staleOutput = await run([process.execPath, '--no-env-file', 'test/fixtures/postgres-package-smoke.ts'], installed);
    expect(staleOutput).toContain('"job_status":"completed"');
    console.log(`stale-module: ${staleOutput.trim()}`);
    const binary = join(scratch, 'smoke-linux');
    await run([process.execPath, 'build', '--compile', '--no-compile-autoload-bunfig', '--outfile', binary, 'test/fixtures/postgres-package-smoke.ts'], root);
    const compiledOutput = await run([binary], scratch);
    expect(compiledOutput).toContain('"job_status":"completed"');
    console.log(`linux-compiled: ${compiledOutput.trim()}`);
    const macBinary = join(scratch, 'smoke-darwin-arm64');
    await run([process.execPath, 'build', '--compile', '--no-compile-autoload-bunfig', '--target=bun-darwin-arm64', '--outfile', macBinary, 'test/fixtures/postgres-package-smoke.ts'], root);
    expect((await readFile(macBinary)).readUInt32LE(0)).toBe(0xfeedfacf);
    console.log('darwin-arm64: cross-compiled; native execution not available on this Linux host');
    console.log(`Distribution smoke including setup: ${Math.round(performance.now() - started)}ms`);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}, 600_000);
