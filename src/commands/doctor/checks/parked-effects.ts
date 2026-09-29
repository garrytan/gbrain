import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import type { ParkedTarget } from '../../../core/persistence/effect-model.ts';

const SAMPLE = 20;

/**
 * #5612: Git and withdrawal targets that failed five consecutive times are
 * parked instead of retried forever. Reads the partial `persistence_effects_parked`
 * index: an exact count plus a capped sample naming each page and its retry command.
 */
export async function checkParkedEffects(engine: BrainEngine): Promise<Check> {
  try {
    const [{ count }] = await engine.executeRaw<{ count: number }>(`SELECT COUNT(*)::int AS count FROM persistence_effects WHERE data ? 'parked'`);
    const rows = await engine.executeRaw<{ request_id: string; source_id: string; kind: string; state: string; parked: ParkedTarget[] }>(
      `SELECT r.request_id::text AS request_id,e.source_id,e.kind,e.state,e.data->'parked' AS parked FROM persistence_effects e
       JOIN persistence_requests r ON r.id=e.request_id WHERE e.data ? 'parked' ORDER BY e.id LIMIT ${SAMPLE}`);
    const effects = rows.map(row => ({ ...row, command: `gbrain sources writer retry-effects ${row.source_id} --request-id ${row.request_id} --dry-run` }));
    const details = { parked_effects: count, exact: true, inspected: rows.length, truncated: count > rows.length, effects };
    if (!count) return { name: 'parked_effects', status: 'ok', message: 'No Git or withdrawal effect is parked.', details };
    const listed = effects.map(effect => `${effect.kind} ${effect.source_id}: ${effect.parked.map(target =>
      `${target.slug ?? '(whole effect)'} (${target.error_code})`).join(', ')}; ${effect.command}`);
    return { name: 'parked_effects', status: 'warn', details,
      message: `${count} Git or withdrawal effect(s) have parked targets after five consecutive failures; their withdrawal or Git backup is incomplete. ` +
        `Inspect \`gbrain sources writer status <source>\`, fix the cause, preview with the command shown, then rerun it without --dry-run to authorize one more attempt: ${listed.join(' | ')}` +
        (count > rows.length ? ` (first ${rows.length} of ${count} shown)` : '') };
  } catch (error) {
    return { name: 'parked_effects', status: 'warn',
      message: `Parked effects could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { exact: false, inspected: 0, truncated: true } };
  }
}
