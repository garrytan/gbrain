/**
 * policy_valid (L1): the owner and company agent policies' state. ok when there is no policy or
 * every policy is approved and parses; warn when a page is malformed, unapproved, or changed
 * outside gbrain (agents then get ask for everything, or the last approved revision), with the
 * next step from stateFix. Advisory policy: nothing here enforces or repairs.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { doctorVerify } from '../check-fix.ts';

export async function runPolicyValidDoctor(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  const { POLICY_SCOPES, resolvePolicy } = await import('../../../core/policy/store.ts');
  const { stateFix } = await import('../../../core/policy/check.ts');
  const served = (await Promise.all(POLICY_SCOPES.map(s => resolvePolicy(engine, s)))).filter(p => p.state !== 'none');
  if (!served.length) {
    checks.push({ name: 'policy_valid', status: 'ok', message: 'No agent policy is set; policy_check answers none (gbrain policy init sets one).' });
    return checks;
  }
  const bad = served.filter(p => p.state !== 'ok');
  const details = { scopes: served.map(p => ({ scope: p.scope, state: p.state, served_revision: p.served_revision, page_revision: p.page_revision })) };
  if (!bad.length) {
    checks.push({ name: 'policy_valid', status: 'ok', message: `Agent policy approved and valid (${served.map(p => p.scope).join(', ')}).`, details });
    return checks;
  }
  const fix = stateFix(bad[0]);
  checks.push({ name: 'policy_valid', status: 'warn',
    message: bad.map(p => `${p.scope} policy: ${p.state.replace(/_/g, ' ')}`).join('; ') + (fix ? `. ${fix.why}` : ''),
    details,
    ...(fix ? { fix: { ...fix, verify: doctorVerify('policy_valid') } } : {}) });
  return checks;
}

export const policyValidEntry: DoctorEntry = { name: 'policy_valid', emits: ['policy_valid'], run: runPolicyValidDoctor };
