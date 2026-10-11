/**
 * Refreshing a pinned answer.
 *
 * 1. Pre-checks with no spend: inactive pins report `awaiting_consent`, a
 *    missing chat key `no_model_key`, a refused budget check `budget_exhausted`.
 * 2. A durable lease on the pin row (a duplicate worker gets `in_progress`; a
 *    crashed worker's expired lease is taken over).
 * 3. Capture: the pin revision, the question page (owner claims), and the
 *    evidence watermark (global page-generation clock, newest fact id).
 * 4. Re-retrieve over current evidence in scope. Question and synthesis pages,
 *    and pages that repeat a stored answer sentence, are never evidence.
 * 5. One model call. With a previous answer and nothing removed or
 *    contradicted it edits that answer; after deletions, withdrawals,
 *    conflicting corrections, non-monotonic questions or `full` it recomputes.
 * 6. Publish in one transaction that first revalidates (memory-prepare.ts
 *    pattern: observe, prepare, then repeat the checks under row locks): the
 *    lease, the pin revision and every cited dependency revision. Any change
 *    rejects publication, so the previous answer keeps its stale flags.
 *    A failure anywhere keeps the previous answer; the error is recorded.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { BudgetMeter } from '../cycle/budget-meter.ts';
import { resolveModel } from '../model-config.ts';
import { normalizeModelId } from '../model-id.ts';
import { canonicalLookup } from '../model-pricing.ts';
import { chat as gatewayChat, probeChatModel } from '../ai/gateway.ts';
import { classifyLlmCallFailure } from '../think/index.ts';
import { PINNED_QUESTION_MARKER, normalizeQuestion, sentenceId } from './identity.ts';
import { entityAnchoredPages, prefixAnchoredPages } from '../search/entity-anchor.ts';
import { quarantinedProvenanceFilterFragment, quarantineFilterFragment } from '../quarantine.ts';
import { FACT_HASH_SQL, TAKE_HASH_SQL, TIMELINE_HASH_SQL, evaluateAnswer, type EvidenceKind } from './freshness.ts';
import { ownerClaims, readQuestionPage } from './pages.ts';
import { acquireLease, getPin, pinId, releaseLease, type AnswerSentence, type PinRow } from './store.ts';

export type BlockedReason = 'no_model_key' | 'budget_exhausted' | 'no_worker' | 'refresh_failed' | 'awaiting_consent';

export interface QuestionChatRequest { model: string; system: string; user: string; maxTokens: number; signal?: AbortSignal }
export interface QuestionChatResponse { text: string; usage: { input_tokens: number; output_tokens: number } | null; model: string }
export type QuestionChatFn = (req: QuestionChatRequest) => Promise<QuestionChatResponse>;

/** Test-only crash and race injection points around publication. */
export interface RefreshHooks {
  afterRetrieve?: () => Promise<void> | void;
  beforeCommit?: () => Promise<void> | void;
  betweenPublicationStages?: () => Promise<void> | void;
}

export interface RefreshOpts {
  trigger: 'pin' | 'manual' | 'cycle';
  full?: boolean;
  chat?: QuestionChatFn;
  meter?: BudgetMeter;
  signal?: AbortSignal;
  leaseOwner: string;
  leaseTtlMs?: number;
  hooks?: RefreshHooks;
}

export type RefreshOutcome =
  | { status: 'published'; mode: 'full' | 'incremental'; cost_usd: number; sentences: number; dropped_uncited: number; gaps: string[] }
  | { status: 'blocked'; blocked_reason: BlockedReason; detail: string }
  | { status: 'in_progress' }
  | { status: 'conflict'; detail: string; cost_usd: number }
  | { status: 'failed'; error: string; cost_usd: number }
  | { status: 'timeout'; cost_usd: number }
  | { status: 'skipped'; reason: 'archived' };

export const EST_INPUT_TOKENS = 8_000;
export const MAX_OUTPUT_TOKENS = 2_000;
const MAX_PAGES = 16;
const MAX_FACTS = 30;
const MAX_TIMELINE = 20;
const MAX_TAKES = 20;
const PAGE_EXCERPT_CHARS = 1_500;
const MAX_SENTENCES = 12;
const NON_MONOTONIC = /\b(latest|current(ly)?|now|today|most recent|newest|recent(ly)?|cheapest|best|worst|top|highest|lowest|largest|smallest|only|still|last)\b/i;

export interface EvidenceItem {
  ref: string;
  kind: Exclude<EvidenceKind, 'owner'>;
  source_id: string;
  page_id: number | null;
  page_slug: string | null;
  page_generation: number | null;
  page_revision: string | null;
  item_id: number | null;
  content_hash: string | null;
  text: string;
}

export async function resolveQuestionModel(engine: BrainEngine, pin: Pick<PinRow, 'model'>): Promise<string> {
  return resolveModel(engine, {
    cliFlag: pin.model ?? undefined, configKey: 'models.standing_questions', deprecatedConfigKey: 'models.auto_think',
    tier: 'deep', fallback: 'opus',
  });
}

/** True when a chat call for this pin's model can run (a key is configured). */
export function chatKeyAvailable(model: string): boolean {
  return probeChatModel(normalizeModelId(model)).ok;
}

const gatewayQuestionChat: QuestionChatFn = async (req) => {
  const r = await gatewayChat({ model: normalizeModelId(req.model), system: req.system, messages: [{ role: 'user', content: req.user }],
    maxTokens: req.maxTokens, allowFallback: false, ...(req.signal ? { abortSignal: req.signal } : {}) });
  return { text: r.text, usage: { input_tokens: r.usage.input_tokens, output_tokens: r.usage.output_tokens }, model: r.model };
};

function costUsd(model: string, usage: QuestionChatResponse['usage']): number {
  const p = canonicalLookup(normalizeModelId(model)) ?? canonicalLookup(model);
  if (!p || !usage) return 0;
  return (usage.input_tokens / 1_000_000) * p.input + (usage.output_tokens / 1_000_000) * p.output;
}

async function recordBlocked(engine: BrainEngine, id: number, code: string): Promise<void> {
  await engine.executeRaw(
    `UPDATE pinned_questions SET last_attempt_at = now(), last_error = $2, updated_at = now()
     WHERE id = $1 AND (lease_token IS NULL OR lease_expires_at < now())`, [id, code]);
}

interface PublishedAnswer { answer: string | null; published_at: Date | string | null; cited: number[] | string | null }

/**
 * Answer sentences already published in this source, with when they were
 * published and which pages they cite. A page that repeats one of them is a
 * copy of the answer (citation laundering) when it changed after the answer
 * was published and is not that sentence's own evidence.
 */
function launderingIndex(rows: PublishedAnswer[]): Array<{ text: string; at: number; cited: Set<number> }> {
  const out: Array<{ text: string; at: number; cited: Set<number> }> = [];
  for (const r of rows) {
    if (!r.answer) continue;
    const at = r.published_at ? new Date(r.published_at).getTime() : 0;
    const cited = new Set((Array.isArray(r.cited) ? r.cited : []).map(Number));
    try {
      for (const s of JSON.parse(r.answer) as Array<{ text?: unknown }>) {
        const t = typeof s.text === 'string' ? normalizeQuestion(s.text).toLowerCase() : '';
        if (t.length >= 24) out.push({ text: t, at, cited });
      }
    } catch { /* unreadable stored answer contributes nothing */ }
  }
  return out;
}

interface CandidatePage { id: number; slug: string; source_id: string; generation: string | number; revision: string | null; type: string; compiled_truth: string; marker: boolean; updated_at: Date | string }

/**
 * Pages anchored to the pin's scope, newest first (search/entity-anchor.ts):
 * for an entity, its own page and every page that links to it or names it as
 * a word; for a slug prefix, the newest pages under it. Keyword retrieval
 * alone ranks every page that shares the question's words alike, so the
 * newest note about the entity can fall outside the window once notes
 * accumulate.
 */
async function anchoredSlugs(engine: BrainEngine, pin: PinRow): Promise<string[]> {
  if (pin.scope_entity) return [pin.scope_entity, ...(await entityAnchoredPages(engine, pin.source_id, pin.scope_entity)).pages.map(p => p.slug)];
  if (pin.scope_slug_prefix) return (await prefixAnchoredPages(engine, pin.source_id, pin.scope_slug_prefix)).map(p => p.slug);
  return [];
}

/** Pages first (scope-anchored newest, then hybrid retrieval with keyword fallback), then facts, timeline and takes anchored to them. */
export async function retrieveEvidence(engine: BrainEngine, pin: PinRow): Promise<EvidenceItem[]> {
  const slugs = new Set<string>(await anchoredSlugs(engine, pin));
  try {
    const { hybridSearch } = await import('../search/hybrid.ts');
    for (const r of await hybridSearch(engine, pin.question, { sourceId: pin.source_id, limit: MAX_PAGES * 2, exclude_slug_prefixes: ['questions/'] })) slugs.add(r.slug);
  } catch {
    for (const r of await engine.searchKeyword(pin.question, { sourceId: pin.source_id, limit: MAX_PAGES * 2 }).catch(() => [])) slugs.add(r.slug);
  }
  const candidates = slugs.size === 0 ? [] : await engine.executeRaw<CandidatePage>(
    `SELECT id, slug, source_id, generation, knowledge_revision::text AS revision, type, compiled_truth, updated_at,
       (frontmatter ? '${PINNED_QUESTION_MARKER}') AS marker
     FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL AND ${quarantineFilterFragment('pages')}`, [pin.source_id, [...slugs]]);
  const laundered = launderingIndex(await engine.executeRaw<PublishedAnswer>(
    `SELECT q.answer, q.last_refresh_at AS published_at,
       COALESCE(array_agg(e.page_id) FILTER (WHERE e.page_id IS NOT NULL), ARRAY[]::integer[]) AS cited
     FROM pinned_questions q LEFT JOIN question_evidence e ON e.question_id = q.id AND e.answer_revision = q.answer_revision
     WHERE q.source_id = $1 AND q.answer IS NOT NULL GROUP BY q.id, q.answer, q.last_refresh_at`, [pin.source_id]));
  const order = [...slugs];
  const pages = candidates
    .filter(p => p.type !== 'question' && p.type !== 'synthesis' && !p.marker)
    .filter(p => !pin.scope_slug_prefix || p.slug.startsWith(pin.scope_slug_prefix) || p.slug === pin.scope_entity)
    .filter(p => {
      const body = normalizeQuestion(p.compiled_truth ?? '').toLowerCase();
      const changed = new Date(p.updated_at).getTime();
      return !laundered.some(s => !s.cited.has(p.id) && changed >= s.at && body.includes(s.text));
    })
    .sort((a, b) => order.indexOf(a.slug) - order.indexOf(b.slug))
    .slice(0, MAX_PAGES);
  const items: EvidenceItem[] = [];
  const push = (item: Omit<EvidenceItem, 'ref'>) => items.push({ ...item, ref: `E${items.length + 1}` });
  for (const p of pages) {
    push({ kind: 'page', source_id: p.source_id, page_id: p.id, page_slug: p.slug, page_generation: Number(p.generation),
      page_revision: p.revision, item_id: null, content_hash: null, text: `[page ${p.slug}] ${(p.compiled_truth ?? '').slice(0, PAGE_EXCERPT_CHARS)}` });
  }
  const pageIds = pages.map(p => p.id);
  const entitySlugs = [...new Set([...pages.map(p => p.slug), ...(pin.scope_entity ? [pin.scope_entity] : [])])];
  if (entitySlugs.length > 0) {
    const facts = await engine.executeRaw<{ id: string | number; fact: string; entity_slug: string | null; valid_from: unknown; hash: string }>(
      `SELECT f.id, f.fact, f.entity_slug, f.valid_from, ${FACT_HASH_SQL('f')} AS hash FROM facts f
       WHERE f.source_id = $1 AND f.entity_slug = ANY($2::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL
         AND (f.valid_until IS NULL OR f.valid_until > now()) AND ${quarantinedProvenanceFilterFragment('f')}
         AND NOT EXISTS (SELECT 1 FROM pages fp WHERE fp.source_id = f.source_id AND fp.slug = f.source_markdown_slug
           AND (fp.type IN ('question', 'synthesis') OR fp.frontmatter ? '${PINNED_QUESTION_MARKER}'))
       ORDER BY f.valid_from DESC, f.id DESC LIMIT ${MAX_FACTS}`, [pin.source_id, entitySlugs]);
    for (const f of facts) {
      push({ kind: 'fact', source_id: pin.source_id, page_id: null, page_slug: f.entity_slug, page_generation: null, page_revision: null,
        item_id: Number(f.id), content_hash: f.hash, text: `[fact about ${f.entity_slug ?? 'unknown'}, from ${String(f.valid_from).slice(0, 10)}] ${f.fact}` });
    }
  }
  if (pageIds.length > 0) {
    const timeline = await engine.executeRaw<{ id: number; date: unknown; summary: string; detail: string; page_id: number; slug: string; generation: string | number; revision: string | null; hash: string }>(
      `SELECT t.id, t.date, t.summary, t.detail, p.id AS page_id, p.slug, p.generation, p.knowledge_revision::text AS revision, ${TIMELINE_HASH_SQL('t')} AS hash
       FROM timeline_entries t JOIN pages p ON p.id = t.page_id WHERE p.id = ANY($1::integer[]) ORDER BY t.date DESC, t.id DESC LIMIT ${MAX_TIMELINE}`, [pageIds]);
    for (const t of timeline) {
      push({ kind: 'timeline', source_id: pin.source_id, page_id: t.page_id, page_slug: t.slug, page_generation: Number(t.generation),
        page_revision: t.revision, item_id: t.id, content_hash: t.hash, text: `[timeline ${t.slug} ${String(t.date).slice(0, 10)}] ${t.summary}${t.detail ? ` — ${t.detail.slice(0, 300)}` : ''}` });
    }
    const takes = await engine.executeRaw<{ id: string | number; claim: string; holder: string; weight: number | null; page_id: number; slug: string; generation: string | number; revision: string | null; hash: string }>(
      `SELECT k.id, k.claim, k.holder, k.weight, p.id AS page_id, p.slug, p.generation, p.knowledge_revision::text AS revision, ${TAKE_HASH_SQL('k')} AS hash
       FROM takes k JOIN pages p ON p.id = k.page_id WHERE p.id = ANY($1::integer[]) AND k.active AND k.superseded_by IS NULL
       ORDER BY k.id DESC LIMIT ${MAX_TAKES}`, [pageIds]);
    for (const k of takes) {
      push({ kind: 'take', source_id: pin.source_id, page_id: k.page_id, page_slug: k.slug, page_generation: Number(k.generation),
        page_revision: k.revision, item_id: Number(k.id), content_hash: k.hash, text: `[take on ${k.slug}, held by ${k.holder}${k.weight !== null ? `, weight ${k.weight}` : ''}] ${k.claim}` });
    }
  }
  return items;
}

const SYSTEM_PROMPT = [
  'You maintain a standing answer to one question from a personal knowledge base.',
  'Use only the numbered evidence. Every sentence must cite at least one evidence id; a sentence you cannot cite is not allowed.',
  'Owner claims are the owner\'s own statements: they are shown for context, are kept verbatim by the system, and must not be repeated or contradicted.',
  'Return only JSON: {"sentences":[{"text":"...","cite":["E1"]}],"gaps":["what the evidence does not answer"]}.',
  'If the evidence does not answer the question, return no sentences and name the gap.',
].join('\n');

const JSON_RETRY_NOTE = 'Your previous reply could not be parsed. Reply with only the JSON object described above, with no other text.';

export function buildPrompt(pin: PinRow, items: EvidenceItem[], owner: string[], previous: AnswerSentence[] | null): string {
  const lines = [`Question: ${pin.question}`];
  if (pin.scope_slug_prefix || pin.scope_entity) {
    lines.push(`Scope: ${[pin.scope_slug_prefix ? `pages under ${pin.scope_slug_prefix}` : '', pin.scope_entity ? `about ${pin.scope_entity}` : ''].filter(Boolean).join(', ')}`);
  }
  if (owner.length) lines.push('', 'Owner claims:', ...owner.map(s => `- ${s}`));
  if (previous && previous.length) {
    lines.push('', 'Previous answer (edit it: keep sentences the evidence still supports, revise or drop the rest, add sentences for new evidence):',
      ...previous.map(s => `- ${s.text}`));
  }
  lines.push('', 'Evidence:', ...(items.length ? items.map(i => `${i.ref}: ${i.text.replace(/\s+/g, ' ')}`) : ['(none)']));
  return lines.join('\n');
}

type AnswerObject = { sentences?: unknown; gaps?: unknown };
const isAnswerObject = (v: unknown): v is AnswerObject => !!v && typeof v === 'object' && !Array.isArray(v) && ('sentences' in v || 'gaps' in v);

/**
 * The answer object in a model reply. Fast path: the span from the first `{`
 * to the last `}`. Otherwise every balanced top-level object (string-aware) is
 * tried and the last one shaped like an answer wins, so prose with braces
 * around the JSON, a fenced block followed by notes, or a draft object
 * followed by a corrected one still parse.
 */
function answerObject(text: string): AnswerObject | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const whole: unknown = JSON.parse(text.slice(start, end + 1));
    if (isAnswerObject(whole)) return whole;
  } catch { /* fall through to the balanced scan */ }
  let found: AnswerObject | null = null;
  for (let i = start; i >= 0 && i <= end; i = text.indexOf('{', i + 1)) {
    let depth = 0, inString = false, escaped = false, close = -1;
    for (let j = i; j <= end && close < 0; j++) {
      const ch = text[j];
      if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; }
      else if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) close = j;
    }
    if (close < 0) continue;
    try {
      const candidate: unknown = JSON.parse(text.slice(i, close + 1));
      if (isAnswerObject(candidate)) { found = candidate; i = close; }
    } catch { /* not JSON; try the next brace */ }
  }
  return found;
}

export function parseModelAnswer(text: string, items: EvidenceItem[]): { sentences: Array<{ text: string; cites: EvidenceItem[] }>; dropped: number; gaps: string[] } {
  const parsed = answerObject(text);
  if (!parsed) throw new Error('model_output_not_json');
  const byRef = new Map(items.map(i => [i.ref, i]));
  const out: Array<{ text: string; cites: EvidenceItem[] }> = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const raw of Array.isArray(parsed.sentences) ? parsed.sentences : []) {
    const s = raw as { text?: unknown; cite?: unknown };
    const body = typeof s.text === 'string' ? normalizeQuestion(s.text).slice(0, 600) : '';
    const cites = (Array.isArray(s.cite) ? s.cite : []).map(c => byRef.get(String(c).trim())).filter((c): c is EvidenceItem => !!c);
    if (!body || cites.length === 0 || seen.has(sentenceId(body))) { if (body) dropped++; continue; }
    seen.add(sentenceId(body));
    out.push({ text: body, cites: [...new Set(cites)] });
    if (out.length >= MAX_SENTENCES) break;
  }
  const gaps = (Array.isArray(parsed.gaps) ? parsed.gaps : []).filter((g): g is string => typeof g === 'string').map(g => g.slice(0, 300)).slice(0, 5);
  return { sentences: out, dropped, gaps };
}

interface EvidenceRow {
  sentence_id: string; kind: EvidenceKind; source_id: string; page_id: number | null; page_slug: string | null;
  page_generation: number | null; page_revision: string | null; item_id: number | null; content_hash: string | null;
}

/** Repeats every dependency check under row locks; returns the first mismatch, or null when all still hold. */
async function revalidate(tx: BrainEngine, rows: EvidenceRow[]): Promise<string | null> {
  const pageRows = rows.filter(r => r.page_id !== null && r.kind !== 'fact');
  const pageIds = [...new Set(pageRows.map(r => r.page_id!))];
  if (pageIds.length) {
    const current = new Map((await tx.executeRaw<{ id: number; generation: string | number; revision: string | null; deleted: boolean; body: string }>(
      `SELECT id, generation, knowledge_revision::text AS revision, deleted_at IS NOT NULL AS deleted, md5(compiled_truth) AS body
       FROM pages WHERE id = ANY($1::integer[]) FOR SHARE`, [pageIds])).map(r => [r.id, r]));
    for (const r of pageRows) {
      const c = current.get(r.page_id!);
      if (!c || c.deleted) return `page ${r.page_slug ?? r.page_id} was removed`;
      if (r.kind === 'owner') { if (c.body !== r.content_hash) return 'the owner edited the question page'; continue; }
      if (String(c.generation) !== String(r.page_generation) || (c.revision ?? null) !== (r.page_revision ?? null)) return `page ${r.page_slug ?? r.page_id} changed`;
    }
  }
  const check = async (kind: EvidenceKind, sql: string) => {
    const want = rows.filter(r => r.kind === kind);
    if (!want.length) return null;
    const current = new Map((await tx.executeRaw<{ id: string | number; ok: boolean; hash: string }>(sql, [[...new Set(want.map(r => r.item_id!))]]))
      .map(r => [Number(r.id), r]));
    for (const r of want) {
      const c = current.get(Number(r.item_id));
      if (!c || !c.ok || c.hash !== r.content_hash) return `${kind} ${r.item_id} changed`;
    }
    return null;
  };
  return (await check('fact', `SELECT id, (expired_at IS NULL AND superseded_by IS NULL AND (valid_until IS NULL OR valid_until > now())) AS ok,
      ${FACT_HASH_SQL('facts')} AS hash FROM facts WHERE id = ANY($1::bigint[]) FOR SHARE`))
    ?? (await check('timeline', `SELECT id, true AS ok, ${TIMELINE_HASH_SQL('timeline_entries')} AS hash FROM timeline_entries WHERE id = ANY($1::integer[]) FOR SHARE`))
    ?? (await check('take', `SELECT id, (active AND superseded_by IS NULL) AS ok, ${TAKE_HASH_SQL('takes')} AS hash FROM takes WHERE id = ANY($1::bigint[]) FOR SHARE`));
}

export async function refreshPin(engine: BrainEngine, sourceId: string, slug: string, opts: RefreshOpts): Promise<RefreshOutcome> {
  const pin = await getPin(engine, sourceId, slug);
  if (!pin) throw new Error(`pinned question ${sourceId}:${slug} not found`);
  if (pin.state === 'archived') return { status: 'skipped', reason: 'archived' };
  if (pin.state === 'inactive') return { status: 'blocked', blocked_reason: 'awaiting_consent', detail: `pin is inactive (${pin.inactive_reason ?? 'awaiting_consent'})` };
  const model = await resolveQuestionModel(engine, pin);
  if (!opts.chat && !chatKeyAvailable(model)) {
    await recordBlocked(engine, pin.id, 'no_model_key');
    return { status: 'blocked', blocked_reason: 'no_model_key', detail: `no usable chat key for ${model}` };
  }
  if (opts.meter) {
    const check = opts.meter.check({ modelId: model, estimatedInputTokens: EST_INPUT_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS, label: `standing_questions:${pinId(pin)}` });
    if (!check.allowed) {
      await recordBlocked(engine, pin.id, 'budget_exhausted');
      return { status: 'blocked', blocked_reason: 'budget_exhausted', detail: check.reason ?? 'budget exhausted' };
    }
  }
  const token = randomUUID();
  const leased = await acquireLease(engine, pin.id, token, opts.leaseOwner, opts.leaseTtlMs ?? 10 * 60_000);
  if (!leased) return { status: 'in_progress' };
  let spend = 0;
  let stage: 'retrieve' | 'model' | 'parse' | 'publish' = 'retrieve';
  try {
    const [clock] = await engine.executeRaw<{ generation: string | number; fact_id: string | number }>(
      `SELECT (SELECT COALESCE(MAX(generation), 0) FROM pages) AS generation,
              (SELECT COALESCE(MAX(id), 0) FROM facts WHERE source_id = $1) AS fact_id`, [pin.source_id]);
    const page = await readQuestionPage(engine, pin);
    const owner = page ? ownerClaims(page.compiled_truth) : [];
    const items = await retrieveEvidence(engine, leased);
    await opts.hooks?.afterRetrieve?.();
    const evaluation = await evaluateAnswer(engine, leased, { readableSources: null });
    const previous = leased.answer.filter(s => s.origin === 'model');
    const full = opts.full === true || previous.length === 0 || evaluation.needsFull || NON_MONOTONIC.test(leased.question);
    opts.signal?.throwIfAborted();
    stage = 'model';
    const chat = opts.chat ?? gatewayQuestionChat;
    const request = { model, system: SYSTEM_PROMPT, user: buildPrompt(leased, items, owner, full ? null : previous), maxTokens: MAX_OUTPUT_TOKENS, signal: opts.signal };
    let response = await chat(request);
    spend = costUsd(response.model || model, response.usage);
    stage = 'parse';
    let parsed: ReturnType<typeof parseModelAnswer>;
    try {
      parsed = parseModelAnswer(response.text, items);
    } catch (e) {
      if (!(e instanceof Error && e.message === 'model_output_not_json')) throw e;
      if (opts.meter && !opts.meter.check({ modelId: model, estimatedInputTokens: EST_INPUT_TOKENS, maxOutputTokens: MAX_OUTPUT_TOKENS, label: `standing_questions:${pinId(pin)}:retry` }).allowed) throw e;
      opts.signal?.throwIfAborted();
      stage = 'model';
      response = await chat({ ...request, user: `${request.user}\n\n${JSON_RETRY_NOTE}` });
      spend += costUsd(response.model || model, response.usage);
      stage = 'parse';
      parsed = parseModelAnswer(response.text, items);
    }
    const ownerSentences: AnswerSentence[] = owner.map(text => ({ id: sentenceId(`owner:${text}`), text, origin: 'owner' }));
    const modelSentences: AnswerSentence[] = parsed.sentences.map(s => ({ id: sentenceId(s.text), text: s.text, origin: 'model' }));
    const evidence: EvidenceRow[] = [
      ...(page ? ownerSentences.map(s => ({ sentence_id: s.id, kind: 'owner' as const, source_id: pin.source_id, page_id: page.page_id,
        page_slug: pin.slug, page_generation: page.generation, page_revision: page.revision, item_id: null,
        content_hash: null })) : []),
      ...parsed.sentences.flatMap(s => s.cites.map(c => ({ sentence_id: sentenceId(s.text), kind: c.kind, source_id: c.source_id, page_id: c.page_id,
        page_slug: c.page_slug, page_generation: c.page_generation, page_revision: c.page_revision, item_id: c.item_id, content_hash: c.content_hash }))),
    ];
    if (page && ownerSentences.length) {
      const [h] = await engine.executeRaw<{ body: string }>('SELECT md5($1::text) AS body', [page.compiled_truth]);
      for (const e of evidence) if (e.kind === 'owner') e.content_hash = h!.body;
    }
    stage = 'publish';
    await opts.hooks?.beforeCommit?.();
    opts.signal?.throwIfAborted();
    const conflict = await engine.transaction(async (tx) => {
      const [row] = await tx.executeRaw<{ revision: string | number; lease_token: string | null; state: string }>(
        'SELECT revision, lease_token, state FROM pinned_questions WHERE id = $1 FOR UPDATE', [pin.id]);
      if (!row || row.lease_token !== token) return 'the refresh lease was lost';
      if (Number(row.revision) !== leased.revision || row.state !== 'active') return 'the pin changed during refresh';
      const mismatch = await revalidate(tx, evidence);
      if (mismatch) return mismatch;
      await tx.executeRaw(
        `UPDATE pinned_questions SET answer = $2, answer_revision = answer_revision + 1, revision = revision + 1, answer_model = $3,
           last_refresh_at = now(), last_error = NULL, watermark_generation = $4, watermark_fact_id = $5, watermark_at = now(),
           lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL, spend_usd = spend_usd + $6, updated_at = now()
         WHERE id = $1`,
        [pin.id, JSON.stringify([...ownerSentences, ...modelSentences]), response.model || model, Number(clock!.generation), Number(clock!.fact_id), spend]);
      await opts.hooks?.betweenPublicationStages?.();
      await tx.executeRaw('DELETE FROM question_evidence WHERE question_id = $1', [pin.id]);
      const revision = leased.answer_revision + 1;
      for (const e of evidence) {
        await tx.executeRaw(
          `INSERT INTO question_evidence (question_id, answer_revision, sentence_id, kind, source_id, page_id, page_slug, page_generation, page_revision, item_id, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [pin.id, revision, e.sentence_id, e.kind, e.source_id, e.page_id, e.page_slug, e.page_generation, e.page_revision, e.item_id, e.content_hash]);
      }
      return null;
    });
    if (conflict) {
      await releaseLease(engine, pin.id, token, { error: 'concurrent_change', spendUsd: spend });
      return { status: 'conflict', detail: conflict, cost_usd: spend };
    }
    return { status: 'published', mode: full ? 'full' : 'incremental', cost_usd: spend, sentences: ownerSentences.length + modelSentences.length,
      dropped_uncited: parsed.dropped, gaps: parsed.gaps };
  } catch (e) {
    if (opts.signal?.aborted) {
      await releaseLease(engine, pin.id, token, { error: leased.last_error, spendUsd: spend });
      return { status: 'timeout', cost_usd: spend };
    }
    const message = e instanceof Error ? e.message : String(e);
    const code = message === 'model_output_not_json' ? 'refresh_failed:model_output_not_json'
      : `refresh_failed:${stage === 'model' ? classifyLlmCallFailure(e) : stage}`;
    process.stderr.write(`[questions] refresh of ${pinId(pin)} failed: ${message}\n`);
    await releaseLease(engine, pin.id, token, { error: code, spendUsd: spend });
    return { status: 'failed', error: code, cost_usd: spend };
  }
}
