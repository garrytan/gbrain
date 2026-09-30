// #5685 follow-up: a managed maintenance page write (the dream synthesis
// write-back after grounding quarantine) reconciles the page's automatic
// links from the published body, the same way an ordinary put_page does. A
// link that only a quarantined sentence carried must not outlive it.

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { maintenancePreflight, publishMaintenancePage } from '../src/core/persistence/prepared-maintenance.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-maintenance-links-db-'));
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
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
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

async function linkTargets(engine: BrainEngine, sourceId: string, slug: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT t.slug FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      WHERE f.source_id = $1 AND f.slug = $2 ORDER BY t.slug`, [sourceId, slug]);
  return rows.map(r => r.slug);
}

test('a managed maintenance page write reconciles automatic links from the published body', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-maintenance-links-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `links-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
          dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        for (const slug of ['people/alice-example', 'people/bob-example', 'people/carol-example']) {
          await submitPageMutation(ctx, { operation: 'put_page', params: {
            slug, content: `---\ntitle: ${slug}\ntype: person\n---\nA person.`, request_id: randomUUID() } });
        }
        const slug = 'wiki/personal/reflections/session-abc123';
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(),
          content: '---\ntitle: Session\ntype: note\n---\nMet [[people/alice-example]]. Invented: [[people/bob-example]] said "a fabricated quote".' } });
        expect(await linkTargets(engine, sourceId, slug)).toEqual(['people/alice-example', 'people/bob-example']);

        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const authority = (await maintenancePreflight(engine, sourceId))!;
        const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
        await publishMaintenancePage(engine, authority, slug,
          '---\ntitle: Session\ntype: note\n---\nMet [[people/alice-example]] and [[people/carol-example]].', { expectedRevision: before.revision });

        expect(await linkTargets(engine, sourceId, slug)).toEqual(['people/alice-example', 'people/carol-example']);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 60_000);
