import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { normalizeDocumentText } from '../normalize.ts';
import type { DocumentParseOptions, DocumentSection, StructuredDocument } from '../types.ts';
import { markdownToSections } from './markdown-sections.ts';

async function parseWithPdfParse(buffer: Buffer, title: string, fallback?: string): Promise<StructuredDocument> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText({ pageJoiner: '\n<!-- PMBRAIN_PAGE page_number -->\n' });
    const pages = result.text.split(/<!-- PMBRAIN_PAGE (\d+) -->/);
    const sections: DocumentSection[] = [];
    let page = 1;
    for (let i = 0; i < pages.length; i++) {
      if (i % 2 === 1) {
        page = Number(pages[i]) + 1;
        continue;
      }
      const text = normalizeDocumentText(pages[i]);
      if (text) sections.push(...markdownToSections(text, { page }, `pdf-fallback-p${page}`));
    }
    return {
      title,
      format: 'pdf',
      sections,
      metadata: {
        parser: 'pdf-parse',
        local: true,
        structured: false,
        fallback,
        pageCount: result.total,
        tableCount: 0,
        imageCount: 0,
        ocrUsed: false,
      },
    };
  } finally {
    await parser.destroy();
  }
}
async function addOcrPages(
  buffer: Buffer,
  document: StructuredDocument,
  pagesNeedingOcr: number[],
  ocrPage: NonNullable<DocumentParseOptions['ocrPage']>,
): Promise<void> {
  if (pagesNeedingOcr.length === 0) return;
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const screenshots = await parser.getScreenshot({
      partial: pagesNeedingOcr,
      desiredWidth: 1800,
      imageBuffer: true,
    });
    for (const screenshot of screenshots.pages) {
      if (!screenshot.data?.length) continue;
      const result = await ocrPage(screenshot.pageNumber, Buffer.from(screenshot.data), 'image/png');
      if (result.status !== 'skipped') document.metadata.ocrAttempted = (document.metadata.ocrAttempted ?? 0) + 1;
      if (result.status === 'success') {
        const text = normalizeDocumentText(result.text);
        if (text) document.sections.push(...markdownToSections(text, { page: screenshot.pageNumber }, `pdf-ocr-p${screenshot.pageNumber}`));
        document.metadata.ocrUsed = true;
        document.metadata.ocrSucceeded = (document.metadata.ocrSucceeded ?? 0) + 1;
      } else if (result.status === 'failed') {
        document.metadata.ocrFailed = (document.metadata.ocrFailed ?? 0) + 1;
      } else {
        document.metadata.ocrSkipped = (document.metadata.ocrSkipped ?? 0) + 1;
      }
      if (result.model) document.metadata.ocrProvider = result.model;
      if (result.message) document.metadata.ocrWarnings = [...(document.metadata.ocrWarnings ?? []), `第 ${screenshot.pageNumber} 页：${result.message}`];
    }
  } finally {
    await parser.destroy();
  }
}

export async function parsePdfDocument(filePath: string, opts: DocumentParseOptions = {}): Promise<StructuredDocument> {
  const buffer = readFileSync(filePath);
  const title = basename(filePath, extname(filePath));
  if (opts.structured === false) return parseWithPdfParse(buffer, title);

  try {
    const { extractPagesMarkdown } = await import('@firecrawl/pdf-inspector');
    const result = extractPagesMarkdown(buffer);
    const sections = result.pages.flatMap(page =>
      markdownToSections(page.markdown, { page: page.page + 1 }, `pdf-p${page.page + 1}`),
    );
    const document: StructuredDocument = {
      title,
      format: 'pdf',
      sections,
      metadata: {
        parser: '@firecrawl/pdf-inspector@1.12.0',
        local: true,
        structured: true,
        pageCount: result.pages.length,
        tableCount: result.pagesWithTables.length,
        imageCount: result.pagesNeedingOcr.length,
        pagesNeedingOcr: result.pagesNeedingOcr,
        ocrUsed: false,
      },
    };
    if (opts.ocrPage) await addOcrPages(buffer, document, result.pagesNeedingOcr, opts.ocrPage);
    if (document.sections.length === 0) {
      const fallback = await parseWithPdfParse(buffer, title, 'pdf-inspector returned no extractable text');
      return fallback.sections.length > 0 || !opts.ocrPage ? fallback : document;
    }
    return document;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const fallback = await parseWithPdfParse(buffer, title, `pdf-inspector failed: ${reason}`);
    if (opts.ocrPage && fallback.sections.length === 0 && (fallback.metadata.pageCount ?? 0) > 0) {
      const pages = Array.from({ length: fallback.metadata.pageCount ?? 0 }, (_, index) => index + 1);
      fallback.metadata.pagesNeedingOcr = pages;
      fallback.metadata.imageCount = pages.length;
      await addOcrPages(buffer, fallback, pages, opts.ocrPage);
    }
    return fallback;
  }
}
