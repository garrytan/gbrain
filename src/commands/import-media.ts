import { existsSync, readFileSync, statSync } from 'fs';
import { basename, extname } from 'path';
import type { BrainEngine } from '../core/engine.ts';
import { serializeMarkdown } from '../core/markdown.ts';
import {
  defaultMediaContent,
  importNormalizedMediaEvidence,
  type MediaFileMetadata,
} from '../core/import-media.ts';
import {
  mediaExtractionToEvidence,
  normalizeMediaExtraction,
  type MediaExtraction,
  type MediaExtractionKind,
} from '../core/media-extraction.ts';

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.srt': 'text/plain',
  '.vtt': 'text/vtt',
  '.json': 'application/json',
};

function importUsage(): never {
  console.error('Usage: gbrain import-media --slug <slug> --extraction <file.json> [--content-file <file.md>] [--media-file <path>] [--source <ref>] [--raw-data-source <name>] [--title <title>] [--type image|pdf|video|audio] [--no-embed]');
  process.exit(1);
}

function ingestUsage(): never {
  console.error('Usage: gbrain ingest-media <file> --extract <file.json> [--slug <slug>] [--title <title>] [--source <ref>] [--type image|pdf|video|audio] [--content-file <file.md>] [--no-embed]');
  process.exit(1);
}

function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function getMimeType(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || null;
}

function defaultMediaSlug(filename: string): string {
  const stem = basename(filename, extname(filename))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'untitled';
  return `media/evidence/${stem}`;
}

function fileKindOverride(explicit: string | undefined, extraction: MediaExtraction, mimeType: string | null): MediaExtractionKind {
  if (explicit) {
    if (['image', 'pdf', 'video', 'audio'].includes(explicit)) return explicit as MediaExtractionKind;
    throw new Error('--type must be one of: image, pdf, video, audio');
  }
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('audio/')) return 'audio';
  if (mimeType?.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  return extraction.kind;
}

function readMediaFileMetadata(mediaFilePath: string | undefined): MediaFileMetadata | undefined {
  if (!mediaFilePath) return undefined;
  const stat = statSync(mediaFilePath);
  return {
    filename: basename(mediaFilePath),
    mimeType: getMimeType(mediaFilePath),
    sizeBytes: stat.size,
  };
}

async function existingPageContent(engine: BrainEngine, slug: string, existing: Awaited<ReturnType<BrainEngine['getPage']>>): Promise<string | undefined> {
  if (!existing) return undefined;
  const tags = await engine.getTags(slug);
  return serializeMarkdown(existing.frontmatter || {}, existing.compiled_truth, existing.timeline || '', {
    type: existing.type,
    title: existing.title,
    tags,
  });
}

function assertJsonExtractionFile(extractionFile: string): void {
  if (extractionFile === 'openclaw') {
    throw new Error('Core GBrain expects normalized gbrain.media-extraction.v1 JSON here. Host adapters can produce that JSON before calling ingest-media.');
  }
}

export async function runImportMedia(engine: BrainEngine, args: string[]) {
  const slug = getFlag(args, '--slug');
  const contentFile = getFlag(args, '--content-file');
  const extractionFile = getFlag(args, '--extraction');
  const source = getFlag(args, '--source');
  const rawDataSource = getFlag(args, '--raw-data-source');
  const mediaFilePath = getFlag(args, '--media-file');
  const title = getFlag(args, '--title');
  const type = getFlag(args, '--type');
  const noEmbed = args.includes('--no-embed');

  if (!slug || !extractionFile) importUsage();
  assertJsonExtractionFile(extractionFile);
  if ((contentFile && !existsSync(contentFile)) || !existsSync(extractionFile) || (mediaFilePath && !existsSync(mediaFilePath))) {
    importUsage();
  }

  const extractionJson = JSON.parse(readFileSync(extractionFile, 'utf-8')) as unknown;
  const normalized = normalizeMediaExtraction(extractionJson);
  const mimeType = mediaFilePath ? getMimeType(mediaFilePath) : null;
  const evidence = mediaExtractionToEvidence({
    ...normalized,
    kind: fileKindOverride(type, normalized, mimeType),
    sourceRef: source || mediaFilePath || normalized.sourceRef || normalized.title,
  });

  const finalTitle = title || normalized.title || (mediaFilePath ? basename(mediaFilePath) : slug);
  const existing = await engine.getPage(slug);
  const content = contentFile
    ? readFileSync(contentFile, 'utf-8')
    : await existingPageContent(engine, slug, existing) ?? defaultMediaContent(finalTitle, evidence);

  const result = await importNormalizedMediaEvidence(engine, {
    slug,
    content,
    evidence,
    rawDataSource: rawDataSource ?? 'gbrain.media-evidence.v1',
    mediaFile: readMediaFileMetadata(mediaFilePath),
    pageTitle: finalTitle,
    noEmbed,
  });

  console.log(JSON.stringify({
    status: result.status,
    slug: result.slug,
    raw_data_source: result.rawDataSource,
    segment_count: evidence.segments.length,
    evidence_text_length: evidence.text.length,
    media_file: mediaFilePath ?? null,
    chunks: result.chunks,
    no_embed: noEmbed,
  }, null, 2));
}

export async function runIngestMedia(engine: BrainEngine, args: string[]) {
  const mediaFile = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  const extractionFile = getFlag(args, '--extract');
  const slug = getFlag(args, '--slug');
  const title = getFlag(args, '--title');
  const source = getFlag(args, '--source');
  const type = getFlag(args, '--type');
  const noEmbed = args.includes('--no-embed');
  const contentFile = getFlag(args, '--content-file');

  if (!mediaFile || !extractionFile || !existsSync(mediaFile)) ingestUsage();
  assertJsonExtractionFile(extractionFile);
  if (!existsSync(extractionFile) || (contentFile && !existsSync(contentFile))) ingestUsage();

  await runImportMedia(engine, [
    '--slug', slug || defaultMediaSlug(mediaFile),
    '--extraction', extractionFile,
    ...(contentFile ? ['--content-file', contentFile] : []),
    '--media-file', mediaFile,
    '--raw-data-source', 'gbrain.media-evidence.v1',
    ...(title ? ['--title', title] : []),
    ...(source ? ['--source', source] : []),
    ...(type ? ['--type', type] : []),
    ...(noEmbed ? ['--no-embed'] : []),
  ]);
}
