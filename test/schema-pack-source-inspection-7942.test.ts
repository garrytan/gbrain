import { afterAll, beforeAll, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  if (home) rmSync(home, { recursive: true, force: true });
});

it('uses the caller source Schema Pack for MCP inspection', async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
  home = mkdtempSync(join(tmpdir(), 'gbrain-schema-source-7942-'));
  const dir = join(home, '.gbrain', 'schema-packs', 'source-pack');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.yaml'), `api_version: gbrain-schema-pack-v1
name: source-pack
version: 1.0.0
description: ""
gbrain_min_version: 0.38.0
extends: null
borrow_from: []
page_types:
  - name: source_only
    primitive: entity
    path_prefixes: [source/]
    aliases: []
    extractable: false
    expert_routing: false
link_types: []
frontmatter_links: []
takes_kinds: [fact, take, bet, hunch]
enrichable_types: []
filing_rules: []
`);

  await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, async () => {
    await engine.setConfig('schema_pack.source.test-source', 'source-pack');
    const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, sourceId: 'test-source' } as never;
    const active = await operationsByName.get_active_schema_pack!.handler(ctx, {}) as Record<string, unknown>;
    const explained = await operationsByName.schema_explain_type!.handler(ctx, { type: 'source_only' }) as Record<string, unknown>;
    expect(active.pack_name).toBe('source-pack');
    expect(active.source_tier).toBe('per-source-db');
    expect(explained.pack).toBe('source-pack');
    expect((explained.type as { name?: string }).name).toBe('source_only');
  });
});
