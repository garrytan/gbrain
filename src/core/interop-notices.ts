/**
 * Lane F notice producers (agent operator contract v1, F3/F8/F9): the
 * model-visible explanations for degraded recall, a source binding that
 * narrowed a read, keyless-by-design answers and the facts the CLI formatter
 * used to invent on its own. Everything here is pure: callers pass the
 * config and the call's result, and emit the returned notices through
 * `ctx.emitNotice` (ops) or dispatch's notice list (MCP). Notices interpolate
 * ids and closed-vocabulary stage names only, never page text.
 */
import { cliRenderContext, renderNotice, type Action, type Notice } from './agent-output.ts';
import { renderCliNotices } from './agent-markers.ts';
import { isInteractive } from './interaction.ts';
import type { GBrainConfig } from './config.ts';
import type { ExplicitReadBinding } from './ops/contract.ts';
import { configReadiness } from './readiness.ts';
import { affectsRecall, type DegradedStage } from './types.ts';
import type { RerankFailedReason } from './search/rerank.ts';
import { localTranscriptsFix } from './transcripts.ts';

// ── degraded recall (F3) ───────────────────────────────────────────────────

type StageFix = 'embeddings' | 'doctor' | null;
interface StageGuidance { why: string; fix: StageFix }

/** Recall-affecting stages: every DEGRADED_STAGES member except the ranking-only ones, plus the verbs' own markers. */
export type RecallStage =
  | Exclude<DegradedStage, 'reranker_skipped'>
  | 'keyword_only_no_embedding_provider' | 'deadline' | 'server_budget';

/**
 * The closed guidance map: what each recall-affecting stage means for the
 * answer, and which fix applies. Pinned exhaustive by its type and by
 * test/mcp-notice-channels.test.ts.
 */
export const DEGRADED_STAGE_GUIDANCE: Readonly<Record<RecallStage, StageGuidance>> = {
  embed_unavailable: { why: 'semantic (vector) search did not run, so matches phrased differently from the query can be missing', fix: 'embeddings' },
  keyword_only_no_embedding_provider: { why: 'semantic (vector) search did not run, so matches phrased differently from the query can be missing', fix: 'embeddings' },
  embed_timeout: { why: 'the embedding provider timed out, so this call fell back to keyword matching', fix: 'doctor' },
  expansion_failed: { why: 'query expansion failed, so synonym-phrased matches can be missing', fix: 'doctor' },
  expansion_partial: { why: 'some query-expansion variants could not be embedded', fix: 'doctor' },
  rescore_skipped: { why: 'the rescoring pass was skipped', fix: 'doctor' },
  vector_arm_failed: { why: 'the vector retrieval arm failed', fix: 'doctor' },
  keyword_arm_failed: { why: 'the keyword retrieval arm failed', fix: 'doctor' },
  title_arm_failed: { why: 'the title retrieval arm failed', fix: 'doctor' },
  budget_dropped_all: { why: 'the token budget dropped every result; raise the budget parameter to see them', fix: null },
  budget_truncated: { why: 'the token budget cut some results; raise the budget parameter to see more', fix: null },
  keyword_zero: { why: 'keyword matching found nothing for these terms', fix: null },
  cache_prestamp: { why: 'this answer came from a cache entry whose original degradation is unknown', fix: null },
  rerank_passthrough: { why: 'the reranker returned nothing usable, so results keep their fused order', fix: null },
  rerank_failed: { why: 'reranking failed, so results keep their fused order', fix: null },
  keyword_relaxed_carried: { why: 'keyword matching was relaxed to find anything at all', fix: null },
  safe_index_pending: { why: 'some pages in scope are still being safety-indexed for agent readers and are withheld until that finishes', fix: 'doctor' },
  vector_candidates_incomplete: { why: 'vector search hit its candidate limit or deadline, so some semantic matches can be missing', fix: null },
  keyword_candidates_incomplete: { why: 'CJK keyword matching hit its deadline or its candidate cap on a large corpus, so some keyword matches can be missing; narrow the search with source_id (the CLI source-id flag), or ask the user to raise search.cjk_keyword_deadline_ms (milliseconds, default 3000)', fix: null },
  projection_pending: { why: 'recently written pages are not in the search index yet', fix: 'doctor' },
  projection_status_unknown: { why: 'whether recent writes are in the search index could not be checked', fix: 'doctor' },
  keyword_count_unavailable: { why: 'the keyword match count did not finish, so how many pages match the query is unknown', fix: null },
  deadline: { why: 'the pack hit its time limit and is partial', fix: null },
  server_budget: { why: 'the server ran out of time budget for this pack', fix: null },
};

const NOT_ABSENCE = 'Treat a thin or empty result as "not found with a degraded search", never as "the brain has nothing on this".';

/** Why each `rerank_failed` reason happened (closed vocabulary: RerankFailedReason). */
const RERANK_REASON_WHY: Readonly<Record<RerankFailedReason, string>> = {
  timeout: 'the reranker did not answer within its timeout',
  budget: 'a spend cap stopped the reranker call',
  rate_limited: 'the reranker provider refused the call for its rate or concurrency limit (HTTP 429)',
  unreachable: 'the reranker endpoint could not be reached (connection refused, DNS or network error; a wrong reranker base URL looks like this)',
  auth: 'the reranker provider rejected its API key (HTTP 401/403)',
  provider_error: 'the reranker provider answered with an error',
};
/** Seconds to wait before repeating the call, for the transient reasons. */
const RERANK_RETRY_AFTER_S: Partial<Record<RerankFailedReason, number>> = { timeout: 5, rate_limited: 20 };
const RERANKER_HEALTH_VERIFY = { argv: ['gbrain', 'doctor', '--only', 'reranker_health', '--json'] };

function rerankReason(reason: string | undefined): RerankFailedReason {
  return reason !== undefined && reason in RERANK_REASON_WHY ? reason as RerankFailedReason : 'provider_error';
}

/**
 * The fix for a failed rerank, per reason: a transient one (timeout, rate
 * limit) repeats the same call after the stated delay (`next: wait`); the
 * rest point at doctor's `reranker_health`, which names the endpoint, key or
 * cap behind the failure. A rejected key is the user's to replace.
 */
function rerankFix(reason: RerankFailedReason, retry?: { op: string; args: Record<string, unknown> }): Action {
  const delay = RERANK_RETRY_AFTER_S[reason];
  if (delay !== undefined && retry) {
    return {
      mcp: { tool: retry.op, arguments: retry.args }, consent: [], actor: 'provider', requires_exclusive: false,
      why: `The results are complete but keep their fused order. If ranking matters, repeat this ${retry.op} call after about ${delay} seconds; if reranking keeps failing, \`gbrain doctor --only reranker_health --json\` on the brain host names the cause.`,
    };
  }
  if (reason === 'auth') {
    return {
      argv: RERANKER_HEALTH_VERIFY.argv, consent: ['credentials'], actor: 'user', requires_exclusive: false, verify: RERANKER_HEALTH_VERIFY,
      why: 'The reranker provider rejected its API key. The user replaces the key in the .env file in the gbrain home directory (never on a command line); doctor confirms the reranker afterwards.',
      user_message: 'Search results are not being reranked because the reranker rejected its API key. Can you check the reranker key (for example VOYAGE_API_KEY) on the brain host?',
    };
  }
  const why = reason === 'unreachable'
    ? "Doctor's reranker_health names the reranker endpoint that could not be reached; the fix is the provider's base URL (provider_base_urls) or the network on the brain host."
    : reason === 'budget'
      ? "Doctor's reranker_health names the spend cap or missing price that stopped reranking; raising a cap is the user's call."
      : "Doctor's reranker_health names the reranker failure and its fix.";
  return { ...doctorFix(why), verify: RERANKER_HEALTH_VERIFY };
}

/** Doctor on the brain host; `run_doctor` where callable (renderAction drops it otherwise). */
export function doctorFix(why: string): Action {
  return { argv: ['gbrain', 'doctor', '--json'], mcp: { tool: 'run_doctor', arguments: {} }, consent: [], actor: 'agent', why, requires_exclusive: false };
}

/**
 * The embeddings fix for a keyword-only call. A brain the user set up keyless
 * (`disabled_by_choice`) gets none: notices never coach on a choice; the why
 * says so and doctor still shows the enable command.
 */
function embeddingsFix(cfg: GBrainConfig | null | undefined, transport: 'stdio' | 'http' | 'cli'): { fix?: Action; byChoice: boolean } {
  if (!cfg) return { fix: doctorFix('Doctor reports why semantic search is unavailable.'), byChoice: false };
  const entry = configReadiness(cfg, { transport }).entries.find(e => e.capability === 'embeddings');
  if (entry?.state === 'disabled_by_choice') return { byChoice: true };
  return { fix: entry && entry.state !== 'ok' && entry.fix ? entry.fix : doctorFix('Embeddings are configured but did not answer; doctor reports the provider failure.'), byChoice: false };
}

/**
 * One `degraded_recall` notice for the recall-affecting stages of this call; null when none applies.
 * A `rerank_failed` stage names its reason, the fallback (fused order) and, when the caller counts them
 * (`rerankDegradedCalls`), this session's reranker-degraded calls; its fix follows the reason (`retry`
 * is the call to repeat after a transient failure) when no other stage needs a fix.
 */
export function degradedRecallNotice(
  stages: ReadonlyArray<{ stage?: string; reason?: string } | string>,
  opts: { config?: GBrainConfig | null; transport: 'stdio' | 'http' | 'cli'; optedOut?: boolean; rerankDegradedCalls?: number; retry?: { op: string; args: Record<string, unknown> } },
): Notice | null {
  const entries = stages.map(s => (typeof s === 'string' ? { stage: s } : s));
  const names = [...new Set(entries
    .filter(s => affectsRecall(s) && (s.stage as string) in DEGRADED_STAGE_GUIDANCE)
    .map(s => s.stage as RecallStage))];
  if (names.length === 0) return null;
  const rerank = names.includes('rerank_failed') ? rerankReason(entries.find(s => s.stage === 'rerank_failed')?.reason) : undefined;
  const labels = names.map(n => (n === 'rerank_failed' ? `rerank_failed: ${rerank}` : n));
  const whys = names.map(n => (n === 'rerank_failed'
    ? `reranking failed because ${RERANK_REASON_WHY[rerank!]}, so results keep their fused order (fallback: fused_order${opts.rerankDegradedCalls ? `; reranker-degraded calls this session: ${opts.rerankDegradedCalls}` : ''})`
    : DEGRADED_STAGE_GUIDANCE[n].why));
  const guidance = names.map(n => DEGRADED_STAGE_GUIDANCE[n]);
  const fixKind: StageFix = guidance.some(g => g.fix === 'embeddings') ? 'embeddings' : guidance.some(g => g.fix === 'doctor') ? 'doctor' : null;
  const byChoice = opts.optedOut || entries.some(s => s.reason === 'embedding_disabled');
  const emb = fixKind === 'embeddings' ? (byChoice ? { byChoice: true } as { fix?: Action; byChoice: boolean } : embeddingsFix(opts.config, opts.transport)) : undefined;
  const fix = emb ? emb.fix
    : fixKind === 'doctor' ? doctorFix('Doctor names the failing retrieval dependency and its fix.')
    : rerank ? rerankFix(rerank, opts.retry) : undefined;
  const choice = emb?.byChoice ? ' This brain was set up keyword-only by the user\'s choice; mention it only if the user asks why something was not found. No query text was sent to an embedding provider. If the user wants semantic search, `gbrain doctor --json` names the enable command; turning it on needs their consent.' : '';
  return {
    code: 'degraded_recall',
    kind: 'degraded',
    why: `Recall was degraded (${labels.join(', ')}): ${whys.join('; ')}. ${NOT_ABSENCE}${choice}`,
    ...(fix ? { fix } : {}),
    ...(fix?.user_message ? { user_message: fix.user_message } : {}),
  };
}

// ── source binding narrowed (F3, TODOS #5250) ──────────────────────────────

const BINDING_READ_OPS: ReadonlySet<string> = new Set(['search', 'query', 'recall', 'list_pages']);

function emptyRead(op: string, result: unknown): boolean {
  if (Array.isArray(result)) return result.length === 0;
  if (op !== 'recall' || !result || typeof result !== 'object') return false;
  const r = result as { facts?: unknown[]; results?: unknown[] };
  return (r.facts?.length ?? 0) === 0 && (r.results?.length ?? 0) === 0;
}

/**
 * A stdio connection bound by GBRAIN_SOURCE / `.gbrain-source` whose
 * unqualified read came back empty while other sources are readable: say the
 * binding narrowed it and name the explicit read that widens it.
 */
export function sourceBindingNarrowedNotice(
  op: string, params: Record<string, unknown>, result: unknown, binding: ExplicitReadBinding | undefined,
): Notice | null {
  if (!binding || !BINDING_READ_OPS.has(op) || params.source_id !== undefined || !emptyRead(op, result)) return null;
  const others = binding.sourceIds.filter(id => id !== binding.sourceId);
  const optedOut = binding.optedOut.filter(id => id !== binding.sourceId && !others.includes(id));
  if (others.length === 0 && optedOut.length === 0) return null;
  const { _meta: _ignored, ...args } = params;
  const parts = [
    `This connection is bound to source '${binding.sourceId}' by ${binding.via}, so this unqualified ${op} read only that source and found nothing there.`,
    others.length ? `Also readable with an explicit source_id: ${others.join(', ')}.` : '',
    optedOut.length ? `Not readable from this connection (opted out of federated reads): ${optedOut.join(', ')}.` : '',
  ].filter(Boolean);
  return {
    code: 'source_binding_narrowed',
    kind: 'info',
    why: parts.join(' '),
    ...(others.length ? {
      fix: {
        mcp: { tool: op, arguments: { ...args, source_id: others[0] } },
        consent: [], actor: 'agent' as const, requires_exclusive: false,
        why: `Repeats the read in '${others[0]}'${others.length > 1 ? `; repeat for ${others.slice(1).join(', ')}` : ''}.`,
      },
    } : {}),
  };
}

// ── keyless chat answers (F8/F9) ───────────────────────────────────────────

/**
 * The chat-key fix for synthesize/think on a keyless brain: a key enables
 * paid calls, so the agent asks; both providers are named; the user stores
 * the key themselves (never on a command line); the free fallback is named.
 */
export function chatKeyFix(): Action {
  return {
    argv: ['gbrain', 'providers', 'list'],
    consent: ['credentials', 'paid'],
    actor: 'user',
    why: 'Synthesis needs a chat-model API key, and every synthesized answer is a paid call. Either provider works: Anthropic (ANTHROPIC_API_KEY) or OpenAI (OPENAI_API_KEY). The user adds `NAME=<key>` to the .env file in the gbrain home directory (or exports it for every gbrain process); a key is never passed on a command line. `gbrain providers list` shows what each provider needs. Free fallback meanwhile: recall, search and get_page work without a key, so answer from their results.',
    user_message: 'Synthesized answers need a chat-model API key (Anthropic or OpenAI), and each answer costs a little. Want to add one? Until then I can still answer from your notes directly.',
    verify: { argv: ['gbrain', 'doctor', '--only', 'facts_extraction_health', '--json'] },
    requires_exclusive: false,
  };
}

/** think on a keyless brain: retrieval-only output is by design, not a failure. */
export function keylessThinkNotice(): Notice {
  return {
    code: 'synthesis_keyless',
    kind: 'info',
    why: 'No chat-model key is configured, so think returned the gathered evidence without a synthesized answer (by design on a keyless brain). Answer from the gathered pages yourself (read them with get_page), or ask the user about adding a key.',
    fix: chatKeyFix(),
  };
}

/** think with save/take over MCP: persistence is local-CLI only, so `saved_slug` is null. */
export function thinkNotSavedNotice(): Notice {
  return {
    code: 'think_not_saved',
    kind: 'info',
    why: 'save/take persist only for the local CLI caller, so this answer was not saved (saved_slug: null). To keep it, save the key facts with remember, or ask the user to run `gbrain think --save` with this question on the brain host.',
  };
}

/** remember without an embedding provider: duplicate detection is exact-match only. */
export function degradedDedupNotice(cfg?: GBrainConfig | null): Notice {
  const fix = cfg ? embeddingsFix(cfg, 'stdio').fix : undefined;
  return {
    code: 'degraded_dedup',
    kind: 'info',
    why: 'No embedding provider is configured, so remember detects only exact duplicates; a near-duplicate phrasing of an existing fact inserts a second fact. Recall first when unsure whether a fact is already saved.',
    ...(fix?.consent.length ? { fix } : {}),
  };
}

// ── dispatch producer ──────────────────────────────────────────────────────

/** think's warning when the brain opted out of embedding and the question was never embedded. */
export const QUESTION_EMBED_OPTED_OUT = 'QUESTION_EMBED_SKIPPED_EMBEDDING_DISABLED';
/** recall's `search_degraded` when the brain opted out of embedding. */
export const RECALL_KEYWORD_ONLY_OPTED_OUT = 'keyword_only_embedding_disabled';
const VECTOR_FALLBACK_WARNINGS: ReadonlySet<string> = new Set(['QUESTION_EMBED_FAILED', QUESTION_EMBED_OPTED_OUT]);

/** Did this call run keyword-only because the brain opted out of embedding (not a missing or failing provider)? */
export function embeddingOptedOutFor(op: string, result: unknown, meta: Record<string, unknown>): boolean {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  if (op === 'search' || op === 'query') {
    const retrieval = meta.retrieval as { degraded?: Array<{ stage?: string; reason?: string }> } | undefined;
    return (retrieval?.degraded ?? []).some(d => d.reason === 'embedding_disabled');
  }
  if (op === 'recall') return r.search_degraded === RECALL_KEYWORD_ONLY_OPTED_OUT;
  if (op === 'think') return Array.isArray(r.warnings) && r.warnings.includes(QUESTION_EMBED_OPTED_OUT);
  return false;
}

/** Recall-affecting stages of one successful call, from its result and the handler-emitted `retrieval` meta. */
export function recallStagesFor(op: string, result: unknown, meta: Record<string, unknown>, cfg?: GBrainConfig | null): string[] {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
  if (op === 'search' || op === 'query') {
    const retrieval = meta.retrieval as { degraded?: Array<{ stage?: string; reason?: string }> } | undefined;
    return (retrieval?.degraded ?? []).filter(affectsRecall).map(d => d.stage as string);
  }
  if (op === 'recall') return typeof r.search_degraded === 'string' ? ['keyword_only_no_embedding_provider'] : [];
  if (op === 'context_pack') return typeof r.degraded_reason === 'string' ? [r.degraded_reason] : [];
  if (op === 'think') {
    const warned = Array.isArray(r.warnings) && r.warnings.some(w => VECTOR_FALLBACK_WARNINGS.has(String(w)));
    const keyless = !!cfg && configReadiness(cfg, { transport: 'stdio' }).entries.some(e => e.capability === 'embeddings' && e.state !== 'ok' && e.state !== 'not_applicable');
    return warned || keyless ? ['embed_unavailable'] : [];
  }
  return [];
}

/**
 * The MCP dispatch producer (one call per successful tool call): the
 * `degraded_recall` notice on search/query/recall/think/context_pack and
 * `source_binding_narrowed` on an empty bound stdio read. Never throws.
 */
export function recallInteropNotices(
  op: string, result: unknown, meta: Record<string, unknown>, params: Record<string, unknown>,
  opts: { config?: GBrainConfig | null; transport: 'stdio' | 'http' | 'cli'; binding?: ExplicitReadBinding; rerankDegradedCalls?: number },
): Notice[] {
  try {
    const out: Notice[] = [];
    const entries = (meta.retrieval as { degraded?: Array<{ stage?: string; reason?: string }> } | undefined)?.degraded ?? [];
    const stages = recallStagesFor(op, result, meta, opts.config).map(stage => entries.find(d => d.stage === stage) ?? stage);
    const { _meta: _ignored, ...args } = params;
    const degraded = degradedRecallNotice(stages, { ...opts, optedOut: embeddingOptedOutFor(op, result, meta), retry: { op, args } });
    if (degraded) out.push(degraded);
    const narrowed = opts.transport === 'stdio' ? sourceBindingNarrowedNotice(op, params, result, opts.binding) : null;
    if (narrowed) out.push(narrowed);
    return out;
  } catch {
    return [];
  }
}

// ── local transcripts behind a CLI-only reader (F5 follow-up) ─────────────

/** Read ops whose answers can wrongly read as "no transcripts" when the transcript reader is not callable here. */
const TRANSCRIPT_HINT_OPS: ReadonlySet<string> = new Set(['search', 'query', 'recall', 'context_pack', 'list_pages']);

/** A request about the user's own recent activity (sessions, conversations, promises, this week...). */
const PERSONAL_ACTIVITY_RE = /\b(transcripts?|sessions?|conversations?|chats?|promis\w*|said|told|discuss\w*|talked|coding|this week|last week|yesterday|today|recent(ly)?|worked on)\b/i;

/**
 * Whether a successful read on a connection that cannot call
 * `get_recent_transcripts` should be told that local transcripts exist:
 * list_pages when it came back empty; search/query/recall/context_pack when
 * the request is about the user's own activity or came back empty.
 */
export function wantsTranscriptHint(op: string, params: Record<string, unknown>, result: unknown): boolean {
  if (!TRANSCRIPT_HINT_OPS.has(op)) return false;
  const empty = emptyRead(op === 'context_pack' ? 'recall' : op, result);
  if (op === 'list_pages') return empty;
  const text = ['query', 'question', 'topic', 'task', 'q'].map(k => params[k]).filter(v => typeof v === 'string').join(' ');
  return empty || PERSONAL_ACTIVITY_RE.test(text);
}

/**
 * `local_transcripts`: the brain host keeps raw session transcripts that
 * pages and search do not cover, and this connection cannot call their
 * reader. Names where they are (stdio only: the owner's own pipe; HTTP never
 * learns host paths) and the CLI read, so "no transcripts" is never the answer.
 * Read-only pointer: no trust is widened (the tool stays uncallable here).
 */
export function localTranscriptsNotice(presence: { dirs: string[]; count: number }): Notice | null {
  if (presence.count === 0) return null;
  const where = presence.dirs.length ? ` in ${presence.dirs.join(', ')}` : '';
  return {
    code: 'local_transcripts',
    kind: 'info',
    why: `This brain host keeps ${presence.count} recent session transcript file(s)${where} (from the last 7 days). They are raw host files, not pages, so search, query, recall and list_pages never return them, and get_recent_transcripts is not callable on this connection. `
      + 'Read them with the command in fix (from a shell on this machine; otherwise ask the user to run it), or read those .txt files directly if you have a shell here. Never answer "no transcripts" or "no notes" from a page search alone.',
    fix: localTranscriptsFix(),
    user_message: 'Your recent session transcripts are on this machine but not in the searchable pages. I can read them with `gbrain transcripts recent --json`; want me to, or can you run it and share the output?',
  };
}

// ── CLI emission for commands without a result document (F7) ──────────────

/**
 * Write notices from a CLI command's human path: a terminal gets readable
 * stderr lines, a non-interactive caller (an agent) gets `[AGENT]` blocks on
 * stdout, and a `--json` invocation keeps stdout for its document (stderr).
 * Never throws.
 */
export function writeCliNotices(notices: readonly Notice[]): void {
  try {
    if (notices.length === 0) return;
    const rendered = notices.map(n => renderNotice(n, cliRenderContext()));
    const args = process.argv.slice(2);
    const end = args.indexOf('--');
    const json = (end < 0 ? args : args.slice(0, end)).some(a => a === '--json' || a === '--json=true');
    const out = renderCliNotices(rendered, { json: false, tty: isInteractive(), stdoutIsData: json });
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr);
  } catch { /* coaching never breaks a command */ }
}
