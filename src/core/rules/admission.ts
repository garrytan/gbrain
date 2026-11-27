/**
 * Write admission for standing rule pages (C2). A remote caller writes a rule only through the correct verb: a
 * put_page, rename or delete naming rules/... and a page declaring type rule anywhere else are refused, the owner's
 * own MCP connections included. Every writer, local sync included, moves a rule's status only along
 * RULE_TRANSITIONS. A trusted local write that did not come through gbrain correct or gbrain rules lands as a
 * revision no confirmation covers, so it is never rendered as a standing rule until the owner approves it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Action } from '../agent-output.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { isRuleSlug, ruleIdOf, RULE_STATUSES, RULE_TRANSITIONS, RULE_TYPE, type RuleStatus } from './record.ts';

const ruleWriter = new AsyncLocalStorage<true>();

/** Runs fn as the correct verb or a gbrain rules command: the only scope a remote rule write is admitted in. */
export function withRuleWriter<T>(fn: () => Promise<T>): Promise<T> {
  return ruleWriter.run(true, fn);
}

export function ruleOwnerOnly(slug: string): OperationError {
  const fix: Action = {
    argv: ['gbrain', 'rules', 'list'], consent: [], actor: 'agent', requires_exclusive: false,
    why: 'Lists the standing rules; a rule changes only through correct or gbrain rules.',
  };
  return opError('rule_owner_only', `${slug} is a standing rule page; it changes only through the correct verb or gbrain rules on the brain host. Nothing was written.`,
    `Save a correction with correct (it writes the rule and fixes the fact together), or ask the user to run gbrain rules retire ${ruleIdOf(slug)} on the brain host to retire it.`, { fix });
}

/** C2: no fact writer, local or remote, lands a fact on a standing rule page; only correct and gbrain rules write one. */
export function refuseRuleFactTarget(...slugs: unknown[]): void {
  const rule = slugs.find(isRuleSlug);
  if (rule !== undefined) throw ruleOwnerOnly(String(rule));
}

/** C2: an automatic fact writer's entity that resolves to a standing rule page is no entity; the fact is kept unlinked. */
export function offRulePage<T extends { slug: string }>(resolved: T | null): T | null {
  return resolved && isRuleSlug(resolved.slug) ? null : resolved;
}

/** Before anything is journaled: a remote write naming a rule slug outside the correct verb. */
export function assertRuleSlugWrite(remote: boolean, params: Record<string, unknown>): void {
  if (!remote || ruleWriter.getStore()) return;
  for (const key of ['slug', 'new_slug', 'to_slug', 'target_slug']) {
    if (isRuleSlug(params[key])) throw ruleOwnerOnly(String(params[key]));
  }
}

/** At preparation: a remote page that is, or would become, a rule outside rules/ (correct only ever writes under it). */
export function admitRuleFrontmatter(remote: boolean, slug: string, page: { type?: unknown; frontmatter: Record<string, unknown> }, storedType: unknown): void {
  if (!remote) return;
  const rule = page.type === RULE_TYPE || page.frontmatter.type === RULE_TYPE || storedType === RULE_TYPE;
  if (rule && !isRuleSlug(slug)) throw ruleOwnerOnly(slug);
}

function transitionError(slug: string, from: string, to: string): OperationError {
  return opError('rule_transition', `${slug} cannot move from ${from} to ${to}: a standing rule goes proposed → active → retired and never back. Nothing was written.`,
    'Save a new rule with correct instead of reviving a retired one.', { fix: { argv: ['gbrain', 'rules', 'show', slug], consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the rule as stored; changes nothing.' } });
}

/**
 * Every writer (put_page, sync, import): a standing rule never moves backwards (a retired rule never becomes active
 * again). A page of type rule with no standing-rule status is an ordinary rule page and is admitted as before; a
 * write that drops a rule's status or type only takes it out of the standing rules, which is always safe.
 */
export function ruleWriteAdmission(slug: string, parsed: { type?: unknown; frontmatter: Record<string, unknown> }, existing: { type?: unknown; frontmatter?: Record<string, unknown> | null; deleted_at?: unknown } | null): void {
  if (!isRuleSlug(slug)) return;
  const live = existing && !existing.deleted_at ? existing : null;
  const status = (v: unknown): RuleStatus | null => (RULE_STATUSES as readonly unknown[]).includes(v) ? v as RuleStatus : null;
  const from = live?.type === RULE_TYPE ? status(live.frontmatter?.status) : null;
  const to = parsed.type === RULE_TYPE ? status(parsed.frontmatter.status) : null;
  if (from && to && to !== from && !RULE_TRANSITIONS[from].includes(to)) throw transitionError(slug, from, to);
}
