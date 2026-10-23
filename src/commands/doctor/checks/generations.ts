/**
 * GBRA-161 doctor checks over the generation ledger (docs/architecture/generations.md). Both are `WAVE_CHECKS` entries
 * and read-only.
 *
 * - `generation_retirements`: items live generations retired inside the restore window (`generations.restore_days`),
 *   which `gbrain repair generations --mode restore` can bring back. Retiring what a complete successor no longer has is
 *   the normal path, so this is `ok` with the counts and the read-only preview; it never warns by itself.
 * - `generation_held`: results the primitive held instead of publishing (shrunk, oversize, valve, no_proof, ...). The
 *   previous generation stays live and nothing was retired; `warn` names each reason and the preview that lists them.
 *   Releasable reasons take `--mode release-held` after the user agrees; the others clear when the producer's input
 *   gives the proof it lacked.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';
import { readGenerationsConfig } from '../../../core/generations/config.ts';
import { RELEASABLE_HELD_REASONS, type HeldReason } from '../../../core/generations/contract.ts';
import { generationsPreviewArgv } from '../../../core/generations/repair.ts';

const DOCS = 'docs/guides/repair.md#generations';

async function activeSources(engine: BrainEngine, sourceIds?: string[]): Promise<string[]> {
  return sourceIds ?? (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
}

export async function generationRetirementsCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const sources = await activeSources(engine, sourceIds);
    const { restoreDays } = await readGenerationsConfig(engine);
    const rows = await engine.executeRaw<{ source_id: string; kind: string; keys: number; items: number; oldest: string | null }>(`
      SELECT g.source_id, g.kind, count(DISTINCT g.id)::int AS keys, count(*)::int AS items, min(g.created_at)::text AS oldest
        FROM derived_generations g JOIN derived_generation_items i ON i.generation_id=g.id AND i.action='retired'
       WHERE g.source_id=ANY($1::text[]) AND g.state='live' AND g.created_at >= now() - interval '1 day' * $2
       GROUP BY g.source_id, g.kind ORDER BY g.source_id, g.kind`, [sources, restoreDays]);
    const bySource = rows.map(row => ({ ...row, keys: Number(row.keys), items: Number(row.items) }));
    const items = bySource.reduce((sum, row) => sum + row.items, 0);
    const details = { items, keys: bySource.reduce((sum, row) => sum + row.keys, 0), restore_days: restoreDays, by_source: bySource, repair: 'generations', docs: DOCS };
    if (!items) return { name: 'generation_retirements', status: 'ok', details, message: `No live generation retired items in the last ${restoreDays} day(s).` };
    const first = bySource[0]!;
    const preview = generationsPreviewArgv({ kind: first.kind, sourceId: first.source_id });
    return { name: 'generation_retirements', status: 'ok', details,
      message: `${items} derived item(s) were retired by ${details.keys} live generation(s) in the last ${restoreDays} day(s) `
        + `(${bySource.map(row => `${row.source_id}/${row.kind}: ${row.items}`).join('; ')}); each is restorable until the purge hold ends. `
        + `Preview a restore with ${preview.join(' ')} (read-only).` };
  } catch (error) {
    return { name: 'generation_retirements', status: 'warn', details: { items: 'unknown' },
      message: `Generation retirements could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.` };
  }
}

export async function generationHeldCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const sources = await activeSources(engine, sourceIds);
    const rows = await engine.executeRaw<{ source_id: string; kind: string; held_reason: HeldReason; count: number; oldest: string | null }>(`
      SELECT source_id, kind, held_reason, count(*)::int AS count, min(created_at)::text AS oldest
        FROM derived_generations WHERE source_id=ANY($1::text[]) AND state='held'
       GROUP BY source_id, kind, held_reason ORDER BY source_id, kind, held_reason`, [sources]);
    const byReason = rows.map(row => ({ ...row, count: Number(row.count), releasable: RELEASABLE_HELD_REASONS.has(row.held_reason) }));
    const count = byReason.reduce((sum, row) => sum + row.count, 0);
    const details = { count, releasable: byReason.filter(row => row.releasable).reduce((sum, row) => sum + row.count, 0), by_reason: byReason, repair: 'generations', docs: DOCS };
    if (!count) return { name: 'generation_held', status: 'ok', details, message: 'No derived generation is held.' };
    const first = byReason.find(row => row.releasable) ?? byReason[0]!;
    const preview = generationsPreviewArgv({ kind: first.kind, sourceId: first.source_id }, 'release-held');
    return { name: 'generation_held', status: 'warn', details,
      message: `${count} derived result(s) were held instead of published (${byReason.map(row => `${row.source_id}/${row.kind} ${row.held_reason}: ${row.count}`).join('; ')}); `
        + 'the previous generation of each key stays live and nothing was retired. '
        + `Preview them with ${preview.join(' ')} (read-only); release a releasable one only after the user agrees.`,
      fix: agentFix(preview, 'Lists each held result with its reason, attempts and item count and prints the apply command bound to that set; it writes nothing. '
        + 'Releasing is the user\'s call: show them the preview before running the apply.', 'generation_held', { docs: DOCS }) };
  } catch (error) {
    return { name: 'generation_held', status: 'warn', details: { count: 'unknown' },
      message: `Held generations could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.` };
  }
}
