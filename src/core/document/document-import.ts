import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import {
  importFromContent,
  importTrustedStructuredContent,
  type ImportResult,
} from '../import-file.ts';
import { slugifyPath } from '../sync.ts';
import { renderStructuredDocument } from './markdown-renderer.ts';
import { normalizeStructuredDocument } from './normalize.ts';
import { buildStructuredParentSections } from './section-builder.ts';
import type {
  DocumentImportSummary,
  DocumentParseOptions,
  StructuredDocument,
} from './types.ts';
import { parseDocxDocument } from './parsers/docx.ts';
import { parsePdfDocument } from './parsers/pdf.ts';
import { parsePptxDocument } from './parsers/pptx.ts';
import { parseSpreadsheetDocument } from './parsers/spreadsheet.ts';
import { appendOoxmlImageOcr } from './ooxml-image-ocr.ts';

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

export async function parseDocument(
  filePath: string,
  opts: DocumentParseOptions = {},
): Promise<StructuredDocument> {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.pdf') return parsePdfDocument(filePath, opts);
  if (ext === '.docx') return appendOoxmlImageOcr(filePath, await parseDocxDocument(filePath), opts);
  if (ext === '.pptx') return appendOoxmlImageOcr(filePath, await parsePptxDocument(filePath), opts);
  if (ext === '.xlsx' || ext === '.xlsm' || ext === '.xls' || ext === '.csv') {
    const document = parseSpreadsheetDocument(filePath);
    return ext === '.xlsx' || ext === '.xlsm'
      ? appendOoxmlImageOcr(filePath, document, opts)
      : document;
  }
  throw new Error(`Unsupported structured document file type: ${ext}`);
}

export function summarizeStructuredDocument(document: StructuredDocument): DocumentImportSummary {
  return {
    parser: document.metadata.parser,
    structured: document.metadata.structured,
    local: document.metadata.local,
    fallback: document.metadata.fallback,
    sections: document.sections.filter(section => section.type !== 'heading' && section.type !== 'slide').length,
    tables: document.metadata.tableCount,
    images: document.metadata.imageCount,
    pagesNeedingOcr: document.metadata.pagesNeedingOcr?.length ?? 0,
    ocrUsed: document.metadata.ocrUsed,
    ocrProvider: document.metadata.ocrProvider,
    ocrAttempted: document.metadata.ocrAttempted ?? 0,
    ocrSucceeded: document.metadata.ocrSucceeded ?? 0,
    ocrFailed: document.metadata.ocrFailed ?? 0,
    ocrSkipped: document.metadata.ocrSkipped ?? 0,
    ocrWarnings: document.metadata.ocrWarnings ?? [],
  };
}

export async function importStructuredDocument(
  engine: BrainEngine,
  inputDocument: StructuredDocument,
  sourceFilePath: string,
  relativePath: string,
  opts: {
    noEmbed?: boolean;
    checkOnly?: boolean;
    forceRechunk?: boolean;
    sourceId?: string;
    activePack?: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> };
  } = {},
): Promise<ImportResult> {
  const document = normalizeStructuredDocument(inputDocument);
  const text = renderStructuredDocument(document);
  if (!text.trim()) {
    return {
      slug: slugifyPath(relativePath),
      status: 'skipped',
      chunks: 0,
      error: `No extractable text found in document file: ${relativePath}`,
      documentSummary: summarizeStructuredDocument(document),
    };
  }

  const stat = statSync(sourceFilePath);
  const rawHash = createHash('sha256').update(readFileSync(sourceFilePath)).digest('hex');
  const title = basename(relativePath, extname(relativePath));
  const ext = extname(relativePath).toLowerCase().slice(1);
  const summary = summarizeStructuredDocument(document);
  const parentSections = buildStructuredParentSections(document);
  const content = [
    '---',
    'type: source',
    `title: ${yamlScalar(title)}`,
    `id: ${yamlScalar(`office:${rawHash}`)}`,
    `source_format: ${yamlScalar(ext)}`,
    `original_path: ${yamlScalar(relativePath.replace(/\\/g, '/'))}`,
    `raw_sha256: ${yamlScalar(rawHash)}`,
    `file_size_bytes: ${stat.size}`,
    `document_parser: ${yamlScalar(summary.parser)}`,
    `document_structured: ${summary.structured}`,
    'document_parse_local: true',
    `document_sections: ${summary.sections}`,
    `document_tables: ${summary.tables}`,
    `document_images: ${summary.images}`,
    `document_pages_needing_ocr: ${summary.pagesNeedingOcr}`,
    `document_ocr_used: ${summary.ocrUsed}`,
    `document_ocr_attempted: ${summary.ocrAttempted}`,
    `document_ocr_succeeded: ${summary.ocrSucceeded}`,
    `document_ocr_failed: ${summary.ocrFailed}`,
    `document_ocr_skipped: ${summary.ocrSkipped}`,
    ...(document.metadata.ocrReceipt ? [`ocr_receipt: ${JSON.stringify(document.metadata.ocrReceipt)}`] : []),
    ...(summary.ocrProvider ? [`document_ocr_provider: ${yamlScalar(summary.ocrProvider)}`] : []),
    ...(summary.fallback ? [`document_parser_fallback: ${yamlScalar(summary.fallback)}`] : []),
    'retrieval_mode: office_parent_child',
    '---',
    '',
    `# ${title}`,
    '',
    text,
    '',
  ].join('\n');

  process.stderr.write(`[pmbrain document-import] ${JSON.stringify({ path: relativePath, ...summary })}\n`);
  const importOptions = {
    noEmbed: opts.noEmbed,
    checkOnly: opts.checkOnly,
    forceRechunk: opts.forceRechunk,
    sourceId: opts.sourceId,
    activePack: opts.activePack,
    filename: title,
    sourcePath: relativePath,
    source_kind: 'document_file',
    source_uri: relativePath.replace(/\\/g, '/'),
    ingested_via: 'pmbrain:import',
    parentSections,
  };
  const result = summary.structured && parentSections.length > 0
    ? await importTrustedStructuredContent(engine, slugifyPath(relativePath), content, importOptions)
    : await importFromContent(engine, slugifyPath(relativePath), content, importOptions);
  return { ...result, documentSummary: summary };
}
