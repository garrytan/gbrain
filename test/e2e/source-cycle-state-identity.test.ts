import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { captureSourceIncarnation, writeSourceCycleTimestamps } from '../../src/core/source-cycle-state.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`${kind}: source cycle-state identity constraints`, () => {
    let engine: BrainEngine;
    const suffix = crypto.randomUUID();
    const sourceA = `cycle-identity-a-${suffix}`;
    const sourceB = `cycle-identity-b-${suffix}`;

    beforeAll(async () => {
      if (kind === 'postgres') {
        assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
        engine = new PostgresEngine();
        await engine.connect({ database_url: process.env.DATABASE_URL! });
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
      }
      await engine.initSchema();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1), ($2, $2)', [sourceA, sourceB]);
    }, 120_000);

    afterAll(async () => {
      if (!engine) return;
      await engine.executeRaw('DELETE FROM sources WHERE id = ANY($1::text[])', [[sourceA, sourceB]]);
      await engine.disconnect();
    }, 60_000);

    test('rejects a valid incarnation paired with a different source id', async () => {
      const incarnationB = await captureSourceIncarnation(engine, sourceB);
      await expect(engine.executeRaw(
        `INSERT INTO source_cycle_state (source_id, source_incarnation, updated_at)
         VALUES ($1, $2::uuid, NOW())`, [sourceA, incarnationB],
      )).rejects.toThrow();
    });

    test('source deletion cascades its matching incarnation state', async () => {
      const incarnationA = await captureSourceIncarnation(engine, sourceA);
      expect(incarnationA).not.toBeNull();
      await writeSourceCycleTimestamps(engine, sourceA, incarnationA!, '2026-05-22T12:00:00.000Z');
      await engine.executeRaw('DELETE FROM sources WHERE id = $1', [sourceA]);
      const rows = await engine.executeRaw('SELECT source_id FROM source_cycle_state WHERE source_id = $1', [sourceA]);
      expect(rows).toHaveLength(0);
    });
  });
}