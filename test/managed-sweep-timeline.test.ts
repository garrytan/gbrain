/**
 * The serve sweep's links/timeline pass on a managed brain publishes each
 * page's timeline through the persistence coordinator.
 *
 * 1. Protects: a page whose timeline rows are missing (written before the
 *    brain was managed, or by a remote writer) gets them from the sweep as a
 *    committed `managed_maintenance_timeline_extract` request, and the pass
 *    reports no `links_timeline_error`.
 * 2. Fails when: the sweep writes `timeline_entries` with a raw batch insert,
 *    which the armed managed writer guard refuses
 *    (`writer_coordinator_required`) and which stopped the whole pass.
 * 3. extract-timeline-db covers `gbrain extract timeline --source db`; this
 *    covers the sweep that remote writes rely on.
 * 4. No production seam.
 *
 * Runs on PGLite; also on Postgres when DATABASE_URL is set (testBackends).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runMaintenanceSweep } from '../src/core/sweep.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-managed-sweep-timeline-db-'));
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(dataDir, { recursive: true, force: true });
});

test('managed: the sweep publishes missing timeline rows through the coordinator', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-managed-sweep-timeline-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `timeline-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example.',
          timeline: '- **2024-03-01** | note — Joined [Acme](companies/acme-example)\n- **2025-01-15** | note — Gave a talk', frontmatter: {} }, { sourceId });
        expect(await engine.executeRaw('SELECT 1 FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1', [sourceId])).toEqual([]);
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await expect(engine.addTimelineEntriesBatch([{ slug: 'people/alice-example', date: '2024-03-01', source: 'note', summary: 'raw', detail: '', source_id: sourceId }])) // gbrain-allow-direct-insert: proves the guard is armed
          .rejects.toThrow(/writer_coordinator_required/);

        const report = await runMaintenanceSweep(engine, { sourceId, budgetMs: 120_000 });
        expect(report.skipped.map(s => s.reason)).not.toContain('links_timeline_error');
        expect(report.timelineExtracted).toBe(2);
        const rows = await engine.executeRaw<{ date: string; summary: string }>(`SELECT to_char(t.date,'YYYY-MM-DD') AS date,t.summary FROM timeline_entries t
          JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 ORDER BY t.date`, [sourceId]);
        expect(rows.map(r => r.date)).toEqual(['2024-03-01', '2025-01-15']);
        const [published] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests
          WHERE source_id=$1 AND state='committed' AND intent->>'kind'='managed_maintenance_timeline_extract'`, [sourceId]);
        expect(published.n).toBe(1);
        // A second sweep finds nothing left to publish.
        const again = await runMaintenanceSweep(engine, { sourceId, budgetMs: 120_000 });
        expect(again.timelineExtracted).toBe(0);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1').catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 180_000);
