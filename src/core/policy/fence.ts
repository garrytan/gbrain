/**
 * The `gbrain:policy v1` fence: one rules table in an agent_policy page body. Parsing is strict:
 * an unknown verb, decision, recipient class, window or a malformed limit makes the whole fence
 * malformed, reported with its line and column, and a malformed fence's own rules are never served.
 * The canonical form (renderPolicyFence) is what the approval digest covers.
 */
import { createHash } from 'node:crypto';
import { isAgentVerb, isRecipientClass, type AgentVerb, type RecipientClass } from '../agent-verbs.ts';
import { escapeFenceCell, isSeparatorRow, parseRowCells } from '../fence-shared.ts';

export const POLICY_FENCE_BEGIN = '<!--- gbrain:policy:v1:begin -->';
export const POLICY_FENCE_END = '<!--- gbrain:policy:v1:end -->';
export const POLICY_COLUMNS = ['id', 'verb', 'decision', 'when', 'limit', 'window', 'merchant', 'note'] as const;
export const POLICY_DECISIONS = ['allow', 'ask', 'deny'] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];
/** per_action caps one action; day, week and month are budgets read from the action ledger (UTC; weeks start Monday). */
export const POLICY_WINDOWS = ['per_action', 'day', 'week', 'month'] as const;
export type PolicyWindow = (typeof POLICY_WINDOWS)[number];
const MAX_RULES = 200;
const MAX_CELL = 200;

export interface PolicyLimit { amount: number; currency: string }

export interface PolicyRule {
  id: string;
  verb: AgentVerb;
  decision: PolicyDecision;
  when?: RecipientClass;
  limit?: PolicyLimit;
  window?: PolicyWindow;
  merchant?: string;
  note?: string;
}

export interface PolicyParseError { line: number; column: number; message: string }

export type PolicyParse = { ok: true; rules: PolicyRule[] } | { ok: false; error: PolicyParseError };

/** `60 USD`, `60USD` or `60.50 eur`; the currency is a three-letter code, uppercased. */
export function parseLimit(raw: string): PolicyLimit | null {
  const m = /^\s*(\d+(?:\.\d{1,2})?)\s*([A-Za-z]{3})\s*$/.exec(raw);
  if (!m) return null;
  return { amount: Number(m[1]), currency: m[2]!.toUpperCase() };
}

export function formatLimit(limit: PolicyLimit): string {
  return `${limit.amount} ${limit.currency}`;
}

function lineColumn(body: string, index: number): { line: number; column: number } {
  const before = body.slice(0, index);
  const line = before.split('\n').length;
  return { line, column: index - before.lastIndexOf('\n') };
}

/** Parse the body's policy fence. A body with no fence parses to zero rules (an empty policy, every verb asks). */
export function parsePolicyFence(body: string): PolicyParse & { present: boolean } {
  const begin = body.indexOf(POLICY_FENCE_BEGIN);
  const end = body.indexOf(POLICY_FENCE_END);
  if (begin === -1 && end === -1) {
    const near = body.indexOf('gbrain:policy');
    if (near !== -1) return { ok: false, present: true, error: { ...lineColumn(body, near), message: `found "gbrain:policy" but not the exact markers ${POLICY_FENCE_BEGIN} … ${POLICY_FENCE_END}` } };
    return { ok: true, present: false, rules: [] };
  }
  if (begin === -1 || end === -1 || end < begin) {
    return { ok: false, present: true, error: { ...lineColumn(body, begin === -1 ? end : begin), message: 'the policy fence is missing its begin or end marker' } };
  }
  const innerStart = begin + POLICY_FENCE_BEGIN.length;
  const lines = body.slice(innerStart, end).split('\n');
  const rules: PolicyRule[] = [];
  const ids = new Set<string>();
  let header = false;
  let offset = innerStart;
  for (const text of lines) {
    const at = lineColumn(body, offset);
    offset += text.length + 1;
    if (!text.trim()) continue;
    const fail = (message: string, column = 1): PolicyParse & { present: boolean } => ({ ok: false, present: true, error: { line: at.line, column, message } });
    const cells = parseRowCells(text);
    if (!cells) return fail('expected a table row starting with |');
    if (!header) {
      if (cells.map(c => c.trim().toLowerCase()).join('|') !== POLICY_COLUMNS.join('|')) return fail(`the header row must be | ${POLICY_COLUMNS.join(' | ')} |`);
      header = true;
      continue;
    }
    if (isSeparatorRow(cells)) continue;
    if (cells.length !== POLICY_COLUMNS.length) return fail(`expected ${POLICY_COLUMNS.length} cells, found ${cells.length}`);
    if (rules.length >= MAX_RULES) return fail(`a policy holds at most ${MAX_RULES} rules`);
    const [id, verb, decision, when, limit, window, merchant, note] = cells.map(c => c.trim());
    const col = (i: number) => text.split('|').slice(0, i + 1).join('|').length + 2;
    if (cells.some(c => c.length > MAX_CELL)) return fail(`a cell is longer than ${MAX_CELL} characters`);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id!)) return fail('id must be lowercase letters, digits, - or _ (at most 64)', col(0));
    if (ids.has(id!)) return fail(`rule id ${id} appears twice`, col(0));
    if (!isAgentVerb(verb)) return fail(`unknown verb "${verb}"`, col(1));
    if (!(POLICY_DECISIONS as readonly string[]).includes(decision!)) return fail(`decision must be allow, ask or deny, not "${decision}"`, col(2));
    if (when && !isRecipientClass(when)) return fail(`when must be self, household, known or new, not "${when}"`, col(3));
    const parsedLimit = limit ? parseLimit(limit) : null;
    if (limit && !parsedLimit) return fail(`limit must be an amount and a currency, like 60 USD, not "${limit}"`, col(4));
    if (window && !(POLICY_WINDOWS as readonly string[]).includes(window)) return fail(`window must be per_action, day, week or month, not "${window}"`, col(5));
    if (window && !parsedLimit) return fail('a window needs a limit', col(5));
    ids.add(id!);
    rules.push({
      id: id!, verb, decision: decision as PolicyDecision,
      ...(when ? { when: when as RecipientClass } : {}),
      ...(parsedLimit ? { limit: parsedLimit } : {}),
      ...(window ? { window: window as PolicyWindow } : {}),
      ...(merchant ? { merchant } : {}),
      ...(note ? { note } : {}),
    });
  }
  if (!header && rules.length === 0 && lines.some(l => l.trim())) return { ok: false, present: true, error: { ...lineColumn(body, innerStart), message: 'the policy fence has no header row' } };
  return { ok: true, present: true, rules };
}

/** The canonical fence text for a rule list: what the approval digest covers. */
export function renderPolicyFence(rules: readonly PolicyRule[]): string {
  const row = (cells: string[]) => `| ${cells.join(' | ')} |`;
  return [
    POLICY_FENCE_BEGIN,
    row([...POLICY_COLUMNS]),
    row(POLICY_COLUMNS.map(() => '---')),
    ...rules.map(r => row([r.id, r.verb, r.decision, r.when ?? '', r.limit ? formatLimit(r.limit) : '', r.window ?? '', r.merchant ?? '', r.note ?? ''].map(escapeFenceCell))),
    POLICY_FENCE_END,
  ].join('\n');
}

/** sha256 of the canonical fence: two bodies with the same rules have the same digest. */
export function policyDigest(rules: readonly PolicyRule[]): string {
  return createHash('sha256').update(renderPolicyFence(rules)).digest('hex');
}
