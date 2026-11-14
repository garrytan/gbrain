/**
 * GST-359 D (GBRA-218): QM's memory provider pair, the two tools a trusted system (QM) calls for the person it
 * attests in `x-qm-actor` (access/actor.ts). The contract they keep is docs/contracts/qm-memory-provider/v1.json.
 *
 * - memory_recall: plain-text facts, one per line (`- <fact> (<date>; <kind>)`), never page bodies. The caller's own
 *   facts from the last 24 hours on its member page come first, then the facts it may read ranked by the query
 *   (keyword-only unless an embedding provider is configured), deduplicated by fact id, as many whole lines as fit in
 *   max_chars and no marker line (QM reads every line as a fact; `truncated` says some were left out). Fence and
 *   heading markers are stripped from fact text.
 * - memory_write: 1-20 facts saved through remember's persistence path (the same writer door, git-first where a repo
 *   exists) onto the attested member's page, readable by that member alone, with provenance `qm:<actor id>; <caller's>`.
 *   Each fact's request id derives from uuidv5(member, idempotency_key), so a key never crosses members and a replay
 *   returns the original receipts. Never retried here: a write still publishing answers `pending`.
 *
 * Both answer with the text for the model in `content` and the result in `structuredContent` (qmMemoryToolResult);
 * QM reads success codes only from `structuredContent`. An unlinked actor on memory_recall is answered by dispatch
 * (actorRefusal) with empty content and `{facts: [], truncated: false, code: 'actor_unlinked'}` (unlinkedRecallResult).
 */
import { createHash } from 'node:crypto';
import type { Operation, OperationContext, ParamDef } from './contract.ts';
import { opError, OperationError } from './contract.ts';
import { federatedSearchScope, parseSourceIdParam } from './context.ts';
import { parseSourceIdsParam, requestSourceScope, SOURCE_IDS_PARAM } from './search-source-scope.ts';
import type { FactRow } from '../engine.ts';
import { resolveReadEligibility } from '../eligibility/policy.ts';
import { currentCallerAccess, resolveExcludePrivatePages, withCallerAccess } from '../search/private-visibility.ts';
import { currentReadMode, scopeReadAccess } from '../access/scope-read.ts';
import { callerMember, memberPageSlug, ownMemberFactIds, SCOPE_PAGE_SLUG } from '../access/member-facts.ts';
import { markedScopeSources, sourceNotAttested, withoutScopeSources } from '../access/attest-sources.ts';
import { ACTOR_ARGUMENT, ACTOR_HEADER } from '../access/actor-model.ts';
import { uuidV5 } from '../persistence/preconditions.ts';
import { isStrictIsoDateTime } from '../utils.ts';

export const QM_MEMORY_OPS: ReadonlySet<string> = new Set(['memory_recall', 'memory_write']);
/** GST-1158 F1: the personal tools contract v3 adds, read or written as the attested person (own DM only); opt-in per client. */
export const QM_PERSONAL_OPS: ReadonlySet<string> = new Set([
  'query', 'get_page', 'get_timeline', 'get_backlinks', 'find_experts', 'whois', 'entity', 'context_pack', 'volunteer_context',
  'get_write_request', 'forget_fact',
]);
/** Results whose `text` is the model's text: it alone fills `content` and leaves `structuredContent`. */
const TEXT_RESULT_OPS: ReadonlySet<string> = new Set(['memory_recall', 'memory_write', 'context_pack']);
export const MEMORY_RECALL_MAX_CHARS = { min: 200, max: 12_000, default: 6_000 } as const;
/** Own facts written within this window lead the answer. */
export const OWN_RECENT_WINDOW_HOURS = 24;
/** Rows read per arm (own recent, query-ranked) before the max_chars cut. */
export const MEMORY_RECALL_ARM_LIMIT = 50;
/** The query ranks on its first 2000 characters (recall's `question` cap); the rest is ignored, never refused. */
export const MEMORY_RECALL_QUERY_CHARS = 2000;
export const MEMORY_WRITE_MAX_FACTS = 20;
export const MEMORY_WRITE_PROVENANCE_MAX = 200;
export const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,128}$/;
/** remember's input kinds (MEMORY_VERBS v1, frozen); a stored `idea` can still come back from memory_recall. */
export const MEMORY_WRITE_KINDS = ['event', 'preference', 'commitment', 'belief', 'fact'] as const;
const FACT_KEYS = new Set(['fact', 'provenance', 'kind', 'valid_from']);
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const UNPAIRED_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** Namespace of the per-member request-id namespaces. Changing it orphans every journaled memory_write receipt. */
export const QM_MEMORY_REQUEST_NAMESPACE = '6b3e9f2a-41c7-4d58-9a0e-2f7c5d1b8e63';

const actorParam: ParamDef = { type: 'string', description: `Set by the trusted system: equal to the ${ACTOR_HEADER} header, or omit.`, fullSurfaceOnly: true };

/**
 * GST-1158 F5: `arm` says which read found the fact: the person's own recent facts, or the query ranking. GST-2407:
 * `own_page` says the fact sits on the person's own member page in the connection's source, the one test forget_fact
 * applies to ownership (ownMemberFactIds), whichever arm found it.
 */
export interface RecallFact { id: string; text: string; date: string; kind: string; arm: 'own' | 'ranked'; own_page: boolean }

/** Fact text as one plain line: fence and heading markers and rules removed, every line break and control character a space. */
export function plainFactText(text: string): string {
  return text
    .replace(/[\r\v\f\u0085\u2028\u2029]/g, '\n')
    .replace(/^[ \t]{0,3}#{1,6}(?=\s|$)/gm, '')
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,}|={3,})[ \t]*$/gm, '')
    .replace(/`{3,}|~{3,}/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The whole lines that fit in maxChars, in order, with no marker line: the first line that would cross the cap ends the list. */
export function boundFactLines(lines: readonly string[], maxChars: number): { kept: number; text: string } {
  let kept = 0;
  let used = 0;
  while (kept < lines.length) {
    const next = used + (kept ? 1 : 0) + lines[kept]!.length;
    if (next > maxChars) break;
    used = next;
    kept++;
  }
  return { kept, text: lines.slice(0, kept).join('\n') };
}

/** YYYY-MM-DD of a stored time, read from its own fields: a database text value keeps its date as written (a non-ISO
 * parse reads year 50 as 1950), a Date its UTC year, month and day; 'undated' outside years 0001-9999. */
export function isoDate(value: Date | string | null | undefined): string {
  const written = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})(?![\d])/.exec(value.trim()) : null;
  if (written) return written[1] === '0000' ? 'undated' : written.slice(1).join('-');
  const t = value instanceof Date ? value : null;
  if (!t || !Number.isFinite(t.getTime()) || t.getUTCFullYear() < 1 || t.getUTCFullYear() > 9999) return 'undated';
  return [String(t.getUTCFullYear()).padStart(4, '0'), String(t.getUTCMonth() + 1).padStart(2, '0'), String(t.getUTCDate()).padStart(2, '0')].join('-');
}

const invalid = (message: string, suggestion: string): OperationError => opError('invalid_params', message, suggestion);

export function parseMaxChars(raw: unknown): number {
  if (raw === undefined || raw === null) return MEMORY_RECALL_MAX_CHARS.default;
  const { min, max } = MEMORY_RECALL_MAX_CHARS;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw invalid(`max_chars must be a whole number from ${min} to ${max}.`, `Omit max_chars for ${MEMORY_RECALL_MAX_CHARS.default}, or pass a whole number from ${min} to ${max}.`);
  }
  return raw;
}

/**
 * memory_recall's arguments, checked before any read (and before an unlinked person's empty answer): query, max_chars and
 * query_keep. A query over MEMORY_RECALL_QUERY_CHARS is ranked on its head (v1) or, with query_keep tail (v3, #8694), on
 * its tail; query_keep also reports the cut as queryTruncated.
 */
export function recallArguments(p: Record<string, unknown> | undefined): { query: string; maxChars: number; queryTruncated?: boolean } {
  if (typeof p?.query !== 'string') throw invalid('query is required and must be a string.', 'Pass what the turn is about as query.');
  const keep = p.query_keep ?? undefined;
  if (keep !== undefined && keep !== 'head' && keep !== 'tail') throw invalid('query_keep must be "head" or "tail".', `Omit query_keep to rank a long query on its first ${MEMORY_RECALL_QUERY_CHARS} characters, or send "tail" to rank it on its last ${MEMORY_RECALL_QUERY_CHARS}.`);
  const query = p.query.trim();
  const kept = keep === 'tail' ? query.slice(-MEMORY_RECALL_QUERY_CHARS) : query.slice(0, MEMORY_RECALL_QUERY_CHARS);
  return { query: kept, maxChars: parseMaxChars(p.max_chars), ...(keep === undefined ? {} : { queryTruncated: kept.length < query.length }) };
}

type ReadPolicy = { excludePrivate: boolean; eligibility: Awaited<ReturnType<typeof resolveReadEligibility>> };

/** The caller's own facts written in the last 24 hours on its member page, newest first; none outside a member caller. */
async function ownRecentFacts(ctx: OperationContext, sources: string[], read: ReadPolicy): Promise<FactRow[]> {
  const member = ctx.remote === false ? null : callerMember();
  if (!member) return [];
  const since = new Date(Date.now() - OWN_RECENT_WINDOW_HOURS * 3_600_000);
  const lists = await Promise.all(sources.map(src => ctx.engine.listFactsSince(src, since, {
    sourceMarkdownSlug: memberPageSlug(member), visibility: ['world'], excludePrivate: read.excludePrivate, eligibility: read.eligibility,
    excludeAuditRows: true, limit: MEMORY_RECALL_ARM_LIMIT,
  })));
  return lists.flat().sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || b.id - a.id).slice(0, MEMORY_RECALL_ARM_LIMIT);
}

/** The sources a recall reads and whether it names them; a named recall whose sources intersect to none reads nothing. */
async function recallSources(ctx: OperationContext, p: Record<string, unknown>): Promise<{ sources: string[]; named: boolean }> {
  const sourceIdParam = parseSourceIdParam(p.source_id, 'memory_recall');
  const sourceIds = parseSourceIdsParam(ctx, 'memory_recall', p.source_ids);
  if (sourceIdParam === undefined && sourceIds === undefined) {
    const scope = federatedSearchScope(ctx, undefined);
    return { sources: await withoutScopeSources(ctx, [...new Set(scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? ctx.sourceId ?? 'default'])]), named: false };
  }
  const scope = await requestSourceScope(ctx, sourceIdParam, sourceIds);
  return { sources: [...new Set(scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : []))], named: true };
}

async function recallFacts(ctx: OperationContext, query: string, maxChars: number, sources: string[], asScope: boolean): Promise<{ facts: RecallFact[]; truncated: boolean; text: string }> {
  const remote = ctx.remote !== false;
  const read: ReadPolicy = { excludePrivate: asScope && remote ? true : await resolveExcludePrivatePages(ctx.engine, ctx.remote), eligibility: await resolveReadEligibility(ctx, {}) };
  const own = asScope || !sources.length ? [] : await ownRecentFacts(ctx, sources, read);
  const { rankFactsByQuestion } = await import('../facts/question-recall.ts');
  const ranked = query && sources.length ? (await rankFactsByQuestion(ctx, {
    question: query, params: { question: query }, factSources: sources, limit: MEMORY_RECALL_ARM_LIMIT, entity: null, sessionId: null, since: null, grep: null,
    scope: { sourceIds: sources, worldOnly: remote, excludePrivate: read.excludePrivate, minTrust: read.eligibility.floor, suppressFlagged: read.eligibility.suppressFlagged },
  })).rows : [];
  const seen = new Set<number>();
  const rows = [...own.map(r => ({ ...r, arm: 'own' as const })), ...ranked.map(r => ({ ...r, arm: 'ranked' as const }))].filter(r => !seen.has(r.id) && !!seen.add(r.id));
  // The date as the database writes it: a driver's timestamp parse reads years 1-99 as 19xx.
  const written = new Map(rows.length ? (await ctx.engine.executeRaw<{ id: number | string; d: string }>(
    `SELECT id, to_char(COALESCE(valid_from, created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM facts WHERE id = ANY($1::bigint[])`, [rows.map(r => r.id)])).map(r => [Number(r.id), r.d]) : []);
  const owned = remote ? await ownMemberFactIds(ctx.engine, ctx.sourceId ?? 'default', rows.map(r => Number(r.id))) : new Set<number>();
  const plain = rows.map(r => ({ id: String(r.id), text: plainFactText(r.fact), date: isoDate(written.get(Number(r.id)) ?? r.valid_from ?? r.created_at), kind: String(r.kind), arm: r.arm, own_page: owned.has(Number(r.id)) }));
  const { redactRetrievalOutput } = await import('../search/output-redaction.ts');
  const facts: RecallFact[] = (remote ? redactRetrievalOutput(plain, {}, { uncapped: true }).results : plain).filter(f => f.text);
  const { kept, text } = boundFactLines(facts.map(f => `- ${f.text} (${f.date}; ${f.kind})`), maxChars);
  return { facts: facts.slice(0, kept), truncated: kept < facts.length, text };
}

const memory_recall: Operation = {
  name: 'memory_recall',
  mutating: false,
  idempotent: true,
  outputRedaction: { exempt: 'renders its own bounded text: fact text passes the retrieval redactor before the max_chars cut' },
  description: 'Facts for the person this call serves, one per line: their own recent facts first, then facts matching query. Never page bodies. For QM; agents use recall.',
  params: {
    query: { type: 'string', required: true, description: 'What the turn is about; ranks the facts.' },
    max_chars: { type: 'integer', description: `Text cap in UTF-16 code units, ${MEMORY_RECALL_MAX_CHARS.min}-${MEMORY_RECALL_MAX_CHARS.max} (default ${MEMORY_RECALL_MAX_CHARS.default}).` },
    query_keep: { type: 'string', enum: ['head', 'tail'], description: `Which end of a query over ${MEMORY_RECALL_QUERY_CHARS} characters ranks the facts: head (the default) or tail. Sending it adds query_truncated.`, fullSurfaceOnly: true },
    [ACTOR_ARGUMENT]: actorParam,
    source_id: { type: 'string', description: 'Read this one source as its audience (a shared scope): never the person\'s own facts.', fullSurfaceOnly: true },
    source_ids: { ...SOURCE_IDS_PARAM, description: 'Read only these sources as their audience (a shared scope): never the person\'s own facts.', fullSurfaceOnly: true },
  },
  scope: 'read',
  annotations: { title: 'memory_recall (QM memory read)', readOnlyHint: true },
  handler: async (ctx, p) => {
    const { query, maxChars, queryTruncated } = recallArguments(p);
    const { sources, named } = await recallSources(ctx, p);
    const mode = currentReadMode();
    const cut = queryTruncated === undefined ? {} : { query_truncated: queryTruncated };
    if (!named || ctx.remote === false || mode) return { ...await recallFacts(ctx, query, maxChars, sources, named && mode !== 'person'), ...cut };
    return { ...await withCallerAccess(await scopeReadAccess(ctx.engine), () => recallFacts(ctx, query, maxChars, sources, true)), ...cut };
  },
};

/** The request id of fact `index` in a memory_write: uuidv5 of the key under the member's own namespace for fact 0, derived from it after. */
export async function memoryWriteRequestId(member: string, idempotencyKey: string, index: number, scopeSource?: string): Promise<string> {
  // GST-1113: a scope write keys under (member, source), so one key never replays across sources; '#' is outside member ids.
  const root = uuidV5(uuidV5(QM_MEMORY_REQUEST_NAMESPACE, scopeSource === undefined ? `member:${member}` : `member:${member}#source:${scopeSource}`), idempotencyKey);
  if (index === 0) return root;
  const { childRequestId } = await import('../remember-batch.ts');
  return childRequestId(root, index);
}

function parseFacts(raw: unknown, actorId: string): Array<Record<string, unknown>> {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MEMORY_WRITE_MAX_FACTS) {
    throw invalid(`facts must be an array of 1 to ${MEMORY_WRITE_MAX_FACTS} facts.`, `Pass facts: [{ "fact": "...", "provenance": "..." }, ...], at most ${MEMORY_WRITE_MAX_FACTS} per call.`);
  }
  return raw.map((item, index) => {
    const at = `facts[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid(`${at} must be an object.`, 'Each fact is { fact, provenance, optional kind, optional valid_from }.');
    const f = item as Record<string, unknown>;
    const extra = Object.keys(f).filter(k => !FACT_KEYS.has(k));
    if (extra.length) throw invalid(`${at} has unknown field(s): ${extra.join(', ')}.`, `Allowed fields: ${[...FACT_KEYS].join(', ')}.`);
    const fact = typeof f.fact === 'string' ? f.fact.trim() : '';
    if (!fact) throw invalid(`${at}.fact must be a non-empty string.`, 'Pass the claim to save as fact.');
    if (fact.includes('\u0000') || UNPAIRED_SURROGATE_RE.test(fact)) {
      throw invalid(`${at}.fact holds a NUL character or malformed Unicode.`, 'Pass the claim as valid UTF-8 text without NUL characters; nothing was saved.');
    }
    const provenance = typeof f.provenance === 'string' ? f.provenance.trim() : '';
    if (!provenance || provenance.length > MEMORY_WRITE_PROVENANCE_MAX) {
      throw invalid(`${at}.provenance must be 1 to ${MEMORY_WRITE_PROVENANCE_MAX} characters.`, 'Pass where the fact came from, for example "slack:C0123/p1700000000".');
    }
    if (CONTROL_RE.test(f.provenance as string) || /^qm:/i.test(provenance)) {
      throw invalid(`${at}.provenance must be one line of text that does not start with qm:.`, 'gbrain adds qm:<actor id> itself; pass only where the fact came from, without line breaks or control characters.');
    }
    if (f.kind !== undefined && !(MEMORY_WRITE_KINDS as readonly unknown[]).includes(f.kind)) {
      throw invalid(`${at}.kind is not a fact kind.`, `Use one of: ${MEMORY_WRITE_KINDS.join(', ')}, or omit it (fact).`);
    }
    if (f.valid_from !== undefined && !isStrictIsoDateTime(f.valid_from)) {
      throw invalid(`${at}.valid_from must be an ISO 8601 date or time in years 0001-9999.`, 'Pass when the fact became true as YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS][Z|±HH:MM], for example "2026-10-30", or omit it.');
    }
    return { fact, provenance: `qm:${actorId}; ${provenance}`, ...(f.kind !== undefined ? { kind: f.kind } : {}), ...(f.valid_from !== undefined ? { valid_from: f.valid_from } : {}) };
  });
}

const memory_write: Operation = {
  name: 'memory_write',
  mutating: true,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Save facts for the person this call serves, readable by them alone. Needs an attested person. The same idempotency_key replays the first receipt. For QM; agents use remember.',
  params: {
    facts: {
      type: 'array', required: true, description: `1-${MEMORY_WRITE_MAX_FACTS} facts.`,
      items: { type: 'object', properties: {
        fact: { type: 'string', required: true, description: 'One claim.' },
        provenance: { type: 'string', required: true, description: `Where it came from (<=${MEMORY_WRITE_PROVENANCE_MAX} chars).` },
        kind: { type: 'string', enum: [...MEMORY_WRITE_KINDS], description: 'Default fact.' },
        valid_from: { type: 'string', description: 'When it became true (ISO 8601).' },
      } },
    },
    idempotency_key: { type: 'string', required: true, description: '1-128 visible ASCII characters; the same key replays this write.' },
    [ACTOR_ARGUMENT]: actorParam,
    source_id: { type: 'string', description: `One of this credential's scope sources: save on its shared ${SCOPE_PAGE_SLUG} page.`, fullSurfaceOnly: true },
  },
  scope: 'write',
  annotations: { title: 'memory_write (QM memory write)', idempotentHint: true },
  handler: async (ctx, p) => {
    const actor = ctx.remote === false ? null : currentCallerAccess().actor ?? null;
    if (!actor) {
      const { actorNotAttested } = await import('../access/actor.ts');
      throw actorNotAttested('actor_required', { auth: ctx.auth }, { op: 'memory_write', transport: ctx.transport });
    }
    if (typeof p.idempotency_key !== 'string' || !IDEMPOTENCY_KEY_RE.test(p.idempotency_key)) {
      throw invalid('idempotency_key must be 1 to 128 visible ASCII characters (no spaces).', 'Send a stable key per write, for example a UUID; the same key replays the same write.');
    }
    const key = p.idempotency_key;
    const scopeSource = p.source_id === undefined ? undefined : parseSourceIdParam(p.source_id, 'memory_write');
    if (scopeSource !== undefined && scopeSource === (ctx.auth?.sourceId ?? ctx.sourceId)) {
      throw opError('invalid_params', `source_id ${scopeSource} is this connection's own source, where the person's member page lives; nothing was saved.`,
        'Omit source_id to save for the person alone; send source_id only for a shared scope\'s source.', { reason: 'source_is_member_source' });
    }
    if (scopeSource !== undefined && (!ctx.auth?.attest?.sources?.includes(scopeSource) || !(await markedScopeSources(ctx.engine, [scopeSource])).has(scopeSource))) throw sourceNotAttested(scopeSource);
    const writeCtx: OperationContext = scopeSource === undefined ? ctx : { ...ctx, sourceId: scopeSource, attestedSource: scopeSource };
    const parsed = parseFacts(p.facts, actor.external_id);
    // Every fact's replay intent carries the whole batch, so a key reused with more, fewer or other facts is an
    // idempotency_conflict at its first fact, before anything new is written.
    const qm_batch = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
    const items = await Promise.all(parsed.map(async (f, i) => ({ ...f, qm_batch, request_id: await memoryWriteRequestId(actor.member, key, i, scopeSource) })));
    const { verbOperations } = await import('../verbs.ts');
    const remember = verbOperations.find(op => op.name === 'remember')!;
    for (const [index, item] of items.entries()) {
      try { await remember.handler({ ...writeCtx, attestedOp: 'memory_write', dryRun: true }, item); } catch (e) {
        if (e instanceof OperationError) e.message = `facts[${index}]: ${e.message} Nothing was saved.`;
        throw e;
      }
    }
    const { assertFactNotWithdrawn } = await import('../facts/single-prepare.ts');
    const { requestPrincipalForContext } = await import('../persistence/page-mutations.ts');
    const { getWriteRequest } = await import('../persistence/journal.ts');
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    const principal = await requestPrincipalForContext(ctx);
    for (const [index, item] of parsed.entries()) {
      if (await getWriteRequest(ctx.engine, principal, items[index]!.request_id)) continue;
      const intent = scopeSource === undefined
        ? { fact: item.fact as string, kind: (item.kind ?? 'fact') as never, visibility: 'private' as const, entity_slug: null, page_slug: memberPageSlug(actor.member) }
        : { fact: item.fact as string, kind: (item.kind ?? 'fact') as never, visibility: 'world' as const, entity_slug: null, page_slug: SCOPE_PAGE_SLUG };
      try { await assertFactNotWithdrawn(ctx.engine, writeCtx.sourceId ?? 'default', intent, { excludePrivate, remote: ctx.remote !== false }); } catch (e) {
        if (e instanceof OperationError) e.message = `facts[${index}]: ${e.message} Nothing was saved.`;
        throw e;
      }
    }
    if (ctx.dryRun) return { dry_run: true, action: 'memory_write', facts: items.length };
    const saved: Array<{ request_id: string; fact_id?: string; pending?: true }> = [];
    for (const [index, item] of items.entries()) {
      try {
        const out = await remember.handler({ ...writeCtx, attestedOp: 'memory_write' }, item) as { id?: string | number } | null;
        saved.push({ request_id: item.request_id, ...(out?.id !== undefined ? { fact_id: String(out.id) } : {}) });
      } catch (e) {
        if (e instanceof OperationError && e.writeError === 'write_pending') { saved.push({ request_id: item.request_id, pending: true }); continue; }
        // memory_write takes no request_id: a retryable refusal names the idempotency_key that replays this write.
        if (e instanceof OperationError && e.requestId === item.request_id) {
          const theirs = `request_id ${item.request_id}`, own = `idempotency_key ${key}`;
          e.message = e.message.replaceAll(theirs, () => own);
          e.suggestion = e.suggestion?.replaceAll(theirs, () => own);
          if (e.fix) e.fix = { ...e.fix, why: e.fix.why.replaceAll(theirs, () => own) };
          e.requestId = undefined;
        }
        if (e instanceof OperationError && index > 0) e.message = `facts[${index}]: ${e.message} The ${index} fact(s) before it were saved; the same idempotency_key replays them.`;
        throw e;
      }
    }
    const pending = saved.filter(s => s.pending).map(s => s.request_id);
    const factIds = [...new Set(saved.flatMap(s => s.fact_id ? [s.fact_id] : []))];
    return {
      status: pending.length ? 'pending' : 'committed',
      request_id: pending[0] ?? items[0]!.request_id,
      fact_ids: factIds,
      ...(pending.length ? { pending_request_ids: pending } : {}),
      text: pending.length ? `Accepted ${factIds.length + pending.length} fact(s); ${pending.length} still publishing.` : `Saved ${factIds.length} fact(s).`,
    };
  },
};

const PROPOSE_FIELDS = { timeline: ['date', 'summary', 'detail', 'source'], link: ['to', 'link_type', 'context', 'valid_from', 'valid_until'] } as const;
const oneLine = (value: string) => !CONTROL_RE.test(value) && !UNPAIRED_SURROGATE_RE.test(value);

/**
 * GST-1158 (GBRA-284): one timeline entry or typed link proposed for a shared page, held in memory_proposals until the
 * brain owner approves it (persistence/memory-proposals.ts). Attested only. Replay first: the request id derives from the
 * member and the key, and a resend with the same fields returns the proposal's current state even after the page moved.
 * Everything is checked before anything is held: the fields of the kind, the date, one-line text, the payload cap, the
 * slug fence, the grant and attested person (attestedOp memory_propose), the target (and a link's target) existing and
 * readable by the person, and expected_revision when sent. The published provenance names the member, never the
 * person's external id.
 */
const memory_propose: Operation = {
  name: 'memory_propose',
  mutating: true,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Propose one timeline entry or link on a shared page for the person this call serves; the brain owner approves it before it is written. Needs an attested person. Poll get_write_request with the request_id; the same idempotency_key replays.',
  params: {
    kind: { type: 'string', required: true, enum: ['timeline', 'link'], description: 'timeline (date, summary) or link (to).' },
    target: { type: 'string', required: true, description: 'Slug the write lands on (a link\'s from page).' },
    idempotency_key: { type: 'string', required: true, description: '1-128 visible ASCII characters; the same key replays this proposal.' },
    expected_revision: { type: 'string', description: 'The revision shown to the person; refused when the page moved.' },
    date: { type: 'string', description: 'timeline: YYYY-MM-DD.' },
    summary: { type: 'string', description: 'timeline: one line.' },
    detail: { type: 'string', description: 'timeline: details.' },
    source: { type: 'string', description: 'timeline: where it came from.' },
    to: { type: 'string', description: 'link: the page it points to.' },
    link_type: { type: 'string', description: 'link: a type the schema pack declares.' },
    context: { type: 'string', description: 'link: context.' },
    valid_from: { type: 'string', description: 'link: YYYY-MM-DD.' },
    valid_until: { type: 'string', description: 'link: YYYY-MM-DD.' },
    [ACTOR_ARGUMENT]: actorParam,
  },
  scope: 'write',
  annotations: { title: 'memory_propose (QM proposed write)', idempotentHint: true },
  handler: async (ctx, p) => {
    const actor = ctx.remote === false ? null : currentCallerAccess().actor ?? null;
    if (!actor) {
      const { actorNotAttested } = await import('../access/actor.ts');
      throw actorNotAttested('actor_required', { auth: ctx.auth }, { op: 'memory_propose', transport: ctx.transport });
    }
    if (typeof p.idempotency_key !== 'string' || !IDEMPOTENCY_KEY_RE.test(p.idempotency_key)) {
      throw invalid('idempotency_key must be 1 to 128 visible ASCII characters (no spaces).', 'Send a stable key per proposal, for example a UUID; the same key replays the same proposal.');
    }
    const kind = p.kind;
    if (kind !== 'timeline' && kind !== 'link') throw invalid('kind must be timeline or link.', 'Pass kind: "timeline" with date and summary, or kind: "link" with to.');
    const target = typeof p.target === 'string' ? p.target.trim().toLowerCase() : '';
    if (!target) throw invalid('target is required: the slug the write lands on.', 'Pass the page slug as target (for a link, the page it starts from).');
    const stray = PROPOSE_FIELDS[kind === 'timeline' ? 'link' : 'timeline'].filter(k => p[k] !== undefined);
    if (stray.length) throw opError('invalid_params', `A ${kind} proposal does not take ${stray.join(', ')}.`, `Drop ${stray.join(', ')}; a ${kind} proposal takes ${PROPOSE_FIELDS[kind].join(', ')}.`, { reason: 'proposal_kind_field' });
    for (const k of [...PROPOSE_FIELDS[kind], 'expected_revision']) {
      if (p[k] !== undefined && typeof p[k] !== 'string') throw invalid(`${k} must be a string.`, `Pass ${k} as text, or omit it.`);
    }
    const sent: Record<string, unknown> = { kind, target, ...Object.fromEntries([...PROPOSE_FIELDS[kind], 'expected_revision'].flatMap(k => p[k] === undefined ? [] : [[k, p[k]]])) };
    const { proposalDigest, proposalRequestId, getProposal, insertProposal, readProposalLimits, linkTargetReadable, PROPOSAL_LINK_SOURCE } = await import('../persistence/memory-proposals.ts');
    const { requestPrincipalForContext, pageMutationSource } = await import('../persistence/page-mutations.ts');
    const digest = proposalDigest(sent);
    const principal = await requestPrincipalForContext(ctx);
    const requestId = proposalRequestId(principal, actor.member, p.idempotency_key);
    const replay = (row: { payload_digest: string; state: string; request_id: string; kind: string; slug: string; expires_at: string }) => {
      if (row.payload_digest !== digest) {
        throw opError('idempotency_conflict', 'This idempotency_key was used for a different proposal; send a new key.',
          'A key is reused only to resend the same proposal. Send this one with a new idempotency_key; the earlier proposal keeps its receipt (get_write_request).');
      }
      return { status: row.state, request_id: row.request_id, kind: row.kind, target: row.slug, expires_at: row.expires_at, text: `Proposal ${row.state.replace('_', ' ')}.` };
    };
    const existing = await getProposal(ctx.engine, principal, requestId);
    if (existing) return replay(existing);
    const limits = await readProposalLimits(ctx.engine);
    let text: string;
    if (kind === 'timeline') {
      const { assertTimelineDate } = await import('./timeline.ts');
      assertTimelineDate(ctx, p.date);
      const summary = typeof p.summary === 'string' ? p.summary.trim() : '';
      if (!summary || !oneLine(summary)) throw invalid('summary is required and must be one line of text.', 'Pass the entry as one line, without line breaks or control characters; put more in detail.');
      for (const k of ['detail', 'source'] as const) {
        const v = p[k] as string | undefined;
        if (v !== undefined && (v.includes('\u0000') || UNPAIRED_SURROGATE_RE.test(v) || (k === 'source' && !oneLine(v)))) throw invalid(`${k} holds a control character or malformed Unicode.`, `Pass ${k} as plain text${k === 'source' ? ' on one line' : ''}.`);
      }
      text = [summary, p.detail ?? '', p.source ?? ''].join('');
    } else {
      if (typeof p.to !== 'string' || !p.to.trim()) throw invalid('to is required: the page the link points to.', 'Pass the slug of the page the link points to as to.');
      const linkType = (p.link_type as string | undefined) ?? '';
      if (linkType) {
        const { loadActivePackForWriteVocabulary, packDeclaresLinkType, undeclaredLinkTypeMessage, undeclaredLinkTypeSuggestion } = await import('../schema-pack/write-vocabulary.ts');
        const pack = await loadActivePackForWriteVocabulary(ctx);
        if (pack && !packDeclaresLinkType(pack, linkType)) throw opError('invalid_params', undeclaredLinkTypeMessage(linkType, pack, 'memory_propose'), undeclaredLinkTypeSuggestion(pack));
      }
      const { primeRelationSemantics } = await import('../link-semantics-pack.ts');
      await primeRelationSemantics(ctx.engine);
      const { validateLinkDates } = await import('./links.ts');
      validateLinkDates(ctx, p, linkType);
      if (p.context !== undefined && !oneLine(p.context as string)) throw invalid('context must be one line of text.', 'Pass context without line breaks or control characters.');
      text = (p.context as string | undefined) ?? '';
    }
    if (text.length > limits.maxPayloadChars) {
      throw opError('invalid_params', `The proposal's text is ${text.length} characters; the cap is ${limits.maxPayloadChars}.`,
        `Shorten ${kind === 'timeline' ? 'summary, detail and source' : 'context'} to ${limits.maxPayloadChars} characters together; nothing was saved.`, { reason: 'proposal_too_large' });
    }
    const { enforceClientSlugFence, requireWritablePage, validatePageSlug } = await import('./context.ts');
    validatePageSlug(target);
    enforceClientSlugFence(ctx, target, 'memory_propose');
    const sourceId = pageMutationSource(ctx, {}, 'memory_propose');
    const [source] = await ctx.engine.executeRaw<{ incarnation: string; archived: boolean }>('SELECT incarnation, archived FROM sources WHERE id=$1', [sourceId]);
    if (!source || source.archived) throw opError('source_changed', 'The write source is not active.', `Source ${sourceId} is archived or not registered, so nothing was saved.`);
    const operation = kind === 'timeline' ? 'add_timeline_entry' as const : 'add_link' as const;
    const to = kind === 'link' ? String(p.to).trim().toLowerCase() : null;
    await requireWritablePage({ ...ctx, sourceId }, target, 'memory_propose', kind === 'link' ? 'from' : 'page');
    if (to) { validatePageSlug(to); await requireWritablePage({ ...ctx, sourceId }, to, 'memory_propose', 'to'); }
    const { submissionAuthority } = await import('../persistence/authority.ts');
    const authority = await submissionAuthority({ ...ctx, attestedOp: 'memory_propose' }, operation, sourceId, String(source.incarnation), target);
    if (to && !await linkTargetReadable(ctx.engine, authority, sourceId, to)) {
      const { pageNotVisibleError } = await import('../persistence/page-visibility.ts');
      throw pageNotVisibleError();
    }
    const snapshot = await ctx.engine.readPageSnapshot(target, { sourceId });
    if (typeof p.expected_revision === 'string' && p.expected_revision !== snapshot?.revision) {
      throw opError('invalid_params', `${target} changed since the revision shown to the person.`,
        'Show the person the page again (get_page) and propose against its current revision; nothing was saved.', { reason: 'proposal_revision_changed' });
    }
    if (ctx.dryRun) return { dry_run: true, action: 'memory_propose', kind, target };
    // OV4: the published provenance names the member; the external id stays on the proposal row, read by the owner.
    const note = `${PROPOSAL_LINK_SOURCE}; member:${actor.member}; approved by owner`;
    const payload: Record<string, unknown> = kind === 'timeline'
      ? { slug: target, date: p.date, summary: (p.summary as string).trim(), ...(p.detail !== undefined ? { detail: p.detail } : {}), source: p.source ? `${note}; ${p.source}` : note }
      : { slug: target, to, link_type: (p.link_type as string | undefined) ?? '', link_source: PROPOSAL_LINK_SOURCE, context: p.context ? `${p.context} (${note})` : note,
        ...(p.valid_from !== undefined ? { valid_from: p.valid_from } : {}), ...(p.valid_until !== undefined ? { valid_until: p.valid_until } : {}) };
    const { row, created } = await insertProposal(ctx.engine, { principal, requestId, actor, sourceId, sourceIncarnation: String(source.incarnation), kind, operation,
      slug: target, toSlug: to, payload, digest, expectedRevision: snapshot?.revision ?? null, authority }, limits);
    if (!created) return replay(row);
    return { status: 'awaiting_owner', request_id: row.request_id, kind, target, expires_at: row.expires_at, text: `Proposal held for the brain owner's approval until ${row.expires_at}.` };
  },
};

/**
 * A successful memory_recall or memory_write result as QM reads it: the model's text alone in `content` (notices stay
 * in `_meta.gbrain_notices`, so memory_recall's text stays within max_chars) and the result in `structuredContent`.
 * A refusal keeps its JSON text block and gains `structuredContent.error` (code, message, reason, detail, fix), as the actor
 * refusals carry it, so QM classifies every error from structuredContent. Dry runs and every other tool pass through.
 * GST-1158 F2: a personal tool (QM_PERSONAL_OPS) is rewritten the same way only for an attested person (`personal`):
 * `content` keeps its JSON and notice blocks, an array result arrives as `structuredContent.results`, and
 * context_pack's text fills `content` as memory_recall's does.
 */
export function qmMemoryToolResult<T extends { content: Array<{ type: 'text'; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> }>(name: string, out: T, personal = false): T {
  if (!QM_MEMORY_OPS.has(name) && name !== 'memory_propose' && !(personal && QM_PERSONAL_OPS.has(name))) return out;
  let result: unknown;
  try { result = JSON.parse(out.content[0]?.text ?? ''); } catch { return out; }
  if (out.isError) {
    if (out.structuredContent || !result || typeof result !== 'object') return out;
    const env = result as Record<string, unknown>;
    return { ...out, structuredContent: { error: { code: env.code, message: env.message, ...(env.reason ? { reason: env.reason } : {}), ...(env.detail ? { detail: env.detail } : {}), ...(env.write_error ? { write_error: env.write_error } : {}), ...(env.fix ? { fix: env.fix } : {}) } } };
  }
  if (!result || typeof result !== 'object' || 'dry_run' in result) return out;
  if (Array.isArray(result)) return { ...out, structuredContent: { results: result } };
  if (!TEXT_RESULT_OPS.has(name)) return { ...out, structuredContent: result as Record<string, unknown> };
  const { text, ...structured } = result as Record<string, unknown>;
  return { ...out, content: [{ type: 'text', text: typeof text === 'string' ? text : '' }], structuredContent: structured };
}

/** The empty memory_recall an unlinked attested person gets (dispatch's actorRefusal seam): a success QM reads by its code. */
export function unlinkedRecallResult(): { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> } {
  return { content: [{ type: 'text', text: '' }], structuredContent: { facts: [], truncated: false, code: 'actor_unlinked' } };
}

export const qmMemoryOperations: Operation[] = [memory_recall, memory_write, memory_propose];

/**
 * GST-900: recall's max_chars, memory_recall's bound on recall's text: the fact texts, then the results' chunk texts,
 * one per line, keep the whole items that fit; the first item that would cross the cap ends both lists, with no
 * marker. `truncated` says whether anything was cut and `total` counts the facts kept; `facts_groups` and
 * `entity_unspecified` keep only the facts and entities still delivered.
 */
export function boundRecallChars<T extends { facts: Array<{ id?: unknown; fact: string }>; total: number; results?: Array<{ chunk?: unknown }>;
  facts_groups?: Array<{ source_id: string; entity_slug: string | null; fact_ids: string[] }>;
  entity_unspecified?: { candidates: Array<{ source_id: string; entity_slug: string }> } }>(out: T, maxChars: number): T & { truncated: boolean } {
  const lines = [...out.facts.map(f => f.fact), ...(out.results ?? []).map(r => String(r.chunk ?? ''))];
  const { kept } = boundFactLines(lines, maxChars);
  const facts = out.facts.slice(0, kept);
  const bounded = { ...out, facts, total: facts.length, ...(out.results ? { results: out.results.slice(0, Math.max(0, kept - out.facts.length)) } : {}), truncated: kept < lines.length };
  if (facts.length === out.facts.length || !out.facts_groups) return bounded;
  const ids = new Set(facts.map(f => String(f.id)));
  const facts_groups = out.facts_groups.map(g => ({ ...g, fact_ids: g.fact_ids.filter(id => ids.has(id)) })).filter(g => g.fact_ids.length);
  const named = new Set(facts_groups.filter(g => g.entity_slug !== null).map(g => g.source_id + '\u0000' + g.entity_slug));
  const candidates = out.entity_unspecified?.candidates.filter(c => named.has(c.source_id + '\u0000' + c.entity_slug)) ?? [];
  const { entity_unspecified: _cut, ...rest } = bounded;
  return { ...rest, facts_groups, ...(out.entity_unspecified && candidates.length >= 2 ? { entity_unspecified: { ...out.entity_unspecified, candidates } } : {}) } as T & { truncated: boolean };
}
