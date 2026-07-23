import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { extractOfficeText, importOfficeFile, isOfficeFilePath } from '../src/core/office-import.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  const calls: { method: string; args: any[] }[] = [];
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    return Promise.resolve(null);
  };

  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (prop === 'getTags') return overrides.getTags || (() => Promise.resolve([]));
      if (prop === 'getPage') return overrides.getPage || (() => Promise.resolve(null));
      if (prop === 'findDuplicatePage') return overrides.findDuplicatePage;
      if (prop === 'transaction') return async (fn: (tx: BrainEngine) => Promise<any>) => fn(engine);
      return track(prop);
    },
  });
  return engine;
}

async function writeDocx(path: string, paragraphs: string[]): Promise<void> {
  const zip = new JSZip();
  const body = paragraphs
    .map(text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
    .join('');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`,
  );
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  writeFileSync(path, bytes);
}

async function writePptx(path: string, slides: string[][]): Promise<void> {
  const zip = new JSZip();
  slides.forEach((lines, index) => {
    const body = lines.map(text => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join('');
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`,
    );
  });
  writeFileSync(path, await zip.generateAsync({ type: 'uint8array' }));
}

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
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += obj;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  writeFileSync(path, pdf);
}

function writeXlsx(path: string): void {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['Task', 'Owner', 'Status'],
    ['Import PDF', 'Alice', 'Done'],
    ['Import Excel', 'Bob', 'Planned'],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Plan');
  XLSX.writeFile(workbook, path);
}

let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `gbrain-office-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('Office import', () => {
  test('recognizes supported document extensions', () => {
    expect(isOfficeFilePath('docs/proposal.docx')).toBe(true);
    expect(isOfficeFilePath('docs/legacy.DOC')).toBe(true);
    expect(isOfficeFilePath('docs/writer.wps')).toBe(true);
    expect(isOfficeFilePath('docs/report.pdf')).toBe(true);
    expect(isOfficeFilePath('docs/sheet.xlsx')).toBe(true);
    expect(isOfficeFilePath('docs/sheet.xls')).toBe(true);
    expect(isOfficeFilePath('docs/slides.pptx')).toBe(true);
    expect(isOfficeFilePath('docs/legacy.ppt')).toBe(true);
  });

  test('extracts paragraphs from a docx file', async () => {
    const filePath = join(tmp, 'proposal.docx');
    await writeDocx(filePath, ['First paragraph', 'Second paragraph']);

    const text = await extractOfficeText(filePath);

    expect(text).toContain('First paragraph');
    expect(text).toContain('Second paragraph');
  });

  test('extracts slides from a pptx file in slide order', async () => {
    const filePath = join(tmp, 'roadmap.pptx');
    await writePptx(filePath, [['Roadmap 2026', 'Launch plan'], ['Risks', 'Budget review']]);

    const text = await extractOfficeText(filePath);

    expect(text).toContain('## Slide 1');
    expect(text).toContain('Roadmap 2026');
    expect(text).toContain('## Slide 2');
    expect(text.indexOf('Roadmap 2026')).toBeLessThan(text.indexOf('Budget review'));
  });

  test('extracts text from a pdf file', async () => {
    const filePath = join(tmp, 'report.pdf');
    writePdf(filePath, 'Quarterly risk report');

    const text = await extractOfficeText(filePath);

    expect(text).toContain('Quarterly risk report');
  });

  test('extracts worksheet rows from an Excel file', async () => {
    const filePath = join(tmp, 'plan.xlsx');
    writeXlsx(filePath);

    const text = await extractOfficeText(filePath);

    expect(text).toContain('## Sheet: Plan');
    expect(text).toContain('| Task | Owner | Status |');
    expect(text).toContain('Import Excel');
  });

  test('imports docx through the markdown chunking and provenance pipeline', async () => {
    const filePath = join(tmp, 'proposal.docx');
    await writeDocx(filePath, ['Project scope', 'Milestone and risk notes']);

    let storedPage: any;
    const engine = mockEngine({
      putPage: (_slug: string, page: any) => {
        storedPage = page;
        return Promise.resolve(null);
      },
    });

    const result = await importOfficeFile(engine, filePath, 'docs/proposal.docx', { noEmbed: true });

    expect(result.status).toBe('imported');
    expect(result.slug).toBe('docs/proposal.docx');
    expect(result.chunks).toBeGreaterThan(0);
    expect(storedPage.type).toBe('source');
    expect(storedPage.source_path).toBe('docs/proposal.docx');
    expect(storedPage.frontmatter.source_format).toBe('docx');
    expect(typeof storedPage.frontmatter.raw_sha256).toBe('string');
    expect(storedPage.compiled_truth).toContain('Project scope');

    const calls = (engine as any)._calls;
    const chunkCall = calls.find((c: any) => c.method === 'upsertChunks');
    expect(chunkCall).toBeTruthy();
  });

  test('imports Excel through the markdown chunking and provenance pipeline', async () => {
    const filePath = join(tmp, 'plan.xlsx');
    writeXlsx(filePath);

    let storedPage: any;
    const engine = mockEngine({
      putPage: (_slug: string, page: any) => {
        storedPage = page;
        return Promise.resolve(null);
      },
    });

    const result = await importOfficeFile(engine, filePath, 'docs/plan.xlsx', { noEmbed: true });

    expect(result.status).toBe('imported');
    expect(storedPage.source_path).toBe('docs/plan.xlsx');
    expect(storedPage.frontmatter.source_format).toBe('xlsx');
    expect(storedPage.compiled_truth).toContain('Import PDF');
  });

  test('imports PowerPoint through the markdown chunking pipeline', async () => {
    const filePath = join(tmp, 'roadmap.pptx');
    await writePptx(filePath, [['Roadmap 2026', 'Launch plan'], ['Risks', 'Budget review']]);
    let storedPage: any;
    const engine = mockEngine({
      putPage: (_slug: string, page: any) => {
        storedPage = page;
        return Promise.resolve(null);
      },
    });

    const result = await importOfficeFile(engine, filePath, 'docs/roadmap.pptx', { noEmbed: true });

    expect(result.status).toBe('imported');
    expect(result.chunks).toBeGreaterThan(0);
    expect(storedPage.frontmatter.source_format).toBe('pptx');
    expect(storedPage.compiled_truth).toContain('Budget review');
  });

  test('uses raw file hash as a stable external identity for duplicate detection', async () => {
    const filePath = join(tmp, 'proposal.docx');
    await writeDocx(filePath, ['Same document']);

    let frontmatterId: string | undefined;
    const engine = mockEngine({
      findDuplicatePage: (_sourceId: string, identity: any) => {
        frontmatterId = identity.frontmatterId;
        return Promise.resolve(null);
      },
    });

    await importOfficeFile(engine, filePath, 'renamed/proposal.docx', { noEmbed: true });

    expect(frontmatterId?.startsWith('office:')).toBe(true);
  });
});
