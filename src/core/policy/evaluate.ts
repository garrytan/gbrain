/**
 * Evaluate a policy for one outside action. Most specific first: a rule naming the merchant, then
 * a rule with a condition (recipient class or limit), then the verb's plain rule. Within a tier,
 * deny beats ask beats allow. A verb with no rule answers ask. A limit in another currency answers
 * ask (no exchange rates), and an amount over the limit falls through to the next tier. A deny or
 * ask rule whose condition the check leaves out (no recipient class, no amount) answers ask, so
 * leaving a field out never gets a looser answer than the owner set.
 */
import type { AgentVerb, RecipientClass } from '../agent-verbs.ts';
import type { PolicyDecision, PolicyLimit, PolicyRule } from './fence.ts';

export interface PolicyQuery { verb: AgentVerb; amount?: PolicyLimit; merchant?: string; to?: RecipientClass }

export interface PolicyVerdict { decision: PolicyDecision; rule_id: string | null; reason: string }

const RANK: Record<PolicyDecision, number> = { deny: 3, ask: 2, allow: 1 };

function strictest(matches: Array<{ rule: PolicyRule; decision: PolicyDecision; reason: string }>): PolicyVerdict | null {
  if (!matches.length) return null;
  const best = matches.reduce((a, b) => (RANK[b.decision] > RANK[a.decision] ? b : a));
  return { decision: best.decision, rule_id: best.rule.id, reason: best.reason };
}

function limitOutcome(rule: PolicyRule, q: PolicyQuery): { decision: PolicyDecision; reason: string } | null {
  if (!rule.limit) return { decision: rule.decision, reason: 'rule matches' };
  if (!q.amount) return null;
  if (q.amount.currency !== rule.limit.currency) return { decision: 'ask', reason: `the rule's limit is in ${rule.limit.currency} and the amount is in ${q.amount.currency}; gbrain does not convert currencies` };
  return q.amount.amount <= rule.limit.amount ? { decision: rule.decision, reason: `within the ${rule.limit.amount} ${rule.limit.currency} limit` } : null;
}

export function evaluatePolicy(rules: readonly PolicyRule[], q: PolicyQuery): PolicyVerdict {
  const forVerb = rules.filter(r => r.verb === q.verb);
  const merchant = q.merchant?.trim().toLowerCase();
  const tiers: PolicyRule[][] = [
    forVerb.filter(r => r.merchant !== undefined && merchant !== undefined && r.merchant.toLowerCase() === merchant),
    forVerb.filter(r => r.merchant === undefined && (r.when !== undefined || r.limit !== undefined)),
    forVerb.filter(r => r.merchant === undefined && r.when === undefined && r.limit === undefined),
  ];
  for (const tier of tiers) {
    const matches = tier.flatMap(rule => {
      const missing = rule.when !== undefined && q.to === undefined ? 'to' : rule.limit && !q.amount ? 'amount' : null;
      if (missing && rule.decision !== 'allow') return [{ rule, decision: 'ask' as const, reason: `a ${rule.decision} rule depends on ${missing}, and the check did not include it` }];
      if (rule.when !== undefined && rule.when !== q.to) return [];
      const outcome = limitOutcome(rule, q);
      return outcome ? [{ rule, ...outcome }] : [];
    });
    const verdict = strictest(matches);
    if (verdict) return verdict;
  }
  return { decision: 'ask', rule_id: null, reason: `the policy has no rule that covers ${q.verb} here, so the agent asks` };
}

/** Two policies (owner and company) both apply: the stricter answer wins. */
export function stricterVerdict(a: PolicyVerdict, b: PolicyVerdict): PolicyVerdict {
  return RANK[b.decision] > RANK[a.decision] ? b : a;
}
