/**
 * #7013 `atom_retirements_restorable`: atoms a managed re-extraction retired (`retired_by: managed-reextract`) that
 * `gbrain repair atoms-restore` can bring back, by the one rule the repair and the purge hold share
 * (`atomRetirementsSql`). A `WAVE_CHECKS` entry: `ok` when none; `warn` with the count, the origins, the
 * oldest and newest retirement, the date the purge hold of the earliest one ends, and the read-only preview as fix.
 * The apply needs the user's agreement on the previewed set. Read-only. GBRA-161 PR 1b: an atom whose retirement a live
 * generation's ledger records is reported there (`generation_retirements`, `ledger_covered` here) and not counted
 * again, so each atom warns at most once; the preview, its JSON and the apply are unchanged.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';
import { ATOM_RESTORE_HOLD_DAYS } from '../../../core/persistence/atom-retirement-hold.ts';
import { sortSourcesById } from '../../../core/source-rows.ts';

const DOCS = 'docs/guides/repair.md#atoms-restore';

export async function atomRetirementsRestorableCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const sources = sourceIds ?? sortSourcesById(await engine.listAllSources()).map(row => row.id);
    const rows = await engine.listRestorableAtomRetirements(sources);
    const covered = await engine.countLedgerCoveredAtomRetirements(sources);
    const bySource = rows.map(row => ({ ...row, count: Number(row.count), origins: Number(row.origins) }));
    const count = bySource.reduce((sum, row) => sum + row.count, 0);
    const details = { count, origins: bySource.reduce((sum, row) => sum + row.origins, 0),
      oldest_retired_at: bySource.map(row => row.oldest).filter(Boolean).sort()[0] ?? null,
      newest_retired_at: bySource.map(row => row.newest).filter(Boolean).sort().at(-1) ?? null,
      hold_until: bySource.map(row => row.hold_until).sort()[0] ?? null,
      source_ids: bySource.map(row => row.source_id), by_source: bySource, ledger_covered: covered, repair: 'atoms-restore', docs: DOCS };
    if (!count) {
      return { name: 'atom_retirements_restorable', status: 'ok', details,
        message: details.ledger_covered ? `No legacy atom retirement is waiting to be restored; ${details.ledger_covered} retirement(s) the generation ledger records are reported by generation_retirements.`
          : 'No atom retired by an empty re-extraction is waiting to be restored.' };
    }
    const first = bySource[0]!;
    const preview = ['gbrain', 'repair', 'atoms-restore', '--source', first.source_id, '--json'];
    return { name: 'atom_retirements_restorable', status: 'warn', details,
      message: `${count} atom(s) from ${details.origins} origin(s) were retired when a re-extraction returned no atoms (#7013), between `
        + `${details.oldest_retired_at ?? 'an unrecorded time'} and ${details.newest_retired_at ?? 'an unrecorded time'} `
        + `(${bySource.map(row => `${row.source_id}: ${row.count} from ${row.origins} origin(s)`).join('; ')}). `
        + `The purge holds them for ${ATOM_RESTORE_HOLD_DAYS} days after deletion; the first hold ends ${details.hold_until}. `
        + `Preview the restore with ${preview.join(' ')} (read-only); apply the previewed set only after the user agrees.`,
      fix: agentFix(preview, 'Lists each restorable atom with its origin, source hash and retirement time and prints the apply command bound to that set; '
        + 'it writes nothing. Restoring is the user\'s call: show them the preview before running the apply.', 'atom_retirements_restorable', { docs: DOCS }) };
  } catch (error) {
    return { name: 'atom_retirements_restorable', status: 'warn',
      message: `Restorable atom retirements could not be inspected: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown' } };
  }
}
