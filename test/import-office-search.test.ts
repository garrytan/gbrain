import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importOfficeFile } from '../src/core/office-import.ts';

let engine: PGLiteEngine;
let fixtureDir: string;

function writePdf(path: string, text: string): void {
  const escaped = text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${escaped.length + 44} >>\nstream\nBT /F1 24 Tf 72 720 Td (${escaped}) Tj ET\nendstream\nendobj\n`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += object;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  writeFileSync(path, pdf);
}

async function writePptx(path: string, text: string): Promise<void> {
  const zip = new JSZip();
  zip.file(
    'ppt/slides/slide1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`,
  );
  writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }));
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  fixtureDir = join(tmpdir(), `pmbrain-office-search-${Date.now()}`);
  mkdirSync(fixtureDir, { recursive: true });
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('Office import searchable-content closure', () => {
  test('Excel, PDF and PPTX preserve fixture text in pages, chunks and keyword search', async () => {
    const xlsxPath = join(fixtureDir, 'plan.xlsx');
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['Topic', 'Owner'], ['excelzebra', 'Alice']]),
      'Plan',
    );
    XLSX.writeFile(workbook, xlsxPath);

    const pdfPath = join(fixtureDir, 'report.pdf');
    writePdf(pdfPath, 'pdfquartz risk report');

    const pptxPath = join(fixtureDir, 'roadmap.pptx');
    await writePptx(pptxPath, 'pptnebula launch roadmap');

    for (const [path, relativePath, token] of [
      [xlsxPath, 'fixtures/plan.xlsx', 'excelzebra'],
      [pdfPath, 'fixtures/report.pdf', 'pdfquartz'],
      [pptxPath, 'fixtures/roadmap.pptx', 'pptnebula'],
    ] as const) {
      const result = await importOfficeFile(engine, path, relativePath, { noEmbed: true });
      expect(result.status).toBe('imported');
      expect(result.chunks).toBeGreaterThan(0);

      const page = await engine.getPage(relativePath);
      expect(page?.compiled_truth).toContain(token);

      const chunks = await engine.getChunks(relativePath);
      expect(chunks.some(chunk => chunk.chunk_text.includes(token))).toBe(true);
      expect(chunks.every(chunk => chunk.chunk_source === 'office_child')).toBe(true);
      expect(chunks.every(chunk => chunk.chunk_text.includes('Parent document:'))).toBe(true);

      const hits = await engine.searchKeyword(token, { limit: 10 });
      expect(hits.some(hit => hit.slug === relativePath)).toBe(true);
    }
  });
});
