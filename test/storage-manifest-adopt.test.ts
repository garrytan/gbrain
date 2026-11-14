/**
 * GST-1943: `gbrain storage adopt` on a repo-less brain (PGLite; the database is the record). Protects:
 *   - the preview maps each interim stored-object page under the prefix (never the index page) onto a card, lists every
 *     refused field with its reason, and writes nothing;
 *   - the apply needs the preview's plan_hash (a stale one refuses preview_changed) and each refused field named with
 *     --drop-field (storage_adopt_field_refused otherwise); it registers each card with origin adopt and tags the
 *     original storage-manifest-adopted, and never soft-deletes anything;
 *   - a credential-shaped value or record key refuses storage_record_secret whatever else is dropped, without echoing it;
 *   - idempotent: a card already on the shelf that matches is tagged only, a rerun writes nothing, and the plan_hash a
 *     half-finished run printed still applies; a differing card is a conflict, never overwritten, its original untagged;
 *   - finalize previews, then soft-deletes only the tagged originals whose card matches (storage_adopt_unverified when
 *     one differs), restorable afterwards;
 *   - a brain with a Git checkout refuses storage_manifest_missing until storage init has run;
 *   - each card takes its original's access labels, readable_by narrowed to the readers of the folder rules over it, so a
 *     storage-only remote caller reads no card its original was kept from; no common reader blocks the page, and a card
 *     that lost the labels is a conflict whose original finalize never deletes;
 *   - a write accepted but still pending is reported with its receipt (side_effects partial, never none);
 *   - a stored-object page a remote (MCP) client wrote is blocked at preview and apply, and nothing it holds reaches a card.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { applyAdopt, applyFinalize, previewAdopt, previewFinalize, ADOPTED_TAG } from '../src/core/storage-manifest/adopt.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
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
  await engine.unsetConfig('sync.repo_path');
});

const ctx = (over: Partial<OperationContext> = {}): OperationContext => ({
  engine, config: { engine: engine.kind, embedding_disabled: true } as OperationContext['config'],
  logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default', ...over,
}) as OperationContext;
const call = (name: string, params: Record<string, unknown>, c: OperationContext = ctx()) => operationsByName[name]!.handler(c, params) as Promise<Record<string, any>>;
const storageOnly = () => ctx({ remote: true, transport: 'http', sourceId: 'storage',
  auth: { token: 'fixture', clientId: 'client-s', principal: { kind: 'oauth_client', id: 'client-s' }, scopes: ['read'], sourceId: 'storage', allowedSources: ['storage'] } } as Partial<OperationContext>);
const restrict = (prefix: string, readers: string[]) => proposeRevision(engine, 'default', [{ id: 'restricted', prefix, readable_by: readers }], { origin: 'cli', store: 'database' });
async function committed(slug: string, sourceId: string, gone = false): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const rows = await engine.executeRaw('SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, slug]);
    if (rows.length === (gone ? 0 : 1)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${slug} did not commit`);
}
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (e: { code?: string; canonical?: string; reason?: string; message?: string; fix?: Record<string, unknown> }) =>
  ({ code: e.canonical ?? e.code, reason: e.reason ?? null, message: e.message ?? '', fix: e.fix ?? null }));
const opts = { sourceId: 'default', prefix: 'storage-manifest/' };

function record(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, title: `Dataset ${id}`, kind: 'dataset', status: 'archived',
    locations: [{ store: 'b2', bucket: 'bucket-a', path: `/archive/${id}`, tool: 'restic', repository: 'archive/restic', snapshot: 'a'.repeat(64),
      size_bytes: 2048, file_count: 4, sha256: 'b'.repeat(64), hash_kind: 'b2-listing-sha1-v1', verified_at: '2026-11-01T00:00:00Z' }],
    original_path: `/srv/data/${id}`, archived_at: '2026-11-01T00:00:00Z', reason: 'disk space',
    restore: { skill: 'restore-data', args: { id } },
    details: { manifest_lines: 4 },
    ...over,
  };
}

const FENCE = '```';

async function interim(slug: string, rec: Record<string, unknown> | string, type = 'stored-object', labels = ''): Promise<void> {
  const json = typeof rec === 'string' ? rec : JSON.stringify(rec, null, 2);
  const content = `---\ntype: ${type}\ntitle: Interim ${slug}\n${labels ? `${labels}\n` : ''}---\n# Interim ${slug}\n\n## Record\n\n${FENCE}json\n${json}\n${FENCE}\n\n## Restore\n\nAsk the archive agent.\n`;
  await call('put_page', { slug, content, request_id: randomUUID() });
}

const live = async () => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map((r) => r.slug);
const tagged = async () => (await engine.executeRaw<{ slug: string }>('SELECT p.slug FROM pages p JOIN tags t ON t.page_id = p.id WHERE t.tag = $1 ORDER BY p.slug', [ADOPTED_TAG])).map((r) => r.slug);

describe('storage adopt on a repo-less brain', () => {
  test('the preview maps interim pages, lists refused fields, skips the index and other types, and writes nothing', async () => {
    await interim('storage-manifest/dataset-a', record('dataset-a', { restore: { skill: 'restore-data', args: { id: 'dataset-a' }, command: 'restic restore latest' }, owner_note: 'kept for audits' }));
    await interim('storage-manifest/dataset-b', record('dataset-b'));
    await interim('storage-manifest/index', record('index-card'));
    await interim('storage-manifest/notes-c', record('notes-c'), 'note');
    await interim('other/dataset-d', record('dataset-d'));
    const pagesBefore = await live();
    const plan = await previewAdopt(ctx(), opts);
    expect(plan.entries.map((e) => [e.slug, e.state, e.card_id])).toEqual([['storage-manifest/dataset-a', 'register', 'dataset-a'], ['storage-manifest/dataset-b', 'register', 'dataset-b']]);
    expect(plan.entries[0]!.refused).toEqual([{ field: 'restore.command', reason: 'command_field' }, { field: 'owner_note', reason: 'unknown_field' }]);
    expect(plan.entries[0]!.card).toMatchObject({ id: 'dataset-a', kind: 'dataset', restore: { skill: 'restore-data', args: { id: 'dataset-a' } }, details: { manifest_lines: 4 } });
    expect(plan.entries[0]!.card!.restore).not.toHaveProperty('command');
    expect(plan.drop_fields).toEqual(['owner_note', 'restore.command']);
    expect(plan.shelf).toBe('creates');
    expect(plan.plan_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.apply).toEqual(['gbrain', 'storage', 'adopt', '--drop-field', 'owner_note', '--drop-field', 'restore.command', '--apply', '--expect', plan.plan_hash]);
    expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='storage'")).toEqual([]);
    expect(await live()).toEqual(pagesBefore);
    expect(await tagged()).toEqual([]);
  }, 60_000);

  test('apply needs the plan_hash and every refused field named; it registers origin adopt, tags the originals and deletes nothing', async () => {
    await interim('storage-manifest/dataset-a', record('dataset-a', { restore: { skill: 'restore-data', command: 'restic restore latest' } }));
    await interim('storage-manifest/dataset-b', record('dataset-b'));
    const plan = await previewAdopt(ctx(), opts);
    expect((await refusal(applyAdopt(ctx(), { ...opts, expect: 'f'.repeat(64), dropFields: ['restore.command'] })))?.code).toBe('preview_changed');
    const unnamed = await refusal(applyAdopt(ctx(), { ...opts, expect: plan.plan_hash, dropFields: [] }));
    expect(unnamed).toMatchObject({ code: 'storage_adopt_field_refused' });
    expect(unnamed!.message).toContain('restore.command');
    expect(unnamed!.fix).toMatchObject({ ask_user: true, argv: plan.apply });
    expect((await refusal(applyAdopt(ctx(), { ...opts, expect: plan.plan_hash, dropFields: ['restore.command', 'kind'] })))?.code).toBe('invalid_params');
    expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='storage'")).toEqual([]);

    const pagesBefore = await live();
    const applied = await applyAdopt(ctx(), { ...opts, expect: plan.plan_hash, dropFields: ['restore.command'] });
    expect(applied).toMatchObject({ side_effects: 'complete', conflicts: [], finalize: ['gbrain', 'storage', 'adopt', '--finalize'] });
    expect(applied.results.map((r) => r.outcome)).toEqual(['registered', 'retagged', 'registered', 'retagged']);
    const got = await call('storage_get', { id: 'dataset-a' });
    expect(got).toMatchObject({ origin: 'adopt', card: { id: 'dataset-a', restore: { skill: 'restore-data' }, locations: [{ hash_kind: 'b2-listing-sha1-v1' }] } });
    expect(got.card.restore).not.toHaveProperty('command');
    expect(await tagged()).toEqual(['storage-manifest/dataset-a', 'storage-manifest/dataset-b']);
    expect(await live()).toEqual(pagesBefore);
    expect(await engine.executeRaw("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NOT NULL")).toEqual([]);
    const original = await call('get_page', { slug: 'storage-manifest/dataset-a' });
    expect(JSON.stringify(original)).toContain('restic restore latest');

    const again = await previewAdopt(ctx(), opts);
    expect(again.entries.map((e) => e.state)).toEqual(['adopted', 'adopted']);
    expect(again.apply).toBeUndefined();
    expect(await applyAdopt(ctx(), { ...opts, expect: again.plan_hash, dropFields: ['restore.command'] })).toMatchObject({ side_effects: 'none' });
  }, 60_000);

  test('a credential-shaped value always refuses, even in a field that would be dropped, and is never echoed', async () => {
    await interim('storage-manifest/dataset-a', record('dataset-a', { restore: { skill: 'restore-data', command: 'B2_ACCOUNT_KEY=fake-key-value restic restore' } }));
    const plan = await previewAdopt(ctx(), opts);
    expect(plan.entries[0]).toMatchObject({ state: 'blocked', card: null, problem: { code: 'storage_record_secret', reason: 'env_assignment' } });
    expect(plan.apply).toBeUndefined();
    const refused = await refusal(applyAdopt(ctx(), { ...opts, expect: plan.plan_hash, dropFields: [] }));
    expect(refused).toMatchObject({ code: 'storage_record_secret', reason: 'env_assignment' });
    expect(refused!.message).toContain('storage-manifest/dataset-a');
    expect(refused!.message).not.toContain('fake-key-value');
    expect(JSON.stringify(plan)).not.toContain('fake-key-value');
    expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='storage'")).toEqual([]);

    await interim('storage-manifest/dataset-k', { ...record('dataset-k'), AKIAIOSFODNN7EXAMPLE: 'x' });
    const keyed = (await previewAdopt(ctx(), opts)).entries.find((e) => e.slug === 'storage-manifest/dataset-k')!;
    expect(keyed).toMatchObject({ state: 'blocked', refused: [], problem: { code: 'storage_record_secret', reason: 'secret_scanner' } });
    expect(JSON.stringify(await previewAdopt(ctx(), opts))).not.toContain('AKIAIOSFODNN7EXAMPLE');

    await interim('storage-manifest/dataset-p', record('dataset-p', { details: { password: 'fake-pass-value' } }));
    const named = (await previewAdopt(ctx(), opts)).entries.find((e) => e.slug === 'storage-manifest/dataset-p')!;
    expect(named).toMatchObject({ state: 'blocked', card: null, problem: { code: 'storage_record_secret', reason: 'credential_key' } });
    expect(JSON.stringify(named)).not.toContain('fake-pass-value');
  }, 60_000);

  test('an unreadable record and a duplicate card id block the apply', async () => {
    await interim('storage-manifest/dataset-a', '{ "id": "dataset-a", ');
    await interim('storage-manifest/dataset-b', record('dataset-b'));
    await interim('storage-manifest/dataset-c', record('dataset-b'));
    await call('put_page', { slug: 'storage-manifest/dataset-d', content: '---\ntype: stored-object\ntitle: No record\n---\n# No record\n\nMoved to bucket-a.\n', request_id: randomUUID() });
    const plan = await previewAdopt(ctx(), opts);
    expect(plan.entries.map((e) => [e.state, e.problem?.reason ?? null])).toEqual([['blocked', 'not_json'], ['register', null], ['blocked', 'duplicate_id'], ['blocked', 'no_record']]);
    expect((await refusal(applyAdopt(ctx(), { ...opts, expect: plan.plan_hash, dropFields: [] })))).toMatchObject({ code: 'storage_record_invalid' });
  }, 60_000);

  test('a matching card is only tagged, a differing one is a conflict, and a half-finished run applies with the hash it printed', async () => {
    await interim('storage-manifest/dataset-a', record('dataset-a'));
    await interim('storage-manifest/dataset-b', record('dataset-b'));
    await interim('storage-manifest/dataset-c', record('dataset-c'));
    const before = await previewAdopt(ctx(), opts);
    // As if a run stopped after registering dataset-a: the card is on the shelf, its original untagged.
    const { details: _d, ...rest } = record('dataset-a');
    await call('storage_register', { card: { ...rest, details: { manifest_lines: 4 } } });
    await call('storage_register', { card: { ...record('dataset-c'), reason: 'something else' } });
    const plan = await previewAdopt(ctx(), opts);
    expect(plan.entries.map((e) => e.state)).toEqual(['retag', 'register', 'conflict']);
    expect(plan.plan_hash).not.toBe(before.plan_hash);
    await call('storage_update', { id: 'dataset-c', expected_revision: (await call('storage_get', { id: 'dataset-c' })).revision, patch: { reason: 'disk space' } });
    expect((await previewAdopt(ctx(), opts)).plan_hash).toBe(before.plan_hash);
    const applied = await applyAdopt(ctx(), { ...opts, expect: before.plan_hash, dropFields: [] });
    expect(applied.results.map((r) => [r.slug, r.outcome])).toEqual([
      ['storage-manifest/dataset-a', 'retagged'], ['storage-manifest/dataset-b', 'registered'], ['storage-manifest/dataset-b', 'retagged'], ['storage-manifest/dataset-c', 'retagged']]);
    expect((await call('storage_get', { id: 'dataset-a' })).origin).toBe('local');

    await call('storage_update', { id: 'dataset-b', expected_revision: (await call('storage_get', { id: 'dataset-b' })).revision, patch: { reason: 'changed on the shelf' } });
    await call('remove_tag', { slug: 'storage-manifest/dataset-b', tag: ADOPTED_TAG });
    const conflicted = await previewAdopt(ctx(), opts);
    expect(conflicted.entries.map((e) => e.state)).toEqual(['adopted', 'conflict', 'adopted']);
    const result = await applyAdopt(ctx(), { ...opts, expect: conflicted.plan_hash, dropFields: [] });
    expect(result).toMatchObject({ side_effects: 'none', conflicts: ['storage-manifest/dataset-b'] });
    expect((await call('storage_get', { id: 'dataset-b' })).card.reason).toBe('changed on the shelf');
    expect(await tagged()).toEqual(['storage-manifest/dataset-a', 'storage-manifest/dataset-c']);
  }, 60_000);

  test('finalize previews, refuses while a card differs, then soft-deletes only the adopted originals', async () => {
    await interim('storage-manifest/dataset-a', record('dataset-a'));
    await interim('storage-manifest/dataset-b', record('dataset-b'));
    const plan = await previewAdopt(ctx(), opts);
    await applyAdopt(ctx(), { ...opts, expect: plan.plan_hash, dropFields: [] });
    await interim('storage-manifest/dataset-c', record('dataset-c'));

    await call('storage_update', { id: 'dataset-b', expected_revision: (await call('storage_get', { id: 'dataset-b' })).revision, patch: { status: 'retired' } });
    const blocked = await previewFinalize(ctx(), opts);
    expect(blocked.entries.map((e) => [e.slug, e.state])).toEqual([['storage-manifest/dataset-a', 'delete'], ['storage-manifest/dataset-b', 'unverified'], ['storage-manifest/dataset-c', 'not_adopted']]);
    expect(blocked.apply).toBeUndefined();
    expect((await refusal(applyFinalize(ctx(), { ...opts, expect: blocked.plan_hash })))?.code).toBe('storage_adopt_unverified');
    expect(await engine.executeRaw("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NOT NULL")).toEqual([]);

    await call('storage_update', { id: 'dataset-b', expected_revision: (await call('storage_get', { id: 'dataset-b' })).revision, patch: { status: 'archived' } });
    const ready = await previewFinalize(ctx(), opts);
    expect(ready.apply).toEqual(['gbrain', 'storage', 'adopt', '--finalize', '--expect', ready.plan_hash]);
    expect(await live()).toContain('storage-manifest/dataset-a');
    expect((await refusal(applyFinalize(ctx(), { ...opts, expect: blocked.plan_hash })))?.code).toBe('preview_changed');
    const done = await applyFinalize(ctx(), { ...opts, expect: ready.plan_hash });
    expect(done).toMatchObject({ side_effects: 'complete', deleted: ['storage-manifest/dataset-a', 'storage-manifest/dataset-b'] });
    expect(await live()).toEqual(['storage-manifest/dataset-c']);
    expect((await call('storage_list', {})).total).toBe(2);
    expect(await applyFinalize(ctx(), { ...opts, expect: ready.plan_hash })).toMatchObject({ side_effects: 'none', deleted: [] });
    const tombstone = await engine.readPageSnapshot('storage-manifest/dataset-a', { sourceId: 'default', includeDeleted: true });
    await call('restore_page', { slug: 'storage-manifest/dataset-a', expected_revision: tombstone!.revision });
    expect(await live()).toContain('storage-manifest/dataset-a');
  }, 60_000);

  test('finalize: a restore recorded on the card is no difference, other sections are named, and an original edited after the preview refuses', async () => {
    await interim('storage-manifest/dataset-a', record('dataset-a'));
    await interim('storage-manifest/dataset-b', record('dataset-b'));
    await call('put_page', { slug: 'storage-manifest/dataset-c', request_id: randomUUID(), content: `---\ntype: stored-object\ntitle: Interim long\n---\n## Record\n\n${FENCE}json\n${JSON.stringify(record('dataset-c'))}\n${FENCE}\n\n## Notes\n\n${'Long notes. '.repeat(6000)}\n\n## Late\n\nPast the read window.\n` });
    const plan = await previewAdopt(ctx(), opts);
    await applyAdopt(ctx(), { ...opts, expect: plan.plan_hash, dropFields: [] });
    await call('storage_update', { id: 'dataset-a', expected_revision: (await call('storage_get', { id: 'dataset-a' })).revision,
      restored_to: '/srv/scratch/dataset-a', restored_verified: true });
    expect((await call('storage_get', { id: 'dataset-a' })).card.status).toBe('restored');

    const preview = await previewFinalize(ctx(), opts);
    expect(preview.entries.map((e) => [e.slug, e.state, e.other_sections, e.unread_tail ?? false])).toEqual([['storage-manifest/dataset-a', 'delete', ['Restore'], false],
      ['storage-manifest/dataset-b', 'delete', ['Restore'], false], ['storage-manifest/dataset-c', 'delete', ['Notes'], true]]);
    expect(preview.summary.join(' ')).toContain('hold sections the card does not carry (Restore, Notes)');
    expect(preview.summary.join(' ')).toContain('longer than 64 KiB, so sections past that point were not read (storage-manifest/dataset-c)');
    expect(preview.apply).toEqual(['gbrain', 'storage', 'adopt', '--finalize', '--expect', preview.plan_hash]);

    const original = await engine.readPageSnapshot('storage-manifest/dataset-b', { sourceId: 'default' });
    await call('put_page', { slug: 'storage-manifest/dataset-b', expected_revision: original!.revision, request_id: randomUUID(),
      content: (await call('get_page', { slug: 'storage-manifest/dataset-b', include_content: true })).content.replace('Ask the archive agent.', 'Ask the archive agent first.') });
    expect((await refusal(applyFinalize(ctx(), { ...opts, expect: preview.plan_hash })))?.code).toBe('preview_changed');
    expect(await live()).toEqual(['storage-manifest/dataset-a', 'storage-manifest/dataset-b', 'storage-manifest/dataset-c']);
  }, 60_000);

  test('a brain with a Git checkout refuses storage_manifest_missing until storage init; the storage source is not an interim source', async () => {
    await interim('storage-manifest/dataset-a', record('dataset-a'));
    expect((await refusal(previewAdopt(ctx(), { ...opts, sourceId: 'storage' })))?.code).toBe('invalid_params');
    expect((await refusal(previewAdopt(ctx(), { ...opts, sourceId: 'source-missing' })))?.code).toBe('invalid_params');
    await engine.setConfig('sync.repo_path', '/srv/data/brain-checkout');
    expect((await refusal(previewAdopt(ctx(), opts)))?.code).toBe('storage_manifest_missing');
    expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='storage'")).toEqual([]);
  }, 60_000);

  test('adopt carries each original\'s access labels and folder-rule readers, so a storage-only remote caller reads no card its original was kept from', async () => {
    await restrict('storage-manifest/restricted/', ['member:alice-example', 'member:bob-example']);
    await interim('storage-manifest/dataset-m', record('dataset-m'), 'stored-object', 'readable_by: [alice-example]');
    await interim('storage-manifest/dataset-p', record('dataset-p'), 'stored-object', 'visibility: private');
    await interim('storage-manifest/restricted/dataset-r', record('dataset-r'), 'stored-object', 'readable_by: [bob-example, carol-example]');
    await interim('storage-manifest/dataset-o', record('dataset-o'));
    const plan = await previewAdopt(ctx(), opts);
    expect(Object.fromEntries(plan.entries.map((e) => [e.card_id, e.labels]))).toEqual({
      'dataset-m': { readable_by: ['alice-example'] }, 'dataset-o': {}, 'dataset-p': { visibility: 'private' }, 'dataset-r': { readable_by: ['member:bob-example'] } });
    expect(plan.summary.join(' ')).toContain("3 card(s) take their original's access labels");
    expect(await applyAdopt(ctx(), { ...opts, expect: plan.plan_hash, dropFields: [] })).toMatchObject({ side_effects: 'complete' });
    const stored = await engine.executeRaw<{ slug: string; visibility: string | null; readers: unknown }>(
      "SELECT slug, frontmatter->>'visibility' AS visibility, frontmatter->'readable_by' AS readers FROM pages WHERE source_id = 'storage' ORDER BY slug");
    expect(stored).toEqual([{ slug: 'dataset-m', visibility: null, readers: ['alice-example'] }, { slug: 'dataset-o', visibility: null, readers: null },
      { slug: 'dataset-p', visibility: 'private', readers: null }, { slug: 'dataset-r', visibility: null, readers: ['member:bob-example'] }]);
    for (const id of ['dataset-m', 'dataset-p', 'dataset-r']) expect((await refusal(call('storage_get', { id }, storageOnly())))?.code).toBe('not_found');
    expect((await call('storage_get', { id: 'dataset-o' }, storageOnly())).card.id).toBe('dataset-o');
    expect((await call('storage_list', {}, storageOnly())).cards.map((c: { id: string }) => c.id)).toEqual(['dataset-o']);
    expect((await call('storage_list', {})).total).toBe(4);
  }, 60_000);

  test('an original whose readers and folder rules share no reader is blocked; a card that lost its original\'s labels is a conflict and its original is never finalized', async () => {
    await restrict('storage-manifest/restricted/', ['member:alice-example']);
    await interim('storage-manifest/restricted/dataset-x', record('dataset-x'), 'stored-object', 'readable_by: [carol-example]');
    const blocked = await previewAdopt(ctx(), opts);
    expect(blocked.entries.map((e) => [e.state, e.problem?.reason])).toEqual([['blocked', 'access_unpreservable']]);
    expect((await refusal(applyAdopt(ctx(), { ...opts, expect: blocked.plan_hash, dropFields: [] })))?.reason).toBe('access_unpreservable');
    expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id = 'storage'")).toEqual([]);

    const x = await engine.readPageSnapshot('storage-manifest/restricted/dataset-x', { sourceId: 'default' });
    await call('delete_page', { slug: 'storage-manifest/restricted/dataset-x', expected_revision: x!.revision });
    await interim('storage-manifest/dataset-m', record('dataset-m'), 'stored-object', 'readable_by: [alice-example]');
    const plan = await previewAdopt(ctx(), opts);
    await applyAdopt(ctx(), { ...opts, expect: plan.plan_hash, dropFields: [] });
    await engine.executeRaw("UPDATE pages SET frontmatter = frontmatter - 'readable_by' WHERE source_id = 'storage' AND slug = 'dataset-m'");
    expect((await previewFinalize(ctx(), opts)).entries.map((e) => [e.slug, e.state])).toEqual([['storage-manifest/dataset-m', 'unverified']]);
    await engine.executeRaw('DELETE FROM tags WHERE tag = $1', [ADOPTED_TAG]);
    expect((await previewAdopt(ctx(), opts)).entries.map((e) => e.state)).toEqual(['conflict']);
  }, 60_000);

  test('a stored-object page a remote client wrote is blocked at preview and apply, and its restore.args never reach a card', async () => {
    await interim('storage-manifest/dataset-l', record('dataset-l'));
    await engine.executeRaw("INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id) VALUES('client-w','fixture-hash','example-client','read write','default')");
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const remote = ctx({ remote: true, transport: 'http', auth: { token: 'fixture', clientId: 'client-w', principal: { kind: 'oauth_client', id: 'client-w' }, scopes: ['read', 'write'], sourceId: 'default', allowedSources: ['default'] } } as Partial<OperationContext>);
    const rec = JSON.stringify(record('dataset-w', { restore: { skill: 'restore-data', args: { target: '/srv/remote-chosen-target' } } }));
    await call('put_page', { slug: 'storage-manifest/dataset-w', request_id: randomUUID(), content: `---\ntype: stored-object\ntitle: Remote record\n---\n## Record\n\n${FENCE}json\n${rec}\n${FENCE}\n` }, remote);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    const plan = await previewAdopt(ctx(), opts);
    expect(plan.entries.map((e) => [e.slug, e.state, e.problem?.reason ?? null])).toEqual([['storage-manifest/dataset-l', 'register', null], ['storage-manifest/dataset-w', 'blocked', 'remote_written']]);
    expect(plan.apply).toBeUndefined();
    const refused = await refusal(applyAdopt(ctx(), { ...opts, expect: plan.plan_hash, dropFields: [] }));
    expect({ code: refused?.code, reason: refused?.reason }).toEqual({ code: 'storage_record_invalid', reason: 'remote_written' });
    expect(await engine.executeRaw("SELECT 1 FROM pages WHERE source_id = 'storage'")).toEqual([]);
    expect(JSON.stringify(await engine.executeRaw("SELECT frontmatter FROM pages WHERE source_id = 'storage'"))).not.toContain('remote-chosen-target');
    expect(await tagged()).toEqual([]);
  }, 60_000);

  test('a write accepted but still pending is reported with its receipt, never as no change, and the rerun finishes it', async () => {
    await interim('storage-manifest/dataset-a', record('dataset-a'));
    const plan = await previewAdopt(ctx(), opts);
    const held = await applyAdopt(ctx({ writeWaitMs: 0 }), { ...opts, expect: plan.plan_hash, dropFields: [] });
    expect(held).toMatchObject({ side_effects: 'partial', results: [], pending: [{ item: 'storage-manifest/dataset-a', state: expect.any(String), poll: ['gbrain', 'write-request', expect.any(String)] }],
      rerun: ['gbrain', 'storage', 'adopt', '--apply', '--expect', plan.plan_hash] });
    expect(held.failure).toBeUndefined();
    expect(held.finalize).toBeUndefined();
    await committed('dataset-a', 'storage');
    expect(await applyAdopt(ctx(), { ...opts, expect: plan.plan_hash, dropFields: [] })).toMatchObject({ side_effects: 'complete', results: [{ outcome: 'retagged' }] });
    const finalize = await previewFinalize(ctx(), opts);
    const deleting = await applyFinalize(ctx({ writeWaitMs: 0 }), { ...opts, expect: finalize.plan_hash });
    expect(deleting).toMatchObject({ side_effects: 'partial', deleted: [], pending: [{ item: 'storage-manifest/dataset-a' }] });
    await committed('storage-manifest/dataset-a', 'default', true);
  }, 60_000);
});
