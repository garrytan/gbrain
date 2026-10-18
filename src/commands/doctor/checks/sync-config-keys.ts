/**
 * #6712 PR 2 (L3): `sync_config_keys`. A retired `sync.*` key stored on the brain before the upgrade is no longer
 * read, so a value the user chose silently stopped applying. The check names each one with the value in effect and
 * the environment variable that replaces it, and lists stored rollback keys with their windows.
 */
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { RETIRED_SYNC_KEYS, SYNC_ROLLBACK_KEYS, effectiveSyncKey, type RetiredSyncKey } from '../../../core/sync-config-keys.ts';
import { CONFIG_ROLLBACK_WINDOWS } from '../../../core/wire-skew.ts';

async function runSyncConfigKeys(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  const stored = async (key: string) => engine.getConfig(key).catch(() => null);
  const unapplied: Array<{ key: string; stored: string; effective: string; replacement: string | null }> = [];
  for (const retired of Object.values(RETIRED_SYNC_KEYS) as RetiredSyncKey[]) {
    const value = await stored(retired.key);
    if (value === null) continue;
    unapplied.push({ key: retired.key, stored: value, effective: effectiveSyncKey(retired.key, value)!.value, replacement: retired.replacement?.env ?? null });
  }
  const rollback: Array<{ key: string; stored: string; honored_until: string }> = [];
  for (const key of SYNC_ROLLBACK_KEYS) {
    const value = await stored(key);
    if (value !== null) rollback.push({ key, stored: value, honored_until: CONFIG_ROLLBACK_WINDOWS[key].honored_until });
  }
  const rollbackLine = rollback.length
    ? ` Rollback keys set on this brain (honored, not tunables): ${rollback.map(row => `${row.key}=${row.stored} (until at least ${row.honored_until})`).join(', ')}.` : '';
  if (!unapplied.length) {
    checks.push({ name: 'sync_config_keys', status: 'ok', message: `No retired sync config key is stored on this brain.${rollbackLine}`, details: { unapplied, rollback } });
    return checks;
  }
  checks.push({ name: 'sync_config_keys', status: 'warn', details: { unapplied, rollback },
    message: `${unapplied.length} retired sync config key(s) are stored but no longer applied: `
      + unapplied.map(row => `${row.key}=${row.stored} (in effect: ${row.effective}${row.replacement ? `; set ${row.replacement} for the process that syncs to change it` : '; removed, nothing replaces it'})`).join('; ')
      + `. Ask the user whether to carry each value over to its environment variable, then remove the stored key with gbrain config unset <key>.${rollbackLine}`,
    fix: agentFix(['gbrain', 'config', 'get', unapplied[0]!.key],
      'Prints the value in effect for the first unapplied key and the environment variable that replaces it; read-only.', 'sync_config_keys') });
  return checks;
}

export const syncConfigKeysEntry: DoctorEntry = { name: 'sync_config_keys', emits: ['sync_config_keys'], run: runSyncConfigKeys };
