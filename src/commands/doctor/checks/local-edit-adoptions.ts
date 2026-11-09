/**
 * `local_edit_adoptions` (GST-1601 part 2, persistence/local-edit-adoption.ts): per source, the one-sided local edits the
 * owner adopted in the last 24 hours (a remember, capture or add_timeline_entry whose page file someone edited outside
 * gbrain, adopted in its own commit before the write applied). Informational and always ok: adoption is opt-in per
 * source (`persistence.adopt_local_edits.source.<id>`), and an edit someone keeps making by hand is worth knowing about.
 * Paths are source-relative; no page text. #8755: read from the receipt's `outcome.adopted_local_edit`, which compaction
 * keeps (it drops the intent), so a compacted adoption is still counted.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const DOCS = 'docs/guides/write-refusals.md#file_database_drift';
const MAX_PATHS = 20;

interface SourceAdoptions { source_id: string; adoptions: number; paths: string[] }

async function runLocalEditAdoptions(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  ctx.progress.heartbeat('local_edit_adoptions');
  const checks: Check[] = [];
  try {
    const rows = await engine.executeRaw<{ source_id: string; adoptions: number | string; paths: string[] }>(
      `SELECT source_id, count(*)::int AS adoptions, array_agg(DISTINCT outcome->'adopted_local_edit'->>'path' ORDER BY outcome->'adopted_local_edit'->>'path') AS paths
       FROM persistence_requests WHERE state='committed' AND operation='put_page' AND outcome ? 'adopted_local_edit'
         AND completed_at > now() - interval '24 hours' GROUP BY source_id ORDER BY source_id`);
    const sources: SourceAdoptions[] = rows.map(row => ({ source_id: row.source_id, adoptions: Number(row.adoptions), paths: row.paths.slice(0, MAX_PATHS) }));
    if (!sources.length) {
      checks.push({ name: 'local_edit_adoptions', status: 'ok', details: { sources, docs: DOCS }, message: 'No local edit was adopted in the last 24 h.' });
      return checks;
    }
    checks.push({ name: 'local_edit_adoptions', status: 'ok', details: { sources, docs: DOCS },
      message: `Local edits adopted in the last 24 h: ${sources.map(source => `${source.source_id}: ${source.adoptions} (${source.paths.join(', ')})`).join('; ')}. `
        + 'Each was committed on its own before the write that met it; someone or something is editing these files outside gbrain.' });
  } catch (error) {
    checks.push({ name: 'local_edit_adoptions', status: 'ok', details: { health: 'unknown', docs: DOCS },
      message: `Could not read local edit adoptions (${error instanceof Error ? error.message : String(error)}).` });
  }
  return checks;
}

export const localEditAdoptionsEntry: DoctorEntry = { name: 'local_edit_adoptions', emits: ['local_edit_adoptions'], run: runLocalEditAdoptions };
