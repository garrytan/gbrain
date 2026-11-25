/**
 * The action ledger store (L2). log_action and policy_reserve write agent_action pages through
 * the page write path as trusted internal writes, after stamping the actor from the call context
 * and computing claim_basis on the server. Reads are trusted internal reads filtered for the
 * caller: the owner, local and unbound callers read every action; a member reads the actions whose
 * readable_by names it (its own, which log_action labels for it and the owner); anyone else reads
 * none. No caller sees a count of actions it cannot read.
 *
 * A reservation is a proposed action with a hold. policy_reserve checks the budget window and
 * writes the hold under one lock, so two agents cannot both spend the last of a cap; log_action
 * with the reservation's action_id settles it, and a hold that outlives HOLD_TTL_MS counts toward
 * nothing and is listed in the digest as unconfirmed.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { sourceScopeOpts } from '../ops/context.ts';
import type { AgentVerb, RecipientClass, SpendPurpose } from '../agent-verbs.ts';
import { submitPageMutation, requestPrincipalForContext } from '../persistence/page-mutations.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { isTerminal } from '../persistence/model.ts';
import { grantedWriteSource, writeGrantRefusal } from '../persistence/write-grant.ts';
import { dumpFrontmatterYaml } from '../data-frontmatter.ts';
import { tryAcquireDbLock } from '../db-lock.ts';
import { normalizeReaders, readersAllow } from '../access/principals.ts';
import { callerAccessRecord, callerIdentities, currentCallerAccess, isPrivatePageForCaller, OWNER_MEMBER_KEY, withoutCallerAccess } from '../search/private-visibility.ts';
import { currentReadMode } from '../access/scope-read.ts';
import { callerScopes, checkPolicy, type PolicyCheckAnswer } from '../policy/check.ts';
import type { PolicyLimit, PolicyRule } from '../policy/fence.ts';
import { ACTION_SOURCE, AGENT_ACTION_TYPE, MAX_SUMMARY, SERVER_STAMPED_KEYS, actionSlug, canTransition, isActionSlug, validateActionFrontmatter,
  type ActionEvidence, type ActionRecord, type ActionStatus, type Approver, type ClaimBasis, type SavedPeriod } from './action.ts';
import type { WindowUsage } from '../policy/evaluate.ts';
import { ledgerTotals, windowStart, windowUsage, type BudgetWindow, type LedgerTotals, type StoredAction } from './totals.ts';
import type { Action } from '../agent-output.ts';

export const HOLD_TTL_MS = 24 * 3600 * 1000;
/** Actions one ledger read scans at most; past it the read is partial and names the narrowing filters. */
export const LEDGER_SCAN_MAX = 5000;
/** The earliest a ledger read reaches back, in days; an older since is clamped to it. */
export const MAX_SINCE_DAYS = 3660;
const RESERVE_LOCK_ID = 'gbrain-ledger-reserve';
const RESERVE_WAIT_MS = 10_000;

export type LedgerReader = { kind: 'brain' } | { kind: 'member'; identities: readonly (readonly string[])[] } | { kind: 'none' };

/** Whose actions this request reads: the same owner test the agent policy uses for the owner's policy. */
export function ledgerReader(remote: boolean, ctx?: Pick<OperationContext, 'remote' | 'sourceId' | 'auth'>): LedgerReader {
  if (!remote) return { kind: 'brain' };
  if (ctx && !readsActionSource(ctx)) return { kind: 'none' };
  if (callerScopes(true).includes('owner')) return { kind: 'brain' };
  if (callerAccessRecord() === null || currentReadMode() === 'scope') return { kind: 'none' };
  const identities = callerIdentities();
  return identities.length && identities.every(i => i.some(p => p.startsWith('member:') || p.startsWith('group:'))) ? { kind: 'member', identities } : { kind: 'none' };
}

/** Whether a remote connection's read grant covers the ledger's source, by the same ladder every read op uses. */
function readsActionSource(ctx: Pick<OperationContext, 'remote' | 'sourceId' | 'auth'>): boolean {
  try {
    const scope = sourceScopeOpts(ctx as OperationContext);
    return scope.sourceIds ? scope.sourceIds.includes(ACTION_SOURCE) : scope.sourceId === undefined || scope.sourceId === ACTION_SOURCE;
  } catch { return false; } // silent-read-ok: a connection with no readable source reads no actions
}

function readable(reader: LedgerReader, frontmatter: unknown): boolean {
  if (reader.kind === 'brain') return true;
  if (reader.kind === 'none' || normalizeReaders(frontmatter) === null) return false;
  return reader.identities.every(identity => readersAllow(frontmatter, identity));
}

/** Who logged it, stamped from the call context and never taken from params. */
export function actorFor(remote: boolean): string {
  if (!remote) return 'owner:local';
  const access = currentCallerAccess();
  if (access.actor) return `member:${access.actor.member}`;
  if (access.owner) return 'owner';
  if (access.audience?.length === 1) return access.audience[0]!;
  const member = access.identity.find(p => p.startsWith('member:'));
  if (member) return member;
  return access.audience?.length ? 'audience' : 'agent';
}

/** A remote caller writes the ledger only when its write grant is the ledger's source, the same rule every remote page write obeys. */
function assertLedgerWriteGrant(ctx: OperationContext, remote: boolean): void {
  if (remote && grantedWriteSource(ctx) !== ACTION_SOURCE) {
    throw writeGrantRefusal(ctx, `The action ledger lives in source ${ACTION_SOURCE}, and this connection may write only to ${grantedWriteSource(ctx)}, so nothing was recorded. Ask the brain host's operator to grant this connection source ${ACTION_SOURCE}, or record it from the brain host's CLI.`);
  }
}

function trustedCtx(ctx: Pick<OperationContext, 'engine' | 'config' | 'logger'>): OperationContext {
  return { engine: ctx.engine, config: ctx.config, remote: false, dryRun: false, sourceId: ACTION_SOURCE, logger: ctx.logger } as unknown as OperationContext;
}

/** The write request id: one per (actor, request_id), so two actors' ids never collide and a replay finds its first write. */
function writeRequestId(actor: string, requestId: string): string {
  const h = createHash('sha256').update(`ledger\n${actor}\n${requestId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function readStored(engine: BrainEngine, slug: string): Promise<{ record: ActionRecord; revision: string; frontmatter: Record<string, unknown> } | null> {
  const page = await withoutCallerAccess(() => engine.getPage(slug, { sourceId: ACTION_SOURCE }));
  if (!page || page.type !== AGENT_ACTION_TYPE) return null;
  const checked = validateActionFrontmatter(page.frontmatter ?? {});
  return checked.ok ? { record: checked.record, revision: String(page.knowledge_revision ?? ''), frontmatter: page.frontmatter } : null;
}

export interface ScanResult { rows: StoredAction[]; partial: boolean; scanned: number }

/** The caller's readable actions with action.at in [since, until), scanning at most LEDGER_SCAN_MAX pages. */
export async function scanActions(engine: BrainEngine, reader: LedgerReader, since: Date, until: Date, max = LEDGER_SCAN_MAX): Promise<ScanResult> {
  const rows: StoredAction[] = [];
  if (reader.kind === 'none') return { rows, partial: false, scanned: 0 };
  let scanned = 0;
  for (let month = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1)); month < until; month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1))) {
    const prefix = `actions/${month.getUTCFullYear()}/${String(month.getUTCMonth() + 1).padStart(2, '0')}/`;
    const pages = await withoutCallerAccess(() => engine.listPages({ type: AGENT_ACTION_TYPE as never, slugPrefix: prefix, sort: 'slug', limit: max + 1 - scanned, sourceId: ACTION_SOURCE }));
    scanned += pages.length;
    if (scanned > max) return { rows, partial: true, scanned };
    for (const page of pages) {
      if (!isActionSlug(page.slug) || !readable(reader, page.frontmatter)) continue;
      const checked = validateActionFrontmatter(page.frontmatter ?? {});
      if (!checked.ok) continue;
      const at = Date.parse(checked.record.action.at);
      if (at >= since.getTime() && at < until.getTime()) rows.push({ slug: page.slug, record: checked.record });
    }
  }
  return { rows, partial: false, scanned };
}

/** Budget usage for windowed rules, from one scan of the caller's readable actions. null: the scan was partial. */
export function usageLookup(engine: BrainEngine, reader: LedgerReader, now: Date, excludeSlug?: string) {
  return async (rules: readonly PolicyRule[], q: { verb: AgentVerb }): Promise<Map<string, WindowUsage | null>> => {
    const out = new Map<string, WindowUsage | null>();
    const windowed = rules.filter(r => r.limit && r.window && r.window !== 'per_action');
    if (!windowed.length) return out;
    if (reader.kind === 'none') {
      for (const r of windowed) out.set(r.id, null);
      return out;
    }
    const earliest = new Date(Math.min(...windowed.map(r => windowStart(r.window as BudgetWindow, now).getTime())));
    const scan = await scanActions(engine, reader, earliest, new Date(now.getTime() + 1));
    const rows = excludeSlug ? scan.rows.filter(row => row.slug !== excludeSlug) : scan.rows;
    for (const r of windowed) {
      out.set(r.id, scan.partial ? null : windowUsage(rows, { verb: q.verb, merchant: r.merchant, currency: r.limit!.currency, since: windowStart(r.window as BudgetWindow, now) }, now));
    }
    return out;
  };
}

export interface EvidenceCheck { ref: string; resolved: boolean }

async function checkEvidence(engine: BrainEngine, reader: LedgerReader, evidence: readonly ActionEvidence[]): Promise<EvidenceCheck[]> {
  return Promise.all(evidence.map(async e => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(e.ref)) return { ref: e.ref, resolved: false };
    const page = await withoutCallerAccess(() => engine.getPage(e.ref.replace(/\.md$/, ''), { sourceId: ACTION_SOURCE }));
    const resolved = !!page && (reader.kind === 'brain' || (readable(reader, page.frontmatter) && !isPrivatePageForCaller(page)));
    return { ref: e.ref, resolved };
  }));
}

export interface LogActionInput {
  verb: AgentVerb;
  status?: ActionStatus;
  summary?: string;
  purpose?: SpendPurpose;
  counterparty?: string;
  harness?: string;
  at?: string;
  currency?: string;
  spent?: number;
  saved?: number;
  saved_period?: SavedPeriod;
  estimated?: boolean;
  minutes_saved?: number;
  evidence?: ActionEvidence[];
  approval_by?: Approver;
  approval_rule?: string;
  policy_revision?: string;
  cost_usd?: number;
  supersedes?: string;
  action_id?: string;
  request_id?: string;
}

export interface LogActionResult { action_id: string; status: ActionStatus; claim_basis: ClaimBasis; evidence: EvidenceCheck[]; replayed: boolean; settled_hold?: boolean }

function invalid(field: string, message: string) {
  return opError('action_invalid', `${message}. Nothing was logged.`, 'Fix the field and call again with the same request_id.', { detail: field });
}

function renderActionPage(fm: Record<string, unknown>, summary: string): string {
  return `---\n${dumpFrontmatterYaml(fm).trimEnd()}\n---\n\n${summary}\n`;
}

async function memberReaders(engine: BrainEngine, actor: string): Promise<string[] | undefined> {
  if (!actor.startsWith('member:')) return undefined;
  const ownerMember = await engine.getConfig(OWNER_MEMBER_KEY);
  return [...new Set([actor.slice('member:'.length), ...(ownerMember ? [ownerMember] : [])])];
}

async function writeAction(ctx: OperationContext, slug: string, fm: Record<string, unknown>, summary: string, requestId: string, expected?: string): Promise<void> {
  await withoutCallerAccess(() => submitPageMutation(trustedCtx(ctx), { operation: 'put_page', params: {
    slug, source_id: ACTION_SOURCE, content: renderActionPage(fm, summary), request_id: requestId, ...(expected ? { expected_revision: expected } : {}) } }));
}

async function priorWrite(ctx: OperationContext, id: string): Promise<string | null> {
  let prior: Awaited<ReturnType<typeof getWriteRequest>> = null;
  try {
    prior = await withoutCallerAccess(async () => getWriteRequest(ctx.engine as never, await requestPrincipalForContext(trustedCtx(ctx)), id));
  } catch { return null; } // silent-read-ok: no local writer registered yet means no earlier write of this request
  if (prior && !isTerminal(prior)) {
    throw opError('write_pending', 'The earlier call with this request_id is still being written, so it was not repeated.', 'Retry in a few seconds with the same request_id.', { retryable: true });
  }
  return prior?.slug ?? null;
}

function moneyOf(input: LogActionInput): ActionRecord['money'] | undefined {
  if (input.spent === undefined && input.saved === undefined) return undefined;
  if (!input.currency) throw invalid('currency', 'An amount needs a currency (a three-letter code like USD)');
  return { currency: input.currency.toUpperCase(), ...(input.spent !== undefined ? { spent: input.spent } : {}), ...(input.saved !== undefined ? { saved: input.saved, saved_period: input.saved_period } : {}),
    ...(input.estimated !== undefined ? { estimated: input.estimated } : {}) };
}

/** log_action: record one outside action, or move a proposed or approved one on (a reservation settles here). */
export async function logAction(ctx: OperationContext, input: LogActionInput, now = new Date()): Promise<LogActionResult> {
  const remote = ctx.remote !== false;
  assertLedgerWriteGrant(ctx, remote);
  const actor = actorFor(remote);
  const reader = ledgerReader(remote, ctx);
  const requestId = input.request_id ?? randomUUID();
  const wid = writeRequestId(actor, requestId);
  const replay = await priorWrite(ctx, wid);
  if (replay) {
    const stored = await readStored(ctx.engine, replay);
    if (stored && ((input.action_id ?? replay) !== replay || (input.action_id === undefined) !== (stored.record.request_id === requestId))) {
      throw opError('idempotency_conflict', `request_id ${requestId} already ${stored.record.request_id === requestId ? 'created' : 'moved'} ${replay}, so this different call was not applied.`,
        'Use a new request_id for each new call; settle a reservation with its action_id and a request_id of its own.');
    }
    if (stored) return { action_id: replay, status: stored.record.action.status, claim_basis: stored.record.claim_basis, evidence: (stored.record.evidence ?? []).map(e => ({ ref: e.ref, resolved: stored.record.claim_basis === 'evidenced' })), replayed: true };
  }
  const existing = input.action_id ? await readStored(ctx.engine, input.action_id) : null;
  if (input.action_id && (!existing || !readable(reader, existing.frontmatter) || (reader.kind !== 'brain' && existing.record.action.actor !== actor))) {
    throw opError('action_not_found', `No action ${input.action_id} that you logged was found, so nothing was changed.`, 'Pass the action_id log_action or policy_reserve returned, or log a new action without action_id.');
  }
  const prior = existing?.record;
  const status = input.status ?? 'done';
  if (prior) {
    if (input.verb !== prior.action.verb) throw invalid('verb', `${input.action_id} is a ${prior.action.verb} action, not ${input.verb}`);
    if (!canTransition(prior.action.status, status) || (prior.action.status === 'done' && status === 'done')) {
      throw opError('action_transition_invalid', `${input.action_id} is ${prior.action.status}; it cannot become ${status}, so nothing was changed.`,
        prior.action.status === 'done' ? 'A done action is never edited: log a new action with supersedes set to its action_id.' : 'Log a new action instead.', { detail: `${prior.action.status}->${status}` });
    }
  }
  const evidence = [...(prior?.evidence ?? []), ...(input.evidence ?? []).filter(e => !(prior?.evidence ?? []).some(p => p.ref === e.ref))];
  const checks = await checkEvidence(ctx.engine, reader, evidence);
  const settledHold: ActionRecord['money'] = prior?.hold && status === 'done' ? { currency: prior.hold.currency, spent: prior.hold.amount, estimated: true } : undefined;
  const money = moneyOf(input) ?? prior?.money ?? settledHold;
  const evidenced = checks.some(c => c.resolved);
  if (money && (money.spent !== undefined || money.saved !== undefined) && !evidenced && money.estimated !== true && status === 'done') {
    throw opError('money_unevidenced', 'An amount was logged with no evidence gbrain could read and without estimated: true, so nothing was logged.',
      'Add evidence (the slug of a page that shows the amount, such as the saved receipt) or pass estimated: true.', { detail: checks.map(c => c.ref).join(', ') || 'no evidence' });
  }
  const at = prior ? prior.action.at : input.at ?? now.toISOString();
  const summary = (input.summary ?? prior?.action.summary ?? '').trim();
  if (!summary) throw invalid('summary', 'summary is required');
  if (summary.length > MAX_SUMMARY) throw invalid('summary', `summary is at most ${MAX_SUMMARY} characters`);
  const claim: ClaimBasis = prior?.claim_basis === 'user_confirmed' ? 'user_confirmed' : evidenced ? 'evidenced' : 'estimated';
  const readers = prior ? (existing!.frontmatter.readable_by as string[] | undefined) : await memberReaders(ctx.engine, actor);
  const keepHold = prior?.hold && (status === 'proposed' || status === 'approved');
  const fm: Record<string, unknown> = {
    type: AGENT_ACTION_TYPE, title: `${input.verb}: ${summary}`.slice(0, 120), visibility: 'private',
    ...(readers?.length ? { readable_by: readers } : {}),
    action: { verb: input.verb, ...(input.purpose ?? prior?.action.purpose ? { purpose: input.purpose ?? prior?.action.purpose } : {}), status, at, summary,
      ...(input.counterparty ?? prior?.action.counterparty ? { counterparty: input.counterparty ?? prior?.action.counterparty } : {}),
      ...(input.harness ?? prior?.action.harness ? { harness: input.harness ?? prior?.action.harness } : {}),
      actor: prior?.action.actor ?? actor },
    ...(money ? { money } : {}),
    ...(input.minutes_saved !== undefined ? { minutes_saved: input.minutes_saved } : prior?.minutes_saved !== undefined ? { minutes_saved: prior.minutes_saved } : {}),
    evidence,
    approval: { by: input.approval_by ?? prior?.approval.by ?? 'none', ...(input.approval_rule ?? prior?.approval.rule ? { rule: input.approval_rule ?? prior?.approval.rule } : {}),
      ...(input.policy_revision ?? prior?.approval.policy_revision ? { policy_revision: input.policy_revision ?? prior?.approval.policy_revision } : {}) },
    ...(input.cost_usd !== undefined ? { cost: { reported: input.cost_usd } } : prior?.cost ? { cost: prior.cost } : {}),
    ...(input.supersedes ?? prior?.supersedes ? { supersedes: input.supersedes ?? prior?.supersedes } : {}),
    claim_basis: claim,
    ...(keepHold ? { hold: prior!.hold } : {}),
    request_id: prior?.request_id ?? requestId,
  };
  const checked = validateActionFrontmatter(fm);
  if (!checked.ok) throw invalid(checked.field, checked.message);
  if (input.supersedes) {
    const target = await readStored(ctx.engine, input.supersedes);
    if (!target || !readable(reader, target.frontmatter) || (reader.kind !== 'brain' && target.record.action.actor !== actor)) {
      throw opError('action_not_found', `No action ${input.supersedes} that you logged was found, so nothing was logged.`, 'Set supersedes to the action_id of an action you logged.');
    }
  }
  const slug = input.action_id ?? actionSlug(new Date(at), actor, requestId);
  await writeAction(ctx, slug, fm, summary, wid, existing?.revision);
  return { action_id: slug, status, claim_basis: claim, evidence: checks, replayed: false, ...(prior?.hold && !keepHold ? { settled_hold: true } : {}) };
}

export interface ReserveInput { verb: AgentVerb; amount: PolicyLimit; merchant?: string; to?: RecipientClass; summary: string; counterparty?: string; harness?: string; purpose?: SpendPurpose; request_id?: string }

export interface ReserveResult extends PolicyCheckAnswer { reservation: { action_id: string; amount: string; expires_at: string } | null; replayed?: boolean }

const reserveChains = new WeakMap<object, Promise<unknown>>();

async function underReserveLock<T>(engine: BrainEngine, fn: () => Promise<T>): Promise<T> {
  const prev = reserveChains.get(engine) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => {
    const deadline = Date.now() + RESERVE_WAIT_MS;
    let lock = await tryAcquireDbLock(engine, RESERVE_LOCK_ID, 1);
    while (!lock && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
      lock = await tryAcquireDbLock(engine, RESERVE_LOCK_ID, 1);
    }
    if (!lock) throw opError('ledger_busy', 'Another budget reservation is being written, so this one was not checked or held.', 'Retry in a few seconds with the same request_id.', { retryable: true });
    try { return await fn(); } finally { await lock.release(); }
  });
  reserveChains.set(engine, run);
  return run;
}

/** policy_reserve: check the policy with its budget windows and hold the amount, under one lock. A deny holds nothing. */
export async function policyReserve(ctx: OperationContext, input: ReserveInput, now = new Date()): Promise<ReserveResult> {
  const remote = ctx.remote !== false;
  assertLedgerWriteGrant(ctx, remote);
  const reader = ledgerReader(remote, ctx);
  return underReserveLock(ctx.engine, async () => {
    const actor = actorFor(remote);
    const requestId = input.request_id ?? randomUUID();
    const replay = await priorWrite(ctx, writeRequestId(actor, requestId));
    const stored = replay ? await readStored(ctx.engine, replay) : null;
    const answer = await checkPolicy(ctx.engine, { verb: input.verb, amount: input.amount, merchant: input.merchant, to: input.to }, callerScopes(remote),
      { usage: usageLookup(ctx.engine, reader, now, stored ? replay! : undefined) });
    if (stored?.record.hold) return { ...answer, reservation: { action_id: replay!, amount: `${stored.record.hold.amount} ${stored.record.hold.currency}`, expires_at: stored.record.hold.expires_at }, replayed: true };
    if (answer.decision === 'deny') return { ...answer, reservation: null };
    const summary = input.summary.trim();
    if (!summary || summary.length > MAX_SUMMARY) throw invalid('summary', `summary is required, at most ${MAX_SUMMARY} characters`);
    const at = now.toISOString();
    const hold = { amount: input.amount.amount, currency: input.amount.currency, expires_at: new Date(now.getTime() + HOLD_TTL_MS).toISOString() };
    const readers = await memberReaders(ctx.engine, actor);
    const fm: Record<string, unknown> = {
      type: AGENT_ACTION_TYPE, title: `${input.verb}: ${summary}`.slice(0, 120), visibility: 'private', ...(readers?.length ? { readable_by: readers } : {}),
      action: { verb: input.verb, ...(input.purpose ? { purpose: input.purpose } : {}), status: 'proposed', at, summary,
        ...(input.counterparty ?? input.merchant ? { counterparty: input.counterparty ?? input.merchant } : {}), ...(input.harness ? { harness: input.harness } : {}), actor },
      evidence: [],
      approval: { by: answer.decision === 'allow' ? 'policy' : 'none', ...(answer.rule_id ? { rule: answer.rule_id } : {}), ...(answer.policy_revision ? { policy_revision: answer.policy_revision } : {}) },
      claim_basis: 'estimated', hold, request_id: requestId,
    };
    const checked = validateActionFrontmatter(fm);
    if (!checked.ok) throw invalid(checked.field, checked.message);
    const slug = actionSlug(now, actor, requestId);
    await writeAction(ctx, slug, fm, summary, writeRequestId(actor, requestId));
    return { ...answer, reservation: { action_id: slug, amount: `${hold.amount} ${hold.currency}`, expires_at: hold.expires_at } };
  });
}

/** gbrain ledger confirm: the owner marks a done action's amounts as confirmed (claim_basis user_confirmed). Local only. */
export async function confirmAction(ctx: OperationContext, slug: string): Promise<{ action_id: string; claim_basis: 'user_confirmed'; unchanged: boolean }> {
  const stored = await readStored(ctx.engine, slug);
  if (!stored) throw opError('action_not_found', `No action ${slug} was found, so nothing was confirmed.`, 'List actions with gbrain ledger --json and pass one action_id.');
  if (stored.record.action.status !== 'done') throw opError('action_transition_invalid', `${slug} is ${stored.record.action.status}; only a done action is confirmed.`, 'Confirm the action after it is logged done.');
  if (stored.record.claim_basis === 'user_confirmed') return { action_id: slug, claim_basis: 'user_confirmed', unchanged: true };
  const fm: Record<string, unknown> = { ...stored.frontmatter, type: AGENT_ACTION_TYPE, claim_basis: 'user_confirmed' };
  for (const key of SERVER_STAMPED_KEYS) delete fm[key];
  await writeAction(ctx, slug, fm, stored.record.action.summary, randomUUID(), stored.revision);
  return { action_id: slug, claim_basis: 'user_confirmed', unchanged: false };
}

export interface LedgerQuery { since: Date; until: Date; verb?: AgentVerb; counterparty?: string; /** Scan bound (default LEDGER_SCAN_MAX). */ max?: number }

export type LedgerReport =
  | { state: 'complete'; scope: 'brain' | 'yours' | 'none'; since: string; until: string; totals: LedgerTotals; note: string }
  | { state: 'partial'; scope: 'brain' | 'yours'; since: string; until: string; totals: null; code: 'ledger_scan_too_large'; scanned: number; fix: Action };

const TOTALS_NOTE = 'Amounts are split by claim basis: evidenced (a readable page backs it, not checked against the amount), user_confirmed (the user ran gbrain ledger confirm) and estimated. minutes_saved is never totalled.';

/** gbrain ledger and the ledger op: totals for a window over the caller's readable actions, or a partial state with the narrowing fix. */
export async function ledgerReport(engine: BrainEngine, reader: LedgerReader, q: LedgerQuery, now = new Date()): Promise<LedgerReport> {
  const scope = reader.kind === 'brain' ? 'brain' : reader.kind === 'member' ? 'yours' : 'none';
  const window = { since: q.since.toISOString(), until: q.until.toISOString() };
  const max = q.max ?? LEDGER_SCAN_MAX;
  const scan = await scanActions(engine, reader, q.since, q.until, max);
  if (scan.partial) {
    const days = Math.max(1, Math.floor((q.until.getTime() - q.since.getTime()) / 86_400_000 / 2));
    return { state: 'partial', scope: scope as 'brain' | 'yours', ...window, totals: null, code: 'ledger_scan_too_large', scanned: scan.scanned,
      fix: { argv: ['gbrain', 'ledger', '--since', `${days}d`, '--json'], mcp: { tool: 'ledger', arguments: { since: `${days}d` } }, consent: [], actor: 'agent', requires_exclusive: false,
        why: `More than ${max} actions fall in this window; a shorter since window fits in one read.` } };
  }
  const party = q.counterparty?.trim().toLowerCase();
  const rows = scan.rows.filter(r => (!q.verb || r.record.action.verb === q.verb) && (!party || r.record.action.counterparty?.trim().toLowerCase() === party));
  return { state: 'complete', scope, ...window, totals: ledgerTotals(rows, now), note: TOTALS_NOTE };
}

/** Parse --since/since: <n>d, or an ISO date. */
export function parseSince(raw: unknown, now: Date): Date | null {
  if (raw === undefined || raw === null || raw === '') return new Date(now.getTime() - 30 * 86_400_000);
  if (typeof raw !== 'string') return null;
  const earliest = now.getTime() - MAX_SINCE_DAYS * 86_400_000;
  const days = /^(\d{1,4})d$/.exec(raw.trim());
  if (days) return new Date(Math.max(earliest, now.getTime() - Number(days[1]) * 86_400_000));
  const t = Date.parse(raw);
  return Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}/.test(raw) ? null : new Date(Math.max(earliest, t));
}

