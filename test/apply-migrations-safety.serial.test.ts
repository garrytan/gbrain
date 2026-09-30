import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import type { CompletedMigrationEntry } from '../src/core/preferences.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { acquireLock, releaseLock } from '../src/core/pglite-lock.ts';

const root = resolve(import.meta.dir, '..');

async function fixture(run: (home: string, ledger: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-migration-safety-'));
  const dir = join(home, '.gbrain');
  mkdirSync(join(dir, 'migrations'), { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(dir, 'brain') }));
  try {
    await run(home, join(dir, 'migrations/completed.jsonl'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function entries(ledger: string): CompletedMigrationEntry[] {
  return readFileSync(ledger, 'utf8').trim().split('\n').map(row => JSON.parse(row));
}

describe('migration runner completion safety', () => {
  test('live-owner retries do not wedge a pending content migration after the owner exits', async () => {
    await fixture(async (home, ledger) => {
      const database = join(home, '.gbrain', 'brain');
      const engine = new PGLiteEngine();
      try {
        await engine.connect({ database_path: database });
        await engine.initSchema();
      } finally { await engine.disconnect(); }
      const lock = await acquireLock(database);
      const lockPath = join(lock.lockDir!, 'lock');
      writeFileSync(lockPath, JSON.stringify({ ...JSON.parse(readFileSync(lockPath, 'utf8')), subcommand: 'serve' }));
      const args = ['apply-migrations', '--yes', '--migration', '0.53.0', '--no-autopilot-install', '--json'];
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const busy = await runCli(args, { home, cwd: home });
          expect(busy.exitCode).toBe(1);
          expect(JSON.parse(busy.stdout.trim().split('\n').at(-1)!)).toMatchObject({
            error: 'pglite_busy', retryable: true, reason: 'live_serve',
          });
          expect(JSON.parse(readFileSync(lockPath, 'utf8')).pid).toBe(process.pid);
        }
      } finally { await releaseLock(lock); }
      const resumed = await runCli(args, { home, cwd: home });
      expect(resumed.exitCode).toBe(0);
      expect(entries(ledger).filter(row => row.version === '0.53.0').map(row => row.status)).toEqual(['complete']);
    });
  }, 60_000);

  test('forced previews do not copy a legacy ledger or open a nonexistent database', async () => {
    await fixture(async (home, ledger) => {
      const relocated = join(home, 'relocated');
      mkdirSync(join(relocated, '.gbrain'), { recursive: true });
      const database = join(relocated, 'must-not-open');
      writeFileSync(join(relocated, '.gbrain/config.json'), JSON.stringify({ engine: 'pglite', database_path: database }));
      const historical = JSON.stringify({ version: '0.11.0', status: 'partial' }) + '\n';
      writeFileSync(ledger, historical.repeat(3));
      for (const flags of [['--force-retry', '0.11.0'], ['--force-orchestrator'], ['--force-schema'], ['--force-all'], ['--force']]) {
        const result = await runCli(['apply-migrations', '--dry-run', ...flags], {
          home, cwd: home, env: { GBRAIN_HOME: relocated, GBRAIN_NO_AUTOPILOT_INSTALL: '1' },
        });
        expect(result.exitCode).toBe(0);
        expect(readFileSync(ledger, 'utf8')).toBe(historical.repeat(3));
        expect(existsSync(join(relocated, '.gbrain/migrations'))).toBe(false);
        expect(existsSync(database)).toBe(false);
      }
    });
  });

  for (const result of [
    { status: 'complete', phases: [{ name: 'install', status: 'failed', detail: 'fixture install failed' }] },
    { status: 'partial', phases: [{ name: 'install', status: 'failed', detail: 'fixture install failed' }] },
    { status: 'failed', phases: [] },
  ]) {
    test(`records ${result.status} with failed work as partial and exits nonzero`, async () => {
      await fixture(async (home, ledger) => {
        const script = join(home, 'runner.ts');
        writeFileSync(script, `
import { migrations } from ${JSON.stringify(join(root, 'src/commands/migrations/index.ts'))};
import { runApplyMigrations } from ${JSON.stringify(join(root, 'src/commands/apply-migrations.ts'))};
migrations.splice(0, migrations.length, {
  version: '0.11.0', featurePitch: { headline: 'fixture migration' },
  orchestrator: async () => (${JSON.stringify({ version: '0.11.0', ...result })}),
});
await runApplyMigrations(['--yes']);
`);
        const child = Bun.spawnSync([process.execPath, '--no-env-file', script], {
          cwd: home, env: { HOME: home, GBRAIN_HOME: home, PATH: process.env.PATH ?? '' },
          stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
        });
        expect(entries(ledger).at(-1)!.status).toBe('partial');
        expect(child.exitCode).toBe(1);
        if (result.phases.length) expect(child.stderr.toString()).toContain('fixture install failed');
        expect(child.stdout.toString()).not.toContain('Migration v0.11.0 complete.');
      });
    });
  }

  test.each(['file-postgres', 'env-overrides-pglite'])('failed applicable install retries in %s, while a historical complete requires explicit force-retry', async (context) => {
    await fixture(async (home, ledger) => {
      const databaseUrl = 'postgresql://fixture:fixture@127.0.0.1:1/gbrain_test';
      if (context === 'file-postgres') {
        writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify({ engine: 'postgres', database_url: databaseUrl }));
      }
      const bin = join(home, 'bin');
      mkdirSync(bin);
      const calls = join(home, 'calls.log');
      const shim = join(bin, 'gbrain');
      const writeShim = (installCode: number) => writeFileSync(shim,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = autopilot ]; then exit ${installCode}; fi\nexit 0\n`, { mode: 0o755 });
      writeShim(7);
      const env: Record<string, string> = { HOME: home, GBRAIN_HOME: home, PATH: `${bin}:${process.env.PATH ?? ''}` };
      if (context === 'env-overrides-pglite') env.GBRAIN_DATABASE_URL = databaseUrl;
      const setup = `
import { mock } from 'bun:test';
import { loadConfig } from ${JSON.stringify(join(root, 'src/core/config.ts'))};
import { LATEST_VERSION } from ${JSON.stringify(join(root, 'src/core/migrate.ts'))};
if (loadConfig()?.engine !== 'postgres') throw new Error('fixture must resolve to an applicable Postgres install');
const migrationSetup = await import(${JSON.stringify(join(root, 'src/commands/migrations/in-process.ts'))});
mock.module(${JSON.stringify(join(root, 'src/commands/migrations/in-process.ts'))}, () => ({
  ...migrationSetup, runMigrateOnlyCore: async () => ({ engine: 'postgres' }),
}));
const factory = await import(${JSON.stringify(join(root, 'src/core/engine-factory.ts'))});
mock.module(${JSON.stringify(join(root, 'src/core/engine-factory.ts'))}, () => ({
  ...factory,
  createEngine: async () => ({
    connect: async () => {}, disconnect: async () => {},
    getConfig: async (key) => {
      if (key !== 'version') throw new Error('unexpected preflight read: ' + key);
      return String(LATEST_VERSION);
    },
  }),
}));
`;
      const runScript = (script: string, args: string[] = []) => {
        const child = Bun.spawnSync([process.execPath, '--no-env-file', script, ...args], {
          cwd: home, env, stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
        });
        return { exitCode: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
      };
      const args = ['--yes', '--migration', '0.11.0'];
      const directScript = join(home, 'orchestrator.ts');
      writeFileSync(directScript, setup + `
const { v0_11_0 } = await import(${JSON.stringify(join(root, 'src/commands/migrations/v0_11_0.ts'))});
const result = await v0_11_0.orchestrator({ yes: true, dryRun: false, noAutopilotInstall: false });
console.log('RESULT=' + JSON.stringify(result));
`);
      const runnerScript = join(home, 'apply.ts');
      writeFileSync(runnerScript, setup + `
const { runApplyMigrations } = await import(${JSON.stringify(join(root, 'src/commands/apply-migrations.ts'))});
await runApplyMigrations(process.argv.slice(2));
`);
      const direct = runScript(directScript);
      expect(direct.exitCode).toBe(0);
      const directResult = JSON.parse(direct.stdout.split('\n').find(line => line.startsWith('RESULT='))!.slice(7));
      expect(directResult.status).toBe('partial');
      expect(directResult.phases).toContainEqual(expect.objectContaining({ name: 'install', status: 'failed' }));
      const failed = runScript(runnerScript, args);
      expect(entries(ledger).at(-1)!.status).toBe('partial');
      expect(entries(ledger).at(-1)!.phases).toContainEqual(expect.objectContaining({ name: 'install', status: 'failed' }));
      expect(failed.exitCode).toBe(1);
      expect(failed.stderr).toContain('install');

      writeShim(0);
      const retry = runScript(runnerScript, args);
      expect(retry.exitCode).toBe(0);
      expect(entries(ledger).at(-1)!.status).toBe('complete');

      const historical = JSON.stringify({ version: '0.11.0', status: 'complete', phases: [{ name: 'install', status: 'failed' }] }) + '\n';
      writeFileSync(ledger, historical);
      const callsBefore = readFileSync(calls, 'utf8');
      const noop = runScript(runnerScript, args);
      expect(noop.exitCode).toBe(0);
      expect(readFileSync(ledger, 'utf8')).toBe(historical);
      expect(readFileSync(calls, 'utf8')).toBe(callsBefore);
      const reset = runScript(runnerScript, ['--force-retry', '0.11.0']);
      expect(reset.exitCode).toBe(0);
      expect(entries(ledger).at(-1)!.status).toBe('retry');
      const recovered = runScript(runnerScript, args);
      expect(recovered.exitCode).toBe(0);
      expect(entries(ledger).at(-1)!.status).toBe('complete');
      expect(readFileSync(calls, 'utf8')).not.toBe(callsBefore);
    });
  }, 60_000);

  for (const explicitEngine of [true, false]) {
    test(`${explicitEngine ? 'explicit' : 'inferred'} PGLite skips inapplicable daemon installation without invoking it`, async () => {
      await fixture(async (home, ledger) => {
        if (!explicitEngine) {
          writeFileSync(join(home, '.gbrain/config.json'), JSON.stringify({ database_path: join(home, '.gbrain/brain') }));
        }
        const bin = join(home, 'bin');
        mkdirSync(bin);
        const calls = join(home, 'calls.log');
        writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = autopilot ]; then exit 99; fi\nexit 0\n`, { mode: 0o755 });
        const result = await runCli(['apply-migrations', '--yes', '--migration', '0.11.0'], {
          home, cwd: home,
          env: { PATH: `${bin}:${process.env.PATH ?? ''}`, GBRAIN_NO_AUTOPILOT_INSTALL: undefined },
        });
        expect(readFileSync(calls, 'utf8')).not.toContain('autopilot');
        expect(result.exitCode).toBe(0);
        const record = entries(ledger).at(-1)!;
        expect(record.status).toBe('complete');
        expect(record.autopilot_installed).toBe(false);
        expect(record.phases).toContainEqual({
          name: 'install', status: 'skipped', detail: 'PGLite is single-writer; use gbrain serve for background maintenance',
        });
      });
    });
  }

  for (const disable of ['flag', 'env']) {
    test(`explicit no-autopilot ${disable} completes without invoking install`, async () => {
      await fixture(async (home, ledger) => {
        const bin = join(home, 'bin');
        mkdirSync(bin);
        const calls = join(home, 'calls.log');
        writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = autopilot ]; then exit 99; fi\nexit 0\n`, { mode: 0o755 });
        const args = ['apply-migrations', '--yes', '--migration', '0.11.0', ...(disable === 'flag' ? ['--no-autopilot-install'] : [])];
        const result = await runCli(args, {
          home, cwd: home,
          env: { PATH: `${bin}:${process.env.PATH ?? ''}`, GBRAIN_NO_AUTOPILOT_INSTALL: disable === 'env' ? '1' : undefined },
        });
        expect(result.exitCode).toBe(0);
        expect(entries(ledger).at(-1)!.status).toBe('complete');
        expect(entries(ledger).at(-1)!.phases).toContainEqual({ name: 'install', status: 'skipped', detail: '--no-autopilot-install' });
        expect(readFileSync(calls, 'utf8')).not.toContain('autopilot');
      });
    });
  }
});
