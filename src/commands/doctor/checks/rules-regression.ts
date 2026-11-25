/**
 * rules_regression (C2): the keyless check of confirmed active standing rules (gbrain rules check). ok when no rule
 * is confirmed or every check passes; warn naming the failing rules, with gbrain rules check as the next step.
 * Read-only: nothing here changes a rule or a fact.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { doctorVerify } from '../check-fix.ts';

export async function runRulesRegressionDoctor(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  const { runRulesCheck } = await import('../../../core/rules/check.ts');
  const r = await runRulesCheck(engine);
  const failing = [...new Set(r.results.filter(x => !x.pass).map(x => x.rule_id))];
  if (!failing.length) {
    checks.push({ name: 'rules_regression', status: 'ok', message: r.checked ? `Every standing-rule check passed (${r.checked}).` : 'No confirmed standing rules to check (gbrain correct saves one).' });
    return checks;
  }
  checks.push({ name: 'rules_regression', status: 'warn',
    message: `${r.failed} of ${r.checked} standing-rule checks failed (${failing.slice(0, 5).join(', ')}${failing.length > 5 ? ', …' : ''}): search no longer returns the rule or the corrected page, or returns a rejected answer.`,
    details: { failed: r.results.filter(x => !x.pass).slice(0, 20) },
    fix: { argv: ['gbrain', 'rules', 'check', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows each failing check and what is missing; changes nothing.', verify: doctorVerify('rules_regression') } });
  return checks;
}

export const rulesRegressionEntry: DoctorEntry = { name: 'rules_regression', emits: ['rules_regression'], run: runRulesRegressionDoctor };
