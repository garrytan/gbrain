import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../../src/core/engine-factory.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { EngineConfig } from '../../src/core/types.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { runCli } from '../helpers/cli-spawn.ts';

for (const kind of ['pglite', 'postgres'] as const) {
  describe.skipIf(kind === 'postgres' && !process.env.DATABASE_URL)(`forced migration preview (${kind})`, () => {
    let home: string;
    let engine: BrainEngine;
    let config: EngineConfig;
    let ledger: string;
    let configFile: string;
    let baseline: Awaited<ReturnType<typeof snapshot>>;
    const wedged = Array.from({ length: 3 }, () => JSON.stringify({ version: '0.11.0', status: 'partial' })).join('\n') + '\n';

    async function snapshot() {
      await engine.connect(config);
      try {
        return {
          version: await engine.getConfig('version'),
          config: await engine.executeRaw('SELECT * FROM config ORDER BY key'),
          sentinel: await engine.executeRaw('SELECT id, body, embedding::text FROM migration_preview_sentinel ORDER BY id'),
          columns: await engine.executeRaw("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position"),
          indexes: await engine.executeRaw("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname"),
        };
      } finally {
        await engine.disconnect();
      }
    }

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), `gbrain-preview-${kind}-`));
      mkdirSync(join(home, '.gbrain/migrations'), { recursive: true });
      if (kind === 'postgres') assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
      config = kind === 'pglite'
        ? { engine: 'pglite', database_path: join(home, 'brain') }
        : { engine: 'postgres', database_url: process.env.DATABASE_URL! };
      engine = await createEngine(config);
      await engine.connect(config);
      try {
        await engine.initSchema();
        await engine.executeRaw('CREATE TABLE migration_preview_sentinel (id integer PRIMARY KEY, body text, embedding vector(3))');
        await engine.executeRaw("INSERT INTO migration_preview_sentinel VALUES (1, 'preserve this fixture', '[1,2,3]')");
        await engine.setConfig('version', String(LATEST_VERSION - 1));
      } finally {
        await engine.disconnect();
      }
      configFile = join(home, '.gbrain/config.json');
      writeFileSync(configFile, JSON.stringify(config));
      ledger = join(home, '.gbrain/migrations/completed.jsonl');
      baseline = await snapshot();
    });

    afterAll(async () => {
      if (engine) {
        try {
          await engine.connect(config);
          await engine.executeRaw('DROP TABLE IF EXISTS migration_preview_sentinel');
          await engine.setConfig('version', String(LATEST_VERSION));
        } finally {
          await engine.disconnect();
        }
      }
      if (home) rmSync(home, { recursive: true, force: true });
    });

    for (const flags of [
      ['--force-retry', '0.11.0'],
      ['--force-orchestrator'],
      ['--force-schema'],
      ['--force-all'],
      ['--force'],
    ]) {
      test(`${flags.join(' ')} --dry-run leaves schema, vectors, config and ledger unchanged`, async () => {
        writeFileSync(ledger, wedged);
        const originalConfig = readFileSync(configFile, 'utf8');
        const result = await runCli(['apply-migrations', ...flags, '--dry-run', '--yes'], {
          home, cwd: home, env: { GBRAIN_NO_AUTOPILOT_INSTALL: '1' },
        });
        expect(result.exitCode).toBe(0);
        expect(readFileSync(ledger, 'utf8')).toBe(wedged);
        expect(readFileSync(configFile, 'utf8')).toBe(originalConfig);
        expect(await snapshot()).toEqual(baseline);
        expect(result.stdout).toMatch(/dry.run|would/i);
      });
    }
  });
}
