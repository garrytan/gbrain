/**
 * E2E: office-ingest engine parity (Postgres).
 *
 * The PGLite path is covered by test/office-adapter-integration.test.ts. This
 * mirror runs the SAME office import against a real Postgres engine to close the
 * engine-parity loop — proving upsertChunkLocators' cross-engine executeRawJsonb
 * write lands source_locator as a true JSONB object on Postgres (not the
 * double-encoded string that the ::jsonb-stringify anti-pattern would produce,
 * and that PGLite masks).
 *
 * Skips gracefully when DATABASE_URL is unset (mirrors every other test/e2e/*).
 * Run: DATABASE_URL=... bun test test/e2e/office-engine-parity.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn } from './helpers.ts';
import { importOfficeFile } from '../../src/core/office/adapter.ts';
import { DOCIR_VERSION, emptyLocator, type DocIR } from '../../src/core/office/types.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;
if (skip) console.log('Skipping office-engine-parity E2E (DATABASE_URL not set)');

function fixtureDocIR(): DocIR {
  return {
    docir_version: DOCIR_VERSION,
    doc: { format: 'docx', page_count: null, content_hash: 'sha256:test', parser: 'test@0' },
    blocks: [
      { id: 'b0', type: 'heading', level: 1, markdown: '# Quarterly Report', text: 'Quarterly Report', order: 0, locator: emptyLocator(), table: null, asset_ref: null },
      { id: 'b1', type: 'paragraph', level: null, markdown: 'Revenue grew strongly this quarter.', text: 'Revenue grew strongly this quarter.', order: 1, locator: { ...emptyLocator(), page: 3 }, table: null, asset_ref: null },
      { id: 'b2', type: 'table', level: null, markdown: '| Quarter | Revenue |\n|---|---|\n| Q1 | 1.2M |', text: '', order: 2, locator: emptyLocator(), table: { header_rows: 1, n_rows: 1, n_cols: 2, columns: ['Quarter', 'Revenue'], rows: [['Q1', '1.2M']] }, asset_ref: null },
    ],
    assets: [],
    warnings: [],
  };
}

const SLUG = 'office-parity-report.docx';

describeE2E('E2E: office-ingest engine parity (Postgres)', () => {
  let dir: string;
  beforeAll(async () => {
    await setupDB();
    dir = mkdtempSync(join(tmpdir(), 'office-pg-'));
  });
  afterAll(async () => {
    await teardownDB();
    rmSync(dir, { recursive: true, force: true });
  });

  test('office import → chunks + table summary + JSONB source_locator on Postgres', async () => {
    const engine = getEngine();
    const fp = join(dir, 'report.docx');
    writeFileSync(fp, Buffer.from([0x50, 0x4b, 0x03, 0x04])); // PKZIP magic; parse injected

    const result = await importOfficeFile(engine, fp, SLUG, {
      noEmbed: true,
      _parseForTest: async () => fixtureDocIR(),
    });
    expect(result.status).toBe('imported');
    expect(result.chunks).toBeGreaterThan(0);

    const chunks = await engine.getChunks(result.slug);
    const allText = chunks.map((c) => c.chunk_text).join('\n');
    expect(allText).toContain('# Quarterly Report');
    expect(allText).toContain('| Quarter | Revenue |');
    expect(allText).toContain('columns: Quarter, Revenue'); // template summary (no chat model)

    // The parity-critical assertion: upsertChunkLocators wrote source_locator as
    // a real JSONB OBJECT (page 3), readable by Postgres JSONB operators — not a
    // double-encoded string. This is exactly what PGLite would mask but Postgres
    // exposes, so a green here proves the cross-engine executeRawJsonb path holds.
    const sql = getConn();
    const [row] = await sql`
      SELECT jsonb_typeof(cc.source_locator) AS t, (cc.source_locator ->> 'page') AS page
      FROM content_chunks cc
      JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = ${result.slug} AND (cc.source_locator ->> 'page') = '3'
    `;
    expect(row?.t).toBe('object');
    expect(row?.page).toBe('3');
  }, 60_000);

  test('re-importing identical bytes is idempotent (skipped) on Postgres', async () => {
    const engine = getEngine();
    const fp = join(dir, 'report.docx');
    const again = await importOfficeFile(engine, fp, SLUG, {
      noEmbed: true,
      _parseForTest: async () => fixtureDocIR(),
    });
    expect(again.status).toBe('skipped');
  }, 60_000);
});
