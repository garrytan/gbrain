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
import type { Operation, OperationContext, ParamDef } from './contract.ts';
import { opError, OperationError } from './contract.ts';
import { federatedSearchScope } from './context.ts';
import type { FactRow } from '../engine.ts';
import { resolveReadEligibility } from '../eligibility/policy.ts';
import { currentCallerAccess, resolveExcludePrivatePages } from '../search/private-visibility.ts';
import { callerMember, memberPageSlug } from '../access/member-facts.ts';
import { ACTOR_ARGUMENT, ACTOR_HEADER } from '../access/actor-model.ts';
import { uuidV5 } from '../persistence/preconditions.ts';
import { isStrictIsoDateTime } from '../utils.ts';

export const QM_MEMORY_OPS: ReadonlySet<string> = new Set(['memory_recall', 'memory_write']);
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
/** Namespace of the per-member request-id namespaces. Changing it orphans every journaled memory_write receipt. */
export const QM_MEMORY_REQUEST_NAMESPACE = '6b3e9f2a-41c7-4d58-9a0e-2f7c5d1b8e63';

const actorParam: ParamDef = { type: 'string', description: `Set by the trusted system: equal to the ${ACTOR_HEADER} header, or omit.`, fullSurfaceOnly: true };

export interface RecallFact { id: string; text: string; date: string; kind: string }

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

/** memory_recall's arguments, checked before any read (and before an unlinked person's empty answer): query and max_chars. */
export function recallArguments(p: Record<string, unknown> | undefined): { query: string; maxChars: number } {
  if (typeof p?.query !== 'string') throw invalid('query is required and must be a string.', 'Pass what the turn is about as query.');
  return { query: p.query.trim().slice(0, MEMORY_RECALL_QUERY_CHARS), maxChars: parseMaxChars(p.max_chars) };
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

const memory_recall: Operation = {
  name: 'memory_recall',
  mutating: false,
  idempotent: true,
  outputRedaction: { exempt: 'renders its own bounded text: fact text passes the retrieval redactor before the max_chars cut' },
  description: 'Facts for the person this call serves, one per line: their own recent facts first, then facts matching query. Never page bodies. For QM; agents use recall.',
  params: {
    query: { type: 'string', required: true, description: 'What the turn is about; ranks the facts.' },
    max_chars: { type: 'integer', description: `Text cap in UTF-16 code units, ${MEMORY_RECALL_MAX_CHARS.min}-${MEMORY_RECALL_MAX_CHARS.max} (default ${MEMORY_RECALL_MAX_CHARS.default}).` },
    [ACTOR_ARGUMENT]: actorParam,
  },
  scope: 'read',
  annotations: { title: 'memory_recall (QM memory read)', readOnlyHint: true },
  handler: async (ctx, p) => {
    const { query, maxChars } = recallArguments(p);
    const scope = federatedSearchScope(ctx, undefined);
    const sources = [...new Set(scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? ctx.sourceId ?? 'default'])];
    const read: ReadPolicy = { excludePrivate: await resolveExcludePrivatePages(ctx.engine, ctx.remote), eligibility: await resolveReadEligibility(ctx, {}) };
    const own = await ownRecentFacts(ctx, sources, read);
    const { rankFactsByQuestion } = await import('../facts/question-recall.ts');
    const ranked = query ? (await rankFactsByQuestion(ctx, {
      question: query, params: { question: query }, factSources: sources, limit: MEMORY_RECALL_ARM_LIMIT, entity: null, sessionId: null, since: null, grep: null,
      scope: { sourceIds: sources, remote: ctx.remote !== false, excludePrivate: read.excludePrivate, minTrust: read.eligibility.floor, suppressFlagged: read.eligibility.suppressFlagged },
    })).rows : [];
    const seen = new Set<number>();
    const rows = [...own, ...ranked].filter(r => !seen.has(r.id) && !!seen.add(r.id));
    // The date as the database writes it: a driver's timestamp parse reads years 1-99 as 19xx.
    const written = new Map(rows.length ? (await ctx.engine.executeRaw<{ id: number | string; d: string }>(
      `SELECT id, to_char(COALESCE(valid_from, created_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM facts WHERE id = ANY($1::bigint[])`, [rows.map(r => r.id)])).map(r => [Number(r.id), r.d]) : []);
    const plain = rows.map(r => ({ id: String(r.id), text: plainFactText(r.fact), date: isoDate(written.get(Number(r.id)) ?? r.valid_from ?? r.created_at), kind: String(r.kind) }));
    const { redactRetrievalOutput } = await import('../search/output-redaction.ts');
    const facts: RecallFact[] = (ctx.remote === false ? plain : redactRetrievalOutput(plain, {}, { uncapped: true }).results).filter(f => f.text);
    const { kept, text } = boundFactLines(facts.map(f => `- ${f.text} (${f.date}; ${f.kind})`), maxChars);
    return { facts: facts.slice(0, kept), truncated: kept < facts.length, text };
  },
};

/** The request id of fact `index` in a memory_write: uuidv5 of the key under the member's own namespace for fact 0, derived from it after. */
export async function memoryWriteRequestId(member: string, idempotencyKey: string, index: number): Promise<string> {
  const root = uuidV5(uuidV5(QM_MEMORY_REQUEST_NAMESPACE, `member:${member}`), idempotencyKey);
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
    const items = await Promise.all(parseFacts(p.facts, actor.external_id).map(async (f, i) => ({ ...f, request_id: await memoryWriteRequestId(actor.member, key, i) })));
    const { verbOperations } = await import('../verbs.ts');
    const remember = verbOperations.find(op => op.name === 'remember')!;
    for (const [index, item] of items.entries()) {
      try { await remember.handler({ ...ctx, attestedOp: 'memory_write', dryRun: true }, item); } catch (e) {
        if (e instanceof OperationError) e.message = `facts[${index}]: ${e.message} Nothing was saved.`;
        throw e;
      }
    }
    if (ctx.dryRun) return { dry_run: true, action: 'memory_write', facts: items.length };
    const saved: Array<{ request_id: string; fact_id?: string; pending?: true }> = [];
    for (const [index, item] of items.entries()) {
      try {
        const out = await remember.handler({ ...ctx, attestedOp: 'memory_write' }, item) as { id?: string | number } | null;
        saved.push({ request_id: item.request_id, ...(out?.id !== undefined ? { fact_id: String(out.id) } : {}) });
      } catch (e) {
        if (e instanceof OperationError && e.writeError === 'write_pending') { saved.push({ request_id: item.request_id, pending: true }); continue; }
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

/**
 * A successful memory_recall or memory_write result as QM reads it: the model's text alone in `content` (notices stay
 * in `_meta.gbrain_notices`, so memory_recall's text stays within max_chars) and the result in `structuredContent`.
 * A refusal keeps its JSON text block and gains `structuredContent.error` (code, message, reason, fix), as the actor
 * refusals carry it, so QM classifies every error from structuredContent. Dry runs and every other tool pass through.
 */
export function qmMemoryToolResult<T extends { content: Array<{ type: 'text'; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> }>(name: string, out: T): T {
  if (!QM_MEMORY_OPS.has(name)) return out;
  let result: unknown;
  try { result = JSON.parse(out.content[0]?.text ?? ''); } catch { return out; }
  if (out.isError) {
    if (out.structuredContent || !result || typeof result !== 'object') return out;
    const env = result as Record<string, unknown>;
    return { ...out, structuredContent: { error: { code: env.code, message: env.message, ...(env.reason ? { reason: env.reason } : {}), ...(env.write_error ? { write_error: env.write_error } : {}), ...(env.fix ? { fix: env.fix } : {}) } } };
  }
  if (!result || typeof result !== 'object' || 'dry_run' in result) return out;
  const { text, ...structured } = result as Record<string, unknown>;
  return { ...out, content: [{ type: 'text', text: typeof text === 'string' ? text : '' }], structuredContent: structured };
}

/** The empty memory_recall an unlinked attested person gets (dispatch's actorRefusal seam): a success QM reads by its code. */
export function unlinkedRecallResult(): { content: Array<{ type: 'text'; text: string }>; structuredContent: Record<string, unknown> } {
  return { content: [{ type: 'text', text: '' }], structuredContent: { facts: [], truncated: false, code: 'actor_unlinked' } };
}

export const qmMemoryOperations: Operation[] = [memory_recall, memory_write];
