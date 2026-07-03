/**
 * Office-ingest adapter integration test.
 *
 * Drives importOfficeFile against a real in-memory PGLite brain, injecting a
 * fixture DocIR via the `_parseForTest` seam (no HTTP sidecar, no embedding
 * provider needed, no lock on the user's brain). Verifies the M0 end-to-end:
 * office file → DocIR → structure-aware chunks → persisted + searchable, and
 * idempotent re-import.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importOfficeFile } from '../src/core/office/adapter.ts';
import { DOCIR_VERSION, emptyLocator, type DocIR } from '../src/core/office/types.ts';

let engine: PGLiteEngine;
let dir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema(); // ~5s cold: needs more than the 5s default hook timeout
  dir = mkdtempSync(join(tmpdir(), 'office-it-'));
}, 30_000);

afterAll(async () => {
  try { await engine.disconnect(); } catch { /* best effort */ }
  rmSync(dir, { recursive: true, force: true });
});

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

test('imports an office file end-to-end: chunks persisted + searchable', async () => {
  const fp = join(dir, 'report.docx');
  writeFileSync(fp, Buffer.from([0x50, 0x4b, 0x03, 0x04])); // PKZIP magic; content irrelevant (parse injected)

  const result = await importOfficeFile(engine, fp, 'report.docx', {
    noEmbed: true,
    _parseForTest: async () => fixtureDocIR(),
  });

  expect(result.status).toBe('imported');
  expect(result.chunks).toBeGreaterThan(0);
  expect(result.slug).toBe('report.docx'); // extension kept (no .md collision)

  const chunks = await engine.getChunks(result.slug);
  expect(chunks.length).toBe(result.chunks);

  const allText = chunks.map((c) => c.chunk_text).join('\n');
  expect(allText).toContain('# Quarterly Report');          // heading prepended to prose chunk
  expect(allText).toContain('Revenue grew strongly');       // prose
  expect(allText).toContain('| Quarter | Revenue |');       // table emitted as its own chunk

  // source_locator persisted via the cross-engine-safe JSONB path (prose chunk → page 3).
  const located = chunks.find((c) => c.source_locator && (c.source_locator as { page?: number }).page === 3);
  expect(located).toBeTruthy();

  // table summary chunk present (template path — no chat model configured in test).
  expect(allText).toContain('columns: Quarter, Revenue');
});

test('imported office content is keyword-searchable', async () => {
  const hits = await engine.searchKeyword('Revenue', { limit: 10 });
  expect(hits.some((h) => h.slug === 'report.docx')).toBe(true);
});

test('re-importing identical bytes is idempotent (skipped)', async () => {
  const fp = join(dir, 'report.docx');
  const again = await importOfficeFile(engine, fp, 'report.docx', {
    noEmbed: true,
    _parseForTest: async () => fixtureDocIR(),
  });
  expect(again.status).toBe('skipped');
  expect(again.chunks).toBe(0);
});

test('DocIR version mismatch is rejected cleanly', async () => {
  const fp = join(dir, 'bad.docx');
  writeFileSync(fp, Buffer.from([0x50, 0x4b]));
  const res = await importOfficeFile(engine, fp, 'bad.docx', {
    noEmbed: true,
    _parseForTest: async () => ({ ...fixtureDocIR(), docir_version: '9.9' }),
  });
  expect(res.status).toBe('error');
  expect(res.error).toContain('version mismatch');
});

test('R3: low-confidence-table warnings surface in ImportResult + page frontmatter', async () => {
  const fp = join(dir, 'warned.docx');
  writeFileSync(fp, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const res = await importOfficeFile(engine, fp, 'warned.docx', {
    noEmbed: true,
    _parseForTest: async () => ({ ...fixtureDocIR(), warnings: ['LOW_CONFIDENCE_TABLE:b2'] }),
  });
  expect(res.status).toBe('imported');
  expect(res.warnings).toContain('LOW_CONFIDENCE_TABLE:b2');

  const page = await engine.getPage('warned.docx');
  const fm = page?.frontmatter as Record<string, unknown> | undefined;
  expect(fm?.warnings).toContain('LOW_CONFIDENCE_TABLE:b2');
});

test('R3: a clean office import carries no warnings field', async () => {
  const fp = join(dir, 'clean.docx');
  writeFileSync(fp, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const res = await importOfficeFile(engine, fp, 'clean.docx', {
    noEmbed: true,
    _parseForTest: async () => fixtureDocIR(), // warnings: []
  });
  expect(res.status).toBe('imported');
  expect(res.warnings).toBeUndefined();
});
