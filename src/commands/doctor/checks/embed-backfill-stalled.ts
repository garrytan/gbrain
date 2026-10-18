/**
 * embed_backfill_stalled doctor check (#6803): sources whose automatic
 * embed-backfill keeps failing the same way with nothing embedded. The
 * submit gate (embed-backfill-stall.ts) backs these off and then stops
 * queueing them; this check names the pages blocking them and the repair.
 *
 * The usual blocker is a page whose text projection cannot be rebuilt
 * (`page_projection_jobs.reason = 'rebuild_failed'`), which the backfill's
 * bounded recovery retries silently. `gbrain projections drain` retries it
 * in the foreground and prints why it fails and what to do; its `--dry-run`
 * is the preview. Image and media pages are rebuilt only by their importer.
 * Nothing here runs a repair.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { doctorVerify } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { EMBED_BACKFILL_STALL_LIMIT, readEmbedBackfillBlockers, readEmbedBackfillStall } from '../../../core/embed-backfill-stall.ts';

const DOCS = 'docs/guides/repair.md#embed-backfill-stalled';
const LISTED = 10;

export async function embedBackfillStalledCheck(engine: BrainEngine): Promise<Check> {
  try {
    const sources = await engine.executeRaw<{ source_id: string }>(
      `SELECT DISTINCT data->>'sourceId' AS source_id FROM minion_jobs
        WHERE name = 'embed-backfill' AND status IN ('failed', 'dead') AND progress ? 'stall'`);
    const stalled = [];
    for (const { source_id } of sources) {
      const stall = source_id ? await readEmbedBackfillStall(engine, source_id) : null;
      if (!stall) continue;
      const current = await readEmbedBackfillBlockers(engine, source_id, stall.signature);
      if (current.fingerprint !== stall.fingerprint) continue;
      const reasons = new Map((await engine.executeRaw<{ slug: string; reason: string }>(
        `SELECT j.slug, j.reason FROM page_projection_jobs j JOIN sources s ON s.incarnation = j.source_incarnation
          WHERE s.id = $1 AND j.slug = ANY($2::text[])`, [source_id, current.pages.slice(0, LISTED).map(p => p.slug)])).map(r => [r.slug, r.reason]));
      stalled.push({ source_id, failures: stall.failures, stopped: stall.failures >= EMBED_BACKFILL_STALL_LIMIT,
        last_failed_at: stall.last_finished_at.toISOString(), remaining_chunks: current.remaining, blocked: current.blocked,
        pages: current.pages.slice(0, LISTED).map(p => ({ slug: p.slug, page_kind: p.page_kind, queue_reason: reasons.get(p.slug) ?? null })) });
    }
    if (stalled.length === 0) return { name: 'embed_backfill_stalled', status: 'ok', message: 'No automatic embed-backfill is repeating the same failure.' };
    const media = stalled.some(s => s.pages.some(p => p.page_kind !== 'markdown' && p.page_kind !== 'code'));
    const lines = stalled.map(s => `${s.source_id}: ${s.failures} identical failed run(s) with nothing embedded, last ${s.last_failed_at}`
      + `${s.stopped ? '; automatic backfill is stopped' : '; retries are backing off'}; ${s.remaining_chunks} stale chunk(s), ${s.blocked} blocked page(s)`
      + (s.pages.length ? `: ${s.pages.map(p => `${p.slug} (${p.page_kind}${p.queue_reason ? `, ${p.queue_reason}` : ''})`).join(', ')}${s.blocked > s.pages.length ? `, +${s.blocked - s.pages.length} more` : ''}` : ''));
    return {
      name: 'embed_backfill_stalled',
      status: 'warn',
      message: `Automatic embed-backfill is stuck on pages it cannot project. ${lines.join('. ')}. `
        + 'Preview with gbrain projections drain --dry-run, then run gbrain projections drain: it retries each queued Markdown or code page in the foreground and prints why one fails and the next step. '
        + (media ? 'Image and media pages are rebuilt only by their importer: restore their source files and run gbrain sync --full --source <id>, or gbrain embed --stale --images --source <id>. ' : '')
        + `Once the blocked pages change, the next automatic backfill runs by itself. Nothing was changed by this check. See ${DOCS}.`,
      details: { code: 'embed_backfill_stalled', sources: stalled, stall_limit: EMBED_BACKFILL_STALL_LIMIT, docs: DOCS },
      fix: {
        argv: ['gbrain', 'projections', 'drain'],
        preview_argv: ['gbrain', 'projections', 'drain', '--dry-run', '--json'],
        consent: [],
        actor: 'agent',
        why: 'Retries the queued projection rebuilds in the foreground and names each page that still fails with its next step; the preview lists them and changes nothing.',
        verify: doctorVerify('embed_backfill_stalled'),
        docs: DOCS,
        requires_exclusive: false,
      },
    };
  } catch (error) {
    return { name: 'embed_backfill_stalled', status: 'warn', message: `Embed-backfill history could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { health: 'unknown' }, fix_unavailable_reason: 'check_errored' };
  }
}

async function runEmbedBackfillStalled(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push({ ...(await embedBackfillStalledCheck(connectedEngine(ctx))), name: 'embed_backfill_stalled' });
  return checks;
}

export const embedBackfillStalledEntry: DoctorEntry = {
  name: 'embed_backfill_stalled',
  emits: ['embed_backfill_stalled'],
  run: runEmbedBackfillStalled,
};
