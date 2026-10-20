/**
 * #6712 PR 4b (design v3.2 §8): `sync_admission_restricted`. While `sync.admission` is not `normal`, managed sync
 * admits less than it classifies (`imports_only`: no deletes and no keep_db writes; `classify_only`: nothing), so the
 * check warns with the value, its age (from `set_at`) and the restore command, which only the user runs. A brain that
 * is not managed has no managed pass to restrict, so the check is ok there. It reads config and one checkpoint row.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { checkError, doctorVerify } from '../check-fix.ts';
import { readManagedMode } from '../../../core/persistence/managed-mode.ts';
import { SYNC_ADMISSION_KEY, readSyncAdmissionSetting } from '../../../core/persistence/sync-admission.ts';

const DOCS = 'docs/guides/error-codes.md#sync_admission_restricted';
const PAUSED = { imports_only: 'admits no deletes and no keep_db writes (those paths wait as paused_deletes and paused_keep_db; imports continue)',
  classify_only: 'reads and classifies only: it writes and stamps nothing (stop admission_paused)' } as const;

async function runSyncAdmissionCheck(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    const setting = await readSyncAdmissionSetting(engine);
    const ageSeconds = setting.set_at ? Math.max(0, Math.round((Date.now() - Date.parse(setting.set_at)) / 1000)) : null;
    const details = { value: setting.value, stored: setting.stored, set_at: setting.set_at, age_seconds: ageSeconds, docs: DOCS };
    if (setting.value === 'normal') {
      checks.push({ name: 'sync_admission_restricted', status: 'ok', message: `${SYNC_ADMISSION_KEY} is normal: managed sync admits everything it classifies.`, details });
      return checks;
    }
    if (!await readManagedMode(engine)) {
      checks.push({ name: 'sync_admission_restricted', status: 'ok', severity: 'info', readiness_state: 'not_applicable', details,
        message: `${SYNC_ADMISSION_KEY} is ${setting.value}, but this brain is not managed, so no managed sync reads it.` });
      return checks;
    }
    const value = setting.value as keyof typeof PAUSED;
    const stored = setting.stored !== value ? ` (the stored value ${JSON.stringify((setting.stored ?? '').slice(0, 40))} is not a value and reads as ${value}, fail closed)` : '';
    const age = ageSeconds === null ? 'set at an unknown time' : `set ${formatAge(ageSeconds)} ago (${setting.set_at})`;
    checks.push({ name: 'sync_admission_restricted', status: 'warn', details,
      message: `${SYNC_ADMISSION_KEY} is ${value}${stored}, ${age}: managed sync ${PAUSED[value]}. Ask the user whether the reason for restricting it still holds; `
        + `gbrain config set ${SYNC_ADMISSION_KEY} normal restores it, and the next sync admits what waited.`,
      fix: { argv: ['gbrain', 'config', 'set', SYNC_ADMISSION_KEY, 'normal'], consent: [], actor: 'user', requires_exclusive: false, verify: doctorVerify('sync_admission_restricted'), docs: DOCS,
        why: `Restores the default, so managed sync admits deletes and keep_db writes again. The owner chose ${value}; only they restore it, and gbrain never runs this on its own.` } });
  } catch (error) {
    checks.push(checkError('sync_admission_restricted', 'read sync.admission', error, { details: { docs: DOCS } }));
  }
  return checks;
}

function formatAge(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/** An ops section: one config read and one checkpoint row, cheap on every engine. */
export const syncAdmissionEntry: DoctorEntry = { name: 'sync_admission_restricted', emits: ['sync_admission_restricted'], tier: 'ops', run: runSyncAdmissionCheck };
