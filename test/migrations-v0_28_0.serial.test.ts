import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __testing } from '../src/commands/migrations/v0_28_0.ts';

let oldHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  oldHome = process.env.HOME;
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-v028-migration-'));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('v0.28.0 migration', () => {
  test('Postgres backfill queues extract-takes instead of running the full scan inline', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    try {
      Object.defineProperty(engine, 'kind', { value: 'postgres' });
      engine.getAllSlugs = async () => {
        throw new Error('phaseBBackfill must not run extractTakes inline for Postgres');
      };

      const result = await __testing.phaseBBackfill(engine, {
        yes: true,
        dryRun: false,
        noAutopilotInstall: false,
      });

      expect(result.status).toBe('complete');
      expect(result.detail).toContain('queued extract-takes job #');

      const rows = await engine.executeRaw<{
        name: string;
        status: string;
        data: { source?: string; migration?: string };
        idempotency_key: string | null;
      }>(
        `SELECT name, status, data, idempotency_key
         FROM minion_jobs
         WHERE idempotency_key = $1`,
        ['migration:0.28.0:extract-takes:db'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('extract-takes');
      expect(rows[0].status).toBe('waiting');
      expect(rows[0].data.source).toBe('db');
      expect(rows[0].data.migration).toBe('0.28.0');
    } finally {
      await engine.disconnect();
    }
  });
});
