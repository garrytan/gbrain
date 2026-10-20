/**
 * #6712 PR 4b: `config set sync.admission`. A value outside `normal | imports_only | classify_only` is refused as a
 * usage error (exit 2) and nothing is written, `--force` included (the reader would fail it closed to
 * `classify_only`). A valid value is stored with its `set_at` in one transaction (persistence/sync-admission.ts).
 * `config` refuses on a thin client and no remote operation writes config, so the switch is set only on the brain host.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { SYNC_ADMISSION_KEY, SYNC_ADMISSION_VALUES, writeSyncAdmission, type SyncAdmission } from '../../core/persistence/sync-admission.ts';
import { inertText } from '../../core/agent-output.ts';
import { exitCliError, usageError } from '../../cli/cli-error.ts';

export async function setSyncAdmissionValue(engine: BrainEngine, value: string): Promise<void> {
  if (!(SYNC_ADMISSION_VALUES as readonly string[]).includes(value)) {
    exitCliError(usageError(`${SYNC_ADMISSION_KEY} is one of ${SYNC_ADMISSION_VALUES.join(', ')}; "${inertText(value, 40)}" is not. Nothing was written.`,
      `Re-run with one of them, e.g. gbrain config set ${SYNC_ADMISSION_KEY} normal (the default: managed sync admits everything it classifies).`, {
        why: 'Managed sync reads any other stored value as classify_only (fail closed), which would stop every write.',
        fix: { argv: ['gbrain', 'config', 'get', SYNC_ADMISSION_KEY], consent: [], actor: 'agent', why: 'Shows the value in effect and when it was set; nothing was written.', requires_exclusive: false },
      }), 'config');
  }
  await writeSyncAdmission(engine, value as SyncAdmission);
}
