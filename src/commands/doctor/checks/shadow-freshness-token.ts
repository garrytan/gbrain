/**
 * `shadow_freshness_token`: whether the database role this brain connects as can see other sessions' transactions, for a
 * Postgres brain with Rust engine shadow mode on (`gbrain engine shadow start`). A role that is neither a superuser nor in
 * `pg_read_all_stats` makes the shadow's freshness token blind (src/shadow/checks.ts), so that brain clears no privacy sample
 * and no recall score and swap readiness criterion 3 stays failing. The finding names the reason and the fix, `GRANT
 * pg_read_all_stats TO <role>` for the connected role (`tell_user_to_run`: the host operator runs it). Not applicable on
 * PGLite or with no shadow on: it says nothing there. Read-only: one catalog query.
 */
import { loadConfig } from '../../../core/config.ts';
import type { BrainEngine } from '../../../core/engine.ts';
import { hasCapability } from '../../../core/engine-capabilities.ts';
import type { EngineConfig } from '../../../core/types.ts';
import { FRESHNESS_BLIND_CHECK, probeFreshnessBlind } from '../../../shadow/freshness-role.ts';
import { shadowStateFor } from '../../../shadow/state.ts';
import type { Check } from '../../doctor.ts';
import { checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

/** The check for a config and a connected engine; null (silent) when shadow mode is off or the brain is not on Postgres. */
export async function shadowFreshnessTokenCheck(config: EngineConfig | null, engine: Pick<BrainEngine, 'capabilities' | 'executeRaw'>): Promise<Check | null> {
  if (!hasCapability(engine, 'postgres_admin') || !config || !shadowStateFor(config)) return null;
  try {
    const blind = await probeFreshnessBlind(engine);
    if (!blind) {
      return { name: FRESHNESS_BLIND_CHECK, status: 'ok', message: 'The database role can see other sessions, so the shadow freshness token can be proven.' };
    }
    return {
      name: FRESHNESS_BLIND_CHECK, status: 'warn', message: `${blind.message} (${blind.code}). ${blind.why}`,
      fix: blind.fix, details: { code: blind.code, role: blind.role, sql: `GRANT pg_read_all_stats TO ${blind.role};` },
    };
  } catch (e) {
    return checkError(FRESHNESS_BLIND_CHECK, 'check whether the database role can see other sessions', e);
  }
}

async function runShadowFreshnessToken(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat(FRESHNESS_BLIND_CHECK);
  let config: EngineConfig | null;
  try { config = loadConfig() as EngineConfig | null; } catch (e) {
    checks.push(checkError('shadow_freshness_token', 'read the brain config', e));
    return checks;
  }
  const check = await shadowFreshnessTokenCheck(config, engine);
  if (check) checks.push({ ...check, name: 'shadow_freshness_token' });
  return checks;
}

export const shadowFreshnessTokenEntry: DoctorEntry = { name: 'shadow_freshness_token', emits: ['shadow_freshness_token'], run: runShadowFreshnessToken };
