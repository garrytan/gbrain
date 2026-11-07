/**
 * #8815: doctor schema_pack_consistency must not count gbrain's own
 * extract_receipt pages as undeclared on a custom pack that predates the type.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSchemaPackConsistency } from '../src/commands/doctor/schema-pack-checks.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

const PACK = `api_version: gbrain-schema-pack-v1
name: legacy-copy
version: 1.0.0
description: custom pack copied before extract_receipt existed
gbrain_min_version: 0.42.0
extends: null
borrow_from: []
takes_kinds: []
phases: []
page_types:
  - name: note
    primitive: concept
    path_prefixes:
      - notes/
    aliases: []
    extractable: true
    expert_routing: false
link_types: []
`;

beforeAll(async () => {
  home = emptyHome();
  mkdirSync(join(home, '.gbrain', 'schema-packs', 'legacy-copy'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'schema-packs', 'legacy-copy', 'pack.yaml'), PACK);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('schema_pack', 'legacy-copy');
  await engine.putPage('extracts/2026-08-01/atoms/default/x/round-single', { type: 'extract_receipt', title: 'receipt', compiled_truth: 'r' }, { sourceId: 'default' });
  await engine.putPage('notes/custom', { type: 'custom_fixture', title: 'Custom', compiled_truth: 'c' }, { sourceId: 'default' });
}, 60_000);

afterAll(async () => { await engine?.disconnect(); });

describe('#8815 gbrain-owned extract receipts', () => {
  test('are not reported as undeclared on a pack that predates the type; user types still are', async () => {
    const check = await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, () =>
      checkSchemaPackConsistency(engine, { sourceIds: ['default'] }));
    expect(check.message).toContain('custom_fixture');
    expect(check.message).not.toContain('extract_receipt');
  });
});
