/**
 * `inline_timeline_chunks`: inline Markdown pages whose stored timeline has a bullet line and whose chunks the
 * pre-bullet inline chunker sealed (MARKDOWN_CHUNKER_VERSION, below INLINE_TIMELINE_CHUNKER_VERSION). Their chunks stay
 * current and keep serving search, so this is information, always ok: new and edited pages already chunk their timeline
 * at bullet boundaries, and nothing (upgrade, sync, doctor) re-chunks an existing page on its own. The fix names the
 * read-only preview of `gbrain reindex --timeline-bullets` (core/page-state/timeline-rechunk.ts); its `--apply` makes no
 * provider call and leaves new chunk texts to `gbrain embed --stale`. One aggregate, exact count, scoped to the
 * caller's sources.
 */
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';
import { connectedEngine, doctorSourceIds, type DoctorContext, type DoctorEntry } from '../context.ts';
import { INLINE_TIMELINE_CHUNKER_VERSION } from '../../../core/markdown-chunks.ts';
import { INLINE_TIMELINE_PENDING_SQL } from '../../../core/page-state/timeline-rechunk.ts';

async function runInlineTimelineChunks(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const sourceIds = doctorSourceIds(ctx);
  try {
    const [row] = await connectedEngine(ctx).executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages p
      JOIN sources s ON s.id = p.source_id AND s.archived IS NOT TRUE WHERE ${INLINE_TIMELINE_PENDING_SQL}${sourceIds ? ' AND p.source_id = ANY($1::text[])' : ''}`,
    sourceIds ? [sourceIds] : []);
    const pages = Number(row?.n ?? 0);
    const details = { informational: true, pages_pending: pages, chunker_version: INLINE_TIMELINE_CHUNKER_VERSION, count: 'exact' };
    if (pages === 0) {
      checks.push({ name: 'inline_timeline_chunks', status: 'ok', details, message: 'Every inline page with a bulleted timeline is chunked at bullet boundaries.' });
      return checks;
    }
    const scope = sourceIds?.length === 1 ? ['--source', sourceIds[0]!] : [];
    checks.push({ name: 'inline_timeline_chunks', status: 'ok', details,
      message: `Informational: ${pages} inline page(s) with a bulleted timeline still use the pre-bullet chunker; their chunks stay current and keep serving search. `
        + `Bullet-aligned timeline chunks re-embed less when an entry is added at the top. Preview the re-chunk (writes nothing): gbrain reindex --timeline-bullets${scope.length ? ` ${scope.join(' ')}` : ''}.`,
      fix: agentFix(['gbrain', 'reindex', '--timeline-bullets', ...scope, '--json'],
        'Read-only preview: lists each page with its chunk counts and the new chunk texts the apply would leave to the embed sweep. Apply only after the user agrees; it makes no provider call.',
        'inline_timeline_chunks') });
  } catch (error) {
    checks.push({ name: 'inline_timeline_chunks', status: 'ok', details: { informational: true, count: 'unknown', health: 'unknown' },
      message: `Informational: the inline timeline chunker state could not be read (${error instanceof Error ? error.message : String(error)}).` });
  }
  return checks;
}

export const inlineTimelineChunksEntry: DoctorEntry = { name: 'inline_timeline_chunks', emits: ['inline_timeline_chunks'], run: runInlineTimelineChunks };
