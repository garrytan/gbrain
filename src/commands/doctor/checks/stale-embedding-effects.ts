/**
 * stale_embedding_effects doctor check (#5629, #5734): embedding effects of
 * committed writes that are queued and unclaimed an hour later, or failed.
 * They block receipt compaction and activation (`writer_not_quiesced`).
 * `gbrain repair embedding-effects` settles them; an effect it re-queued for
 * its owner stays counted as pending until it commits.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { EMBEDDING_CANDIDATE_WHERE } from '../../../core/persistence/embedding-settlement.ts';
import { loadConfigWithEngine } from '../../../core/config.ts';

const SAMPLE = 10;

export async function staleEmbeddingEffectsCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  const name = 'stale_embedding_effects';
  try {
    const where = `${EMBEDDING_CANDIDATE_WHERE} ${sourceIds ? 'AND r.source_id=ANY($1::text[])' : ''}`;
    const params = sourceIds ? [sourceIds] : [];
    const [{ count, failed, requeued }] = await engine.executeRaw<{ count: number; failed: number; requeued: number }>(`SELECT COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE e.state='failed')::int AS failed, COUNT(*) FILTER (WHERE e.state='queued' AND e.data ? 'repair_requeued_at')::int AS requeued
      FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE ${where}`, params);
    const rows = await engine.executeRaw<{ effect_id: string; source_id: string; slug: string | null; request_id: string; state: string; updated_at: string }>(
      `SELECT e.id::text AS effect_id,r.source_id,r.slug,r.request_id::text AS request_id,e.state,e.updated_at::text AS updated_at FROM persistence_effects e
       JOIN persistence_requests r ON r.id=e.request_id WHERE ${where} ORDER BY e.id LIMIT ${SAMPLE}`, params);
    const sources = [...new Set(rows.map(row => row.source_id))];
    const repair = sources.length === 1 ? `gbrain repair embedding-effects --source ${sources[0]}` : 'gbrain repair embedding-effects';
    const effects = rows.map(row => ({ ...row, kind: 'embedding', inspect: `gbrain sources writer status ${row.source_id} --json` }));
    const details: Record<string, unknown> = { stale_effects: Number(count), failed_effects: Number(failed), retry_queued_effects: Number(requeued), count: 'exact',
      truncated: Number(count) > rows.length, effects, resolution: 'repairable', repair: 'embedding-effects', command: repair,
      docs: 'docs/guides/repair.md#stale-queued-embedding-effects' };
    if (!Number(count)) return { name, status: 'ok', details, message: 'No committed write has a stale queued or failed embedding effect.' };
    // Settlement needs a configured, enabled embedding model; without one the repair can only report blocked.
    const config = await loadConfigWithEngine(engine).catch(() => null);
    if (!config?.embedding_model || !config.embedding_dimensions || config.embedding_disabled) {
      details.operator_instruction = `Configure and enable an embedding model on the brain host, then run ${repair} and apply it with --apply.`;
    }
    return { name, status: 'warn', details, message: `${count} committed write(s) have an unsettled embedding effect (${Number(count) - Number(failed)} queued over an hour`
      + `${Number(requeued) ? `, ${requeued} of them re-queued for the owner and still pending` : ''}; ${failed} failed); they block receipt compaction and activation `
      + `(writer_not_quiesced). Preview on the brain host: ${repair} — then apply after the user agrees: ${repair} --apply. `
      + `Effects: ${effects.map(e => `effect ${e.effect_id} (${e.state}, ${e.source_id}:${e.slug ?? '(no page)'}, request ${e.request_id})`).join(' | ')}` };
  } catch (error) {
    return { name, status: 'warn', message: `Queued embedding effects could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown', truncated: true, health: 'unknown' } };
  }
}
