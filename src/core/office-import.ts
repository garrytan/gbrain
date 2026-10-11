import { lstatSync, readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { extractImageOcrResult, type ImportResult, type ParentSectionInput } from './import-file.ts';
import { isOfficeFilePath, slugifyPath } from './sync.ts';
import { importStructuredDocument, parseDocument } from './document/document-import.ts';
import { renderStructuredDocument } from './document/markdown-renderer.ts';
import { normalizeDocumentText } from './document/normalize.ts';
import type { StructuredDocument } from './document/types.ts';
import { parseLegacyPresentationDocument, parseLegacyWordDocument } from './document/parsers/legacy-office.ts';
import { hashOcrSource, OCR_PROMPT_VERSION, OCR_RECEIPT_VERSION } from './ocr.ts';

export const SUPPORTED_OFFICE_EXTS = ['.docx', '.doc', '.wps', '.pptx', '.ppt', '.pdf', '.xlsx', '.xlsm', '.xls', '.csv'] as const;
export const MAX_OFFICE_BYTES = 50 * 1024 * 1024;
export { isOfficeFilePath };

/** Compatibility helper retained for callers that still provide Markdown text. */
export function buildOfficeParentSections(text: string, documentTitle: string): ParentSectionInput[] {
  const heading = /^##\s+(.+)$/gm;
  const matches = [...text.matchAll(heading)];
  if (matches.length > 0) {
    return matches.flatMap((match, index) => {
      const start = (match.index ?? 0) + match[0].length;
      const end = matches[index + 1]?.index ?? text.length;
      const body = normalizeDocumentText(text.slice(start, end));
      return body ? [{ title: match[1].trim(), locator: match[1].trim(), text: body }] : [];
    });
  }
  const paragraphs = text.split(/\n{2,}/).map(normalizeDocumentText).filter(Boolean);
  const sections: ParentSectionInput[] = [];
  let current: string[] = [];
  let length = 0;
  const flush = () => {
    if (!current.length) return;
    const index = sections.length + 1;
    sections.push({
      title: index === 1 ? documentTitle : `${documentTitle} - Part ${index}`,
      locator: `part-${index}`,
      text: current.join('\n\n'),
    });
    current = [];
    length = 0;
  };
  for (const paragraph of paragraphs) {
    if (length > 0 && length + paragraph.length > 3_000) flush();
    current.push(paragraph);
    length += paragraph.length;
  }
  flush();
  return sections;
}

function flattenDocument(document: StructuredDocument): StructuredDocument {
  const text = renderStructuredDocument(document);
  return {
    ...document,
    sections: text ? [{ id: 'legacy-1', type: 'paragraph', text, locator: {} }] : [],
    metadata: { ...document.metadata, parser: 'pmbrain-document-v1', structured: false },
  };
}

async function parseOfficeDocument(
  filePath: string,
  opts: { structured?: boolean; ocrPage?: import('./document/types.ts').DocumentParseOptions['ocrPage'] } = {},
): Promise<StructuredDocument> {
  const ext = extname(filePath).toLowerCase();
  let document: StructuredDocument;
  if (ext === '.doc' || ext === '.wps') document = await parseLegacyWordDocument(filePath);
  else if (ext === '.ppt') document = await parseLegacyPresentationDocument(filePath);
  else document = await parseDocument(filePath, { structured: opts.structured, ocrPage: opts.ocrPage });
  return opts.structured === false && ext !== '.pdf' ? flattenDocument(document) : document;
}

export async function extractOfficeText(filePath: string, opts: { structured?: boolean } = {}): Promise<string> {
  return renderStructuredDocument(await parseOfficeDocument(filePath, opts));
}

export async function importOfficeFile(
  engine: BrainEngine,
  filePath: string,
  relativePath: string,
  opts: {
    noEmbed?: boolean;
    checkOnly?: boolean;
    forceRechunk?: boolean;
    sourceId?: string;
    structured?: boolean;
    documentOcr?: boolean;
    activePack?: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> };
  } = {},
): Promise<ImportResult> {
  const lstat = lstatSync(filePath);
  if (lstat.isSymbolicLink()) {
    return { slug: slugifyPath(relativePath), status: 'skipped', chunks: 0, error: `Skipping symlink: ${filePath}` };
  }
  const stat = statSync(filePath);
  if (stat.size > MAX_OFFICE_BYTES) {
    return {
      slug: slugifyPath(relativePath),
      status: 'skipped',
      chunks: 0,
      error: `Document file too large (${stat.size} bytes, max ${MAX_OFFICE_BYTES})`,
    };
  }

  const gateway = await import('./ai/gateway.ts');
  const ocrEnabled = !opts.checkOnly && (opts.documentOcr === true || gateway.isOcrEnabled());
  const document = await parseOfficeDocument(filePath, {
    structured: opts.structured !== false,
    ocrPage: ocrEnabled
      ? async (_page, image, mime) => extractImageOcrResult(engine, image, mime, { enabled: true })
      : undefined,
  });
  document.title = basename(relativePath, extname(relativePath));
  if (ocrEnabled) {
    const candidates = document.metadata.pagesNeedingOcr?.length ?? document.metadata.imageCount;
    const failed = document.metadata.ocrFailed ?? 0;
    const succeeded = document.metadata.ocrSucceeded ?? 0;
    const skipped = document.metadata.ocrSkipped ?? 0;
    let model: string | null = document.metadata.ocrProvider ?? null;
    if (!model) {
      try { model = gateway.getImageOcrModel(); } catch { model = null; }
    }
    document.metadata.ocrReceipt = {
      version: OCR_RECEIPT_VERSION,
      promptVersion: OCR_PROMPT_VERSION,
      sourceHash: hashOcrSource(readFileSync(filePath)),
      model,
      candidates,
      attempted: document.metadata.ocrAttempted ?? 0,
      succeeded,
      failed,
      failedItems: document.metadata.ocrWarnings ?? [],
      status: failed > 0 || skipped > 0 ? 'partial' : 'complete',
      ...(document.metadata.ocrWarnings?.[0] ? { reason: document.metadata.ocrWarnings[0] } : {}),
      processedAt: new Date().toISOString(),
    };
  }
  return importStructuredDocument(engine, document, filePath, relativePath, opts);
}
