/**
 * rules_regression (C2): the keyless check of confirmed active standing rules (gbrain rules check), in every source.
 * ok when no rule is confirmed or every check passes; warn naming the failing rules, with gbrain rules check as the
 * next step. It also notes pages remote writers can no longer change: pages under rules/ that correct did not write
 * and pages of type rule outside rules/ (rule_owner_only). Read-only: nothing here changes a rule or a fact.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { doctorVerify } from '../check-fix.ts';
import type { BrainEngine } from '../../../core/engine.ts';

const NOTE_SCAN = 500;
const NOTE_SHOWN = 20;

/** Pages remote writers are refused on that no correction wrote, up to NOTE_SCAN per source. */
async function ownerOnlyPages(engine: BrainEngine, sourceIds: string[]): Promise<Array<{ source_id: string; slug: string }>> {
  const { isRuleSlug, readRule, RULE_PREFIX, RULE_TYPE } = await import('../../../core/rules/record.ts');
  const out: Array<{ source_id: string; slug: string }> = [];
  for (const sourceId of sourceIds) {
    const [under, typed] = await Promise.all([
      engine.listPages({ slugPrefix: RULE_PREFIX, sourceId, sort: 'slug', limit: NOTE_SCAN, omitBodies: true }),
      engine.listPages({ type: RULE_TYPE as never, sourceId, sort: 'slug', limit: NOTE_SCAN, omitBodies: true }),
    ]);
    const written = (p: (typeof under)[number]) => /^cr-[0-9a-f]{16}$/.test(String(readRule({ ...p, source_id: sourceId })?.receipt ?? ''));
    for (const p of under) if (!written(p)) out.push({ source_id: sourceId, slug: p.slug });
    for (const p of typed) if (!isRuleSlug(p.slug)) out.push({ source_id: sourceId, slug: p.slug });
  }
  return out;
}

export async function runRulesRegressionDoctor(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  const [{ runRulesCheck }, { listSources }] = await Promise.all([import('../../../core/rules/check.ts'), import('../../../core/sources-ops.ts')]);
  const sourceIds = (await listSources(engine)).map(s => s.id);
  const results = [];
  for (const sourceId of sourceIds) results.push(...(await runRulesCheck(engine, { sourceId })).results);
  const checked = results.length;
  const failedRows = results.filter(x => !x.pass);
  const name = (x: { source_id: string; rule_id: string }) => x.source_id === 'default' ? x.rule_id : `${x.source_id}:${x.rule_id}`;
  const failing = [...new Set(failedRows.map(name))];
  const owned = await ownerOnlyPages(engine, sourceIds);
  const note = owned.length
    ? ` ${owned.length} page${owned.length === 1 ? '' : 's'} under rules/ or of type rule that no correction wrote (${owned.slice(0, 3).map(o => o.source_id === 'default' ? o.slug : `${o.source_id}:${o.slug}`).join(', ')}${owned.length > 3 ? ', …' : ''}) now change only on the brain host: remote writers are refused (rule_owner_only).`
    : '';
  const details = owned.length ? { owner_only_pages: owned.slice(0, NOTE_SHOWN), owner_only_count: owned.length } : undefined;
  if (!failing.length) {
    checks.push({ name: 'rules_regression', status: 'ok', message: (checked ? `Every standing-rule check passed (${checked}).` : 'No confirmed standing rules to check (gbrain correct saves one).') + note,
      ...(details ? { details } : {}) });
    return checks;
  }
  const sources = [...new Set(failedRows.map(x => x.source_id))];
  checks.push({ name: 'rules_regression', status: 'warn',
    message: `${failedRows.length} of ${checked} standing-rule checks failed (${failing.slice(0, 5).join(', ')}${failing.length > 5 ? ', …' : ''}): search no longer returns the rule or the corrected page, or returns a rejected answer.${note}`,
    details: { failed: failedRows.slice(0, 20), ...details },
    fix: { argv: ['gbrain', 'rules', 'check', ...(sources.length === 1 && sources[0] !== 'default' ? ['--source', sources[0]!] : []), '--json'], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Shows each failing check and what is missing; changes nothing.', verify: doctorVerify('rules_regression') } });
  return checks;
}

export const rulesRegressionEntry: DoctorEntry = { name: 'rules_regression', emits: ['rules_regression'], run: runRulesRegressionDoctor };
