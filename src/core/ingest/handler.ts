import { createHash } from 'crypto';
import { isIP } from 'net';
import { existsSync, statSync } from 'fs';
import { join } from 'path';
import type { BrainEngine } from '../engine.ts';
import type { MinionHandler, MinionJobContext } from '../minions/types.ts';
import { importFromContent } from '../import-file.ts';
import { serializeMarkdown } from '../markdown.ts';
import { slugifySegment } from '../sync.ts';
import { writeBrainPage } from '../brain-writer.ts';
import type { NormalizedIngestInput } from './types.ts';
import { INGEST_PAYLOAD_VERSION } from './types.ts';
import { CodexOAuthInferenceError, type CodexOAuthRunner } from './codex-oauth.ts';
import type { BoundedEnrichmentResult } from './enrichment.ts';

export interface FetchedText {
  finalUrl: string;
  contentType: string;
  text: string;
}

export interface IngestHandlerDeps {
  engine: BrainEngine;
  fetchText?: (url: string, signal?: AbortSignal) => Promise<FetchedText>;
  enableEnrichment?: boolean;
  inferenceRunner?: CodexOAuthRunner;
}

const MAX_URL_BYTES = 5 * 1024 * 1024;

interface SourceLocalPath {
  sourceId: string;
  localPath: string | null;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function assertNormalizedInput(data: Record<string, unknown>): NormalizedIngestInput {
  if (data.version !== INGEST_PAYLOAD_VERSION) {
    throw new Error(`unsupported gbrain-ingest payload version: ${String(data.version)}`);
  }
  if (data.kind !== 'text' && data.kind !== 'url' && data.kind !== 'file') {
    throw new Error(`unsupported gbrain-ingest kind: ${String(data.kind)}`);
  }
  if (data.mode !== 'explicit' && data.mode !== 'signal') {
    throw new Error(`unsupported gbrain-ingest mode: ${String(data.mode)}`);
  }
  if (typeof data.content_hash !== 'string' || data.content_hash.length < 16) {
    throw new Error('gbrain-ingest payload missing content_hash');
  }
  return data as unknown as NormalizedIngestInput;
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.').map(p => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || a === 0;
}

export function assertPublicHttpUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`unsupported URL scheme: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`refusing private URL host: ${url.hostname}`);
  }
  const ipKind = isIP(host);
  if (ipKind === 4 && isPrivateIPv4(host)) {
    throw new Error(`refusing private URL host: ${url.hostname}`);
  }
  if (ipKind === 6) {
    const normalized = host.replace(/^\[|\]$/g, '');
    if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80')) {
      throw new Error(`refusing private URL host: ${url.hostname}`);
    }
  }
  return url;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchPublicText(url: string, signal?: AbortSignal): Promise<FetchedText> {
  let current = assertPublicHttpUrl(url).toString();
  for (let i = 0; i < 5; i++) {
    const response = await fetch(current, { redirect: 'manual', signal });
    const location = response.headers.get('location');
    if (location && response.status >= 300 && response.status < 400) {
      current = assertPublicHttpUrl(new URL(location, current).toString()).toString();
      continue;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!response.ok) {
      throw new Error(`URL fetch failed ${response.status} ${response.statusText}`);
    }
    if (!/^(text\/|application\/(json|ld\+json|xml|xhtml\+xml))/.test(contentType)) {
      throw new Error(`unsupported URL content type: ${contentType || '(missing)'}`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_URL_BYTES) {
      throw new Error(`URL response exceeds ${MAX_URL_BYTES} bytes`);
    }
    return { finalUrl: current, contentType, text };
  }
  throw new Error('too many URL redirects');
}

async function resolveJobContent(input: NormalizedIngestInput, deps: IngestHandlerDeps, signal: AbortSignal): Promise<{
  text: string;
  resolvedUrl?: string;
  contentType?: string;
}> {
  if (input.kind === 'url') {
    if (!input.url) throw new Error('URL ingest missing url');
    assertPublicHttpUrl(input.url);
    const fetched = await (deps.fetchText ?? fetchPublicText)(input.url, signal);
    return {
      text: fetched.contentType.includes('html') ? htmlToText(fetched.text) : fetched.text.trim(),
      resolvedUrl: fetched.finalUrl,
      contentType: fetched.contentType,
    };
  }
  if (!input.text || input.text.trim().length === 0) {
    throw new Error(`${input.kind} ingest missing text content`);
  }
  return { text: input.text.trim() };
}

function titleFor(input: NormalizedIngestInput, text: string): string {
  if (input.title?.trim()) return input.title.trim();
  if (input.url) return new URL(input.url).hostname;
  if (input.file?.name) return input.file.name.replace(/\.[^.]+$/, '');
  return text.split(/\r?\n/)[0]?.slice(0, 80).trim() || 'GBrain ingest source';
}

function slugFor(input: NormalizedIngestInput, title: string): string {
  const base = slugifySegment(title) || 'source';
  return `sources/${base}-${shortHash(input.content_hash)}`;
}

function buildSourceMarkdown(input: NormalizedIngestInput, title: string, text: string, resolved?: { resolvedUrl?: string; contentType?: string }): string {
  const compiled = [
    '## Source Content',
    '',
    text,
    '',
    '## Provenance',
    '',
    `- Ingest mode: ${input.mode}`,
    `- Input kind: ${input.kind}`,
    input.url ? `- URL: ${input.url}` : '',
    resolved?.resolvedUrl && resolved.resolvedUrl !== input.url ? `- Final URL: ${resolved.resolvedUrl}` : '',
    input.file?.name ? `- File: ${input.file.name}` : '',
  ].filter(Boolean).join('\n');

  const frontmatter = Object.fromEntries(Object.entries({
    ingest_source: 'gbrain-ingest',
    input_kind: input.kind,
    mode: input.mode,
    content_hash: input.content_hash,
    url: input.url,
    final_url: resolved?.resolvedUrl,
    content_type: resolved?.contentType,
    file_name: input.file?.name,
    source_id: input.source_id,
  }).filter(([, value]) => value !== undefined));

  return serializeMarkdown(frontmatter, compiled, '', { type: 'source', title, tags: ['gbrain-ingest'] });
}

async function sourceLocalPath(engine: BrainEngine, sourceId: string): Promise<SourceLocalPath> {
  const rows = await engine.executeRaw<{ id: string; local_path: string | null }>(
    `SELECT id, local_path FROM sources WHERE id = $1`,
    [sourceId],
  );
  if (!rows[0]) {
    throw new Error(`gbrain-ingest source "${sourceId}" is not registered. Run: gbrain sources list`);
  }
  return { sourceId: rows[0].id, localPath: rows[0].local_path };
}

async function writeSourceMarkdownIfConfigured(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  markdown: string,
): Promise<{ status: 'written' | 'skipped_no_local_path'; path?: string; source_id: string }> {
  const source = await sourceLocalPath(engine, sourceId);
  if (!source.localPath) {
    return { status: 'skipped_no_local_path', source_id: source.sourceId };
  }
  if (!existsSync(source.localPath) || !statSync(source.localPath).isDirectory()) {
    throw new Error(`gbrain-ingest source "${source.sourceId}" local_path is missing or not a directory: ${source.localPath}`);
  }
  const filePath = join(source.localPath, `${slug}.md`);
  writeBrainPage(filePath, markdown, { sourcePath: source.localPath });
  return { status: 'written', path: filePath, source_id: source.sourceId };
}

export function makeIngestHandler(deps: IngestHandlerDeps): MinionHandler {
  return async (job: MinionJobContext) => {
    const input = assertNormalizedInput(job.data);
    await job.updateProgress({ phase: 'resolve', kind: input.kind });
    const resolved = await resolveJobContent(input, deps, job.signal);
    const title = titleFor(input, resolved.text);
    const slug = slugFor(input, title);
    const markdown = buildSourceMarkdown(input, title, resolved.text, resolved);
    const sourceId = input.source_id ?? 'default';

    await job.updateProgress({ phase: 'wiki_write', slug, source_id: sourceId });
    const wikiWrite = await writeSourceMarkdownIfConfigured(deps.engine, sourceId, slug, markdown);

    await job.updateProgress({ phase: 'db_import', slug });
    const imported = await importFromContent(deps.engine, slug, markdown, { noEmbed: true });
    await deps.engine.logIngest({
      source_type: 'gbrain-ingest',
      source_ref: input.url ?? input.file?.path ?? input.content_hash,
      pages_updated: [slug],
      summary: `${input.kind} ingest ${imported.status} for ${slug}`,
    });

    const status = imported.status === 'skipped' ? 'no-op' : 'succeeded';
    let enrichment: BoundedEnrichmentResult = { status: 'skipped', reason: 'disabled' };
    if (status === 'no-op') {
      enrichment = { status: 'skipped', reason: 'source_noop' };
    } else if (deps.enableEnrichment) {
      await job.updateProgress({ phase: 'enrich', slug });
      const { enrichAcceptedSource, summarizeFailedEnrichment, summarizeSuccessfulEnrichment } = await import('./enrichment.ts');
      try {
        enrichment = summarizeSuccessfulEnrichment(await enrichAcceptedSource({
          engine: deps.engine,
          sourceSlug: slug,
          sourceTitle: title,
          sourceText: resolved.text,
          runner: deps.inferenceRunner,
          allowPartial: true,
          signal: job.signal,
        }));
      } catch (e) {
        if (job.signal.aborted || (e instanceof CodexOAuthInferenceError && e.code === 'aborted')) {
          throw e;
        }
        enrichment = summarizeFailedEnrichment(e);
      }
    }

    await job.updateProgress({ phase: 'done', status, slug, enrichment_status: enrichment.status });
    return {
      status,
      updated_slugs: [slug],
      chunks: imported.chunks,
      content_hash: input.content_hash,
      wiki_write: wikiWrite,
      embedding: 'deferred',
      enrichment,
    };
  };
}
