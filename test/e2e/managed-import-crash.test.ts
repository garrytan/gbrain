/**
 * GBRA-69 forced probes: a managed import SIGKILLed after admission, or at its
 * one closing page write inside publication, is recovered from the durable
 * request intent alone. The pre-admission checkpoint no longer carries the
 * content, so the retry resumes the same request id and the content it
 * publishes is the content the request stored; the page ends sealed (chunker
 * version and text projection) as an uninterrupted import leaves it.
 * PGLite always runs; Postgres runs when DATABASE_URL is set.
 */
import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../../src/core/chunkers/recursive.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { managedImportContent } from '../../src/core/persistence/import-prepare.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { editRequest } from '../helpers/persistence-request-fixture.ts';
import { withEnv } from '../helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-import-crash-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
afterAll(() => rmSync(home, { recursive: true, force: true }));

const kinds = ['pglite', ...(process.env.DATABASE_URL ? ['postgres'] as const : [])] as const;

async function open(kind: 'pglite' | 'postgres', dataDir: string) {
  if (kind === 'pglite') {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir });
    return { engine: engine as BrainEngine, target: dataDir, close: () => engine.disconnect() };
  }
  const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
  const [{ name }] = await pg.engine.executeRaw<{ name: string }>('SELECT current_database() AS name');
  const url = new URL(process.env.DATABASE_URL!); url.pathname = `/${name}`;
  return { engine: pg.engine as BrainEngine, target: url.toString(), close: pg.close };
}

for (const kind of kinds) for (const boundary of ['admitted', 'closing_write'] as const) {
  test(`${kind}: an import killed at ${boundary} publishes its stored request on retry`, () => withEnv(env, async () => {
    const dataDir = join(home, `${kind}-${boundary}.pglite`);
    let brain = await open(kind, dataDir);
    if (kind === 'pglite') await brain.engine.initSchema();
    const sourceId = `crash-${randomUUID().slice(0, 8)}`;
    const root = join(home, sourceId), input = join(home, `${sourceId}-input`);
    mkdirSync(root); mkdirSync(input);
    await brain.engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await brain.engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    await registerLocalWriter(brain.engine, 'cli');
    await claimWorktree(brain.engine, sourceId, root);
    await brain.engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const file = join(input, 'crash.md');
    writeFileSync(file, '---\ntitle: Crash\ntags: [example]\n---\n# Crash\n\nPublished from the stored request after the writer was killed.\n');
    const expected = managedImportContent('crash.md', readFileSync(file)).content;
    if (kind === 'pglite') { await disposePersistenceConsumer(brain.engine); await brain.close(); }

    const child = Bun.spawn([process.execPath, '--no-env-file', join(import.meta.dir, '../fixtures/managed-import-crash-worker.ts'),
      kind, brain.target, file, 'crash.md', sourceId, boundary], { env: { ...process.env, GBRAIN_HOME: home }, stdout: 'pipe', stderr: 'inherit' });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(stdout).toContain(`"boundary":"${boundary}"`);
    expect(child.signalCode ?? code).toBe('SIGKILL');

    if (kind === 'pglite') { brain = await open(kind, dataDir); }
    const engine = brain.engine;
    try {
      const [checkpoint] = await engine.executeRaw<{ params: Record<string, unknown> }>(
        "SELECT completed_keys->0 AS params FROM op_checkpoints WHERE op='managed-file-import' AND completed_keys->0->>'source_id'=$1", [sourceId]);
      expect(checkpoint!.params).not.toHaveProperty('content');
      const requestId = String(checkpoint!.params.request_id);
      const [killed] = await engine.executeRaw<{ id: string; state: string; content: string }>(
        "SELECT id::text, state, intent->>'content' AS content FROM persistence_requests WHERE source_id=$1 AND request_id=$2::uuid", [sourceId, requestId]);
      expect(killed).toMatchObject({ state: boundary === 'admitted' ? 'queued' : 'running', content: expected });
      expect(await engine.getPage('crash', { sourceId })).toBeNull();
      // The dead writer's claim lease is spent rather than waited out.
      if (boundary === 'closing_write') await editRequest(engine, killed!.id, "claim_expires_at=now()-interval '1 minute'");

      expect(await importManagedFile(engine, file, 'crash.md', { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
      const requests = await engine.executeRaw<{ request_id: string; state: string; content: string }>(
        "SELECT request_id::text, state, intent->>'content' AS content FROM persistence_requests WHERE source_id=$1 AND operation='put_page'", [sourceId]);
      expect(requests).toEqual([{ request_id: requestId, state: 'committed', content: expected }]);
      const [page] = await engine.executeRaw<{ body: string; chunker_version: number; sealed: boolean; searchable: boolean; tags: string[] }>(
        `SELECT compiled_truth AS body, chunker_version, text_projection_revision=knowledge_revision AS sealed, search_vector IS NOT NULL AS searchable,
          ARRAY(SELECT tag FROM tags t WHERE t.page_id=p.id ORDER BY tag) AS tags FROM pages p WHERE source_id=$1 AND slug='crash'`, [sourceId]);
      expect(page).toMatchObject({ chunker_version: MARKDOWN_CHUNKER_VERSION, sealed: true, searchable: true, tags: ['example'] });
      expect(page!.body).toContain('Published from the stored request');
      expect(readFileSync(join(root, 'crash.md'), 'utf8')).toContain('Published from the stored request');
      expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-file-import' AND completed_keys->0->>'source_id'=$1", [sourceId])).toHaveLength(0);
    } finally { await disposePersistenceConsumer(engine); await brain.close(); }
  }), 180_000);
}
