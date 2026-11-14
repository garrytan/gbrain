/**
 * GST-1943: the storage_manifest doctor check (read-only, PGLite in-memory). Protects:
 *   - not_applicable with no shelf and no interim record;
 *   - interim stored-object pages under storage-manifest/ outside the shelf warn until adopted, with the read-only adopt
 *     preview as the fix; the index page and adopted originals do not count;
 *   - a card on the shelf that fails the current schema warns by id, never by value;
 *   - a hosted shelf whose directory is gone warns and asks the user;
 *   - the check writes nothing and is categorized brain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { storageManifestCheck } from '../src/commands/doctor/checks/storage-manifest.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
}, 60_000);
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
});

const ctx = (): OperationContext => ({
  engine, config: { engine: engine.kind, embedding_disabled: true } as OperationContext['config'],
  logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default',
}) as OperationContext;
const call = (name: string, params: Record<string, unknown>) => operationsByName[name]!.handler(ctx(), params) as Promise<Record<string, any>>;
const card = (id: string) => ({ id, title: `Dataset ${id}`, kind: 'dataset',
  locations: [{ store: 'b2', bucket: 'bucket-a', path: `/archive/${id}`, tool: 'restic', size_bytes: 64 }], restore: { skill: 'restore-data', args: { id } } });
const FENCE = '```';
const interim = (slug: string) => call('put_page', { slug, request_id: randomUUID(),
  content: `---\ntype: stored-object\ntitle: Interim ${slug}\n---\n## Record\n\n${FENCE}json\n${JSON.stringify(card(slug.split('/').pop()!))}\n${FENCE}\n` });

describe('storage_manifest doctor check', () => {
  test('not_applicable with no shelf and no interim record', async () => {
    const check = await storageManifestCheck(engine);
    expect(check).toMatchObject({ name: 'storage_manifest', status: 'ok', readiness_state: 'not_applicable' });
    expect(categorizeCheck('storage_manifest')).toBe('brain');
  }, 30_000);

  test('interim records warn until adopted; the index page does not count', async () => {
    await interim('storage-manifest/dataset-a');
    await interim('storage-manifest/index');
    const before = await engine.executeRaw('SELECT slug, updated_at::text AS at FROM pages ORDER BY slug');
    const check = await storageManifestCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('1 interim storage record(s)');
    expect(check.details).toMatchObject({ shelf: false, interim_pending: [{ source_id: 'default', count: 1 }] });
    expect(check.fix).toMatchObject({ argv: ['gbrain', 'storage', 'adopt', '--json'], verify: { argv: ['gbrain', 'doctor', '--only', 'storage_manifest', '--json'] } });
    expect(await engine.executeRaw('SELECT slug, updated_at::text AS at FROM pages ORDER BY slug')).toEqual(before);

    await call('add_tag', { slug: 'storage-manifest/dataset-a', tag: 'storage-manifest-adopted' });
    await call('storage_register', { card: card('dataset-a') });
    expect(await storageManifestCheck(engine)).toMatchObject({ status: 'ok', details: { shelf: true, invalid_cards: [], interim_pending: [] } });
  }, 30_000);

  test('a card failing the current schema warns by id, never by value', async () => {
    await call('storage_register', { card: card('dataset-a') });
    await engine.executeRaw("UPDATE pages SET frontmatter = jsonb_set(frontmatter, '{storage,restore}', '{\"skill\":\"restore-data\",\"command\":\"placeholder-command-value\"}'::jsonb) WHERE source_id='storage' AND slug='dataset-a'");
    const check = await storageManifestCheck(engine);
    expect(check).toMatchObject({ status: 'warn', details: { invalid_cards: ['dataset-a'] }, fix: { argv: ['gbrain', 'storage-get', 'dataset-a', '--json'] } });
    expect(JSON.stringify(check)).not.toContain('placeholder-command-value');
  }, 30_000);

  test('a hosted shelf whose directory is gone warns and asks the user', async () => {
    await call('storage_register', { card: card('dataset-a') });
    await engine.executeRaw("UPDATE sources SET local_path = '/srv/data/missing-shelf/worktree' WHERE id='storage'");
    const check = await storageManifestCheck(engine);
    expect(check).toMatchObject({ status: 'warn', details: { missing_dirs: ['/srv/data/missing-shelf/worktree'] }, fix: { ask_user: true, actor: 'user' } });
  }, 30_000);
});
