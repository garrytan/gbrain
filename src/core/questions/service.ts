/**
 * Pinned questions behind the questions_* operations and `gbrain questions`.
 *
 * Version 1 is owner-private: every operation requires an owner-capable
 * caller (access below), question pages are private, and answers are read
 * only through these receipts and context_pack's optional pinned field.
 * Consent: a CLI pin is active; a pin created over MCP stays inactive
 * (`awaiting_consent`) until the owner activates it on the brain host or a
 * paid preapproval (consent.preapprove.paid.max_usd_per_run) covers it. A pin
 * never installs a scheduler.
 */
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { hostOnlyError, invalidParam, readFix } from '../ops/op-fix.ts';
import { assertSourceInCallerScope, assertSourceInCallerWriteScope, enforceClientSlugFence, sourceScopeOpts } from '../ops/context.ts';
import { resolveExcludePrivatePages } from '../search/private-visibility.ts';
import { readConsentPreapprovals } from '../consent-preapproval.ts';
import { ALL_SOURCES } from '../source-id.ts';
import { BudgetMeter, loadAllowUnpriced, loadPricingOverrides, parseBudgetUsd } from '../cycle/budget-meter.ts';
import { MAX_QUESTION_CHARS, normalizeQuestion, parseQuestionId, questionSlug, type QuestionScope } from './identity.ts';
import { syncQuestionPage } from './pages.ts';
import { buildReceipt, type QuestionReceipt } from './receipt.ts';
import { refreshPin, type QuestionChatFn, type RefreshHooks, type RefreshOutcome } from './refresh.ts';
import { getPin, insertPin, listPins, pinId, updatePinState, type PinRow } from './store.ts';
import { evaluateAnswer } from './freshness.ts';

export const DEFAULT_BUDGET_USD = 1.0;
export const DEFAULT_PIN_WAIT_MS = 30_000;
export const DEFAULT_REFRESH_WAIT_MS = 120_000;
const MAX_WAIT_MS = 300_000;

/** Test seams: an injected chat function and publication hooks (production callers pass none). */
export interface QuestionsDeps { chat?: QuestionChatFn; hooks?: RefreshHooks }

export interface CallerAccess { readableSources: string[] | null; remote: boolean }

/**
 * Owner-capable callers: the trusted local CLI, or a remote grant that reads
 * private pages (the operator opted remote readers into private pages) and is
 * not slug-fenced or a delegated subagent. Everyone else is refused with the
 * CLI equivalent, so restricted grants never learn a question or answer.
 */
export async function requireOwnerCapable(ctx: OperationContext, op: string, cli: string[]): Promise<CallerAccess> {
  if (ctx.remote === false) {
    const scope = sourceScopeOpts(ctx);
    return { readableSources: scope.sourceIds ?? null, remote: false };
  }
  const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
  const restricted = ctx.viaSubagent === true || (ctx.auth?.boundSlugPrefixes?.length ?? 0) > 0
    || ctx.auth?.fenceProjectionDegraded === true || ctx.auth?.grantProjectionDegraded === true;
  if (excludePrivate || restricted) {
    throw hostOnlyError(ctx, 'question_owner_only', `${op}: pinned questions are owner-private, and this connection cannot read private pages.`, cli,
      'Pinned questions and their answers are private to the brain owner in this version. This connection is a restricted grant (it cannot read private pages' +
      `${restricted ? ', or it is slug-fenced or delegated' : ''}), so the owner runs the command on the brain host. An operator who wants this MCP connection to manage pins sets search.remote_private_pages=visible, which also shows it every private page.`);
  }
  const scope = sourceScopeOpts(ctx);
  const readable = scope.sourceIds ?? (scope.sourceId !== undefined ? [scope.sourceId] : null);
  return { readableSources: readable, remote: true };
}

function defaultSource(ctx: OperationContext): string {
  if (ctx.sourceId && ctx.sourceId !== ALL_SOURCES) return ctx.sourceId;
  return ctx.auth?.sourceId && ctx.auth.sourceId !== ALL_SOURCES ? ctx.auth.sourceId : 'default';
}

function waitMs(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.min(Math.floor(raw), MAX_WAIT_MS) : fallback;
}

async function parseScope(ctx: OperationContext, raw: unknown, op: string): Promise<QuestionScope> {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    throw invalidParam(ctx, op, 'scope', `${op}: scope must be an object {source, slug_prefix?, entity?}.`, { example: { source: 'default' } });
  }
  const s = (raw ?? {}) as Record<string, unknown>;
  const source = typeof s.source === 'string' && s.source.trim() ? s.source.trim() : defaultSource(ctx);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(source)) throw invalidParam(ctx, op, 'scope', `${op}: scope.source is not a valid source id.`, { example: { source: 'default' } });
  assertSourceInCallerScope(ctx, source);
  const [live] = await ctx.engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id = $1 AND NOT archived', [source]);
  if (!live) {
    throw opError('not_found', `Unknown source: ${source}`, 'Pass a source id from sources_list.',
      { fix: readFix('Lists the sources this connection can read.', { argv: ['gbrain', 'sources', 'list'], mcp: { tool: 'sources_list', arguments: {} } }) });
  }
  let slugPrefix: string | undefined;
  if (s.slug_prefix !== undefined && s.slug_prefix !== null && s.slug_prefix !== '') {
    if (typeof s.slug_prefix !== 'string' || !/^[a-z0-9][a-z0-9/_.-]{0,200}$/i.test(s.slug_prefix) || s.slug_prefix.includes('..')) {
      throw invalidParam(ctx, op, 'scope', `${op}: scope.slug_prefix must be a slug prefix such as "projects/".`, { example: { source, slug_prefix: 'projects/' } });
    }
    slugPrefix = s.slug_prefix.toLowerCase().endsWith('/') ? s.slug_prefix.toLowerCase() : `${s.slug_prefix.toLowerCase()}/`;
  }
  let entity: string | undefined;
  if (s.entity !== undefined && s.entity !== null && s.entity !== '') {
    if (typeof s.entity !== 'string' || !/^[a-z0-9][a-z0-9/_.-]{0,200}$/i.test(s.entity) || s.entity.includes('..')) {
      throw invalidParam(ctx, op, 'scope', `${op}: scope.entity must be an entity page slug such as "companies/acme-example".`, { example: { source, entity: 'companies/acme-example' } });
    }
    entity = s.entity.toLowerCase();
  }
  return { source, ...(slugPrefix ? { slug_prefix: slugPrefix } : {}), ...(entity ? { entity } : {}) };
}

async function resolvePin(ctx: OperationContext, access: CallerAccess, rawId: unknown, op: string): Promise<PinRow> {
  if (typeof rawId !== 'string' || !rawId.trim()) throw invalidParam(ctx, op, 'id', `${op}: id is required.`, { example: 'default:questions/who-leads-acme-example-1a2b3c4d' });
  const parsed = parseQuestionId(rawId, defaultSource(ctx));
  const notFound = () => opError('question_not_found', `${op}: no pinned question ${rawId} in this connection's scope.`,
    'Pass an id from questions_list; ids are source-qualified, like default:questions/who-leads-acme-example-1a2b3c4d.',
    { fix: readFix('Lists the pinned questions this connection can read, with their ids.', { argv: ['gbrain', 'questions', 'list', '--json'], mcp: { tool: 'questions_list', arguments: {} } }) });
  if (!parsed) throw notFound();
  if (access.readableSources && !access.readableSources.includes(parsed.sourceId)) throw notFound();
  const pin = await getPin(ctx.engine, parsed.sourceId, parsed.slug);
  if (!pin) throw notFound();
  return pin;
}

async function meterFor(ctx: OperationContext): Promise<BudgetMeter> {
  let budget = parseBudgetUsd(await ctx.engine.getConfig('cycle.standing_questions.budget_usd'), DEFAULT_BUDGET_USD);
  if (ctx.remote !== false) {
    const pre = readConsentPreapprovals().paid?.max_usd_per_run;
    if (pre !== undefined) budget = Math.min(budget, pre);
  }
  const allowUnpriced = (await ctx.engine.getConfig('cycle.standing_questions.allow_unpriced')) === 'true' || await loadAllowUnpriced(ctx.engine);
  return new BudgetMeter({ budgetUsd: budget, allowUnpriced, pricingOverrides: await loadPricingOverrides(ctx.engine), phase: 'standing_questions' });
}

async function boundedRefresh(ctx: OperationContext, pin: PinRow, opts: { full: boolean; waitMs: number; trigger: 'pin' | 'manual' }, deps: QuestionsDeps): Promise<RefreshOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('wait_ms elapsed')), opts.waitMs);
  try {
    return await refreshPin(ctx.engine, pin.source_id, pin.slug, {
      trigger: opts.trigger, full: opts.full, signal: controller.signal, meter: await meterFor(ctx),
      leaseOwner: ctx.remote === false ? 'cli' : `mcp:${ctx.auth?.clientId ?? ctx.transport ?? 'stdio'}`,
      leaseTtlMs: opts.waitMs + 60_000, ...(deps.chat ? { chat: deps.chat } : {}), ...(deps.hooks ? { hooks: deps.hooks } : {}),
    });
  } finally {
    clearTimeout(timer);
  }
}

async function receiptFor(ctx: OperationContext, access: CallerAccess, sourceId: string, slug: string, includeAnswer: boolean, refresh?: RefreshOutcome): Promise<QuestionReceipt> {
  const pin = (await getPin(ctx.engine, sourceId, slug))!;
  const receipt = await buildReceipt(ctx.engine, pin, { readableSources: access.readableSources, includeAnswer, remote: access.remote, refresh });
  if (receipt.blocked_reason || receipt.freshness === 'stale') {
    ctx.emitNotice?.({
      code: 'pinned_answer_stale', kind: 'degraded',
      why: receipt.blocked_reason
        ? `Pinned question ${receipt.id} is ${receipt.freshness} and blocked (${receipt.blocked_reason}); its stale sentences are flagged here and withheld from context_pack.`
        : `Pinned question ${receipt.id} has ${receipt.sentences.stale} stale sentence(s): their evidence changed or was removed. They are flagged here and withheld from context_pack until a refresh.`,
      ...(receipt.fix ? { fix: receipt.fix } : {}),
    });
  }
  return receipt;
}

export async function pinQuestion(ctx: OperationContext, p: Record<string, unknown>, deps: QuestionsDeps = {}): Promise<{ created: boolean; activated: boolean; receipt: QuestionReceipt }> {
  const access = await requireOwnerCapable(ctx, 'questions_pin', typeof p.question === 'string' ? ['gbrain', 'questions', 'pin', p.question] : ['gbrain', 'questions', 'list']);
  const local = ctx.remote === false;
  if (p.publish !== undefined && !local) {
    throw hostOnlyError(ctx, 'question_owner_only', 'questions_pin: publish (draft -> published answers) is set by the owner on the brain host.',
      typeof p.id === 'string' ? ['gbrain', 'questions', 'pin', '--id', p.id, '--publish'] : ['gbrain', 'questions', 'list'], 'Publishing a draft-only pin changes what context_pack serves, so only the owner decides it.');
  }
  const preapproved = readConsentPreapprovals().paid !== undefined;
  const desired = local || preapproved ? { state: 'active' as const, inactiveReason: null } : { state: 'inactive' as const, inactiveReason: 'awaiting_consent' as const };
  let pin: PinRow;
  let created = false;
  if (p.id !== undefined) {
    pin = await resolvePin(ctx, access, p.id, 'questions_pin');
    if (!local) assertSourceInCallerWriteScope(ctx, pin.source_id);
  } else {
    const question = typeof p.question === 'string' ? normalizeQuestion(p.question) : '';
    if (!question || question.length > MAX_QUESTION_CHARS) {
      throw invalidParam(ctx, 'questions_pin', 'question', `questions_pin: question is required (1-${MAX_QUESTION_CHARS} characters), or pass id to activate an existing pin.`, { example: 'Who leads acme-example now?' });
    }
    const scope = await parseScope(ctx, p.scope, 'questions_pin');
    if (!local) assertSourceInCallerWriteScope(ctx, scope.source);
    const slug = questionSlug(question, scope);
    if (!local) enforceClientSlugFence(ctx, slug, 'questions_pin');
    ({ row: pin, created } = await insertPin(ctx.engine, {
      sourceId: scope.source, slug, question, scope, state: desired.state, inactiveReason: desired.inactiveReason,
      publishMode: 'publish', createdBy: local ? 'cli' : `mcp:${ctx.auth?.clientId ?? ctx.transport ?? 'stdio'}`,
    }));
  }
  let activated = created && pin.state === 'active';
  const reactivate = pin.state === 'archived' || (pin.state === 'inactive' && desired.state === 'active');
  if (!created && (reactivate || (p.publish === true && pin.publish_mode === 'draft'))) {
    const next = reactivate ? desired : { state: pin.state, inactiveReason: pin.inactive_reason };
    pin = await updatePinState(ctx.engine, pin.id, { state: next.state, inactiveReason: next.inactiveReason, ...(p.publish === true ? { publishMode: 'publish' as const } : {}) });
    activated = reactivate && pin.state === 'active';
  }
  await syncQuestionPage(ctx, pin);
  let refresh: RefreshOutcome | undefined;
  if (p.defer !== true && pin.state === 'active' && pin.answer_revision === 0) {
    refresh = await boundedRefresh(ctx, pin, { full: true, waitMs: waitMs(p.wait_ms, DEFAULT_PIN_WAIT_MS), trigger: 'pin' }, deps);
  }
  return { created, activated, receipt: await receiptFor(ctx, access, pin.source_id, pin.slug, true, refresh) };
}

export async function listQuestions(ctx: OperationContext, p: Record<string, unknown>): Promise<{
  questions: QuestionReceipt[]; counts: Record<'total' | 'fresh' | 'stale' | 'awaiting_refresh' | 'refreshing' | 'archived' | 'blocked', number>;
}> {
  const access = await requireOwnerCapable(ctx, 'questions_list', ['gbrain', 'questions', 'list']);
  let sources = access.readableSources ?? undefined;
  if (typeof p.source === 'string' && p.source.trim()) {
    assertSourceInCallerScope(ctx, p.source.trim());
    sources = [p.source.trim()];
  } else if (access.remote && !sources) {
    sources = [defaultSource(ctx)];
  }
  const pins = await listPins(ctx.engine, { ...(sources ? { sourceIds: sources } : {}), includeArchived: p.include_archived === true });
  const questions: QuestionReceipt[] = [];
  for (const pin of pins) questions.push(await buildReceipt(ctx.engine, pin, { readableSources: access.readableSources, includeAnswer: false, remote: access.remote }));
  const count = (f: (r: QuestionReceipt) => boolean) => questions.filter(f).length;
  return {
    questions,
    counts: {
      total: questions.length, fresh: count(r => r.freshness === 'fresh'), stale: count(r => r.freshness === 'stale'),
      awaiting_refresh: count(r => r.freshness === 'awaiting_refresh'), refreshing: count(r => r.freshness === 'refreshing'),
      archived: count(r => r.freshness === 'archived'), blocked: count(r => r.blocked_reason !== null),
    },
  };
}

export async function questionStatus(ctx: OperationContext, p: Record<string, unknown>): Promise<QuestionReceipt> {
  const access = await requireOwnerCapable(ctx, 'questions_status', typeof p.id === 'string' ? ['gbrain', 'questions', 'status', p.id] : ['gbrain', 'questions', 'list']);
  const pin = await resolvePin(ctx, access, p.id, 'questions_status');
  return receiptFor(ctx, access, pin.source_id, pin.slug, p.include_answer !== false);
}

export async function refreshQuestion(ctx: OperationContext, p: Record<string, unknown>, deps: QuestionsDeps = {}): Promise<QuestionReceipt> {
  const access = await requireOwnerCapable(ctx, 'questions_refresh', typeof p.id === 'string' ? ['gbrain', 'questions', 'refresh', p.id] : ['gbrain', 'questions', 'list']);
  let pin = await resolvePin(ctx, access, p.id, 'questions_refresh');
  if (ctx.remote !== false) assertSourceInCallerWriteScope(ctx, pin.source_id);
  if (pin.state !== 'archived') await syncQuestionPage(ctx, pin);
  pin = (await getPin(ctx.engine, pin.source_id, pin.slug))!;
  const refresh: RefreshOutcome = pin.state === 'archived' ? { status: 'skipped', reason: 'archived' }
    : pin.state === 'inactive' ? { status: 'blocked', blocked_reason: 'awaiting_consent', detail: `pin is inactive (${pin.inactive_reason ?? 'awaiting_consent'})` }
    : await boundedRefresh(ctx, pin, { full: p.full === true, waitMs: waitMs(p.wait_ms, DEFAULT_REFRESH_WAIT_MS), trigger: 'manual' }, deps);
  return receiptFor(ctx, access, pin.source_id, pin.slug, true, refresh);
}

export async function unpinQuestion(ctx: OperationContext, p: Record<string, unknown>): Promise<{ unpinned: boolean; receipt: QuestionReceipt }> {
  const access = await requireOwnerCapable(ctx, 'questions_unpin', typeof p.id === 'string' ? ['gbrain', 'questions', 'unpin', p.id] : ['gbrain', 'questions', 'list']);
  let pin = await resolvePin(ctx, access, p.id, 'questions_unpin');
  if (ctx.remote !== false) assertSourceInCallerWriteScope(ctx, pin.source_id);
  const unpinned = pin.state !== 'archived';
  if (unpinned) pin = await updatePinState(ctx.engine, pin.id, { state: 'archived' });
  await syncQuestionPage(ctx, pin);
  return { unpinned, receipt: await receiptFor(ctx, access, pin.source_id, pin.slug, false) };
}

export interface PinnedForPack {
  pinned_questions?: Array<{ id: string; question: string; answer: string[]; freshness: 'fresh' | 'stale' }>;
  withheld?: { stale_sentences: number; question_ids: string[]; refresh_command: string };
}

/**
 * context_pack's optional pinned fields: published, active pins scoped to one
 * of the packed entities, fresh sentences only. Stale (and unreadable)
 * sentences are withheld and counted. Owner-capable callers only; anyone else
 * gets nothing (and no hint that pins exist).
 */
export async function pinnedAnswersForPack(ctx: OperationContext, entitySlugs: string[]): Promise<PinnedForPack | null> {
  if (entitySlugs.length === 0) return null;
  let access: CallerAccess;
  try { access = await requireOwnerCapable(ctx, 'context_pack', ['gbrain', 'questions', 'list']); } catch { return null; }
  const sources = access.readableSources ?? [defaultSource(ctx)];
  const pins = (await listPins(ctx.engine, { sourceIds: sources, states: ['active'] }))
    .filter(pin => pin.publish_mode === 'publish' && pin.answer_revision > 0 && pin.scope_entity && entitySlugs.includes(pin.scope_entity));
  if (pins.length === 0) return null;
  const pinned: NonNullable<PinnedForPack['pinned_questions']> = [];
  let withheld = 0;
  const withheldIds: string[] = [];
  for (const pin of pins) {
    const evaluation = await evaluateAnswer(ctx.engine, pin, { readableSources: access.readableSources });
    const fresh = evaluation.sentences.filter(s => !s.stale && !s.hidden).map(s => s.text);
    const held = evaluation.stale + evaluation.hidden;
    if (held > 0) { withheld += held; withheldIds.push(pinId(pin)); }
    if (fresh.length > 0) pinned.push({ id: pinId(pin), question: pin.question, answer: fresh, freshness: held > 0 ? 'stale' : 'fresh' });
  }
  return {
    ...(pinned.length ? { pinned_questions: pinned } : {}),
    ...(withheld > 0 ? { withheld: { stale_sentences: withheld, question_ids: withheldIds, refresh_command: `gbrain questions refresh ${withheldIds[0]}` } } : {}),
  };
}
