/**
 * recall's `question` ranking (MEMORY_VERBS v1 additive field): active facts
 * ranked by relevance to the question instead of by recency, inside any
 * `entity`, `session_id`, `since` or `grep` filter. The candidate pool and
 * the score are fact-relevance.ts's (shared with the temporal fact reserve);
 * the read policy is recall's own (source scope, trust floor, quarantine and
 * rederive hiding, remote world-only plus the private-provenance filter).
 * Facts below the admission rule are not returned, so an empty list is a
 * valid answer. One query embedding per call, no model call; the brain's
 * embedding opt-out, a missing provider or a failed embed rank by term share
 * alone and say so in `facts_degraded`.
 */
import type { BrainEngine, FactRow } from '../engine.ts';
import type { Action, Notice } from '../agent-output.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { MEMORY_VERBS_VERSION } from '../verbs.ts';
import { isAvailable } from '../ai/gateway.ts';
import { rowToFact, type FactRowSqlShape } from '../engine-sql/facts.ts';
import { loadEmbeddingQueryPrefix } from '../search/query-prefix.ts';
import { embedQueryBounded, makeQueryEmbedDeadline } from '../search/hybrid.ts';
import { resolveHnswIterativeScan } from '../search/hnsw-iterative-scan.ts';
import {
  QUESTION_ADMISSION_RULES, admitted, collectFactCandidates, countUncomparableFacts, poolEntityPairs, queryTerms, scoreFactCandidates,
  type FactPoolFilters, type FactPoolScope, type QuestionAdmissionRule,
} from '../search/fact-relevance.ts';

export const QUESTION_MAX_CHARS = 2000;
/** Candidates per arm, separate from the output `limit`. */
export const QUESTION_POOL_DEPTH = 100;
/** Which preregistered admission rule ranks recall's `question` (dev-tuned): `reserve` (default) or `facts_arm`. */
export const QUESTION_ADMISSION_KEY = 'recall.question_admission';

export interface FactsDegraded {
  /** Why the cosine arm did not run: recall's search_degraded strings, or no_query_terms. */
  reason?: string;
  /** Facts in the authorized pool the cosine arm could not compare (no vector, another model, a stale hash or other dimensions). */
  unembedded?: number;
}

export type EntityCandidate = { source_id: string; entity_slug: string };

/**
 * The identity key is (source_id, slug): an entity name resolved in several
 * granted sources names different entities unless an entity-identity group
 * links their pages. Merging them would hand the caller a stranger's facts,
 * so federated recall refuses unlinked namesakes and names the candidates.
 * Returns null when the per-source fact lists are one entity.
 */
export async function unlinkedNamesakes(engine: BrainEngine, lists: Array<Array<{ source_id: string; entity_slug: string | null }>>): Promise<EntityCandidate[] | null> {
  const candidates = [...new Map(lists.flat().map((r): [string, EntityCandidate] =>
    [`${r.source_id}:${r.entity_slug}`, { source_id: r.source_id, entity_slug: r.entity_slug as string }])).values()];
  if (candidates.length < 2) return null;
  const { identityIdsForPages } = await import('../entity-identity.ts');
  const ids = await identityIdsForPages(engine, candidates.map(c => ({ sourceId: c.source_id, slug: c.entity_slug })));
  const groups = new Set(candidates.map(c => ids.get(`${c.source_id}:${c.entity_slug}`) ?? null));
  return groups.size === 1 && !groups.has(null) ? null : candidates;
}

/** The call's arguments without transport metadata, for retry fixes. */
function callArgs(p: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(p).filter(([k, v]) => !k.startsWith('_') && v !== undefined));
}

const ARGV_FLAGS: Record<string, string> = { question: '--question', query: '--query', entity: '', since: '--since', session_id: '--session-id', grep: '--grep', limit: '--limit', source_id: '--source-id' };

/** The CLI form of a recall call, for the flags the CLI has. */
export function recallArgv(args: Record<string, unknown>): string[] {
  const argv = ['gbrain', 'recall'];
  for (const [k, flag] of Object.entries(ARGV_FLAGS)) {
    const v = args[k];
    if (v === undefined || v === null || v === '') continue;
    if (flag) argv.push(flag);
    argv.push(String(v));
  }
  return argv;
}

/** An `invalid_params` refusal whose fix is the same recall with `retry` arguments. */
function invalidQuestionCall(message: string, suggestion: string, retry: Record<string, unknown>, why: string) {
  const e = opError('invalid_params', message, suggestion, {
    fix: { argv: recallArgv(retry), mcp: { tool: 'recall', arguments: retry }, consent: [], actor: 'agent', requires_exclusive: false, why },
  });
  e.protocolVersion = MEMORY_VERBS_VERSION;
  return e;
}

/**
 * The validated `question`, or null when absent. Refuses the combinations
 * ranking cannot honor (`supersessions`, `include_expired`) and an over-long
 * question, each with the corrected call as its fix.
 */
export function parseQuestionParam(p: Record<string, unknown>): string | null {
  if (p.question === undefined || p.question === null) return null;
  const args = callArgs(p);
  if (typeof p.question !== 'string') {
    const { question: _q, ...rest } = args;
    throw invalidQuestionCall(`question must be a string, got ${typeof p.question}.`, 'Pass question as a string, or omit it to read facts newest first.', rest, 'The same recall without question.');
  }
  const question = p.question.trim();
  if (!question) return null;
  if (p.supersessions === true) {
    const { supersessions: _s, ...rest } = args;
    throw invalidQuestionCall('question cannot be combined with supersessions: the supersession log is ordered by when facts were replaced, not ranked.',
      'Drop supersessions to rank active facts, or drop question to read the supersession log.', rest, 'The same recall without supersessions.');
  }
  if (p.include_expired === true) {
    const { include_expired: _e, ...rest } = args;
    throw invalidQuestionCall('question cannot be combined with include_expired: ranking runs over active facts only.',
      'Drop include_expired to rank active facts, or drop question to list expired facts newest first.', rest, 'The same recall without include_expired.');
  }
  if (question.length > QUESTION_MAX_CHARS) {
    throw invalidQuestionCall(`question is ${question.length} characters; the limit is ${QUESTION_MAX_CHARS}.`,
      `Shorten question to at most ${QUESTION_MAX_CHARS} characters.`, { ...args, question: question.slice(0, QUESTION_MAX_CHARS) }, `The same recall with question cut to ${QUESTION_MAX_CHARS} characters.`);
  }
  return question;
}

/** The configured admission rule; the default (`reserve`) on an unset or unreadable key. */
async function admissionRule(engine: BrainEngine): Promise<QuestionAdmissionRule> {
  const raw = (await engine.getConfig(QUESTION_ADMISSION_KEY).catch(() => null))?.trim().toLowerCase();
  return (QUESTION_ADMISSION_RULES as readonly string[]).includes(raw ?? '') ? raw as QuestionAdmissionRule : 'reserve';
}

/** One bounded query embedding for the question, or why there is none. */
async function questionEmbedding(ctx: OperationContext, question: string): Promise<{ embedding: Float32Array | null; reason?: string }> {
  const { factEmbeddingDisabled } = await import('../embedding-disabled.ts');
  if (await factEmbeddingDisabled(ctx.engine, ctx.config)) return { embedding: null, reason: (await import('../interop-notices.ts')).RECALL_KEYWORD_ONLY_OPTED_OUT };
  if (!isAvailable('embedding')) return { embedding: null, reason: 'keyword_only_no_embedding_provider' };
  try {
    const queryPrefix = await loadEmbeddingQueryPrefix(ctx.engine);
    return { embedding: await embedQueryBounded(question, queryPrefix ? { queryPrefix } : undefined, makeQueryEmbedDeadline()) };
  } catch (error) {
    const timedOut = /deadline|timeout|abort/i.test(error instanceof Error ? `${error.name} ${error.message}` : String(error));
    return { embedding: null, reason: timedOut ? 'embed_timeout' : 'embed_unavailable' };
  }
}

/** A database failure while ranking: `unavailable`, never a silent empty list. */
function rankingUnavailable(p: Record<string, unknown>, error: unknown) {
  const args = callArgs(p);
  const verify: Action['verify'] = { argv: ['gbrain', 'doctor', '--json'] };
  const e = opError('unavailable', 'recall could not rank facts for this question: the facts read failed.', 'Retry the same call in a few seconds; if it keeps failing, run `gbrain doctor --json`.', {
    reason: 'facts_read_failed',
    why: `Reading the fact candidates failed (${error instanceof Error ? error.message.slice(0, 160) : 'unknown error'}); an empty list here would read as "no saved facts".`,
    fix: { argv: recallArgv(args), mcp: { tool: 'recall', arguments: args }, consent: [], actor: 'provider', requires_exclusive: false, why: 'Retry the same recall after a few seconds.', verify },
  });
  e.protocolVersion = MEMORY_VERBS_VERSION;
  return e;
}

export interface QuestionRecallInput {
  question: string;
  params: Record<string, unknown>;
  factSources: string[];
  limit: number;
  scope: FactPoolScope;
  entity: string | null;
  sessionId: string | null;
  since: Date | null;
  grep: string | null;
}

export interface QuestionRecall {
  rows: FactRow[];
  /** fact id → relevance (cosine + term share + 0.1 when dated). */
  relevance: Map<number, number>;
  degraded?: FactsDegraded;
  /** The source holding the most uncomparable facts, for the `embed --stale --facts` fix. */
  unembeddedSource?: string;
  ambiguousEntity: EntityCandidate[] | null;
}

/** Active facts ranked by relevance to `question` under recall's read policy and filters. */
export async function rankFactsByQuestion(ctx: OperationContext, input: QuestionRecallInput): Promise<QuestionRecall> {
  const { question, scope } = input;
  const filters: FactPoolFilters = {
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.since ? { since: input.since } : {}),
    ...(input.grep ? { grep: input.grep } : {}),
  };
  const empty = (degraded?: FactsDegraded, ambiguousEntity: EntityCandidate[] | null = null): QuestionRecall => ({ rows: [], relevance: new Map(), ambiguousEntity, ...(degraded ? { degraded } : {}) });
  try {
    if (input.entity) {
      const { resolveEntitySlug } = await import('../entities/resolve.ts');
      filters.entities = await Promise.all(input.factSources.map(async src => ({ sourceId: src, slug: (await resolveEntitySlug(ctx.engine, src, input.entity!)) ?? input.entity! })));
      const ambiguous = await unlinkedNamesakes(ctx.engine, [await poolEntityPairs(ctx.engine, scope, filters)]);
      if (ambiguous) return empty(undefined, ambiguous);
    }
  } catch (error) {
    throw rankingUnavailable(input.params, error);
  }
  const { embedding, reason } = await questionEmbedding(ctx, question);
  if (!embedding && queryTerms(question).length === 0) return empty({ reason: 'no_query_terms' });
  try {
    const pool = await collectFactCandidates(ctx.engine, question, scope, embedding, {
      depth: { keyword: QUESTION_POOL_DEPTH, cosine: QUESTION_POOL_DEPTH, entity: QUESTION_POOL_DEPTH }, filters, cosineForAll: true,
      hnswIterativeScan: resolveHnswIterativeScan(ctx.config),
    });
    const rule = await admissionRule(ctx.engine);
    const ranked = scoreFactCandidates(question, pool.candidates).filter(s => admitted(s, rule)).slice(0, input.limit);
    const uncomparable = embedding && pool.column ? await countUncomparableFacts(ctx.engine, scope, filters, embedding.length) : [];
    const unembedded = uncomparable.reduce((n, r) => n + r.n, 0);
    const why = reason ?? (embedding && !pool.column ? 'facts_embedding_column_missing' : undefined);
    const degraded: FactsDegraded | undefined = why || unembedded ? { ...(why ? { reason: why } : {}), ...(unembedded ? { unembedded } : {}) } : undefined;
    const ids = ranked.map(s => s.candidate.id);
    const raw = ids.length
      ? await ctx.engine.executeRaw<FactRowSqlShape>('SELECT * FROM facts WHERE source_id = ANY($1::text[]) AND id = ANY($2::bigint[])', [input.factSources, ids])
      : [];
    const byId = new Map(raw.map(r => { const row = rowToFact(r); return [row.id, { ...row, embedding: null }] as const; }));
    return {
      rows: ids.flatMap(id => byId.get(id) ?? []),
      relevance: new Map(ranked.map(s => [s.candidate.id, Math.round(s.score * 1e4) / 1e4])),
      ambiguousEntity: null,
      ...(degraded ? { degraded } : {}),
      ...(uncomparable[0] ? { unembeddedSource: uncomparable[0].source_id } : {}),
    };
  } catch (error) {
    throw rankingUnavailable(input.params, error);
  }
}

/**
 * TC7: a recall that passed `query` but no `question` and no fact filter got
 * its facts newest first; the hint names `question` and carries the same call
 * with it added.
 */
export function recallHintNotice(p: Record<string, unknown>, queryText: string): Notice {
  const retry = { ...callArgs(p), question: queryText };
  return {
    code: 'recall_hint',
    kind: 'info',
    why: 'The facts in this response are the newest saved facts: `query` searches pages and does not rank facts. `question` ranks saved facts by relevance to a question (it does not search pages).',
    fix: { argv: recallArgv(retry), mcp: { tool: 'recall', arguments: retry }, consent: [], actor: 'agent', requires_exclusive: false,
      why: 'The same recall with question set to the query, so saved facts come back ranked by relevance and pages are still searched.' },
  };
}

/** Notices for a question-ranked recall: facts the cosine arm could not compare, with the preview-then-approve embed fix. */
export function questionRecallNotices(ranking: QuestionRecall): Notice[] {
  const n = ranking.degraded?.unembedded ?? 0;
  if (!n || !ranking.unembeddedSource) return [];
  const base = ['gbrain', 'embed', '--stale', '--facts', '--source', ranking.unembeddedSource];
  return [{
    code: 'facts_unembedded',
    kind: 'degraded',
    why: `${n} saved fact(s) in scope have no embedding this brain can compare with the question (none stored, another embedding model, a changed text or other dimensions), so they were ranked by word overlap alone and a relevant one can be missing.`,
    fix: {
      argv: [...base, '--dry-run'], consent: [], actor: 'agent', requires_exclusive: false,
      why: `Previews how many facts in source ${ranking.unembeddedSource} need embedding and what it costs; writes nothing.`,
      then: { argv: [...base, '--yes', '--max-cost-usd', '<usd>'], consent: ['paid'], actor: 'agent', requires_exclusive: false,
        inputs: [{ name: 'usd', how: 'The dollar cap the user approved after seeing the preview.' }],
        why: 'Embeds those facts within the approved cost cap.' },
    },
  }];
}
