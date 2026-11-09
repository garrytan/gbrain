/**
 * #8815: schema_pack_consistency counted every stored type the active pack
 * lacks as user schema drift, so a custom pack copied from gbrain-base-v2
 * before it declared gbrain's own page types (`extract_receipt`, `code`,
 * #6818) warned `page_type_undeclared` about pages gbrain itself writes.
 * Pages gbrain wrote are exempt, judged by how they were written (a code
 * importer page, a dream_generated receipt under extracts/), not by type
 * name: a user's Markdown page typed `code` or `extract_receipt` still warns.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSchemaPackConsistency } from '../src/commands/doctor/schema-pack-checks.ts';
import { writeReceipt } from '../src/core/extract/receipt-writer.ts';
import { importCodeFile, importFromContent } from '../src/core/import-file.ts';
import { runRetypeCore } from '../src/core/schema-pack/retype.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { emptyHome, withEnv } from './helpers/with-env.ts';

const PACK = `api_version: gbrain-schema-pack-v1
name: copied-pack
version: 1.0.0
description: custom pack copied before gbrain declared its own page types
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

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  home = emptyHome();
  mkdirSync(join(home, '.gbrain', 'schema-packs', 'copied-pack'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'schema-packs', 'copied-pack', 'pack.yaml'), PACK);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('schema_pack', 'copied-pack');
}, 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

const consistency = () => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, () => checkSchemaPackConsistency(engine, { sourceIds: ['default'] }));

test('gbrain-owned page types are not undeclared drift on a pack that predates them; a user type still is', async () => {
  await writeReceipt(engine, { kind: 'links', source_id: 'default', run_id: 'a1b2c3d4e5f6789abcdef', round: 'full', extracted_at: '2026-05-27T14:30:00.000Z', total_rows: 3, cost_usd: 0 });
  await importCodeFile(engine, 'src/example.ts', 'export const x = 1;\n', { noEmbed: true });
  const own = await consistency();
  expect(own.message).not.toContain('extract_receipt');
  expect(own.message).not.toContain("'code'");
  expect(own.status).toBe('ok');

  await engine.putPage('notes/custom', { type: 'custom_fixture', title: 'Custom', compiled_truth: 'Fixture content.' }, { sourceId: 'default' });
  const user = await consistency();
  expect(user.status).toBe('warn');
  expect(user.message).toContain('custom_fixture');
  expect(user.message).not.toContain('extract_receipt');
});

test('a user Markdown page typed like a gbrain page is still undeclared drift', async () => {
  await engine.executeRaw('DELETE FROM pages');
  await writeReceipt(engine, { kind: 'links', source_id: 'default', run_id: 'b1c2d3e4f5a6789abcdef', round: 'full', extracted_at: '2026-05-27T14:30:00.000Z', total_rows: 3, cost_usd: 0 });
  await importCodeFile(engine, 'src/example.ts', 'export const x = 1;\n', { noEmbed: true });
  expect((await consistency()).status).toBe('ok');

  await importFromContent(engine, 'notes/snippet', '---\ntitle: Snippet\ntype: code\n---\nA pasted snippet.\n', { noEmbed: true });
  const code = await consistency();
  expect(code.status).toBe('warn');
  expect(code.message).toContain("'code' (1)");

  await importFromContent(engine, 'notes/receipt-like', '---\ntitle: Receipt like\ntype: extract_receipt\n---\nA user note.\n', { noEmbed: true });
  const receipt = await consistency();
  expect(receipt.message).toContain("'extract_receipt' (1)");
});

test('a code importer page retyped to an undeclared type is drift', async () => {
  await engine.executeRaw('DELETE FROM pages');
  await importCodeFile(engine, 'src/example.ts', 'export const x = 1;\n', { noEmbed: true });
  expect((await consistency()).status).toBe('ok');
  const ctx = { engine, config: {}, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false } as unknown as OperationContext;
  const retyped = await withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, () =>
    runRetypeCore(ctx, { rules: [{ from_type: 'code', to_type: 'custom_fixture' }], apply: true, sourceId: 'default' }));
  expect(retyped.total_applied).toBe(1);
  const [page] = await engine.executeRaw<{ type: string; page_kind: string }>("SELECT type, page_kind FROM pages WHERE deleted_at IS NULL");
  expect(page).toEqual({ type: 'custom_fixture', page_kind: 'code' });
  const drift = await consistency();
  expect(drift.status).toBe('warn');
  expect(drift.message).toContain("'custom_fixture' (1)");
});
