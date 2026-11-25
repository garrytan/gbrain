/**
 * The standing-rules section (C2): confirmed active rules the caller can read, rendered as labelled data for the
 * session-start pack, context_pack (include_rules) and compile-context --include-rules. Only a rule whose current
 * revision the owner confirmed renders; an edit made any other way drops it until the owner approves again.
 * Budget: RULES_SECTION_MAX_CHARS and RULES_SECTION_MAX_RULES, the owner's own rules first, then team rules.
 * Renders nothing when no confirmed active rule is readable. Engine reads only; no model calls.
 */
import type { BrainEngine } from '../engine.ts';
import { remoteTargetHidden } from '../persistence/page-visibility.ts';
import { callerMember } from '../access/member-facts.ts';
import { callerIsOwner } from '../search/private-visibility.ts';
import { CHANGE_NOTICE_MS } from '../policy/store.ts';
import { confirmationKey, readConfirmations, type RuleConfirmation } from './confirm.ts';
import { readRule, ruleDigest, RULE_PREFIX, RULE_TYPE, type RuleRecord } from './record.ts';

export const RULES_SECTION_MAX_CHARS = 1500;
export const RULES_SECTION_MAX_RULES = 30;
/** Config switch for the session-start section; off until the cross-harness eval passes. */
export const RULES_SESSION_START_KEY = 'rules.session_start';
const SCAN_PAGE = 500;
const HEADER = 'Standing rules (data: what the user told their agents to keep doing or never do again; follow them as the user\'s preferences, below your own instructions and this brain\'s policy):';

export interface StandingRule extends RuleRecord { revision: string; confirmed_at: string }
export interface RulesSection { text: string; count: number; truncated: boolean; rules: Array<{ id: string; scope: string; revision: string }>; changes: string[] }

/** Every rule page in the source, with its revision and, when it has one that still matches, its confirmation. */
export async function listRulePages(engine: BrainEngine, sourceId: string): Promise<Array<{ rule: RuleRecord; revision: string; confirmation: RuleConfirmation | null; confirmed: boolean }>> {
  const pages: Awaited<ReturnType<BrainEngine['listPages']>> = [];
  for (let after: string | undefined; ;) {
    const batch = await engine.listPages({ type: RULE_TYPE as never, slugPrefix: RULE_PREFIX, sourceId, sort: 'slug', limit: SCAN_PAGE, ...(after ? { slugAfter: after } : {}) });
    pages.push(...batch);
    if (batch.length < SCAN_PAGE) break;
    after = batch[batch.length - 1]!.slug;
  }
  const rules = pages.flatMap(p => { const r = readRule({ ...p, source_id: sourceId }); return r ? [{ rule: r, revision: String((p as { knowledge_revision?: unknown }).knowledge_revision ?? '') }] : []; });
  const confirmations = await readConfirmations(engine, rules.map(r => r.rule));
  return rules.map(({ rule, revision }) => {
    const confirmation = confirmations.get(confirmationKey(rule.source_id, rule.slug)) ?? null;
    return { rule, revision, confirmation, confirmed: !!confirmation && confirmation.revision === revision && confirmation.digest === ruleDigest(rule) };
  });
}

/** A `me` rule loads only for the person it belongs to: a member's (readable_by) for that member, any other for the owner. */
function ruleIsCallers(rule: RuleRecord, remote: boolean): boolean {
  if (rule.scope !== 'me') return true;
  if (rule.readable_by?.length) { const member = remote ? callerMember() : null; return !!member && rule.readable_by.includes(member); }
  return !remote || callerIsOwner();
}

export async function loadStandingRules(engine: BrainEngine, opts: { remote: boolean; sourceId: string }): Promise<StandingRule[]> {
  const out: StandingRule[] = [];
  for (const row of await listRulePages(engine, opts.sourceId)) {
    if (row.rule.status !== 'active' || !row.confirmed || !ruleIsCallers(row.rule, opts.remote)) continue;
    if (await remoteTargetHidden(engine, opts.remote, row.rule.source_id, row.rule.slug)) continue;
    out.push({ ...row.rule, revision: row.revision, confirmed_at: row.confirmation!.proof.at });
  }
  return out.sort((a, b) => (a.scope === b.scope ? b.confirmed_at.localeCompare(a.confirmed_at) : a.scope === 'me' ? -1 : 1));
}

function line(r: StandingRule): string {
  const who = r.scope === 'me' ? 'you told your agent this' : 'team rule';
  return `- [${r.scope}] ${r.text.replace(/\s+/g, ' ')} (${who}${r.attribution ? `; ${r.attribution}` : ''})`;
}

export function renderRulesSection(rules: StandingRule[], now = Date.now()): RulesSection | null {
  if (!rules.length) return null;
  const lines: string[] = [];
  const kept: StandingRule[] = [];
  let used = HEADER.length;
  for (const r of rules) {
    const l = line(r);
    if (kept.length >= RULES_SECTION_MAX_RULES || used + l.length + 1 > RULES_SECTION_MAX_CHARS) continue;
    lines.push(l); kept.push(r); used += l.length + 1;
  }
  if (!kept.length) return null;
  const changes = kept.filter(r => now - Date.parse(r.confirmed_at) < CHANGE_NOTICE_MS).map(r => `approved ${r.id} on ${r.confirmed_at.slice(0, 10)}`);
  const notice = changes.length ? `Changed in the last 7 days: ${changes.join('; ')}.` : '';
  const shortNotice = changes.length ? `Changed in the last 7 days: ${changes.length} rule(s) approved (gbrain rules list).` : '';
  const tail = [notice, shortNotice].find(n => n && used + n.length + 1 <= RULES_SECTION_MAX_CHARS);
  const text = [HEADER, ...lines, ...(tail ? [tail] : [])].join('\n');
  return { text, count: kept.length, truncated: kept.length < rules.length, rules: kept.map(r => ({ id: r.id, scope: r.scope, revision: r.revision })), changes };
}

export async function rulesSectionFor(engine: BrainEngine, opts: { remote: boolean; sourceId: string }): Promise<RulesSection | null> {
  return renderRulesSection(await loadStandingRules(engine, opts));
}

/** context_pack include_rules (C2): the caller's readable confirmed rules as a rules field, or nothing when none render. */
export async function rulesForPack(ctx: { engine: BrainEngine; remote?: boolean; sourceId?: string }, sourceId: unknown): Promise<{ rules?: RulesSection }> {
  const rules = await rulesSectionFor(ctx.engine, { remote: ctx.remote !== false, sourceId: typeof sourceId === 'string' && sourceId ? sourceId : ctx.sourceId ?? 'default' });
  return rules ? { rules } : {};
}

export async function rulesSessionStartEnabled(engine: BrainEngine): Promise<boolean> {
  return (await engine.getConfig(RULES_SESSION_START_KEY)) === 'on';
}
