/**
 * GST-1943: storage shelf recovery as JSONL (PGLite, repo-less). Protects:
 *   - export writes one card per line, sorted by id, stamped fields included;
 *   - importing that export into an empty brain previews every line as create, and the apply (bound to its plan_hash)
 *     reproduces every card with origin import, so a second export matches the first apart from the stamps;
 *   - a rerun is idempotent (identical, side_effects none); a card on the shelf that differs is a conflict, never
 *     overwritten; invalid lines (not JSON, a credential shape, a duplicate id) are listed without their values.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { applyImport, exportShelfJsonl, previewImport } from '../src/core/storage-manifest/jsonl.ts';

let source: PGLiteEngine;
let target: PGLiteEngine;

beforeAll(async () => {
  source = new PGLiteEngine();
  await source.connect({});
  await source.initSchema();
  target = new PGLiteEngine();
  await target.connect({});
  await target.initSchema();
}, 60_000);
afterAll(async () => {
  for (const engine of [source, target]) await disposePersistenceConsumer(engine);
  await source.disconnect();
  await target.disconnect();
}, 60_000);

const ctx = (engine: PGLiteEngine): OperationContext => ({
  engine, config: { engine: engine.kind, embedding_disabled: true } as OperationContext['config'],
  logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default',
}) as OperationContext;
const call = (engine: PGLiteEngine, name: string, params: Record<string, unknown>) => operationsByName[name]!.handler(ctx(engine), params) as Promise<Record<string, any>>;

function card(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, title: `Dataset ${id}`, aliases: [`${id} archive`], kind: 'directory', description: 'Example archive for the JSONL tests.',
    locations: [{ store: 'supabase', bucket: 'bucket-a', path: `archive/${id}`, tool: 'object', size_bytes: 512, file_count: 2, hash_kind: 'supabase-listing-etag-v1', verified_at: '2026-11-02T00:00:00Z' },
      { store: 's3', bucket: 'bucket-b', path: `/archive/${id}`, tool: 'rclone', size_bytes: 512 }],
    original_path: `/srv/data/${id}`, on_source_machine: false, restore: { skill: 'restore-data', args: { id, verify: true } },
    restores: [{ at: '2026-11-03T00:00:00Z', to: `/srv/scratch/${id}`, verified: true }], details: { note: 'placeholder', parts: [1, 2] },
    ...over,
  };
}

const withoutStamps = (line: string) => { const { registered_by: _b, origin: _o, ...rest } = JSON.parse(line); return rest; };

describe('storage shelf JSONL export and import', () => {
  test('export, then import into an empty brain, reproduces every card; a rerun is idempotent', async () => {
    for (const id of ['dataset-b', 'dataset-a', 'acme-example-runs']) await call(source, 'storage_register', { card: card(id) });
    const exported = await exportShelfJsonl(source);
    expect(exported.skipped).toEqual([]);
    expect(exported.lines.map((l) => JSON.parse(l).id)).toEqual(['acme-example-runs', 'dataset-a', 'dataset-b']);
    expect(JSON.parse(exported.lines[0]!)).toMatchObject({ origin: 'local', registered_by: expect.any(String) });
    const text = `${exported.lines.join('\n')}\n`;

    expect((await exportShelfJsonl(target)).lines).toEqual([]);
    const { cards: _c, ...plan } = await previewImport(target, 'shelf.jsonl', text);
    expect(plan.lines.map((l) => l.action)).toEqual(['create', 'create', 'create']);
    expect(plan.apply).toEqual(['gbrain', 'storage', 'import', '--jsonl', 'shelf.jsonl', '--apply', '--expect', plan.plan_hash]);
    expect(await target.executeRaw("SELECT 1 FROM sources WHERE id='storage'")).toEqual([]);
    expect(await applyImport(ctx(target), 'shelf.jsonl', text, 'f'.repeat(64)).then(() => null, (e) => e.code)).toBe('preview_changed');

    const applied = await applyImport(ctx(target), 'shelf.jsonl', text, plan.plan_hash);
    expect(applied).toMatchObject({ side_effects: 'complete', created: ['acme-example-runs', 'dataset-a', 'dataset-b'], conflicts: [], invalid: [] });
    const reimported = await exportShelfJsonl(target);
    expect(reimported.lines.map(withoutStamps)).toEqual(exported.lines.map(withoutStamps));
    expect(reimported.lines.map((l) => JSON.parse(l).origin)).toEqual(['import', 'import', 'import']);

    const { cards: _again, ...rerun } = await previewImport(target, 'shelf.jsonl', text);
    expect(rerun.lines.map((l) => l.action)).toEqual(['identical', 'identical', 'identical']);
    expect(rerun.plan_hash).toBe(plan.plan_hash);
    expect(rerun.apply).toBeUndefined();
    expect(await applyImport(ctx(target), 'shelf.jsonl', text, plan.plan_hash)).toMatchObject({ side_effects: 'none', created: [], identical: ['acme-example-runs', 'dataset-a', 'dataset-b'] });
  }, 60_000);

  test('a differing card is a conflict and never overwritten; invalid lines are listed without their values', async () => {
    const lines = [
      JSON.stringify({ ...card('dataset-a'), reason: 'a different reason' }),
      '{ not json',
      JSON.stringify(card('dataset-c', { reason: 'export SUPABASE_SERVICE_KEY=fake-secret-value' })),
      JSON.stringify(card('dataset-d')),
      JSON.stringify(card('dataset-d')),
      '',
    ];
    const text = lines.join('\n');
    const { cards: _c, ...plan } = await previewImport(target, 'more.jsonl', text);
    expect(plan.lines.map((l) => [l.line, l.action, l.reason ?? null])).toEqual([[1, 'conflict', null], [2, 'invalid', 'not_json'], [3, 'invalid', 'env_assignment'], [4, 'create', null], [5, 'invalid', 'duplicate_id']]);
    expect(JSON.stringify(plan)).not.toContain('fake-secret-value');
    const applied = await applyImport(ctx(target), 'more.jsonl', text, plan.plan_hash);
    expect(applied).toMatchObject({ side_effects: 'complete', created: ['dataset-d'], conflicts: ['dataset-a'], invalid: [2, 3, 5] });
    expect((await call(target, 'storage_get', { id: 'dataset-a' })).card.reason ?? null).toBeNull();
    expect((await call(target, 'storage_get', { id: 'dataset-d' })).origin).toBe('import');
  }, 60_000);
});
