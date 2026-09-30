/**
 * stale_embedding_effects doctor check (#5629): a queued embedding effect
 * whose write request already committed, still unclaimed an hour later. It
 * blocks shared-skill activation (`writer_not_quiesced`) and no command can
 * clear it yet: `retry-effects` refuses effects that have not failed, and the
 * reconcile-or-re-queue path is deferred. The check names each effect so an
 * operator can inspect it; inspection cannot clear it.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';

const SAMPLE = 10;

export async function staleEmbeddingEffectsCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  const name = 'stale_embedding_effects';
  try {
    const where = `e.kind='embedding' AND e.state='queued' AND r.state='committed' AND e.updated_at < now() - interval '1 hour'
      ${sourceIds ? 'AND r.source_id=ANY($1::text[])' : ''}`;
    const params = sourceIds ? [sourceIds] : [];
    const [{ count }] = await engine.executeRaw<{ count: number }>(`SELECT COUNT(*)::int AS count FROM persistence_effects e
      JOIN persistence_requests r ON r.id=e.request_id WHERE ${where}`, params);
    const rows = await engine.executeRaw<{ effect_id: string; source_id: string; slug: string | null; request_id: string; updated_at: string }>(
      `SELECT e.id::text AS effect_id,r.source_id,r.slug,r.request_id::text AS request_id,e.updated_at::text AS updated_at FROM persistence_effects e
       JOIN persistence_requests r ON r.id=e.request_id WHERE ${where} ORDER BY e.id LIMIT ${SAMPLE}`, params);
    const effects = rows.map(row => ({ ...row, kind: 'embedding', inspect: `gbrain sources writer status ${row.source_id} --json` }));
    const details = { stale_effects: Number(count), count: 'exact', truncated: Number(count) > rows.length, effects,
      resolution: 'unsupported', docs: 'docs/guides/repair.md#stale-queued-embedding-effects' };
    if (!Number(count)) return { name, status: 'ok', details, message: 'No committed write has a queued embedding effect older than an hour.' };
    return { name, status: 'warn', details, message: `${count} committed write(s) still have a queued embedding effect after an hour; it blocks shared-skill activation `
      + `(writer_not_quiesced). No command clears it yet (retry-effects refuses effects that have not failed), and inspection cannot clear it. Inspect: `
      + `${effects.map(e => `effect ${e.effect_id} (${e.source_id}:${e.slug ?? '(no page)'}, request ${e.request_id}): ${e.inspect}`).join(' | ')}` };
  } catch (error) {
    return { name, status: 'warn', message: `Queued embedding effects could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown', truncated: true, health: 'unknown' } };
  }
}
