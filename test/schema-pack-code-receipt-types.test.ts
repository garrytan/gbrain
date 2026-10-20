/**
 * #6818 + PR #6915: the stock base pack (gbrain-base-v2, the init default)
 * and packs extending it (company-brain) declare the two page types gbrain's
 * own writers stamp outside the canonical content taxonomy: `code` (the code
 * importer, import-file.ts) and `extract_receipt` (the extract receipt
 * writer, under extracts/).
 *
 * Protects: importing code or running an extractor on a default brain never
 * trips doctor `schema_pack_consistency` (`page_type_undeclared`), and the
 * catch-all retype rule never turns those pages into notes.
 * Regression: a pack edit that drops either declaration.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSchemaPackConsistency } from '../src/commands/doctor/schema-pack-checks.ts';
import { classifyStoredType } from '../src/core/schema-pack/type-usage.ts';
import { bundledPackPath } from '../src/core/schema-pack/bundled-assets.ts';
import { loadPackFromFile } from '../src/core/schema-pack/loader.ts';
import { mergeInheritedManifest } from '../src/core/schema-pack/merge.ts';
import { extractableTypesFromPack } from '../src/core/schema-pack/extractable.ts';
import { writeReceipt } from '../src/core/extract/receipt-writer.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
}, 120_000);

afterAll(async () => {
  await engine?.disconnect();
}, 60_000);

describe('#6818 code and extract_receipt page types in the stock base pack', () => {
  test('gbrain-base-v2 declares code as non-extractable media and extract_receipt as an extracts/ annotation', () => {
    const base = loadPackFromFile(bundledPackPath('gbrain-base-v2')!);
    expect(classifyStoredType('code', base)).toEqual({ kind: 'canonical' });
    expect(classifyStoredType('extract_receipt', base)).toEqual({ kind: 'canonical' });
    expect(base.page_types.find(t => t.name === 'code')).toMatchObject({
      primitive: 'media', path_prefixes: [], extractable: false, expert_routing: false,
    });
    expect(base.page_types.find(t => t.name === 'extract_receipt')).toMatchObject({
      primitive: 'annotation', path_prefixes: ['extracts/'], extractable: false, expert_routing: false,
    });
    const extractable = extractableTypesFromPack(base);
    expect(extractable.has('code')).toBe(false);
    expect(extractable.has('extract_receipt')).toBe(false);
  });

  test('company-brain inherits both declarations', () => {
    const base = loadPackFromFile(bundledPackPath('gbrain-base-v2')!);
    const company = mergeInheritedManifest([base], loadPackFromFile(bundledPackPath('company-brain')!), { page_types: [], link_types: [] });
    expect(classifyStoredType('code', company)).toEqual({ kind: 'canonical' });
    expect(classifyStoredType('extract_receipt', company)).toEqual({ kind: 'canonical' });
  });

  test('a written receipt and a code page keep the consistency check ok; a custom type still warns', async () => {
    const { slug } = await writeReceipt(engine, {
      kind: 'links', source_id: 'default', run_id: 'a1b2c3d4e5f6789abcdef', round: 'full',
      extracted_at: '2026-05-27T14:30:00.000Z', total_rows: 3, cost_usd: 0,
    });
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.type).toBe('extract_receipt');
    await engine.putPage('src/example.ts', { type: 'code', title: 'example.ts', compiled_truth: 'export const x = 1;' }, { sourceId: 'default' });
    const ok = await checkSchemaPackConsistency(engine, { sourceIds: ['default'] });
    expect(ok.message).toBe('All pages match the active schema pack across every source.');
    expect(ok.status).toBe('ok');

    await engine.putPage('notes/custom-control', { type: 'custom_receipt_fixture', title: 'Custom control', compiled_truth: 'Fixture content.' }, { sourceId: 'default' });
    const warn = await checkSchemaPackConsistency(engine, { sourceIds: ['default'] });
    expect(warn.status).toBe('warn');
    expect(warn.message).toContain('custom_receipt_fixture');
    expect(warn.message).not.toContain("'extract_receipt'");
    expect(warn.message).not.toContain("'code'");
  }, 60_000);
});
