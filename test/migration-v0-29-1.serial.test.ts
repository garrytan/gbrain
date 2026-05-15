import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createEngine } from '../src/core/engine-factory.ts';
import { __testing } from '../src/commands/migrations/v0_29_1.ts';

const opts = {
  yes: true,
  dryRun: false,
  noAutopilotInstall: true,
};

describe('v0.29.1 migration', () => {
  let tmp: string;
  let oldGbrainHome: string | undefined;
  let oldGbrainDbUrl: string | undefined;
  let oldDbUrl: string | undefined;

  beforeEach(async () => {
    oldGbrainHome = process.env.GBRAIN_HOME;
    oldGbrainDbUrl = process.env.GBRAIN_DATABASE_URL;
    oldDbUrl = process.env.DATABASE_URL;
    tmp = mkdtempSync(join(tmpdir(), 'gbrain-v0291-'));
    process.env.GBRAIN_HOME = tmp;
    delete process.env.GBRAIN_DATABASE_URL;
    delete process.env.DATABASE_URL;

    const gbrainHome = join(tmp, '.gbrain');
    const dbPath = join(tmp, 'brain-db');
    mkdirSync(gbrainHome, { recursive: true });
    writeFileSync(
      join(gbrainHome, 'config.json'),
      JSON.stringify({ engine: 'pglite', database_path: dbPath }, null, 2) + '\n',
    );

    const engine = await createEngine({ engine: 'pglite', database_path: dbPath });
    await engine.connect({ engine: 'pglite', database_path: dbPath });
    try {
      await engine.initSchema();
    } finally {
      await engine.disconnect();
    }
  });

  afterEach(() => {
    if (oldGbrainHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = oldGbrainHome;
    if (oldGbrainDbUrl !== undefined) process.env.GBRAIN_DATABASE_URL = oldGbrainDbUrl;
    else delete process.env.GBRAIN_DATABASE_URL;
    if (oldDbUrl !== undefined) process.env.DATABASE_URL = oldDbUrl;
    else delete process.env.DATABASE_URL;
    rmSync(tmp, { recursive: true, force: true });
  });

  test('connects the PGLite engine before backfill and verify phases', async () => {
    const backfill = await __testing.phaseBBackfill(opts);
    expect(backfill.status).toBe('complete');
    expect(backfill.detail).toContain('examined=0');

    const verify = await __testing.phaseCVerify(opts);
    expect(verify).toEqual({
      name: 'verify',
      status: 'complete',
      detail: '0 pages with NULL effective_date',
    });
  });
});
