// src/core/office/adapter.ts
//
// importOfficeFile: the office-format ingest path. Sibling to importCodeFile /
// importImageFile (dispatched from importFromFile). Calls the Docling sidecar,
// chunks the DocIR structurally, and persists searchable text chunks through
// the same engine path as the other importers.
//
// Spec: docs/proposals/office-ingest.md §8.
//
// M0 scope: PDF/DOCX/PPTX/XLSX text layer. Deferred (column/sidecar already in
// place): source_locator PERSISTENCE (needs upsertChunks JSONB threading +
// engine-parity e2e), LLM table summaries, selective multimodal embedding.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, basename } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { ChunkInput } from '../types.ts';
import type { ImportResult } from '../import-file.ts';
import { embedBatch } from '../embedding.ts';
import { chunkDocBlocks } from '../chunkers/doc-block.ts';
import { resolveOfficeConfig } from './config.ts';
import { parseViaSidecar } from './sidecar-client.ts';
import { tableChunksFor } from './table.ts';
import { DOCIR_VERSION, type DocIR } from './types.ts';

const OFFICE_EXTS = new Set(['.pdf', '.docx', '.pptx', '.xlsx']);

export function isOfficeFilePath(relativePath: string): boolean {
  return OFFICE_EXTS.has(extname(relativePath).toLowerCase());
}

/** Deterministic slug that KEEPS the extension so report.pdf can't collide
 *  with report.md or report.docx. */
function officeSlug(relativePath: string): string {
  return relativePath
    .replace(/^[./\\]+/, '')
    .replace(/\\/g, '/')
    .toLowerCase()
    .replace(/[^a-z0-9/._-]+/g, '-')
    .replace(/-+/g, '-');
}

export interface ImportOfficeOpts {
  noEmbed?: boolean;
  sourceId?: string;
  forceRechunk?: boolean;
  /** Test seam: inject a DocIR-producer instead of hitting the HTTP sidecar.
   *  Production callers never set this. */
  _parseForTest?: (relativePath: string, bytes: Uint8Array) => Promise<DocIR>;
}

export async function importOfficeFile(
  engine: BrainEngine,
  filePath: string,
  relativePath: string,
  opts: ImportOfficeOpts = {},
): Promise<ImportResult> {
  const slug = officeSlug(relativePath);
  const sourceId = opts.sourceId;
  const txOpts = sourceId ? { sourceId } : undefined;

  const cfg = await resolveOfficeConfig(engine);
  if (!cfg.enabled && !opts._parseForTest) {
    return {
      slug,
      status: 'error',
      chunks: 0,
      error: 'office ingest disabled — set ingest.docling.enabled true and run the Docling sidecar',
    };
  }

  const bytes = readFileSync(filePath); // Buffer (binary — NOT utf-8)
  const sizeMb = bytes.byteLength / (1024 * 1024);
  if (sizeMb > cfg.maxFileMb) {
    return { slug, status: 'skipped', chunks: 0, error: `office file too large (${sizeMb.toFixed(1)}MB > ${cfg.maxFileMb}MB)` };
  }

  // Idempotency: bytes + DocIR contract version (a contract bump forces re-parse).
  const hash = createHash('sha256').update(bytes).update(`docir:${DOCIR_VERSION}`).digest('hex');
  const existing = await engine.getPage(slug, txOpts);
  if (!opts.forceRechunk && existing?.content_hash === hash) {
    return { slug, status: 'skipped', chunks: 0 };
  }

  // Parse via the Docling sidecar (or the test seam).
  let docir: DocIR;
  try {
    docir = opts._parseForTest
      ? await opts._parseForTest(relativePath, bytes)
      : await parseViaSidecar(cfg.url, relativePath, bytes);
  } catch (e) {
    return { slug, status: 'error', chunks: 0, error: `docling sidecar: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (docir.docir_version !== DOCIR_VERSION) {
    return { slug, status: 'error', chunks: 0, error: `DocIR version mismatch: got ${docir.docir_version}, expected ${DOCIR_VERSION}` };
  }

  // Structure-aware chunking. M0: tables emitted as their own markdown chunk;
  // LLM summary + row-blocks + source_locator persistence land in later tasks.
  const targetWords = Math.max(64, Math.round(cfg.chunkTokens / 1.3));
  const prose = chunkDocBlocks(docir.blocks, { targetWords });
  const tableGroups = await Promise.all(
    docir.blocks.filter((b) => b.type === 'table').map((b) => tableChunksFor(b, cfg)),
  );
  const officeChunks = [...prose, ...tableGroups.flat()];

  // Persist text as 'compiled_truth' (standard searchable text chunks); the
  // office-specific chunk_source tags are cosmetic for M0. source_locator is
  // written separately below via the cross-engine-safe JSONB path.
  const chunks: ChunkInput[] = officeChunks.map((c, i) => ({
    chunk_index: i,
    chunk_text: c.chunk_text,
    chunk_source: 'compiled_truth' as const,
  }));

  // Embed (best-effort — matches importCodeFile's tolerance).
  if (!opts.noEmbed && chunks.length > 0) {
    try {
      const embeddings = await embedBatch(chunks.map((c) => c.chunk_text));
      for (let i = 0; i < chunks.length; i++) {
        chunks[i]!.embedding = embeddings[i];
        chunks[i]!.token_count = Math.ceil(chunks[i]!.chunk_text.length / 4);
      }
    } catch (e) {
      console.warn(`[gbrain] embedding failed for office file ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const body = docir.blocks.map((b) => b.markdown).filter((m) => m && m.trim()).join('\n\n');
  const title = basename(relativePath);

  await engine.transaction(async (tx) => {
    if (existing) await tx.createVersion(slug, txOpts);
    await tx.putPage(
      slug,
      {
        type: 'note' as string,
        page_kind: 'markdown', // CHECK allows markdown|code|image; office → markdown text
        title,
        compiled_truth: body,
        timeline: '',
        frontmatter: { source: 'office', format: docir.doc.format, file: relativePath },
        content_hash: hash,
      },
      txOpts,
    );
    await tx.addTag(slug, 'document', txOpts);
    await tx.addTag(slug, docir.doc.format, txOpts);
    if (chunks.length > 0) {
      await tx.upsertChunks(slug, chunks, txOpts);
    } else {
      await tx.deleteChunks(slug, txOpts);
    }
  });

  // Per-chunk source locators via the cross-engine-safe JSONB path (best-effort:
  // a locator write failure must not fail an otherwise-successful import).
  if (chunks.length > 0) {
    try {
      const locators = officeChunks.map((c, i) => ({
        idx: i,
        loc: c.source_locator as unknown as Record<string, unknown>,
      }));
      await engine.upsertChunkLocators(slug, locators, txOpts);
    } catch (e) {
      console.warn(`[gbrain] source_locator write failed for ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { slug, status: 'imported', chunks: chunks.length };
}
