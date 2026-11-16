/**
 * GST-1943: the storage shelf on Postgres (repo-less brain; the database is the record). Protects the Postgres paths
 * PGLite cannot: the first storage_register creates the non-federated storage source; storage_find ranks exact id,
 * exact alias and words, and a miss lists the closest cards through pg_trgm; storage_list filters by store; the page
 * door refuses put_page into the shelf; update binds to the revision it read.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const d = hasDatabase() ? describe : describe.skip;
let engine: PostgresEngine;

const ctx = (): OperationContext => ({
  engine, config: { engine: 'postgres', embedding_disabled: true } as OperationContext['config'],
  logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default',
}) as OperationContext;
const call = (name: string, params: Record<string, unknown>) => operationsByName[name]!.handler(ctx(), params) as Promise<Record<string, any>>;
const card = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, title: `Dataset ${id}`, aliases: [], kind: 'directory', status: 'archived', description: 'Example archive for the Postgres storage shelf test.',
  locations: [{ store: 'b2', bucket: 'bucket-a', path: `/archive/${id}`, tool: 'restic', repository: 'archive/restic', snapshot: 'a'.repeat(64), size_bytes: 1024 }],
  original_path: `/srv/data/${id}`, on_source_machine: false, archived_at: '2026-11-08T00:00:00Z', archived_by: 'archive-agent', reason: 'disk space',
  restore: { skill: 'restore-data', args: { id } }, ...over,
});

d('storage shelf on Postgres', () => {
  beforeAll(async () => { engine = await setupDB(); }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await teardownDB(); });

  test('register, find, list, guard and revision binding', async () => {
    await call('storage_register', { card: card('mail-export-oct', { title: 'October mail and web export', aliases: ['october gmail dataset'] }) });
    await call('storage_register', { card: card('model-weights-a', { title: 'Merged model weights', kind: 'file' }) });
    await call('storage_register', { card: card('family-media', { title: 'Family media library',
      locations: [{ store: 'supabase', bucket: 'bucket-b', path: 'items/family-media/', tool: 'object', size_bytes: 2048 }] }) });
    const [source] = await engine.executeRaw<{ role: string; federated: string; local_path: string | null }>(
      "SELECT config->>'role' AS role, config->>'federated' AS federated, local_path FROM sources WHERE id = 'storage'");
    expect(source).toEqual({ role: 'storage_manifest', federated: 'false', local_path: null });

    expect((await call('storage_find', { query: 'model-weights-a' })).hits[0]).toMatchObject({ id: 'model-weights-a', match: 'id' });
    expect((await call('storage_find', { query: 'October Gmail Dataset' })).hits[0]).toMatchObject({ id: 'mail-export-oct', match: 'alias' });
    expect((await call('storage_find', { query: 'bring back the merged model weights' })).hits[0]).toMatchObject({ id: 'model-weights-a', match: 'words' });
    const miss = await call('storage_find', { query: 'famly medai' });
    expect(miss).toMatchObject({ not_found: true, hits: [] });
    expect(miss.closest[0].id).toBe('family-media');
    expect((await call('storage_list', { store: 'supabase' })).cards.map((c: { id: string }) => c.id)).toEqual(['family-media']);

    const put = await call('put_page', { slug: 'family-media', source_id: 'storage', content: '---\ntype: note\ntitle: x\n---\nOverwrite.\n', request_id: randomUUID() })
      .then(() => null, (e: { canonical?: string; code?: string }) => e.canonical ?? e.code);
    expect(put).toBe('storage_source_managed');

    const got = await call('storage_get', { id: 'family-media' });
    await call('storage_update', { id: 'family-media', expected_revision: got.revision, restored_to: '/srv/restore/family-media', restored_verified: true });
    const stale = await call('storage_update', { id: 'family-media', expected_revision: got.revision, patch: { status: 'retired' } })
      .then(() => null, (e: { canonical?: string; code?: string }) => e.canonical ?? e.code);
    expect(stale).toBe('storage_revision_conflict');
    const after = await call('storage_get', { id: 'family-media' });
    expect(after.card).toMatchObject({ status: 'restored', title: 'Family media library' });
    expect(after.card.restores[0]).toMatchObject({ to: '/srv/restore/family-media', verified: true });
  }, 60_000);
});
