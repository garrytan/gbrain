/**
 * The correct verb (agent platform C2): one call that saves a standing rule and fixes the fact it corrects, in a
 * fixed order: the rule page is written proposed, then the wrong fact is superseded (remember with replaces) or
 * withdrawn (forget; never purged), then the rule is made active. Each step is its own write with a request_id
 * derived from the receipt, so a replay or a resume never writes twice, and the receipt (config
 * correct.receipt.<id>) says which step was reached: committed, pending (a write still in flight), partial (a step
 * failed or the process stopped), proposed (waiting for the owner) or conflicted (the rule page changed under it).
 * Every receipt that is not finished carries the next action and who takes it, and what has taken effect.
 *
 * Who may do what: the owner (a trusted local caller, or a remote credential bound to the owner) writes active rules
 * at once; they render in the standing-rules section only after the owner confirms that exact revision at a terminal
 * (gbrain correct at a TTY with no agent marker, or gbrain rules approve <id>@<revision>). Any other caller's rule
 * stays proposed and its fact unchanged until the owner approves it. Guests and tool output are refused.
 *
 * Works the same on a repo-less brain: the pages go through the ordinary write path, the receipt and the
 * confirmation live in the database.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { loadConfig } from '../config.ts';
import { initializeLocalPersistence, pageMutationSource, requestPrincipalForContext, submitPageMutation } from '../persistence/page-mutations.ts';
import { refuseGuestSourceWrite } from '../guests/admission.ts';
import { callerIsOwner, currentCallerAccess, privateProvenanceFilterUnderPolicy, resolveExcludePrivatePages, withoutCallerAccess } from '../search/private-visibility.ts';
import { callerMember, factVisibilitySql, memberPageSlug, ownerSpeaksForItself } from '../access/member-facts.ts';
import { projectionEligibleSql } from '../eligibility/sql.ts';
import { resolveReadEligibility } from '../eligibility/policy.ts';
import { ownerReachesFact, readForgetTarget } from '../persistence/forget-prepare.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { writeResponse } from '../persistence/service.ts';
import { throwIfHeld } from '../trust/gate-outcomes.ts';
import { withRegisteredLocalWriter } from '../persistence/identity.ts';
import { withRemoteCaller } from '../remote-caller.ts';

import type { Principal } from '../persistence/model.ts';
import { fallbackSlugify } from '../entities/resolve.ts';
import { parseWriteRequestId } from '../persistence/preconditions.ts';
import { detectInstructionLike } from '../write-gate.ts';
import { confirmOnTerminal, confirmRequiredError, terminalAuthorityProblem, type OwnerProof, type TerminalProbe } from '../policy/authority.ts';
import { withRuleWriter } from './admission.ts';
import { approvalDigest, clearApproval, readApproval, readConfirmations, saveApproval, saveConfirmation, type ApprovedFact, type PendingApproval } from './confirm.ts';
import { isRuleSlug, parseChecks, readRule, renderRulePage, ruleDigest, ruleIdOf, ruleName, ruleSlugOf, RULE_PREFIX, RULE_SCOPES, RULE_TEXT_MAX, type RuleCheck, type RuleScope, type RuleStatus } from './record.ts';

export const RECEIPT_PREFIX = 'correct.receipt.';
export const CORRECT_STEPS = ['rule', 'fact', 'activate'] as const;
export type CorrectStep = typeof CORRECT_STEPS[number];
export type ReceiptState = 'committed' | 'pending' | 'partial' | 'proposed' | 'conflicted';
const REFUSED_FAMILIES = new Set(['override', 'exfiltration', 'credential']);
/** Codes a remote caller may simply retry; anything else stops at the host operator. */
const RETRYABLE = new Set(['write_pending', 'commit_lock_busy', 'owner_unavailable', 'timeout', 'interrupted', 'rule_busy']);
/** Authority refusals of the first write: nothing took effect, so the call fails and leaves no receipt. */
const REFUSED_AT_START = new Set(['permission_denied', 'scope_denied', 'insufficient_scope', 'writer_registration_required', 'source_changed', 'rule_owner_only', 'rule_exists']);

/** `already`: the fact was withdrawn or superseded by another write before this correction's own withdrawal. */
interface StepRecord { state: 'started' | 'committed' | 'pending'; request_id: string; revision?: string; fact_id?: string; contested?: boolean; already?: true; principal?: Principal }

export interface CorrectReceipt {
  receipt_id: string;
  created_at: string;
  principal: string;
  intent: string;
  author: { owner: boolean; member: string | null; client: string };
  source_id: string;
  rule: { slug: string; scope: RuleScope; text: string; corrects: string | null; checks: RuleCheck[]; attribution: string; visibility?: 'private'; readable_by?: string[] };
  fact: { action: 'replace' | 'withdraw' | 'none'; id: string | null; text: string | null; entity: string | null; provenance: string };
  steps: Partial<Record<CorrectStep, StepRecord>>;
  state: ReceiptState;
  step: CorrectStep | null;
  error?: { code: string; message: string };
  confirmed: boolean;
}

export interface CorrectNext { who: 'caller' | 'owner' | 'host_operator'; why: string; argv?: string[]; mcp?: { tool: string; arguments: Record<string, unknown> }; user_message?: string; code?: string }

/** Test seam: runs after a step's write returned and before the receipt records it, where a crash would land. */
export const __correctFaults: { before?: (step: CorrectStep, r: CorrectReceipt) => void | Promise<void>; after?: (step: CorrectStep) => void; claimed?: (r: CorrectReceipt) => void | Promise<void> } = {};

const receiptKey = (id: string) => `${RECEIPT_PREFIX}${id}`;
const digestOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const codeOf = (e: unknown) => !(e instanceof OperationError) ? 'interrupted'
  : (e as { writeError?: unknown }).writeError === 'write_pending' ? 'write_pending' : String((e as OperationError & { canonicalCode?: string }).canonicalCode ?? e.code);

async function readReceipt(engine: BrainEngine, id: string): Promise<CorrectReceipt | null> {
  if (!/^cr-[0-9a-f]{16}$/.test(id)) return null;
  const raw = await engine.getConfig(receiptKey(id));
  if (!raw) return null;
  try { return JSON.parse(raw) as CorrectReceipt; } catch { return null; }
}

/** Finished receipts kept (committed or conflicted); older ones are dropped when a new correction starts, so the config table stays bounded. */
export const RECEIPTS_KEPT = 100;
/** Unfinished receipts (proposed, partial or pending) one remote caller may hold; settling one frees a place. */
export const OPEN_RECEIPTS_PER_PRINCIPAL = 20;
const OPEN_STATES = new Set<ReceiptState>(['proposed', 'partial', 'pending']);

/** Every stored receipt; null for a row that does not parse. */
async function readAllReceipts(engine: BrainEngine): Promise<Array<{ key: string; receipt: CorrectReceipt | null }>> {
  const keys = await engine.listConfigKeys(RECEIPT_PREFIX);
  if (!keys.length) return [];
  return (await engine.getConfigValues(keys)).map(({ key, value }) => {
    try { return { key, receipt: JSON.parse(value) as CorrectReceipt }; } catch { return { key, receipt: null }; }
  });
}

async function pruneReceipts(engine: BrainEngine, rows: Array<{ key: string; receipt: CorrectReceipt | null }>): Promise<void> {
  if (rows.length < RECEIPTS_KEPT) return;
  const finished = rows.flatMap(({ key, receipt: r }) => !r ? [{ key, at: '' }] : (r.state === 'committed' && r.confirmed) || r.state === 'conflicted' ? [{ key, at: r.created_at }] : [])
    .sort((a, b) => a.at.localeCompare(b.at));
  for (const row of finished.slice(0, rows.length - RECEIPTS_KEPT + 1)) await engine.unsetConfig(row.key);
}

/** Claims a config key atomically; false when another call already holds it. */
async function claimConfig(engine: BrainEngine, key: string, value: string): Promise<boolean> {
  return (await engine.executeRaw('INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key', [key, value])).length > 0;
}

/** Drops a claimed key only while it still holds this exact value, so a lease taken over after going stale stays its new holder's. */
async function releaseConfig(engine: BrainEngine, key: string, value: string): Promise<void> {
  await engine.executeRaw('DELETE FROM config WHERE key = $1 AND value = $2', [key, value]);
}

const claimReceipt = (engine: BrainEngine, r: CorrectReceipt) => claimConfig(engine, receiptKey(r.receipt_id), JSON.stringify(r));

export const LEASE_PREFIX = 'correct.lease.';
export const RULE_LEASE_WAIT_MS = 15_000;
/** A lease older than this belongs to a process that stopped, and the next caller takes it over. */
const RULE_LEASE_STALE_MS = 5 * 60_000;

/**
 * One writer per rule page at a time: every step a correction runs (new, replayed, resumed, polled or approved) and
 * every retirement holds this lease, so a retire never lands between an approval's revision check and its fact
 * change, and two corrections choosing the same page never both write it. Database-side, so repo-less brains and
 * separate processes on one brain share it.
 */
async function withRuleLease<T>(engine: BrainEngine, sourceId: string, slug: string, fn: () => Promise<T>): Promise<T> {
  return withLease(engine, `${sourceId}:${slug}`, () => opError('rule_busy', `Another correction, approval or retirement of rule ${ruleIdOf(slug)} is running, so nothing was written.`,
    'Retry in a few seconds; the other call finishes on its own.'), fn);
}

async function withLease<T>(engine: BrainEngine, name: string, busy: () => OperationError, fn: () => Promise<T>): Promise<T> {
  const key = `${LEASE_PREFIX}${name}`;
  const value = JSON.stringify({ token: randomUUID(), at: new Date().toISOString() });
  const deadline = Date.now() + RULE_LEASE_WAIT_MS;
  while (!(await claimConfig(engine, key, value))) {
    const held = await engine.getConfig(key);
    let at = Number.NaN;
    try { at = Date.parse((JSON.parse(held ?? '{}') as { at?: string }).at ?? ''); } catch { at = Number.NaN; }
    if (held && !(Date.now() - at < RULE_LEASE_STALE_MS)) { await releaseConfig(engine, key, held); continue; }
    if (Date.now() > deadline) throw busy();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  try { return await fn(); } finally { await releaseConfig(engine, key, value); }
}

async function saveReceipt(engine: BrainEngine, r: CorrectReceipt): Promise<void> {
  await engine.setConfig(receiptKey(r.receipt_id), JSON.stringify(r));
}

function receiptNotFound(id: string): OperationError {
  return opError('correct_receipt_not_found', `No correction receipt ${String(id).slice(0, 40)} that this connection made.`,
    'Use the receipt_id that correct returned to this same connection; a receipt is read and resumed only by the caller that made it, or on the brain host.');
}

const principalKey = (p: { kind: string; id: string }) => `${p.kind}:${p.id}`;

/** Whose a receipt is: the request principal, and for a call made for an audience (on_behalf_of) that audience too. */
function receiptPrincipal(p: { kind: string; id: string }): string {
  const audience = currentCallerAccess().audience;
  return audience?.length ? `${principalKey(p)}|${[...audience].sort().join(',')}` : principalKey(p);
}

/** Caller text on one line with no control characters, so nothing it holds can redraw the owner's approval prompt. */
const oneLine = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();

const approvedFact = (f: CorrectReceipt['fact']): ApprovedFact | null => f.action === 'none' || !f.id ? null : { action: f.action, id: f.id, text: f.text };
const factLine = (f: ApprovedFact) => `Fact ${f.id}: ${f.action === 'replace' ? `replaced by "${oneLine(f.text ?? '')}"` : 'withdrawn'}`;

/** Owner, member or other; the client label names who saved it ("saved by <client> on <date>"). */
function authorOf(ctx: OperationContext): CorrectReceipt['author'] {
  const local = ctx.remote === false;
  const owner = local || ownerSpeaksForItself(ctx);
  const client = local ? 'gbrain CLI' : oneLine(ctx.auth?.clientName || callerMember() || 'an agent').slice(0, 60);
  return { owner, member: local ? null : callerMember(), client };
}

function refuseOrigin(origin: unknown): void {
  if (origin === undefined || origin === null || origin === 'user_said') return;
  if (origin === 'tool_output' || origin === 'inferred') {
    throw opError('correct_origin_refused', `correct saves what the user said; content_origin ${String(origin)} is refused, so nothing was written.`,
      'Call correct only with the user\'s own correction (content_origin user_said). Save what a tool returned with remember instead.');
  }
  throw opError('invalid_params', 'content_origin must be user_said.', 'Omit content_origin, or pass user_said.');
}

function refuseInstructions(fields: Array<[string, string | null]>): void {
  const hits = detectInstructionLike(fields.filter((f): f is [string, string] => !!f[1]).map(([, v]) => ['body', v] as const)).filter(h => REFUSED_FAMILIES.has(h.family));
  if (!hits.length) return;
  throw opError('correct_instruction_refused', `The correction reads like an instruction to override, exfiltrate or reveal credentials (${[...new Set(hits.map(h => h.family))].join(', ')}), so nothing was written.`,
    'A standing rule says what is true or how the user wants something done; it cannot tell an agent to ignore its instructions, send data out or handle secrets. Rephrase it as the user\'s own preference.');
}

interface CorrectInput {
  rule: string; scope: RuleScope; fact_id: string | null; corrected_fact: string | null; entity: string | null; corrects: string | null;
  checks: RuleCheck[]; provenance: string; request_id: string | null; source_id: string;
}

export function parseCorrectInput(ctx: OperationContext, p: Record<string, unknown>): CorrectInput {
  refuseOrigin(p.content_origin);
  const rule = typeof p.rule === 'string' ? oneLine(p.rule) : '';
  if (!rule) throw opError('invalid_params', 'correct needs rule: the standing rule in the user\'s words.', 'Pass rule, for example "Alice-example is VP Engineering; never call her the CTO."');
  if (rule.length > RULE_TEXT_MAX) throw opError('invalid_params', `rule is ${rule.length} characters; a standing rule is at most ${RULE_TEXT_MAX}.`, 'Shorten it to one sentence.');
  const scope = (p.scope ?? 'me') as RuleScope;
  if (!RULE_SCOPES.includes(scope)) throw opError('invalid_params', 'scope must be me or team.', 'Omit scope for your own rule, or pass team for a rule every agent in this brain follows.');
  const factId = p.fact_id === undefined || p.fact_id === null || p.fact_id === '' ? null : String(p.fact_id).trim();
  if (factId !== null && !/^[1-9][0-9]{0,15}$/.test(factId)) throw opError('invalid_params', `fact_id "${factId.slice(0, 20)}" is not a fact id.`, 'Pass the fact_id that recall or remember returned.');
  if (p.corrected_fact !== undefined && p.corrected_fact !== null && (typeof p.corrected_fact !== 'string' || !oneLine(p.corrected_fact))) {
    throw opError('invalid_params', 'corrected_fact is empty, so nothing was written.', 'Pass the right fact in corrected_fact, or omit corrected_fact to withdraw the wrong fact.');
  }
  const corrected = typeof p.corrected_fact === 'string' ? oneLine(p.corrected_fact).slice(0, 2000) : null;
  if (corrected && !factId) throw opError('invalid_params', 'corrected_fact needs fact_id: the wrong fact it replaces.', 'Pass fact_id from recall, or save a new fact with remember.');
  const entity = typeof p.entity === 'string' && p.entity.trim() ? p.entity.trim().slice(0, 200) : null;
  if (entity && namesRule(entity)) throw opError('invalid_params', `entity ${entity.slice(0, 80)} is a standing rule page; a fact is never written onto a rule.`, 'Pass the page the fact is about (a person, company or topic), or omit entity.');
  const provenance = (typeof p.provenance === 'string' && p.provenance.trim() ? p.provenance.trim() : 'the user\'s correction').slice(0, 500);
  refuseInstructions([['rule', rule], ['corrected_fact', corrected]]);
  return { rule, scope, fact_id: factId, corrected_fact: corrected, entity, corrects: entity, checks: parseChecks(p.checks), provenance,
    request_id: typeof p.request_id === 'string' && p.request_id ? p.request_id.slice(0, 128) : null, source_id: pageMutationSource(ctx, p, 'correct') };
}

/** What the caller can do next, and who does it; null when nothing is left. */
export function nextFor(r: CorrectReceipt, remote: boolean): CorrectNext | null {
  const id = ruleIdOf(r.rule.slug);
  const src = r.source_id && r.source_id !== 'default' ? ['--source', r.source_id] : [];
  const srcText = src.length ? ` ${src.join(' ')}` : '';
  const revision = r.steps.activate?.revision ?? r.steps.rule?.revision ?? '';
  if (r.state === 'pending') return { who: 'caller', why: `The ${r.step} write is accepted and still in flight.`, argv: ['gbrain', 'correct', 'status', r.receipt_id], mcp: { tool: 'correct', arguments: { receipt_id: r.receipt_id } } };
  if (r.state === 'partial') {
    const retry = !remote || RETRYABLE.has(r.error?.code ?? 'interrupted');
    return retry
      ? { who: 'caller', why: `Stopped at the ${r.step} step${r.error ? ` (${r.error.code})` : ''}; resuming repeats only the steps not yet committed.`, argv: ['gbrain', 'correct', 'resume', r.receipt_id], mcp: { tool: 'correct', arguments: { receipt_id: r.receipt_id, resume: true } } }
      : { who: 'host_operator', why: `Stopped at the ${r.step} step (${r.error?.code}); this connection cannot clear that, so the brain host's operator resumes it.`, argv: ['gbrain', 'correct', 'resume', r.receipt_id],
        user_message: `A correction stopped part way. On the brain host, run: gbrain correct resume ${r.receipt_id}` };
  }
  if (r.state === 'proposed') return { who: 'owner', code: 'rule_proposed', why: 'The rule is proposed; the owner approves it, which also fixes the fact.', argv: ['gbrain', 'rules', 'approve', `${id}@${revision}`, ...src],
    user_message: `Your agent proposed a standing rule: "${r.rule.text}". To approve it, run in your own terminal: gbrain rules approve ${id}@${revision}${srcText}` };
  if (r.state === 'conflicted') return { who: 'caller', why: `The rule page changed under the ${r.step} step, so nothing more was written.`, argv: ['gbrain', 'rules', 'show', id, ...src] };
  if (!r.confirmed) return { who: 'owner', code: 'rule_proposed', why: 'The rule is active for retrieval; it joins the standing-rules section once the owner confirms this revision.',
    argv: ['gbrain', 'rules', 'approve', `${id}@${revision}`, ...src], user_message: `To have your agents load "${r.rule.text}" at session start, run in your own terminal: gbrain rules approve ${id}@${revision}${srcText}` };
  return null;
}

export function receiptView(r: CorrectReceipt, remote: boolean): Record<string, unknown> {
  const done = (s: CorrectStep) => r.steps[s]?.state === 'committed';
  return {
    receipt_id: r.receipt_id, state: r.state, ...(r.step && r.state !== 'committed' ? { step: r.step } : {}),
    rule_id: ruleIdOf(r.rule.slug), scope: r.rule.scope,
    revision: r.steps.activate?.revision ?? r.steps.rule?.revision ?? null,
    effect: {
      rule: done('activate') ? 'active' : done('rule') ? 'proposed' : 'none',
      fact: r.fact.action === 'none' ? 'unchanged' : done('fact') ? (r.steps.fact?.already ? 'already_withdrawn' : r.steps.fact?.contested ? 'contested' : r.fact.action === 'replace' ? 'replaced' : 'withdrawn') : r.steps.fact?.state === 'pending' ? 'pending' : 'unchanged',
      ...(r.steps.fact?.fact_id ? { new_fact_id: r.steps.fact.fact_id } : {}),
      standing: done('activate') && r.confirmed,
    },
    confirmed: r.confirmed,
    ...(r.error ? { error: r.error } : {}),
    next: nextFor(r, remote),
  };
}

async function pageRevision(engine: BrainEngine, slug: string, sourceId: string): Promise<string | null> {
  const snap = await engine.readPageSnapshot(slug, { sourceId });
  return snap && !snap.page.deleted_at ? String(snap.revision) : null;
}

/**
 * Who a rule page is for, in a form two copies compare by: its private mark, and for a `me` rule its readers too, which
 * name the member it belongs to. A team rule's readers are left to the write path (GST-4000 tracks its narrowing).
 */
const labelsOf = (scope: RuleScope, visibility: unknown, readers: readonly string[] | null | undefined) =>
  JSON.stringify(scope === 'me' ? [visibility === 'private', [...(readers ?? [])].sort()] : [visibility === 'private']);

/**
 * A committed write is this correction's own fact change: the same operation on the same fact in the same source, with
 * the same words, saved on the fact's own page (`entity`, or none).
 */
function writesFact(own: { operation: string; source_id: string; intent: Record<string, unknown> | null }, fact: CorrectReceipt['fact'], sourceId: string, entity: string | null): boolean {
  const intent = own.intent ?? {};
  if (own.source_id !== sourceId) return false;
  const on = typeof intent.entity_slug === 'string' ? intent.entity_slug.toLowerCase() : null;
  return fact.action === 'replace'
    ? own.operation === 'remember' && intent.fact === fact.text && String(intent.replaces) === fact.id && on === (entity?.toLowerCase() ?? null)
    : own.operation === 'forget' && String(intent.id) === fact.id;
}

/** Runs the steps not yet committed. `owner`: whether this run carries the owner's authority (the fact and activation need it). */
async function advance(ctx: OperationContext, r: CorrectReceipt, owner: boolean, proof: OwnerProof | null, approval: PendingApproval | null = null): Promise<CorrectReceipt> {
  const engine = ctx.engine;
  const persist = async () => {
    await saveReceipt(engine, r);
    if (approval) await saveApproval(engine, r.receipt_id, { ...approval, steps: r.steps });
  };
  const pageFor = (status: RuleStatus) => renderRulePage({ ...r.rule, status, receipt: r.receipt_id });
  for (const step of CORRECT_STEPS) {
    if (r.steps[step]?.state === 'committed') continue;
    if (step === 'fact' && r.fact.action === 'none') { r.steps.fact = { state: 'committed', request_id: '' }; continue; }
    if (step !== 'rule' && !owner) {
      if (r.steps[step]?.state === 'pending' || r.steps[step]?.state === 'started') { r.state = r.steps[step]!.state === 'pending' ? 'pending' : 'partial'; r.step = step; return r; }
      r.state = 'proposed'; r.step = step; await persist(); return r;
    }
    const requestId = `${r.receipt_id}.${step}`;
    const tried = r.steps[step] !== undefined;
    const by = await requestPrincipalForContext(ctx);
    const submittedBy = r.steps[step]?.principal ?? by;
    r.steps[step] = { ...(r.steps[step] ?? {}), state: 'started', request_id: requestId };
    r.state = 'partial'; r.step = step; delete r.error;
    await persist();
    try {
      if (step === 'rule') {
        const snap = tried ? await engine.readPageSnapshot(r.rule.slug, { sourceId: r.source_id }) : null;
        const landed = snap && !snap.page.deleted_at ? readRule({ ...snap.page, source_id: r.source_id }) : null;
        if (landed?.receipt !== r.receipt_id) {
          await __correctFaults.before?.(step, r);
          const now = await engine.readPageSnapshot(r.rule.slug, { sourceId: r.source_id });
          const exists = () => opError('rule_exists', `${ruleIdOf(r.rule.slug)} was written by another call before this correction's first write, so nothing was written.`,
            `Run gbrain rules show ${ruleIdOf(r.rule.slug)}; approve that rule, or save this one with different words.`);
          if (now && !now.page.deleted_at) throw exists();
          await withRuleWriter(() => submitPageMutation(ctx, { operation: 'put_page', params: { slug: r.rule.slug, source_id: r.source_id, content: pageFor('proposed'), request_id: requestId } }))
            .catch(e => { throw codeOf(e) === 'revision_required' ? exists() : e; });
        }
      } else if (step === 'fact') {
        const snap = await engine.readPageSnapshot(r.rule.slug, { sourceId: r.source_id });
        const live = snap && !snap.page.deleted_at ? readRule({ ...snap.page, source_id: r.source_id }) : null;
        if (!live || live.status !== 'proposed' || live.receipt !== r.receipt_id || String(snap!.revision) !== r.steps.rule?.revision) {
          throw new OperationError('rule_transition', 'The rule page changed or was retired before its fact was fixed, so the fact was left unchanged.', `Run gbrain rules show ${ruleIdOf(r.rule.slug)}.`);
        }
        await __correctFaults.before?.(step, r);
        const target = r.fact.action === 'replace' ? await readForgetTarget(engine, Number(r.fact.id), r.source_id, false, false) : null;
        if (r.fact.entity && target && target.entity_slug?.toLowerCase() !== r.fact.entity.toLowerCase()) {
          throw new OperationError('rule_transition', 'The fact is no longer on the page this correction names, so the fact was left unchanged.', `Run gbrain rules show ${ruleIdOf(r.rule.slug)}.`);
        }
        const entity = r.fact.action === 'replace' ? r.fact.entity ?? target?.entity_slug ?? null : null;
        const own = tried ? await getWriteRequest(engine as never, submittedBy, parseWriteRequestId(requestId)!) : null;
        if (own?.state === 'committed' && !writesFact(own, r.fact, r.source_id, entity)) {
          throw new OperationError('rule_transition', 'Another write already used this correction\'s fact request, so the fact was left as it is.', `Run gbrain rules show ${ruleIdOf(r.rule.slug)}.`);
        }
        if (own && !['committed', 'conflict', 'failed', 'cancelled'].includes(own.state)) {
          throw new OperationError('write_pending', 'The write is accepted and is still pending.', 'Read the receipt again with correct {receipt_id}; it finishes the step once the write commits.');
        }
        const gone = tried && r.fact.action === 'withdraw' && own?.state !== 'committed' && !!(await readForgetTarget(engine, Number(r.fact.id), r.source_id, false, false))?.expired_at;
        if (gone) r.steps.fact!.already = true;
        if (own?.state === 'committed') {
          const done = throwIfHeld(writeResponse(own));
          if (done.id !== undefined && done.id !== null) r.steps.fact!.fact_id = String(done.id);
          if (done.contested) r.steps.fact!.contested = true;
        }
        if (own?.state !== 'committed' && !gone) {
        r.steps.fact!.principal = { kind: by.kind, id: by.id };
        await persist();
        const { verbOperations } = await import('../verbs.ts');
        const verb = verbOperations.find(o => o.name === (r.fact.action === 'replace' ? 'remember' : 'forget'))!;
        const out = await verb.handler(ctx, r.fact.action === 'replace'
          ? { fact: r.fact.text, replaces: r.fact.id, provenance: r.fact.provenance, content_origin: 'user_said', source_id: r.source_id, request_id: requestId, ...(entity ? { entity } : { infer_entity: false }) }
          : { id: r.fact.id, reason: `corrected: ${r.rule.text}`.slice(0, 500), source_id: r.source_id, request_id: requestId }) as Record<string, unknown>;
        if (out?.status === 'pending' || out?.state === 'pending') throw new OperationError('write_pending', 'The write is accepted and is still pending.', 'Read the receipt again with correct {receipt_id}; it finishes the step once the write commits.');
        const newId = out?.id;
        if (newId !== undefined) r.steps.fact!.fact_id = String(newId);
        if (out?.contested) r.steps.fact!.contested = true;
        }
      } else {
        await __correctFaults.before?.(step, r);
        const own = tried && r.steps.activate?.principal ? await getWriteRequest(engine as never, r.steps.activate.principal, parseWriteRequestId(requestId)!) : null;
        if (own && (own.operation !== 'put_page' || own.source_id !== r.source_id || own.slug !== r.rule.slug)) {
          throw new OperationError('rule_transition', 'Another write already used this correction\'s activation request, so the rule was left as it is.', `Run gbrain rules show ${ruleIdOf(r.rule.slug)}.`);
        }
        if (own && !['committed', 'conflict', 'failed', 'cancelled'].includes(own.state)) {
          throw new OperationError('write_pending', 'The write is accepted and is still pending.', 'Read the receipt again with correct {receipt_id}; it finishes the step once the write commits.');
        }
        if (own?.state !== 'committed') {
          r.steps.activate!.principal = { kind: by.kind, id: by.id };
          await persist();
          await withRuleWriter(() => submitPageMutation(ctx, { operation: 'put_page', params: { slug: r.rule.slug, source_id: r.source_id, content: pageFor('active'),
            expected_revision: r.steps.rule!.revision, request_id: requestId } }));
        }
      }
      __correctFaults.after?.(step);
    } catch (e) {
      const code = codeOf(e);
      if (step === 'rule' && !tried && REFUSED_AT_START.has(code)) { await engine.unsetConfig(receiptKey(r.receipt_id)); throw e; }
      if (code === 'write_pending') { r.steps[step]!.state = 'pending'; r.state = 'pending'; }
      else if ((step === 'activate' && code === 'revision_conflict') || code === 'rule_transition' || code === 'rule_exists') r.state = 'conflicted';
      else r.state = 'partial';
      r.error = { code, message: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
      await persist();
      return r;
    }
    r.steps[step]!.state = 'committed';
    if (step !== 'fact') r.steps[step]!.revision = (await pageRevision(engine, r.rule.slug, r.source_id)) ?? undefined;
    await persist();
  }
  r.state = 'committed'; r.step = null; delete r.error;
  if (proof && !r.confirmed) {
    const page = await engine.getPage(r.rule.slug, { sourceId: r.source_id });
    const stored = page ? readRule({ ...page, source_id: r.source_id }) : null;
    const fact = approvedFact(r.fact);
    if (stored && stored.status === 'active' && approvalDigest(ruleDigest(stored), fact) === proof.digest && labelsOf(r.rule.scope, page!.frontmatter?.visibility, stored.readable_by) === labelsOf(r.rule.scope, r.rule.visibility, r.rule.readable_by)) {
      await saveConfirmation(engine, { source_id: r.source_id, slug: r.rule.slug, revision: r.steps.activate!.revision!, digest: ruleDigest(stored), ...(fact ? { fact } : {}), proof });
      r.confirmed = true;
    }
  }
  await persist();
  return r;
}

async function chooseSlug(engine: BrainEngine, sourceId: string, scope: RuleScope, text: string, receiptId: string, salt: string): Promise<string> {
  const slug = `${RULE_PREFIX}${scope}/${ruleName(text, salt)}`;
  const snap = await engine.readPageSnapshot(slug, { sourceId });
  if (!snap || snap.page.deleted_at) return slug;
  const existing = readRule({ ...snap.page, source_id: sourceId });
  if (existing && existing.status !== 'retired') {
    throw opError('rule_exists', `A ${existing.status} rule with these words already exists (${existing.id}), so nothing was written.`,
      existing.status === 'proposed' ? `Ask the owner to approve it: gbrain rules approve ${existing.id}@${snap.revision}.` : 'Nothing to do: the rule is already saved.',
      undefined);
  }
  return `${slug}-${receiptId.slice(3, 9)}`;
}

export interface CorrectOptions { probe?: TerminalProbe }

const factNotFound = (id: string) => opError('fact_not_found', `No fact with id "${id}" that this connection can read, so nothing was written.`, 'Pass a fact_id that recall returned to this same connection.');

/**
 * The fact a remote caller names, read under the rules recall and forget apply (visibility, read eligibility, the fact's
 * page and its entity's privacy), with the page it is about from the same read. A member only withdraws a fact on its
 * own member page, never replaces it (`own`), and is never told the page such a fact is about; the owner speaking for
 * itself does either.
 */
async function remoteFact(ctx: OperationContext, id: number, sourceId: string, member: string | null, withdraw: boolean, owner: boolean): Promise<{ entity_slug: string | null; own: boolean } | null> {
  const excludePrivate = await resolveExcludePrivatePages(ctx.engine, true);
  const mine = member ? await readForgetTarget(ctx.engine, id, sourceId, true, excludePrivate, false, memberPageSlug(member)) : null;
  if (mine) return owner ? { entity_slug: mine.entity_slug ?? null, own: false } : withdraw ? { entity_slug: mine.entity_slug ?? null, own: true } : null;
  const readable = !withdraw ? "facts.visibility = 'world'" : callerIsOwner() ? 'TRUE' : factVisibilitySql('facts', ['world']);
  const eligible = projectionEligibleSql('facts', 'facts', await resolveReadEligibility(ctx));
  const provenance = excludePrivate ? ` AND ${privateProvenanceFilterUnderPolicy('facts')}` : '';
  const [row] = await ctx.engine.executeRaw<{ entity_slug: string | null }>(`SELECT entity_slug FROM facts WHERE id=$1 AND source_id=$2 AND ${readable} AND ${eligible}${provenance}`, [id, sourceId]);
  if (row) return { entity_slug: row.entity_slug ?? null, own: false };
  return null;
}

/** An entity that names a standing rule page in any spelling remember would turn into that slug. */
const namesRule = (entity: string) => isRuleSlug(entity) || isRuleSlug(fallbackSlugify(entity.trim()) ?? '');

/**
 * The page a correction's fact is on, which is the page its replacement is saved on: a correction never moves a fact to
 * another page and never infers one. A remote caller names only a fact it reads (the owner speaking for itself also one
 * it reaches); `entity`, when given, must be that page, a fact on no page takes none, and a refusal names the page only
 * to a caller that reads it.
 */
async function factEntity(ctx: OperationContext, factId: string, sourceId: string, entity: string | null, reader: { member: string | null; withdraw: boolean; owner: boolean } | null): Promise<string | null> {
  const id = Number(factId);
  let seen = reader ? await remoteFact(ctx, id, sourceId, reader.member, reader.withdraw, reader.owner) : null;
  if (!seen && (!reader || reader.owner)) {
    const access = currentCallerAccess();
    const reach = !reader || await ownerReachesFact(ctx.engine, id, sourceId, { identity: access.identity, satisfied: access.satisfiedRuleIds });
    const target = reach ? await readForgetTarget(ctx.engine, id, sourceId, !!reader && !reader.withdraw, false) : null;
    if (target) seen = { entity_slug: target.entity_slug ?? null, own: false };
  }
  if (!seen) throw factNotFound(factId);
  const on = seen.entity_slug;
  if (entity === null) return seen.own ? null : on;
  if (on === null) throw opError('invalid_params', `Fact ${factId} is on no entity page, so a correction names no entity for it and nothing was written.`, 'Omit entity.');
  if (on.toLowerCase() === entity.toLowerCase()) return on;
  throw seen.own
    ? opError('invalid_params', `Fact ${factId} is not about ${entity.slice(0, 80)}, so nothing was written.`, 'Omit entity.')
    : opError('invalid_params', `Fact ${factId} is about ${on}, not ${entity.slice(0, 80)}, so nothing was written.`, `Pass entity ${on}, or omit entity.`);
}

/** What the owner approves of a proposal, kept with the approval: a later continuation runs this, never the receipt's copy. */
type ApprovedPayload = Pick<CorrectReceipt, 'source_id' | 'rule' | 'fact'>;
const payloadOf = (r: CorrectReceipt): ApprovedPayload => ({ source_id: r.source_id, rule: r.rule, fact: r.fact });

/** The owner approved this exact proposal: its revision, its words and its fact change. */
function approvalHolds(r: CorrectReceipt, a: PendingApproval | null): a is PendingApproval {
  const p = a?.payload as ApprovedPayload | undefined;
  return !!a && !!p?.rule && !!p.fact && a.revision === r.steps.rule?.revision && p.source_id === r.source_id && p.rule.slug === r.rule.slug && a.rule_digest === ruleDigest(p.rule)
    && a.proof.digest === approvalDigest(a.rule_digest, approvedFact(p.fact)) && (a.proof.method === 'terminal' || a.proof.method === 'owner_session');
}

/**
 * The receipt an approval runs: the approved payload, at the approved revision, with only the progress the approval
 * itself recorded. A fact write the receipt says was submitted before the approval is checked against the write journal.
 */
function approvedRun(r: CorrectReceipt, a: PendingApproval): CorrectReceipt {
  const recorded = (a.steps ?? {}) as CorrectReceipt['steps'];
  const submitted = !recorded.fact && r.author.owner && r.steps.fact?.principal ? { fact: { state: 'started' as const, request_id: `${r.receipt_id}.fact`, principal: r.steps.fact.principal } } : {};
  return { ...r, ...(a.payload as ApprovedPayload), confirmed: false,
    steps: { ...submitted, ...recorded, rule: { state: 'committed', request_id: `${r.receipt_id}.rule`, revision: a.revision } } };
}

/** Runs fn as the brain host's own CLI writer, outside the remote caller's access, remote mark and writer scope. */
const asOwner = <T>(engine: BrainEngine, fn: () => Promise<T>): Promise<T> =>
  withoutCallerAccess(() => withRemoteCaller(false, () => withRegisteredLocalWriter(engine, 'cli', () => fn())));

const changedReceipt = (id: string) => opError('rule_transition', `The correction behind rule ${id} no longer matches what the rule page and the approval show, so nothing was approved.`,
  `Retire it with gbrain rules retire ${id} and save the correction again.`);

/**
 * Runs a stored receipt's remaining steps under its rule's lease, on the receipt as stored once the lease is held. An
 * owner's receipt continues only on the owner's own connection; another member's continues only once the owner has
 * approved it, and then under the owner's authority, so a write left pending by the approval finishes on the next read.
 */
async function continueReceipt(ctx: OperationContext, r: CorrectReceipt, probe?: TerminalProbe): Promise<CorrectReceipt> {
  const foreign = await foreignOnHost(ctx, r);
  if (foreign && r.author.owner) {
    const fact = r.steps.fact?.state !== 'committed' ? approvedFact(r.fact) : null;
    const on = fact ? (await readForgetTarget(ctx.engine, Number(fact.id), r.source_id, false, false))?.entity_slug : null;
    const argv = ['gbrain', 'correct', 'resume', r.receipt_id];
    const bound = approvalDigest(ruleDigest(r.rule), fact);
    const proof = await confirmOnTerminal({ argv, digest: bound, probe, subject: 'correction',
      summary: [`Correction ${r.receipt_id}, saved by ${oneLine(r.author.client)}: rule ${ruleIdOf(r.rule.slug)} (${r.rule.scope}): ${oneLine(r.rule.text)}`,
        `Resuming it on this host makes the rule active${fact ? ` and changes a fact. ${factLine(fact)} (${on ? `on ${on}` : 'on no entity page'})` : ''}`] });
    if (proof.digest !== bound) throw confirmRequiredError(argv, { reason: 'declined' });
  }
  return withRuleLease(ctx.engine, r.source_id, r.rule.slug, async () => {
    const fresh = (await readReceipt(ctx.engine, r.receipt_id)) ?? r;
    if (fresh.state === 'conflicted') return fresh;
    const approval = await readApproval(ctx.engine, fresh.receipt_id);
    if (fresh.source_id === r.source_id && fresh.rule.slug === r.rule.slug && approvalHolds(fresh, approval)) {
      const approved = approvedRun(fresh, approval);
      const done = await asOwner(ctx.engine, () => advance(localRulesCtx(ctx.engine, approved.source_id), approved, true, approval.proof, approval));
      if (done.state === 'committed' || done.state === 'conflicted') await clearApproval(ctx.engine, fresh.receipt_id, approval.proof);
      return done;
    }
    if (foreign && (fresh.author.owner !== r.author.owner || JSON.stringify(payloadOf(fresh)) !== JSON.stringify(payloadOf(r)))) throw changedReceipt(ruleIdOf(r.rule.slug));
    if (foreign && !fresh.author.owner && fresh.steps.rule?.state !== 'committed') {
      const snap = await ctx.engine.readPageSnapshot(fresh.rule.slug, { sourceId: fresh.source_id });
      const landed = snap && !snap.page.deleted_at ? readRule({ ...snap.page, source_id: fresh.source_id }) : null;
      if (landed?.receipt !== fresh.receipt_id) return fresh;
    }
    if (fresh.author.owner) return advance(ctx, fresh, authorOf(ctx).owner, null);
    return advance(ctx, fresh, false, null);
  });
}

/**
 * A receipt the brain host continues for another connection, with no owner approval behind it: the host asks at the
 * terminal before it runs a remote owner's remaining steps, and never writes a member's rule page as itself (it only
 * records a page the member's own call already wrote).
 */
async function foreignOnHost(ctx: OperationContext, r: CorrectReceipt): Promise<boolean> {
  if (ctx.remote !== false) return false;
  await initializeLocalPersistence(ctx);
  return r.principal !== receiptPrincipal(await requestPrincipalForContext(ctx)) && !approvalHolds(r, await readApproval(ctx.engine, r.receipt_id));
}

const intentOf = (i: CorrectInput) => digestOf([i.rule, i.scope, i.fact_id, i.corrected_fact, i.entity, i.checks, i.source_id]);

export async function runCorrect(ctx: OperationContext, p: Record<string, unknown>, opts: CorrectOptions = {}): Promise<Record<string, unknown>> {
  const remote = ctx.remote !== false;
  if (typeof p.receipt_id === 'string' && p.rule === undefined) {
    if (ctx.dryRun) return { dry_run: true, action: 'correct', receipt_id: p.receipt_id };
    return p.resume === true ? resumeCorrect(ctx, p.receipt_id, opts) : correctStatus(ctx, p.receipt_id);
  }
  const input = parseCorrectInput(ctx, p);
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  try {
    await refuseGuestSourceWrite(ctx.engine, input.source_id, () => Promise.resolve(principal), 'correct');
  } catch (e) {
    if (codeOf(e) !== 'source_writer_restricted' && codeOf(e) !== 'guest_page_immutable') throw e;
    throw opError('correct_guest_refused', `Source ${input.source_id} is a guest source; a guest cannot save standing rules or correct facts there. Nothing was written.`,
      'Tell the user what should be corrected; the brain\'s owner saves the rule.', { detail: codeOf(e) });
  }
  const author = authorOf(ctx);
  const meta = ctx.guestChannels?.requestMeta;
  if (currentCallerAccess().audience?.includes('guest') || ctx.guestChannels?.header?.trim() || (!!meta && typeof meta === 'object' && Object.hasOwn(meta, 'guest'))) {
    throw opError('correct_guest_refused', 'This call acts for a guest (an on_behalf_of audience or a guest attribution), and a guest cannot save standing rules or correct facts. Nothing was written.',
      'Tell the user what should be corrected; the brain\'s owner saves the rule.');
  }
  const ownerSubject = !remote || callerIsOwner();
  if (remote && input.scope === 'me' && !ownerSubject && !author.member) {
    throw opError('invalid_params', 'A rule with scope me belongs to one member, and this connection acts for no member, so nothing was written.',
      'Pass scope team, or call with a credential bound to one member.');
  }
  const key = receiptPrincipal(principal);
  let receiptId = `cr-${digestOf([key, input.request_id ?? intentOf(input)]).slice(0, 16)}`;
  const entity = input.fact_id
    ? await factEntity(ctx, input.fact_id, input.source_id, input.entity, remote ? { member: author.member, withdraw: !input.corrected_fact, owner: author.owner } : null)
    : input.entity;
  if (ctx.dryRun) return { dry_run: true, action: 'correct', scope: input.scope, rule: input.rule, fact: input.fact_id ? { action: input.corrected_fact ? 'replace' : 'withdraw', id: input.fact_id, entity } : null };
  const intent = intentOf(input);
  let prior = await readReceipt(ctx.engine, receiptId);
  if (prior && !input.request_id && (prior.state === 'committed' || prior.state === 'conflicted')) { receiptId = `cr-${randomBytes(8).toString('hex')}`; prior = null; }
  if (prior) {
    if (prior.intent !== intent) throw opError('idempotency_conflict', 'The request_id already belongs to a different correction, so nothing was written.', 'Use a new request_id for a new correction.');
    return receiptView(prior.state === 'conflicted' ? prior : await continueReceipt(ctx, prior), remote);
  }
  const underCap = async (stored: Awaited<ReturnType<typeof readAllReceipts>>) => {
    if (remote && stored.filter(({ receipt: r }) => r?.principal?.split('|')[0] === principalKey(principal) && OPEN_STATES.has(r.state)).length >= OPEN_RECEIPTS_PER_PRINCIPAL) {
      throw opError('correct_proposals_capped', `This connection already has ${OPEN_RECEIPTS_PER_PRINCIPAL} corrections waiting (proposed or unfinished), so nothing was written.`,
        'Ask the owner to approve or retire the waiting rules (gbrain rules list shows them), or finish a stopped correction with correct {receipt_id, resume: true}.');
    }
  };
  const stored = await readAllReceipts(ctx.engine);
  await underCap(stored);
  await pruneReceipts(ctx.engine, stored);
  const slug = await chooseSlug(ctx.engine, input.source_id, input.scope, input.rule, receiptId, input.scope === 'me' && !ownerSubject ? (author.member ?? key) : '');
  const fact: ApprovedFact | null = input.fact_id ? { action: input.corrected_fact ? 'replace' : 'withdraw', id: input.fact_id, text: input.corrected_fact } : null;
  const proof = !remote && !terminalAuthorityProblem(opts.probe)
    ? await confirmOnTerminal({ argv: ['gbrain', 'correct'], subject: 'standing rule', digest: approvalDigest(ruleDigest({ slug, scope: input.scope, text: input.rule, corrects: input.corrects, checks: input.checks }), fact), probe: opts.probe,
      summary: [`Standing rule (${input.scope}): ${input.rule}`, ...(fact ? [factLine(fact)] : [])] })
    : null;
  const day = new Date().toISOString().slice(0, 10);
  const member = author.member;
  const receipt: CorrectReceipt = {
    receipt_id: receiptId, created_at: new Date().toISOString(), principal: key, intent, author, source_id: input.source_id,
    rule: { slug, scope: input.scope, text: input.rule, corrects: input.corrects, checks: input.checks, attribution: `saved by ${author.client} on ${day}`,
      ...(input.scope === 'me' ? (ownerSubject ? { visibility: 'private' as const } : member ? { readable_by: [member] } : { visibility: 'private' as const }) : {}) },
    fact: { action: input.fact_id ? (input.corrected_fact ? 'replace' : 'withdraw') : 'none', id: input.fact_id, text: input.corrected_fact, entity, provenance: input.provenance },
    steps: {}, state: 'partial', step: 'rule', confirmed: false,
  };
  const claimed = remote
    ? await withLease(ctx.engine, `@${principalKey(principal)}`, () => opError('rule_busy', 'Another correction from this connection is being saved, so nothing was written.',
      'Retry in a few seconds; the other call finishes on its own.'), async () => { await underCap(await readAllReceipts(ctx.engine)); return claimReceipt(ctx.engine, receipt); })
    : await claimReceipt(ctx.engine, receipt);
  if (!claimed) {
    const held = await readReceipt(ctx.engine, receiptId);
    if (!held || held.intent !== intent) throw opError('idempotency_conflict', 'The request_id already belongs to a different correction, so nothing was written.', 'Use a new request_id for a new correction.');
    return receiptView(held, remote);
  }
  await __correctFaults.claimed?.(receipt);
  try {
    return receiptView(await withRuleLease(ctx.engine, receipt.source_id, slug, async () => {
      const fresh = (await readReceipt(ctx.engine, receiptId)) ?? receipt;
      return fresh.state === 'conflicted' ? fresh : advance(ctx, fresh, author.owner, proof);
    }), remote);
  } catch (e) {
    if (e instanceof OperationError && e.code === 'rule_busy') await releaseConfig(ctx.engine, receiptKey(receiptId), JSON.stringify(receipt));
    throw e;
  }
}

async function ownReceipt(ctx: OperationContext, id: string): Promise<CorrectReceipt> {
  const r = await readReceipt(ctx.engine, id);
  if (!r) throw receiptNotFound(id);
  if (ctx.remote === false) return r;
  if (r.principal !== receiptPrincipal(await requestPrincipalForContext(ctx))) throw receiptNotFound(id);
  return r;
}

export async function correctStatus(ctx: OperationContext, id: string, probe?: TerminalProbe): Promise<Record<string, unknown>> {
  const r = await ownReceipt(ctx, id);
  const approved = (r.state === 'proposed' || r.state === 'partial') && approvalHolds(r, await readApproval(ctx.engine, r.receipt_id));
  if (approved || (r.state === 'pending' && !(r.author.owner && await foreignOnHost(ctx, r)))) return receiptView(await continueReceipt(ctx, r, probe), ctx.remote !== false);
  if (r.state === 'committed' && !r.confirmed) {
    const c = (await readConfirmations(ctx.engine, [{ source_id: r.source_id, slug: r.rule.slug }])).values().next().value;
    if (c && c.revision === r.steps.activate?.revision) { r.confirmed = true; await saveReceipt(ctx.engine, r); }
  }
  return receiptView(r, ctx.remote !== false);
}

export async function resumeCorrect(ctx: OperationContext, id: string, opts: CorrectOptions = {}): Promise<Record<string, unknown>> {
  const r = await ownReceipt(ctx, id);
  if (r.state === 'committed' || r.state === 'proposed' || r.state === 'conflicted') return correctStatus(ctx, id, opts.probe);
  return receiptView(await continueReceipt(ctx, r, opts.probe), ctx.remote !== false);
}

export function localRulesCtx(engine: BrainEngine, sourceId = 'default'): OperationContext {
  return { engine, config: loadConfig() ?? { engine: engine.kind }, remote: false, dryRun: false, sourceId,
    logger: { info: () => {}, warn: (m: string) => console.error(m), error: (m: string) => console.error(m) } } as unknown as OperationContext;
}

function staleRevision(id: string, revision: string, current: string | null): OperationError {
  return opError('rule_revision_stale', `Revision ${revision} is not the current revision of rule ${id}${current ? ` (it is ${current})` : ''}, so nothing was approved.`,
    `Run gbrain rules show ${id} to read the current revision, then approve that one.`);
}

/**
 * Owner approval of <id>@<revision>, bound to that revision's words. A proposed rule saved by correct is finished
 * under the owner's authority (its fact is fixed, then it is made active) and the active revision is confirmed.
 */
export async function approveRule(engine: BrainEngine, ref: string, opts: { sourceId?: string; probe?: TerminalProbe; proof?: (digest: string) => OwnerProof } = {}): Promise<Record<string, unknown>> {
  const at = ref.lastIndexOf('@');
  const id = at > 0 ? ref.slice(0, at) : ref;
  const revision = at > 0 ? ref.slice(at + 1) : '';
  const slug = ruleSlugOf(id);
  if (!slug || !revision) throw opError('invalid_params', `Approve a rule as <id>@<revision>, like me/no-cto-1a2b3c@<revision>; got "${ref.slice(0, 80)}".`, 'gbrain rules list shows each rule\'s id and revision.');
  const sourceId = opts.sourceId ?? 'default';
  const snap = await engine.readPageSnapshot(slug, { sourceId });
  const current = snap && !snap.page.deleted_at ? String(snap.revision) : null;
  if (current !== revision) throw staleRevision(ruleIdOf(slug), revision, current);
  const rule = readRule({ ...snap!.page, source_id: sourceId });
  if (!rule) throw opError('rule_transition', `${slug} is not a well-formed standing rule (type rule with scope, status and rule), so nothing was approved.`, `Run gbrain rules show ${ruleIdOf(slug)}.`);
  if (rule.status === 'retired') throw opError('rule_transition', `Rule ${rule.id} is retired; a retired rule is never revived, so nothing was approved.`, 'Save a new rule with gbrain correct.');
  const digest = ruleDigest(rule);
  const stored = rule.status === 'proposed' && rule.receipt ? await readReceipt(engine, rule.receipt) : null;
  const receipt = stored && stored.rule.slug === slug ? stored : null;
  const fact = receipt ? approvedFact(receipt.fact) : null;
  if (receipt?.fact.entity && namesRule(receipt.fact.entity)) {
    throw opError('invalid_params', `Rule ${rule.id}'s fact change would write onto the standing rule page ${receipt.fact.entity.slice(0, 80)}, so nothing was approved.`,
      'Retire it with gbrain rules retire and save the correction again with the fact\'s own page as entity.');
  }
  if (receipt) {
    const audience = receipt.rule.scope === 'me' ? (receipt.rule.visibility === 'private') !== !!receipt.rule.readable_by?.length : !receipt.rule.visibility && !receipt.rule.readable_by?.length;
    const labels = labelsOf(receipt.rule.scope, receipt.rule.visibility, receipt.rule.readable_by) === labelsOf(rule.scope, snap!.page.frontmatter?.visibility, rule.readable_by);
    if (receipt.source_id !== sourceId || ruleDigest(receipt.rule) !== digest || receipt.rule.attribution !== rule.attribution || !audience || !labels) throw changedReceipt(rule.id);
  }
  const shown = receipt?.rule ?? rule;
  const target = fact ? await readForgetTarget(engine, Number(fact.id), sourceId, false, false) : null;
  if (fact && receipt?.fact.entity && receipt.fact.entity.toLowerCase() !== target?.entity_slug?.toLowerCase()) throw changedReceipt(rule.id);
  const argv = ['gbrain', 'rules', 'approve', `${rule.id}@${revision}`];
  const bound = approvalDigest(digest, fact);
  const proof = opts.proof ? opts.proof(bound) : await confirmOnTerminal({ argv, digest: bound, probe: opts.probe, subject: 'standing rule',
    summary: [`Rule ${rule.id} (${rule.scope}, ${rule.status}): ${oneLine(rule.text)}`, `Saved: ${oneLine(rule.attribution) || 'outside gbrain correct'}`,
      `Applies to: ${shown.scope === 'team' ? 'every agent in this brain' : shown.readable_by?.length ? `the agents of member ${shown.readable_by.map(oneLine).join(', ')}` : 'your own agents'}`,
      ...(rule.corrects ? [`Corrects: ${oneLine(rule.corrects)}`] : []),
      ...(fact ? [`Approving also changes a fact. ${factLine(fact)} (${!target ? 'the fact is not found' : target.entity_slug ? `on ${target.entity_slug}` : 'on no entity page'})`] : []),
      ...(fact?.action === 'replace' && receipt?.fact.entity ? [`The new fact is saved on: ${oneLine(receipt.fact.entity)}`] : [])] });
  if (proof.digest !== bound) throw confirmRequiredError(argv, { reason: 'declined' });
  return withRuleLease(engine, sourceId, slug, async () => {
    const now = await engine.readPageSnapshot(slug, { sourceId });
    const at = now && !now.page.deleted_at ? String(now.revision) : null;
    if (at !== revision) throw staleRevision(rule.id, revision, at);
    const ctx = localRulesCtx(engine, sourceId);
    await initializeLocalPersistence(ctx);
    let finalRevision = revision;
    if (rule.status === 'proposed') {
      const held = receipt ? (await readReceipt(engine, receipt.receipt_id)) ?? receipt : null;
      if (held) {
        if (held.state === 'conflicted') return { approved: false, rule_id: rule.id, receipt: receiptView(held, false) };
        if (JSON.stringify(payloadOf(held)) !== JSON.stringify(payloadOf(receipt!))) throw changedReceipt(rule.id);
        const approval: PendingApproval = { revision, rule_digest: digest, proof, payload: payloadOf(receipt!) };
        await saveApproval(engine, held.receipt_id, approval);
        const done = await advance(ctx, approvedRun(held, approval), true, proof, approval);
        if (done.state === 'committed' || done.state === 'conflicted') await clearApproval(engine, held.receipt_id, proof);
        if (done.state !== 'committed') return { approved: false, rule_id: rule.id, receipt: receiptView(done, false) };
        return { approved: true, rule_id: rule.id, revision: done.steps.activate?.revision ?? null, confirmed: done.confirmed, receipt: receiptView(done, false) };
      }
      const page = renderRulePage({ scope: rule.scope, status: 'active', text: rule.text, corrects: rule.corrects, attribution: rule.attribution, receipt: rule.receipt ?? '', checks: rule.checks,
        ...(snap!.page.frontmatter?.visibility === 'private' ? { visibility: 'private' as const } : {}), ...(rule.readable_by ? { readable_by: rule.readable_by } : {}) });
      await withRuleWriter(() => submitPageMutation(ctx, { operation: 'put_page', params: { slug, source_id: sourceId, content: page, expected_revision: revision } }));
      finalRevision = (await pageRevision(engine, slug, sourceId)) ?? revision;
    }
    await saveConfirmation(engine, { source_id: sourceId, slug, revision: finalRevision, digest, proof });
    const settled = rule.receipt ? await readReceipt(engine, rule.receipt) : null;
    if (settled && settled.rule.slug === slug && settled.state === 'committed' && !settled.confirmed && settled.steps.activate?.revision === finalRevision) {
      settled.confirmed = true;
      await saveReceipt(engine, settled);
    }
    return { approved: true, rule_id: rule.id, revision: finalRevision, confirmed: true };
  });
}

/** Retire a rule (owner, local): it stops rendering at once and is never revived. */
export async function retireRule(engine: BrainEngine, id: string, opts: { sourceId?: string } = {}): Promise<Record<string, unknown>> {
  const slug = ruleSlugOf(id);
  if (!slug) throw opError('invalid_params', `"${id.slice(0, 80)}" is not a rule id (me/<name> or team/<name>).`, 'gbrain rules list shows each rule\'s id.');
  const sourceId = opts.sourceId ?? 'default';
  return withRuleLease(engine, sourceId, slug, () => retireHeld(engine, slug, sourceId));
}

async function retireHeld(engine: BrainEngine, slug: string, sourceId: string): Promise<Record<string, unknown>> {
  const snap = await engine.readPageSnapshot(slug, { sourceId });
  const rule = snap && !snap.page.deleted_at ? readRule({ ...snap.page, source_id: sourceId }) : null;
  if (!rule) throw opError('page_not_found', `No standing rule ${ruleIdOf(slug)}.`, 'gbrain rules list shows each rule\'s id.');
  if (rule.status === 'retired') {
    await settleRetired(engine, rule.receipt, slug);
    return { retired: true, rule_id: rule.id, unchanged: true };
  }
  const fm = snap!.page.frontmatter ?? {};
  const page = renderRulePage({ scope: rule.scope, status: 'retired', text: rule.text, corrects: rule.corrects, attribution: rule.attribution, receipt: rule.receipt ?? '', checks: rule.checks,
    ...(fm.visibility === 'private' ? { visibility: 'private' as const } : {}), ...(rule.readable_by ? { readable_by: rule.readable_by } : {}) });
  const ctx = localRulesCtx(engine, sourceId);
  await initializeLocalPersistence(ctx);
  await withRuleWriter(() => submitPageMutation(ctx, { operation: 'put_page', params: { slug, source_id: sourceId, content: page, expected_revision: String(snap!.revision) } }));
  await settleRetired(engine, rule.receipt, slug);
  return { retired: true, rule_id: rule.id };
}

/** A retired rule's unfinished receipt ends conflicted, so it writes nothing more and no longer counts as waiting. */
async function settleRetired(engine: BrainEngine, receiptId: string | null | undefined, slug: string): Promise<void> {
  const receipt = receiptId ? await readReceipt(engine, receiptId) : null;
  if (receipt && receipt.rule.slug === slug && receipt.state !== 'committed' && receipt.state !== 'conflicted') {
    receipt.state = 'conflicted';
    const submitted = receipt.steps.fact?.state === 'pending' || receipt.steps.fact?.state === 'committed';
    receipt.error = { code: 'rule_transition', message: submitted
      ? 'The owner retired this rule after its fact change was submitted; that change may still commit, and nothing more is written.'
      : 'The owner retired this rule before it was finished, so its fact was left unchanged and nothing more is written.' };
    await saveReceipt(engine, receipt);
    const approval = await readApproval(engine, receipt.receipt_id);
    if (approval) await clearApproval(engine, receipt.receipt_id, approval.proof);
  }
}
