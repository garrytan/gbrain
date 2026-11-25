/**
 * gbrain rules check (C2): a keyless regression check for confirmed active standing rules. For each check a rule
 * carries ({question, expect[], reject[]}), or the rule's own words when it carries none, a keyword search for the
 * question must return the rule page or the page it corrects in its top RULE_CHECK_TOP results, every expect string
 * must appear in those results' text and no reject string may. No model calls and no embeddings, so it runs on any
 * brain, repo-less included; doctor's rules_regression reads the same result.
 */
import type { BrainEngine } from '../engine.ts';
import { listRulePages } from './section.ts';
import type { RuleRecord } from './record.ts';

export const RULE_CHECK_TOP = 5;

export interface RuleCheckResult {
  rule_id: string;
  question: string;
  pass: boolean;
  problems: string[];
}

export async function checkRule(engine: BrainEngine, rule: RuleRecord): Promise<RuleCheckResult[]> {
  const checks = rule.checks.length ? rule.checks : [{ question: rule.text, expect: [], reject: [] }];
  const out: RuleCheckResult[] = [];
  for (const c of checks) {
    const hits = await engine.searchKeyword(c.question, { limit: RULE_CHECK_TOP, sourceId: rule.source_id } as never);
    const top = hits.slice(0, RULE_CHECK_TOP);
    const text = top.map(h => `${h.title}\n${h.chunk_text}`).join('\n').toLowerCase();
    const problems: string[] = [];
    if (!top.some(h => h.slug === rule.slug || (rule.corrects && h.slug === rule.corrects))) problems.push(`neither the rule nor ${rule.corrects ?? 'the page it corrects'} is in the top ${RULE_CHECK_TOP}`);
    for (const e of c.expect) if (!text.includes(e.toLowerCase())) problems.push(`expected "${e}" is missing`);
    for (const r of c.reject) if (text.includes(r.toLowerCase())) problems.push(`rejected "${r}" is present`);
    out.push({ rule_id: rule.id, question: c.question, pass: problems.length === 0, problems });
  }
  return out;
}

/** Every confirmed active rule's checks (or one rule's, by id). */
export async function runRulesCheck(engine: BrainEngine, opts: { sourceId?: string; id?: string } = {}): Promise<{ checked: number; failed: number; results: RuleCheckResult[] }> {
  const rows = (await listRulePages(engine, opts.sourceId ?? 'default')).filter(r => r.rule.status === 'active' && r.confirmed && (!opts.id || r.rule.id === opts.id));
  const results: RuleCheckResult[] = [];
  for (const row of rows) results.push(...await checkRule(engine, row.rule));
  return { checked: results.length, failed: results.filter(r => !r.pass).length, results };
}
