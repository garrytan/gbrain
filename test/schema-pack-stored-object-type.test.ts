/**
 * The stock base pack (gbrain-base-v2, the init default) and packs extending it (company-brain) declare
 * `stored-object`, the type the storage verbs stamp on every storage shelf card.
 *
 * Protects: registering a card on a default brain never trips doctor `schema_pack_consistency`
 * (`page_type_undeclared`), and the catch-all retype rule never turns cards into notes, which would hide them
 * from storage_find and storage_list.
 * Regression: a pack edit that drops the declaration.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSchemaPackConsistency } from '../src/commands/doctor/schema-pack-checks.ts';
import { classifyStoredType } from '../src/core/schema-pack/type-usage.ts';
import { bundledPackPath } from '../src/core/schema-pack/bundled-assets.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { mergeInheritedManifest } from '../src/core/schema-pack/merge.ts';
import { extractableTypesFromPack } from '../src/core/schema-pack/extractable.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { STORED_OBJECT_TYPE } from '../src/core/storage-manifest/schema.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine?.disconnect();
}, 60_000);

describe('stored-object page type in the stock base pack', () => {
  test('gbrain-base-v2 declares stored-object as a non-extractable annotation, and company-brain inherits it', () => {
    const base = loadPackFromFile(bundledPackPath('gbrain-base-v2')!);
    expect(classifyStoredType(STORED_OBJECT_TYPE, base)).toEqual({ kind: 'canonical' });
    expect(base.page_types.find(t => t.name === STORED_OBJECT_TYPE)).toMatchObject({
      primitive: 'annotation', path_prefixes: [], extractable: false, expert_routing: false,
    });
    expect(extractableTypesFromPack(base).has(STORED_OBJECT_TYPE)).toBe(false);
    const company = mergeInheritedManifest([base], loadPackFromFile(bundledPackPath('company-brain')!), { page_types: [], link_types: [] });
    expect(classifyStoredType(STORED_OBJECT_TYPE, company)).toEqual({ kind: 'canonical' });
  });

  test('a registered card keeps the consistency check ok on the shelf', async () => {
    const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} },
      dryRun: false, remote: false, sourceId: 'default' } as unknown as OperationContext;
    await operationsByName.storage_register!.handler(ctx, { card: {
      id: 'dataset-a', title: 'Dataset a', aliases: [], kind: 'directory', status: 'archived',
      locations: [{ store: 'b2', bucket: 'bucket-a', path: '/archive/dataset-a', tool: 'restic', size_bytes: 1024 }],
      restore: { skill: 'restore-data', args: { id: 'dataset-a' } },
    } });
    expect((await engine.getPage('dataset-a', { sourceId: 'storage' }))?.type).toBe(STORED_OBJECT_TYPE);
    const check = await checkSchemaPackConsistency(engine, { sourceIds: ['storage'] });
    expect({ status: check.status, message: check.message }).toEqual({ status: 'ok', message: 'All pages match the active schema pack across every source.' });
  }, 60_000);
});
