/**
 * Re-chunk inline Markdown pages sealed at the pre-bullet inline chunker (`gbrain reindex --timeline-bullets`).
 *
 * New and changed inline bodies chunk their timeline at bullet boundaries (INLINE_TIMELINE_CHUNKER_VERSION,
 * markdown-chunks.ts). A page sealed at MARKDOWN_CHUNKER_VERSION whose stored timeline has a bullet line keeps its
 * older chunks, which stay current for every reader, until this runs. Preview first: the preview chunks each such
 * page with the bullet-aligned chunker, compares the result with the stored rows and writes nothing. `--apply`
 * installs the new chunks through the projection install (installPageProjection under the page guard, at the revision
 * the run read): no page content, revision, version history or journal changes, vectors of unchanged chunk texts are
 * kept, and new texts carry no vector until the embed sweep (`gbrain embed --stale`), so the apply makes no provider
 * call. A page that changed while it was read is left as it is (`moved`). No migration, upgrade, sync or doctor step
 * runs it.
 */
import type { BrainEngine } from '../engine.ts';
import { MARKDOWN_CHUNKER_VERSION } from '../chunkers/recursive.ts';
import { INLINE_TIMELINE_CHUNKER_VERSION } from '../markdown-chunks.ts';
import { chunkGenerationFilter } from '../search/safe-chunks.ts';
import { installPageProjection, preparePageProjection, readProjectionSnapshot } from './projections.ts';
import { PageRevisionConflictError } from './types.ts';

/**
 * SQL over `pages p`: a live inline Markdown page sealed at the pre-bullet chunker whose stored timeline chunks hold a
 * bullet line (the chunk text is the projection the bullet-aligned chunker reads, so no page body is read).
 */
export const INLINE_TIMELINE_PENDING_SQL = `p.deleted_at IS NULL AND p.page_kind = 'markdown' AND p.body_storage IS DISTINCT FROM 'segmented'
  AND p.chunker_version >= ${MARKDOWN_CHUNKER_VERSION} AND p.chunker_version < ${INLINE_TIMELINE_CHUNKER_VERSION}
  AND EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id = p.id AND ${chunkGenerationFilter('p', 'c')} AND c.chunk_source = 'timeline' AND c.chunk_text ~ '(^|\\n)[-*+][ \\t]+\\S')`;

export interface TimelineRechunkPage {
  source_id: string;
  slug: string;
  /** The page's chunker version when the run read it. */
  chunker_version: number;
  /** Stored chunk rows, and the rows the bullet-aligned chunker makes of the same body. */
  chunks: number;
  chunks_after: number;
  /** Chunk texts no stored row of the page holds: each needs a vector from the embed sweep. */
  new_chunk_texts: number;
  new_chunk_chars: number;
  /** `stamped` (apply): the chunks were already identical; `moved`: the page changed or went while it was read, run again (counts are 0). */
  state?: 'rechunked' | 'stamped' | 'moved' | 'failed';
  error?: string;
}

export interface TimelineRechunkReceipt {
  dry_run: boolean;
  chunker_version: number;
  /** Pages in scope still sealed at the pre-bullet chunker when the run started; `pages` holds the ones it read (`--limit`). */
  pending: number;
  pages: TimelineRechunkPage[];
  commands: { apply: string[] | null; embed: string[] | null; preview: string[] };
}

interface CandidateRow { slug: string; source_id: string }

const chunkKey = (c: { chunk_source: string; chunk_text: string; projected_byte_start?: number | null; projected_byte_end?: number | null }) =>
  JSON.stringify([c.chunk_source, c.chunk_text, c.projected_byte_start ?? null, c.projected_byte_end ?? null]);

async function rechunkPage(engine: BrainEngine, row: CandidateRow, apply: boolean): Promise<TimelineRechunkPage | null> {
  const moved = (chunkerVersion: number): TimelineRechunkPage => ({ source_id: row.source_id, slug: row.slug, chunker_version: chunkerVersion, chunks: 0, chunks_after: 0,
    new_chunk_texts: 0, new_chunk_chars: 0, state: 'moved' });
  // A preview reads without the page guard, statement by statement: a page that changes or goes while it is read is reported moved.
  const read = await readProjectionSnapshot(engine, row.slug, row.source_id, { requireLiveSource: true, preview: !apply }).catch(error => {
    if (!apply && error instanceof PageRevisionConflictError) return 'moved' as const;
    throw error;
  });
  if (read === 'moved') return moved(0);
  if (!read || read.pageKind !== 'markdown') return null;
  const stored = read.storedChunkerVersion ?? 0;
  if (stored < MARKDOWN_CHUNKER_VERSION || stored >= INLINE_TIMELINE_CHUNKER_VERSION) return null;
  const prepared = { ...read, timelineBullets: true };
  const { chunks } = await preparePageProjection(prepared);
  const texts = new Set(read.chunks.map(c => `${c.chunk_source}\0${c.chunk_text}`));
  const fresh = chunks.filter(c => !texts.has(`${c.chunk_source}\0${c.chunk_text}`));
  const out: TimelineRechunkPage = { source_id: row.source_id, slug: row.slug, chunker_version: stored, chunks: read.chunks.length,
    chunks_after: chunks.length, new_chunk_texts: fresh.length, new_chunk_chars: fresh.reduce((sum, c) => sum + c.chunk_text.length, 0) };
  if (!apply) {
    const [now] = await engine.executeRaw<{ revision: string; projection: string | null; chunker_version: number | null }>(
      'SELECT knowledge_revision AS revision, text_projection_revision AS projection, chunker_version FROM pages WHERE id=$1 AND deleted_at IS NULL', [Number(read.snapshot.page.id)]);
    const same = now?.revision === read.snapshot.revision && now.projection === read.snapshot.revision && Number(now.chunker_version) === stored;
    return same ? out : moved(stored);
  }
  const same = read.chunks.length === chunks.length && chunks.every((c, i) => chunkKey(c) === chunkKey(read.chunks[i]!));
  try {
    await installPageProjection(engine, prepared, chunks, { seal: true, preserveEmbeddings: true, chunkerVersion: INLINE_TIMELINE_CHUNKER_VERSION });
    return { ...out, state: same ? 'stamped' : 'rechunked' };
  } catch (error) {
    if (error instanceof PageRevisionConflictError) return { ...out, state: 'moved' };
    return { ...out, state: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
}

/** Preview (default) or apply the bullet-aligned re-chunk of every sealed inline page in scope still at the pre-bullet chunker. */
export async function runTimelineRechunk(engine: BrainEngine,
  opts: { apply?: boolean; sourceId?: string; slug?: string; limit?: number } = {}): Promise<TimelineRechunkReceipt> {
  const apply = opts.apply === true;
  const params: unknown[] = [];
  let where = '';
  if (opts.sourceId) { params.push(opts.sourceId); where += ` AND p.source_id=$${params.length}`; }
  if (opts.slug) { params.push(opts.slug); where += ` AND p.slug=$${params.length}`; }
  const from = `FROM pages p JOIN sources s ON s.id=p.source_id AND s.archived IS NOT TRUE WHERE ${INLINE_TIMELINE_PENDING_SQL}${where}`;
  const [count] = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n ${from}`, params);
  const rows = await engine.executeRaw<CandidateRow>(`SELECT p.slug, p.source_id ${from}
    AND (p.text_projection_revision = p.knowledge_revision) IS TRUE ORDER BY p.source_id, p.slug${opts.limit ? ` LIMIT ${Math.floor(opts.limit)}` : ''}`, params);
  const pages: TimelineRechunkPage[] = [];
  for (const row of rows) {
    const page = await rechunkPage(engine, row, apply);
    if (page) pages.push(page);
  }
  const scope = [...(opts.sourceId ? ['--source', opts.sourceId] : []), ...(opts.slug ? ['--slug', opts.slug] : []),
    ...(opts.limit ? ['--limit', String(opts.limit)] : [])];
  const embed = apply && pages.some(p => p.state === 'rechunked' && p.new_chunk_texts > 0);
  return { dry_run: !apply, chunker_version: INLINE_TIMELINE_CHUNKER_VERSION, pending: Number(count?.n ?? 0), pages,
    commands: { apply: !apply && pages.length ? ['gbrain', 'reindex', '--timeline-bullets', ...scope, '--apply'] : null,
      embed: embed ? ['gbrain', 'embed', '--stale'] : null, preview: ['gbrain', 'reindex', '--timeline-bullets', ...scope] } };
}

const LISTED_PAGES = 20;

export function formatTimelineRechunkReceipt(r: TimelineRechunkReceipt): string[] {
  const total = (key: 'chunks' | 'chunks_after' | 'new_chunk_texts' | 'new_chunk_chars') => r.pages.reduce((sum, p) => sum + p[key], 0);
  const lines = [`reindex --timeline-bullets${r.dry_run ? ' (preview, nothing written)' : ''}: ${r.pending} inline page(s) with a bulleted timeline below chunker ${r.chunker_version}`
    + `${r.pages.length < r.pending ? `, ${r.pages.length} read this run` : ''}; ${total('chunks')} -> ${total('chunks_after')} chunks, `
    + `${total('new_chunk_texts')} new chunk text(s), ${total('new_chunk_chars')} chars to embed`];
  for (const p of r.pages.slice(0, LISTED_PAGES)) {
    lines.push(`  ${p.source_id}/${p.slug}  v${p.chunker_version}  ${p.chunks} -> ${p.chunks_after} chunks, ${p.new_chunk_texts} new chunk text(s)`
      + `${p.state ? `  ${p.state}` : ''}${p.error ? `: ${p.error}` : ''}`);
  }
  if (r.pages.length > LISTED_PAGES) lines.push(`  ... ${r.pages.length - LISTED_PAGES} more (--json lists every page)`);
  if (r.commands.apply) lines.push(`Apply: ${r.commands.apply.join(' ')}`);
  if (r.commands.embed) lines.push(`New chunk texts get vectors from the embed sweep: ${r.commands.embed.join(' ')}`);
  if (r.pages.some(p => p.state === 'moved')) lines.push(`A page changed while it was read; run again: ${r.commands.preview.join(' ')}${r.dry_run ? '' : ' --apply'}`);
  return lines;
}
