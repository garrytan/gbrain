import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { orphanConnectorCheckpoints } from '../../../core/persistence/connector-checkpoint-migration.ts';
import { ORPHAN_CHECKPOINT_MIN_AGE_DAYS } from '../../../core/repair/connector-checkpoints.ts';

const LIMIT = 1000;

/**
 * #5686: connector checkpoint rows and retry pointers that no registered
 * connector source can load, older than 7 days. The 7-day checkpoint purge
 * never removes them, so they accumulate after a content-config change or an
 * old binary running during an upgrade. Counts only; names the repair.
 */
export async function checkConnectorCheckpoints(engine: BrainEngine): Promise<Check> {
  try {
    const rows = await orphanConnectorCheckpoints(engine, { minAgeDays: ORPHAN_CHECKPOINT_MIN_AGE_DAYS, limit: LIMIT + 1 });
    const truncated = rows.length > LIMIT;
    const counted = rows.slice(0, LIMIT);
    const checkpoints = counted.filter(row => row.op === 'managed-connector').length;
    const retries = counted.length - checkpoints;
    const details = { count: counted.length, checkpoints, retries, truncated, repair: 'connector-checkpoints', docs: 'docs/guides/repair.md#connector-checkpoints' };
    if (!counted.length) return { name: 'connector_checkpoints', status: 'ok', message: 'No orphan connector checkpoint rows older than 7 days.', details };
    return { name: 'connector_checkpoints', status: 'warn', details,
      message: `${counted.length}${truncated ? '+' : ''} connector checkpoint row(s) no source can load (${checkpoints} checkpoint(s), ${retries} retry pointer(s)), older than 7 days. `
        + 'Preview on the brain host: gbrain repair connector-checkpoints — then apply after the user agrees: gbrain repair connector-checkpoints --apply' };
  } catch (error) {
    return { name: 'connector_checkpoints', status: 'warn',
      message: `Connector checkpoint rows could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 0, truncated: true } };
  }
}
