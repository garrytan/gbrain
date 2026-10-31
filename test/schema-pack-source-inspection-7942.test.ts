// #7942: MCP schema inspection resolves the caller's source pack, the same
// tiers capture and `gbrain schema active --source` use (per-source DB config).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { engineSchemaInput, loadActivePackForEngine } from '../src/core/schema-pack/engine-resolution.ts';
import { resolveActivePackNameOnly } from '../src/core/schema-pack/load-active.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('source-a','source-a') ON CONFLICT DO NOTHING");
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  home = emptyHome();
  await engine.executeRaw("DELETE FROM config WHERE key LIKE 'schema_pack%'");
});

const isolated = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, fn);
const remoteCtx = (sourceId: string) => ({ engine, config: { engine: 'pglite' }, remote: true, dryRun: false, sourceId,
  logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;
const call = (op: string, sourceId: string, p: Record<string, unknown> = {}) =>
  operationsByName[op]!.handler(remoteCtx(sourceId), p) as Promise<Record<string, unknown>>;

describe('#7942 schema inspection honors the per-source pack', () => {
  test('inspection ops report the pack write-time validation uses for the caller source', async () => {
    await engine.setConfig('schema_pack.source.source-a', 'company-brain');
    await isolated(async () => {
      const writePack = await loadActivePackForEngine(engine, { remote: true, sourceId: 'source-a' });
      const basePack = await loadActivePackForEngine(engine, { remote: true, sourceId: 'default' });
      expect(writePack.manifest.name).toBe('company-brain');
      expect(resolveActivePackNameOnly(await engineSchemaInput(engine, { remote: true, sourceId: 'source-a' })).source).toBe('per-source-db');
      const baseTypes = new Set(basePack.manifest.page_types.map(t => t.name));
      const sourceOnly = writePack.manifest.page_types.find(t => !baseTypes.has(t.name))!;
      expect(sourceOnly).toBeDefined();

      expect(await call('get_active_schema_pack', 'source-a')).toMatchObject({ pack_name: 'company-brain', source_tier: 'per-source-db',
        page_types_count: writePack.manifest.page_types.length });
      expect(await call('schema_explain_type', 'source-a', { type: sourceOnly.name })).toMatchObject({ pack: 'company-brain', type: { name: sourceOnly.name } });
      expect((await call('schema_graph', 'source-a')).pack).toBe('company-brain');
      expect((await call('schema_graph', 'source-a')).nodes).toEqual(writePack.manifest.page_types.map(t => ({ name: t.name, primitive: t.primitive })));
    });
  });

  test('another source keeps the brain-wide pack', async () => {
    await engine.setConfig('schema_pack.source.source-a', 'company-brain');
    await isolated(async () => {
      const active = await call('get_active_schema_pack', 'default');
      expect(active.pack_name).not.toBe('company-brain');
      expect(active.source_tier).not.toBe('per-source-db');
    });
  });
});
