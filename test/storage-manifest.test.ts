/**
 * GST-1943: the storage shelf on a repo-less brain (PGLite; the database is the record). Protects:
 *   - the first storage_register creates the database-only, non-federated storage source with its role, and the card
 *     round-trips through storage_get with registered_by and origin stamped by gbrain;
 *   - storage_find ranks exact id, then exact alias, then most of the phrase's words; a miss says not_found and lists
 *     the closest cards; storage_list filters by store and status;
 *   - validation refuses a missing field, a command field, a stamped field, a scanner secret and every credential shape
 *     (env assignment, credential variable, URL userinfo, presigned URL), without echoing the value;
 *   - the write guard: put_page and remember into the shelf are refused storage_source_managed, a forged parameter
 *     does not open it, and the storage verbs still write;
 *   - register never overwrites (storage_card_exists); update binds to the revision it read (storage_revision_conflict
 *     carries the current one) and records a restore newest first;
 *   - register and update refuse remote callers; the shelf is not federated, so a remote connection reads cards only
 *     when its grant names the storage source (an ungranted bound client and an unbound stdio connection are refused);
 *   - derived writers skip the shelf: a dream cycle scoped to the storage source runs no phase, and enrichment
 *     considers no card there (no model call, no page write).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runCycle } from '../src/core/cycle.ts';
import { runEnrichCore } from '../src/commands/enrich.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-storage-manifest-'));
}, 60_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
}, 60_000);
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  await engine.unsetConfig('sync.repo_path');
});

const ctx = (over: Partial<OperationContext> = {}): OperationContext => ({
  engine, config: { engine: engine.kind, embedding_disabled: true } as OperationContext['config'],
  logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default', ...over,
}) as OperationContext;
const call = (name: string, params: Record<string, unknown>, c: OperationContext = ctx()) =>
  operationsByName[name]!.handler(c, params) as Promise<Record<string, any>>;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (e: { code?: string; canonical?: string; reason?: string; message?: string }) => ({ code: e.canonical ?? e.code, reason: e.reason ?? null, message: e.message ?? '' }));

function card(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, title: `Dataset ${id}`, aliases: [], kind: 'directory', status: 'archived',
    description: 'Example archive used by the storage manifest tests.',
    locations: [{ store: 'b2', bucket: 'bucket-a', path: `/archive/${id}`, tool: 'restic', repository: 'archive/restic', snapshot: 'a'.repeat(64),
      size_bytes: 1024, file_count: 3, sha256: 'b'.repeat(64), hash_kind: 'sha256-tree-v1', verified_at: '2026-11-08T00:00:00Z' }],
    original_path: `/srv/data/${id}`, on_source_machine: false, archived_at: '2026-11-08T00:00:00Z', archived_by: 'archive-agent', reason: 'disk space',
    restore: { skill: 'restore-data', args: { id } },
    ...over,
  };
}

describe('storage shelf on a repo-less brain', () => {
  test('the first register creates the non-federated storage source; get round-trips the card with stamped fields', async () => {
    const out = await call('storage_register', { card: card('mail-export-oct', { aliases: ['october gmail dataset'] }) });
    expect(out).toMatchObject({ id: 'mail-export-oct', source_id: 'storage', origin: 'local' });
    const [source] = await engine.executeRaw<{ config: Record<string, unknown> | string; local_path: string | null }>("SELECT config, local_path FROM sources WHERE id='storage'");
    const config = typeof source!.config === 'string' ? JSON.parse(source!.config) : source!.config;
    expect(config).toMatchObject({ role: 'storage_manifest', federated: false });
    expect(source!.local_path).toBeNull();
    const got = await call('storage_get', { id: 'mail-export-oct' });
    expect(got.card).toMatchObject({ id: 'mail-export-oct', title: 'Dataset mail-export-oct', aliases: ['october gmail dataset'], kind: 'directory',
      locations: [{ store: 'b2', snapshot: 'a'.repeat(64), size_bytes: 1024 }], restore: { skill: 'restore-data', args: { id: 'mail-export-oct' } }, origin: 'local' });
    expect(got.registered_by).toMatch(/^local_cli:/);
    expect(typeof got.revision).toBe('string');
  }, 30_000);

  test('find ranks id, alias and words; a miss lists the closest cards; list filters', async () => {
    await call('storage_register', { card: card('mail-export-oct', { title: 'October mail and web export', aliases: ['october gmail dataset'] }) });
    await call('storage_register', { card: card('model-weights-a', { title: 'Merged model weights', aliases: ['the big model'], kind: 'file' }) });
    await call('storage_register', { card: card('family-media', { title: 'Family media library', status: 'restored',
      locations: [{ store: 'supabase', bucket: 'bucket-b', path: 'items/family-media/', tool: 'object', size_bytes: 2048 }] }) });

    expect((await call('storage_find', { query: 'model-weights-a' })).hits[0]).toMatchObject({ id: 'model-weights-a', match: 'id' });
    expect((await call('storage_find', { query: 'October Gmail Dataset' })).hits[0]).toMatchObject({ id: 'mail-export-oct', match: 'alias' });
    const words = await call('storage_find', { query: 'bring back the merged model weights' });
    expect(words.hits[0]).toMatchObject({ id: 'model-weights-a', match: 'words' });
    expect(words.next.argv).toEqual(['gbrain', 'storage-get', 'model-weights-a', '--json']);

    const miss = await call('storage_find', { query: 'famly medai' });
    expect(miss.not_found).toBe(true);
    expect(miss.hits).toEqual([]);
    expect(miss.closest[0].id).toBe('family-media');

    const nothing = await call('storage_find', { query: 'zzqx quarterly invoices' });
    expect(nothing).toMatchObject({ not_found: true, hits: [] });

    expect((await call('storage_list', { store: 'supabase' })).cards.map((c: { id: string }) => c.id)).toEqual(['family-media']);
    expect((await call('storage_list', { status: 'archived' })).total).toBe(2);
    expect((await call('storage_find', { query: 'export', store: 'supabase' })).hits).toEqual([]);
  }, 30_000);

  test('validation refuses incomplete cards, command fields, stamped fields, secrets and credential shapes', async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [card('a-1', { locations: [{ store: 'b2', path: '/x', tool: 'restic' }] }), 'storage_record_invalid', 'schema'],
      [card('a-2', { restore: { skill: 'restore-data', command: 'restore-data --id a-2' } }), 'storage_record_invalid', 'command_field'],
      [card('a-3', { details: { steps: [{ Script: 'rm -rf /' }] } }), 'storage_record_invalid', 'command_field'],
      [card('a-4', { origin: 'import' }), 'storage_record_invalid', 'stamped_field'],
      [card('a-5', { reason: 'key AKIAIOSFODNN7EXAMPLE was used' }), 'storage_record_secret', 'secret_scanner'],
      [card('a-6', { reason: 'run with B2_ACCOUNT_KEY=abcdef123' }), 'storage_record_secret', 'env_assignment'],
      [card('a-7', { restore: { skill: 'restore-data', args: { id: 'a-7', key: '$B2_APPLICATION_KEY' } } }), 'storage_record_secret', 'credential_variable'],
      [card('a-8', { locations: [{ store: 's3', path: 'https://user:@example.invalid/x', tool: 'object', size_bytes: 1 }] }), 'storage_record_secret', 'url_userinfo'],
      [card('a-9', { locations: [{ store: 's3', path: 'https://example.invalid/x?X-Amz-Signature=abc', tool: 'object', size_bytes: 1 }] }), 'storage_record_secret', 'presigned_url'],
    ];
    for (const [input, code, reason] of cases) {
      const r = await refusal(call('storage_register', { card: input }));
      expect({ id: input.id, code: r?.code, reason: r?.reason }).toEqual({ id: input.id, code, reason });
      expect(r!.message).not.toContain('abcdef123');
      expect(r!.message).not.toContain('AKIAIOSFODNN7EXAMPLE');
    }
    expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id='storage'")).toEqual([]);
  }, 30_000);

  test('the write guard refuses put_page and remember into the shelf, forged parameters included', async () => {
    await call('storage_register', { card: card('guarded-item') });
    const put = await refusal(call('put_page', { slug: 'guarded-item', source_id: 'storage', content: '---\ntype: note\ntitle: x\n---\nOverwrite.\n', request_id: randomUUID() }));
    expect(put?.code).toBe('storage_source_managed');
    const forged = await refusal(call('put_page', { slug: 'other', source_id: 'storage', content: '---\ntype: note\ntitle: y\n---\nNew.\n', storage_door: true, request_id: randomUUID() }));
    expect(forged?.code).not.toBeNull();
    expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id='storage' AND slug='other'")).toEqual([]);
    const remember = await refusal(call('remember', { fact: 'The item moved.', entity: 'guarded-item', source_id: 'storage', provenance: 'test', request_id: randomUUID() }));
    expect(remember?.message).toContain('is the storage manifest; only the storage verbs write it');
    expect(await engine.executeRaw("SELECT 1 FROM facts WHERE source_id='storage'")).toEqual([]);
    const got = await call('storage_get', { id: 'guarded-item' });
    expect(got.card.title).toBe('Dataset guarded-item');
  }, 30_000);

  test('register never overwrites; update binds to its revision and records restores newest first', async () => {
    await call('storage_register', { card: card('item-b') });
    expect((await refusal(call('storage_register', { card: card('item-b') })))?.code).toBe('storage_card_exists');
    const first = await call('storage_get', { id: 'item-b' });
    await call('storage_update', { id: 'item-b', expected_revision: first.revision, restored_to: '/scratch/item-b', restored_verified: true });
    const stale = await refusal(call('storage_update', { id: 'item-b', expected_revision: first.revision, patch: { status: 'retired' } }));
    expect(stale?.code).toBe('storage_revision_conflict');
    const second = await call('storage_get', { id: 'item-b' });
    expect(second.card.status).toBe('restored');
    expect(second.card.restores[0]).toMatchObject({ to: '/scratch/item-b', verified: true });
    await call('storage_update', { id: 'item-b', expected_revision: second.revision, restored_to: '/scratch/item-b-2' });
    const third = await call('storage_get', { id: 'item-b' });
    expect(third.card.restores.map((r: { to: string }) => r.to)).toEqual(['/scratch/item-b-2', '/scratch/item-b']);
    expect((await refusal(call('storage_update', { id: 'item-b', expected_revision: third.revision, patch: { reason: 'TOKEN=abc123' } })))?.code).toBe('storage_record_secret');
    expect((await refusal(call('storage_update', { id: 'item-b', expected_revision: third.revision, patch: { origin: 'import' } })))?.code).toBe('storage_record_invalid');
  }, 30_000);

  test('remote callers cannot write; a bound client without the storage grant reads nothing; only a grant naming the shelf reads it', async () => {
    await call('storage_register', { card: card('remote-item') });
    const remote = ctx({ remote: true, transport: 'http' } as Partial<OperationContext>);
    expect((await refusal(call('storage_register', { card: card('remote-new') }, remote)))?.code).toBe('trusted_local_only');
    const rev = (await call('storage_get', { id: 'remote-item' })).revision;
    expect((await refusal(call('storage_update', { id: 'remote-item', expected_revision: rev, patch: { status: 'retired' } }, remote)))?.code).toBe('trusted_local_only');

    const bound = ctx({ remote: true, transport: 'http', sourceId: 'default',
      auth: { token: 'fixture', clientId: 'client-a', principal: { kind: 'oauth_client', id: 'client-a' }, scopes: ['read'], sourceId: 'default', allowedSources: ['default'] } } as Partial<OperationContext>);
    const boundFind = await refusal(call('storage_find', { query: 'remote-item' }, bound));
    expect(boundFind?.code).toBe('permission_denied');
    expect((await refusal(call('storage_get', { id: 'remote-item' }, bound)))?.code).toBe('permission_denied');

    const unbound = ctx({ remote: true, transport: 'stdio' } as Partial<OperationContext>);
    expect((await refusal(call('storage_find', { query: 'remote-item' }, unbound)))?.code).toBe('permission_denied');

    const granted = ctx({ remote: true, transport: 'http', sourceId: 'default',
      auth: { token: 'fixture', clientId: 'client-b', principal: { kind: 'oauth_client', id: 'client-b' }, scopes: ['read'], sourceId: 'default', allowedSources: ['default', 'storage'] } } as Partial<OperationContext>);
    expect((await call('storage_find', { query: 'remote-item' }, granted)).hits[0].id).toBe('remote-item');
    expect((await call('storage_get', { id: 'remote-item' }, granted)).card.id).toBe('remote-item');
  }, 30_000);

  test('derived writers skip the shelf: dream scoped to it runs no phase, enrichment considers no card', async () => {
    await call('storage_register', { card: card('thin-card') });
    const before = await engine.executeRaw<{ revision: string }>("SELECT updated_at::text AS revision FROM pages WHERE source_id='storage'");
    const report = await runCycle(engine, { brainDir: null, sourceId: 'storage', phases: ['extract', 'extract_facts', 'backlinks', 'lint'] });
    expect(report).toMatchObject({ status: 'skipped', reason: 'storage_manifest_source', phases: [] });
    let modelCalls = 0;
    const enriched = await runEnrichCore(engine, { sourceId: 'storage', types: ['stored-object'], thinThreshold: 1_000_000, minContextChars: 0, dryRun: false,
      synthesizeFn: (async () => { modelCalls++; return 'enriched'; }) as never });
    expect(enriched).toMatchObject({ candidates_considered: 0, pages_enriched: 0, pages_failed: 0 });
    expect(modelCalls).toBe(0);
    expect(await engine.executeRaw("SELECT updated_at::text AS revision FROM pages WHERE source_id='storage'")).toEqual(before);
  }, 30_000);

  test('a brain with a Git checkout needs storage init first, and init needs managed persistence', async () => {
    await engine.setConfig('sync.repo_path', join(home, 'repo'));
    expect((await refusal(call('storage_register', { card: card('repo-item') })))?.code).toBe('storage_manifest_missing');
    const { initStorageSource } = await import('../src/core/storage-manifest/source.ts');
    expect((await refusal(initStorageSource(engine, { dryRun: true })))?.code).toBe('invalid_params');
    expect((await refusal(initStorageSource(engine, { dir: join(home, 'shelf'), dryRun: true })))?.code).toBe('strict_requires_managed');
    expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='storage'")).toEqual([]);
  }, 30_000);

  test('storage init on a repo-less brain previews, then creates the database-only shelf once', async () => {
    const { initStorageSource } = await import('../src/core/storage-manifest/source.ts');
    const preview = await initStorageSource(engine, { dryRun: true });
    expect(preview).toMatchObject({ action: 'create_database_source', dry_run: true, apply: ['gbrain', 'storage', 'init'] });
    expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='storage'")).toEqual([]);
    expect(await initStorageSource(engine, { dryRun: false })).toMatchObject({ action: 'create_database_source', dry_run: false });
    expect(await initStorageSource(engine, { dryRun: false })).toMatchObject({ action: 'none' });
  }, 30_000);
});
