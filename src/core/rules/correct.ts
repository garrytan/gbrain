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
import { createHash, randomBytes } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { loadConfig } from '../config.ts';
import { initializeLocalPersistence, pageMutationSource, requestPrincipalForContext, submitPageMutation } from '../persistence/page-mutations.ts';
import { refuseGuestSourceWrite } from '../guests/admission.ts';
import { callerIsOwner, resolveExcludePrivatePages } from '../search/private-visibility.ts';
import { callerMember, memberPageSlug } from '../access/member-facts.ts';
import { readForgetTarget } from '../persistence/forget-prepare.ts';
import { detectInstructionLike } from '../write-gate.ts';
import { confirmOnTerminal, confirmRequiredError, terminalAuthorityProblem, type OwnerProof, type TerminalProbe } from '../policy/authority.ts';
import { withRuleWriter } from './admission.ts';
import { approvalDigest, readConfirmations, saveConfirmation, type ApprovedFact } from './confirm.ts';
import { parseChecks, readRule, renderRulePage, ruleDigest, ruleIdOf, ruleName, ruleSlugOf, RULE_PREFIX, RULE_SCOPES, RULE_TEXT_MAX, type RuleCheck, type RuleScope, type RuleStatus } from './record.ts';

export const RECEIPT_PREFIX = 'correct.receipt.';
export const CORRECT_STEPS = ['rule', 'fact', 'activate'] as const;
export type CorrectStep = typeof CORRECT_STEPS[number];
export type ReceiptState = 'committed' | 'pending' | 'partial' | 'proposed' | 'conflicted';
const REFUSED_FAMILIES = new Set(['override', 'exfiltration', 'credential']);
/** Codes a remote caller may simply retry; anything else stops at the host operator. */
const RETRYABLE = new Set(['write_pending', 'commit_lock_busy', 'owner_unavailable', 'timeout', 'interrupted']);
/** Authority refusals of the first write: nothing took effect, so the call fails and leaves no receipt. */
const REFUSED_AT_START = new Set(['permission_denied', 'scope_denied', 'insufficient_scope', 'writer_registration_required', 'source_changed', 'rule_owner_only']);

interface StepRecord { state: 'started' | 'committed' | 'pending'; request_id: string; revision?: string; fact_id?: string; contested?: boolean }

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
export const __correctFaults: { after?: (step: CorrectStep) => void } = {};

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

async function pruneReceipts(engine: BrainEngine): Promise<void> {
  const keys = await engine.listConfigKeys(RECEIPT_PREFIX);
  if (keys.length < RECEIPTS_KEPT) return;
  const finished = (await engine.getConfigValues(keys)).flatMap(({ key, value }) => {
    try { const r = JSON.parse(value) as CorrectReceipt; return r.state === 'committed' || r.state === 'conflicted' ? [{ key, at: r.created_at }] : []; } catch { return [{ key, at: '' }]; }
  }).sort((a, b) => a.at.localeCompare(b.at));
  for (const row of finished.slice(0, keys.length - RECEIPTS_KEPT + 1)) await engine.unsetConfig(row.key);
}

async function saveReceipt(engine: BrainEngine, r: CorrectReceipt): Promise<void> {
  await engine.setConfig(receiptKey(r.receipt_id), JSON.stringify(r));
}

function receiptNotFound(id: string): OperationError {
  return opError('correct_receipt_not_found', `No correction receipt ${String(id).slice(0, 40)} that this connection made.`,
    'Use the receipt_id that correct returned to this same connection; a receipt is read and resumed only by the caller that made it, or on the brain host.');
}

const principalKey = (p: { kind: string; id: string }) => `${p.kind}:${p.id}`;

const approvedFact = (f: CorrectReceipt['fact']): ApprovedFact | null => f.action === 'none' || !f.id ? null : { action: f.action, id: f.id, text: f.text };
const factLine = (f: ApprovedFact) => `Fact ${f.id}: ${f.action === 'replace' ? `replaced by "${f.text}"` : 'withdrawn'}`;

/** Owner, member or other; the client label names who saved it ("saved by <client> on <date>"). */
function authorOf(ctx: OperationContext): CorrectReceipt['author'] {
  const local = ctx.remote === false;
  const owner = local || callerIsOwner();
  const client = local ? 'gbrain CLI' : (ctx.auth?.clientName || callerMember() || 'an agent').slice(0, 60);
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
  const rule = typeof p.rule === 'string' ? p.rule.replace(/\s+/g, ' ').trim() : '';
  if (!rule) throw opError('invalid_params', 'correct needs rule: the standing rule in the user\'s words.', 'Pass rule, for example "Alice-example is VP Engineering; never call her the CTO."');
  if (rule.length > RULE_TEXT_MAX) throw opError('invalid_params', `rule is ${rule.length} characters; a standing rule is at most ${RULE_TEXT_MAX}.`, 'Shorten it to one sentence.');
  const scope = (p.scope ?? 'me') as RuleScope;
  if (!RULE_SCOPES.includes(scope)) throw opError('invalid_params', 'scope must be me or team.', 'Omit scope for your own rule, or pass team for a rule every agent in this brain follows.');
  const factId = p.fact_id === undefined || p.fact_id === null || p.fact_id === '' ? null : String(p.fact_id).trim();
  if (factId !== null && !/^[1-9][0-9]{0,15}$/.test(factId)) throw opError('invalid_params', `fact_id "${factId.slice(0, 20)}" is not a fact id.`, 'Pass the fact_id that recall or remember returned.');
  if (p.corrected_fact !== undefined && p.corrected_fact !== null && (typeof p.corrected_fact !== 'string' || !p.corrected_fact.trim())) {
    throw opError('invalid_params', 'corrected_fact is empty, so nothing was written.', 'Pass the right fact in corrected_fact, or omit corrected_fact to withdraw the wrong fact.');
  }
  const corrected = typeof p.corrected_fact === 'string' ? p.corrected_fact.trim().slice(0, 2000) : null;
  if (corrected && !factId) throw opError('invalid_params', 'corrected_fact needs fact_id: the wrong fact it replaces.', 'Pass fact_id from recall, or save a new fact with remember.');
  const entity = typeof p.entity === 'string' && p.entity.trim() ? p.entity.trim().slice(0, 200) : null;
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
      fact: r.fact.action === 'none' ? 'unchanged' : done('fact') ? (r.steps.fact?.contested ? 'contested' : r.fact.action === 'replace' ? 'replaced' : 'withdrawn') : r.steps.fact?.state === 'pending' ? 'pending' : 'unchanged',
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

/** Runs the steps not yet committed. `owner`: whether this run carries the owner's authority (the fact and activation need it). */
async function advance(ctx: OperationContext, r: CorrectReceipt, owner: boolean, proof: OwnerProof | null): Promise<CorrectReceipt> {
  const engine = ctx.engine;
  const pageFor = (status: RuleStatus) => renderRulePage({ ...r.rule, status, receipt: r.receipt_id });
  for (const step of CORRECT_STEPS) {
    if (r.steps[step]?.state === 'committed') continue;
    if (step === 'fact' && r.fact.action === 'none') { r.steps.fact = { state: 'committed', request_id: '' }; continue; }
    if (step !== 'rule' && !owner) { r.state = 'proposed'; r.step = step; await saveReceipt(engine, r); return r; }
    const requestId = `${r.receipt_id}.${step}`;
    const tried = r.steps[step] !== undefined;
    r.steps[step] = { ...(r.steps[step] ?? {}), state: 'started', request_id: requestId };
    r.state = 'partial'; r.step = step; delete r.error;
    await saveReceipt(engine, r);
    try {
      if (step === 'rule') {
        await withRuleWriter(() => submitPageMutation(ctx, { operation: 'put_page', params: { slug: r.rule.slug, source_id: r.source_id, content: pageFor('proposed'), request_id: requestId } }));
      } else if (step === 'fact') {
        const snap = await engine.readPageSnapshot(r.rule.slug, { sourceId: r.source_id });
        const live = snap && !snap.page.deleted_at ? readRule({ ...snap.page, source_id: r.source_id }) : null;
        if (!live || live.status !== 'proposed' || String(snap!.revision) !== r.steps.rule?.revision) {
          throw new OperationError('rule_transition', 'The rule page changed or was retired before its fact was fixed, so the fact was left unchanged.', `Run gbrain rules show ${ruleIdOf(r.rule.slug)}.`);
        }
        if (tried && (await readForgetTarget(engine, Number(r.fact.id), r.source_id, false, false))?.expired_at) { r.steps.fact!.state = 'committed'; r.steps.fact!.request_id = requestId; }
        else {
        const { verbOperations } = await import('../verbs.ts');
        const verb = verbOperations.find(o => o.name === (r.fact.action === 'replace' ? 'remember' : 'forget'))!;
        const out = await verb.handler(ctx, r.fact.action === 'replace'
          ? { fact: r.fact.text, replaces: r.fact.id, provenance: r.fact.provenance, content_origin: 'user_said', source_id: r.source_id, request_id: requestId, ...(r.fact.entity ? { entity: r.fact.entity } : {}) }
          : { id: r.fact.id, reason: `corrected: ${r.rule.text}`.slice(0, 500), source_id: r.source_id, request_id: requestId }) as Record<string, unknown>;
        if (out?.status === 'pending' || out?.state === 'pending') throw new OperationError('write_pending', 'The write is accepted and is still pending.', 'Read the receipt again with correct {receipt_id}; it finishes the step once the write commits.');
        const newId = out?.id;
        if (newId !== undefined) r.steps.fact!.fact_id = String(newId);
        if (out?.contested) r.steps.fact!.contested = true;
        }
      } else {
        await withRuleWriter(() => submitPageMutation(ctx, { operation: 'put_page', params: { slug: r.rule.slug, source_id: r.source_id, content: pageFor('active'),
          expected_revision: r.steps.rule!.revision, request_id: requestId } }));
      }
      __correctFaults.after?.(step);
    } catch (e) {
      const code = codeOf(e);
      if (step === 'rule' && !tried && REFUSED_AT_START.has(code)) { await engine.unsetConfig(receiptKey(r.receipt_id)); throw e; }
      if (code === 'write_pending') { r.steps[step]!.state = 'pending'; r.state = 'pending'; }
      else if ((step === 'activate' && code === 'revision_conflict') || code === 'rule_transition') r.state = 'conflicted';
      else r.state = 'partial';
      r.error = { code, message: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
      await saveReceipt(engine, r);
      return r;
    }
    r.steps[step]!.state = 'committed';
    if (step !== 'fact') r.steps[step]!.revision = (await pageRevision(engine, r.rule.slug, r.source_id)) ?? undefined;
    await saveReceipt(engine, r);
  }
  r.state = 'committed'; r.step = null; delete r.error;
  if (proof && !r.confirmed) {
    const stored = readRule({ ...(await engine.getPage(r.rule.slug, { sourceId: r.source_id }))!, source_id: r.source_id });
    const fact = approvedFact(r.fact);
    if (stored && stored.status === 'active' && approvalDigest(ruleDigest(stored), fact) === proof.digest) {
      await saveConfirmation(engine, { source_id: r.source_id, slug: r.rule.slug, revision: r.steps.activate!.revision!, digest: ruleDigest(stored), ...(fact ? { fact } : {}), proof });
      r.confirmed = true;
    }
  }
  await saveReceipt(engine, r);
  return r;
}

async function chooseSlug(engine: BrainEngine, sourceId: string, scope: RuleScope, text: string, receiptId: string, salt: string): Promise<string> {
  const slug = `${RULE_PREFIX}${scope}/${ruleName(text, salt)}`;
  const snap = await engine.readPageSnapshot(slug, { sourceId });
  if (!snap || snap.page.deleted_at) return slug;
  const existing = readRule({ ...snap.page, source_id: sourceId });
  if (existing && existing.status !== 'retired' && existing.receipt !== receiptId) {
    throw opError('rule_exists', `A ${existing.status} rule with these words already exists (${existing.id}), so nothing was written.`,
      existing.status === 'proposed' ? `Ask the owner to approve it: gbrain rules approve ${existing.id}@${snap.revision}.` : 'Nothing to do: the rule is already saved.',
      undefined);
  }
  return `${slug}-${receiptId.slice(3, 9)}`;
}

export interface CorrectOptions { probe?: TerminalProbe }

/** A non-owner names only a fact it reads: a world fact, or one on its own member page. The owner's approval runs the fact step. */
async function callerReadsFact(engine: BrainEngine, id: number, sourceId: string, member: string | null): Promise<boolean> {
  const excludePrivate = await resolveExcludePrivatePages(engine, true);
  if (await readForgetTarget(engine, id, sourceId, true, excludePrivate)) return true;
  return !!member && !!(await readForgetTarget(engine, id, sourceId, true, excludePrivate, false, memberPageSlug(member)));
}

const intentOf = (i: CorrectInput) => digestOf([i.rule, i.scope, i.fact_id, i.corrected_fact, i.entity, i.checks, i.source_id]);

export async function runCorrect(ctx: OperationContext, p: Record<string, unknown>, opts: CorrectOptions = {}): Promise<Record<string, unknown>> {
  const remote = ctx.remote !== false;
  if (typeof p.receipt_id === 'string' && p.rule === undefined) return p.resume === true ? resumeCorrect(ctx, p.receipt_id, opts) : correctStatus(ctx, p.receipt_id);
  const input = parseCorrectInput(ctx, p);
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  try {
    await refuseGuestSourceWrite(ctx.engine, input.source_id, () => Promise.resolve(principal), 'correct');
  } catch (e) {
    throw opError('correct_guest_refused', `Source ${input.source_id} is a guest source; a guest cannot save standing rules or correct facts there. Nothing was written.`,
      'Tell the user what should be corrected; the brain\'s owner saves the rule.', { detail: codeOf(e) });
  }
  const key = principalKey(principal);
  let receiptId = `cr-${digestOf([key, input.request_id ?? intentOf(input)]).slice(0, 16)}`;
  const author = authorOf(ctx);
  if (input.fact_id && !author.owner && !(await callerReadsFact(ctx.engine, Number(input.fact_id), input.source_id, author.member))) {
    throw opError('fact_not_found', `No fact with id "${input.fact_id}" that this connection can read, so nothing was written.`, 'Pass a fact_id that recall returned to this same connection.');
  }
  const intent = intentOf(input);
  let prior = await readReceipt(ctx.engine, receiptId);
  if (prior && !input.request_id && prior.state === 'committed') { receiptId = `cr-${randomBytes(8).toString('hex')}`; prior = null; }
  if (prior) {
    if (prior.intent !== intent) throw opError('idempotency_conflict', 'The request_id already belongs to a different correction, so nothing was written.', 'Use a new request_id for a new correction.');
    return receiptView(prior.state === 'conflicted' ? prior : await advance(ctx, prior, author.owner, null), remote);
  }
  await pruneReceipts(ctx.engine);
  const slug = await chooseSlug(ctx.engine, input.source_id, input.scope, input.rule, receiptId, input.scope === 'me' && !author.owner ? (author.member ?? key) : '');
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
      ...(input.scope === 'me' ? (author.owner ? { visibility: 'private' as const } : member ? { readable_by: [member] } : { visibility: 'private' as const }) : {}) },
    fact: { action: input.fact_id ? (input.corrected_fact ? 'replace' : 'withdraw') : 'none', id: input.fact_id, text: input.corrected_fact, entity: input.entity, provenance: input.provenance },
    steps: {}, state: 'partial', step: 'rule', confirmed: false,
  };
  return receiptView(await advance(ctx, receipt, author.owner, proof), remote);
}

async function ownReceipt(ctx: OperationContext, id: string): Promise<CorrectReceipt> {
  const r = await readReceipt(ctx.engine, id);
  if (!r) throw receiptNotFound(id);
  if (ctx.remote === false) return r;
  if (r.principal !== principalKey(await requestPrincipalForContext(ctx))) throw receiptNotFound(id);
  return r;
}

export async function correctStatus(ctx: OperationContext, id: string): Promise<Record<string, unknown>> {
  const r = await ownReceipt(ctx, id);
  if (r.state === 'pending') return receiptView(await advance(ctx, r, authorOf(ctx).owner, null), ctx.remote !== false);
  if (r.state === 'committed' && !r.confirmed) {
    const c = (await readConfirmations(ctx.engine, [{ source_id: r.source_id, slug: r.rule.slug }])).values().next().value;
    if (c && c.revision === r.steps.activate?.revision) { r.confirmed = true; await saveReceipt(ctx.engine, r); }
  }
  return receiptView(r, ctx.remote !== false);
}

export async function resumeCorrect(ctx: OperationContext, id: string, _opts: CorrectOptions = {}): Promise<Record<string, unknown>> {
  const r = await ownReceipt(ctx, id);
  if (r.state === 'committed' || r.state === 'proposed' || r.state === 'conflicted') return correctStatus(ctx, id);
  return receiptView(await advance(ctx, r, authorOf(ctx).owner, null), ctx.remote !== false);
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
  const argv = ['gbrain', 'rules', 'approve', `${rule.id}@${revision}`];
  const bound = approvalDigest(digest, fact);
  const proof = opts.proof ? opts.proof(bound) : await confirmOnTerminal({ argv, digest: bound, probe: opts.probe, subject: 'standing rule',
    summary: [`Rule ${rule.id} (${rule.scope}, ${rule.status}): ${rule.text}`, `Saved: ${rule.attribution || 'outside gbrain correct'}`,
      `Applies to: ${rule.scope === 'team' ? 'every agent in this brain' : rule.readable_by?.length ? `the agents of member ${rule.readable_by.join(', ')}` : 'your own agents'}`,
      ...(fact ? [`Approving also changes a fact. ${factLine(fact)} (on ${(await readForgetTarget(engine, Number(fact.id), sourceId, false, false))?.entity_slug ?? 'no page; the fact is not found'})`] : [])] });
  if (proof.digest !== bound) throw confirmRequiredError(argv, { reason: 'declined' });
  const ctx = localRulesCtx(engine, sourceId);
  let finalRevision = revision;
  if (rule.status === 'proposed') {
    if (receipt) {
      const done = await advance(ctx, receipt, true, proof);
      if (done.state !== 'committed') return { approved: false, rule_id: rule.id, receipt: receiptView(done, false) };
      return { approved: true, rule_id: rule.id, revision: done.steps.activate?.revision ?? null, confirmed: done.confirmed, receipt: receiptView(done, false) };
    }
    const page = renderRulePage({ scope: rule.scope, status: 'active', text: rule.text, corrects: rule.corrects, attribution: rule.attribution, receipt: rule.receipt ?? '', checks: rule.checks,
      ...(snap!.page.frontmatter?.visibility === 'private' ? { visibility: 'private' as const } : {}), ...(rule.readable_by ? { readable_by: rule.readable_by } : {}) });
    await withRuleWriter(() => submitPageMutation(ctx, { operation: 'put_page', params: { slug, source_id: sourceId, content: page, expected_revision: revision } }));
    finalRevision = (await pageRevision(engine, slug, sourceId)) ?? revision;
  }
  await saveConfirmation(engine, { source_id: sourceId, slug, revision: finalRevision, digest, proof });
  return { approved: true, rule_id: rule.id, revision: finalRevision, confirmed: true };
}

/** Retire a rule (owner, local): it stops rendering at once and is never revived. */
export async function retireRule(engine: BrainEngine, id: string, opts: { sourceId?: string } = {}): Promise<Record<string, unknown>> {
  const slug = ruleSlugOf(id);
  if (!slug) throw opError('invalid_params', `"${id.slice(0, 80)}" is not a rule id (me/<name> or team/<name>).`, 'gbrain rules list shows each rule\'s id.');
  const sourceId = opts.sourceId ?? 'default';
  const snap = await engine.readPageSnapshot(slug, { sourceId });
  const rule = snap && !snap.page.deleted_at ? readRule({ ...snap.page, source_id: sourceId }) : null;
  if (!rule) throw opError('page_not_found', `No standing rule ${ruleIdOf(slug)}.`, 'gbrain rules list shows each rule\'s id.');
  if (rule.status === 'retired') return { retired: true, rule_id: rule.id, unchanged: true };
  const fm = snap!.page.frontmatter ?? {};
  const page = renderRulePage({ scope: rule.scope, status: 'retired', text: rule.text, corrects: rule.corrects, attribution: rule.attribution, receipt: rule.receipt ?? '', checks: rule.checks,
    ...(fm.visibility === 'private' ? { visibility: 'private' as const } : {}), ...(rule.readable_by ? { readable_by: rule.readable_by } : {}) });
  await withRuleWriter(() => submitPageMutation(localRulesCtx(engine, sourceId), { operation: 'put_page', params: { slug, source_id: sourceId, content: page, expected_revision: String(snap!.revision) } }));
  const receipt = rule.receipt ? await readReceipt(engine, rule.receipt) : null;
  if (receipt && receipt.rule.slug === slug && receipt.state !== 'committed') {
    receipt.state = 'conflicted';
    receipt.error = { code: 'rule_transition', message: 'The owner retired this rule before it was finished, so its fact was left unchanged and nothing more is written.' };
    await saveReceipt(engine, receipt);
  }
  return { retired: true, rule_id: rule.id };
}
