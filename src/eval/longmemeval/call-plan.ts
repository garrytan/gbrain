/**
 * call-plan.ts — `gbrain eval longmemeval --call-plan FILE`: writes gstack's
 * eval call plan (wire format GSTACK_EVAL_CALLS v1, gstack docs/eval-calls.md)
 * for the exact run the other flags describe, then exits 0. No provider is
 * called and no brain is opened: the command parses and resolves the run
 * (flags, pins, mode knobs, models, question filters) exactly as a real run
 * does, then hands the result here before any engine or client exists.
 *
 * One row per active lane (purposes from the lane inventory: expansion,
 * embed_doc, embed_query, rerank, trajectory_extract, synopsis, fact_keys,
 * reader, judge). Haystacks are chunked offline with the importer's pure
 * functions, so trajectory_extract and synopsis call counts are exact; every
 * other count is exact or an upper bound, never an estimate below the run.
 * Token counts use ONE rule, `ceil(chars / CALL_PLAN_CHARS_PER_TOKEN)`, on
 * the real prompt text each lane builds. out_tokens = calls × max_out_tokens.
 *
 * INVARIANTS:
 *   - A lane the planner cannot bound (`--decide*`, `--via-operation`, an
 *     expansion model with no known output default, the LLM intent tie-break)
 *     refuses with a message and a non-zero exit; nothing is written.
 *   - The file is complete or absent: FILE.tmp is written, then renamed.
 *   - Caches and the resume skip are not subtracted (they live outside the
 *     repository and cannot be bound to HEAD); `--expansion-replay` turns the
 *     expansion lane off, and its file sets the query-embed count.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from '../../core/spawn.ts';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { haystackToPages } from './adapter.ts';
import { EXTRACTOR_MAX_TOKENS, EXTRACTOR_SYSTEM_PROMPT } from './extract.ts';
import { buildJudgePrompt, JUDGE_MAX_TOKENS } from './judge.ts';
import { selectBackfillRows, type RowLike } from './judge-lane.ts';
import { classifyIntent } from './intent.ts';
import { sessionIdFromSlug } from './metrics.ts';
import { buildReaderUserText, READER_MAX_SESSION_CHARS, type ReaderConfig } from './reader.ts';
import { loadExpansionReplay, readJsonlRows } from './resume.ts';
import { bodyOf, PAPER_FACT_MAX_TOKENS, PAPER_USER_FACT_SYSTEM, paperFactUserPrompt, resolveFactKeyArm, userTurns, type RetrievalArmOptions } from './retrieval-arms.ts';
import type { DatasetQuestion, RetrievalPins } from './run-config.ts';
import { renderChatBlock } from './sanitize.ts';
import type { SynopsisTier, SynopsisTierOptions } from './synopsis-tier.ts';
import type { DecideEvalRun } from '../decide-eval-flags.ts';
import { buildExpansionPrompt } from '../../core/ai/expansion-prompt.ts';
import { embedRequestCeilings, EMBED_MAX_CHARS } from '../../core/ai/embed-batch-plan.ts';
import { getEmbeddingModel, getExpansionModel, thinkingOffOutputCap } from '../../core/ai/gateway.ts';
import { resolveRecipe } from '../../core/ai/model-resolver.ts';
import { observationDateLine } from '../../core/ai/date-grounding.ts';
import { sanitizeText } from '../../core/batch-rows.ts';
import { countCJKAwareWords } from '../../core/cjk.ts';
import { resolveContextualRetrievalMode } from '../../core/contextual-retrieval-resolver.ts';
import { buildContextualPrefix, wrapChunkForEmbedding } from '../../core/embedding-context.ts';
import { resolveMaxChunkTokens } from '../../core/embedding-input-limit.ts';
import { buildExtractorSystem, DEFAULT_EXTRACTION_MAX_TOKENS, MAX_TURN_TEXT_CHARS } from '../../core/facts/extract.ts';
import { screenImportContent } from '../../core/import-screen.ts';
import { prepareMarkdownChunks } from '../../core/markdown-chunks.ts';
import { normalizeModelId } from '../../core/model-id.ts';
import { buildChunkPrompt, buildPagePrompt, SYNOPSIS_SYSTEM_PROMPT } from '../../core/page-summary.ts';
import { capRerankDoc } from '../../core/search/rerank.ts';
import { sanitizeQueryForPrompt } from '../../core/search/expansion.ts';
import type { ResolvedSearchKnobs } from '../../core/search/mode.ts';
import { INJECTION_PATTERNS } from '../../core/think/sanitize.ts';
import { formatTrajectoryBlock } from '../../core/trajectory-format.ts';
import type { ThinkLLMClient } from '../../core/think/index.ts';
import type { ChunkInput } from '../../core/types.ts';

/** The ONE token rule: no provider tokenizer exists in the repo, so every lane counts `ceil(chars / 3)`. */
export const CALL_PLAN_CHARS_PER_TOKEN = 3;
export const planTokens = (text: string): number => Math.ceil(text.length / CALL_PLAN_CHARS_PER_TOKEN);

/** Budget for the structured-output tool block the native expansion path adds (schema + tool-use system text); not in the prompt string. */
export const EXPANSION_TOOL_ALLOWANCE_TOKENS = 1024;
/** Output defaults the AI SDK applies when expansion sends no max_tokens (@ai-sdk/anthropic getModelCapabilities). */
const EXPANSION_DEFAULT_MAX_OUT: ReadonlyArray<{ provider: string; match: string; maxOut: number }> = [
  { provider: 'anthropic', match: 'claude-haiku-4-5', maxOut: 64_000 },
];
const EXPANSION_MAX_VARIANT_CHARS = 500;
/** The longest synopsis the wrapper keeps (embedding-context.ts SUMMARY_HARD_CAP_CHARS). */
const SYNOPSIS_BOUND = 'x'.repeat(300);

const KEYS = ['purpose', 'model', 'calls', 'in_tokens', 'out_tokens', 'max_out_tokens', 'scope'] as const;
export type CallPlanRow = { purpose: string; model: string; calls: number; in_tokens: number; out_tokens: number; max_out_tokens: number; scope: 'full' | 'smoke' };
export interface CallPlan { gate: string; head: string; inputs: { path: string; sha256: string }[]; preconditions: string[]; rows: CallPlanRow[] }

/** gstack's reference emitter (docs/eval-calls.md `formatEvalCalls`), copied. */
export function formatEvalCalls(p: CallPlan): string {
  return [
    '# gstack eval call plan, wire format v1 (docs/eval-calls.md); priced by `gstack-eval-plan price-gate`, never executed',
    `GSTACK_EVAL_GATE v1: ${p.gate}`,
    `GSTACK_EVAL_HEAD v1: ${p.head}`,
    ...p.inputs.map(i => `GSTACK_EVAL_INPUT v1: sha256=${i.sha256} path=${i.path}`),
    ...p.preconditions.map(t => `GSTACK_EVAL_PRECONDITION: ${t}`),
    ...p.rows.map(r => `GSTACK_EVAL_CALLS v1: ${KEYS.map(k => `${k}=${r[k]}`).join(' ')}`),
    `GSTACK_EVAL_CALLS v1 end: lines=${p.rows.length}`,
  ].join('\n') + '\n';
}

/** POSIX shell quoting, applied only when the word needs it. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The gate command: `gbrain eval longmemeval` + argv without `--call-plan FILE` / `--call-plan-gate CMD`. */
export function gateCommand(args: readonly string[]): string {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--call-plan' || a === '--call-plan-gate') { i++; continue; }
    if (a.startsWith('--call-plan=') || a.startsWith('--call-plan-gate=')) continue;
    kept.push(a);
  }
  return ['gbrain', 'eval', 'longmemeval', ...kept.map(shellQuote)].join(' ');
}

export class CallPlanRefusal extends Error {
  constructor(message: string) { super(message); this.name = 'CallPlanRefusal'; }
}

/** The parsed run (structurally the command's ParsedArgs). */
export interface CallPlanArgs {
  datasetPath?: string;
  questionIdsPath?: string;
  callPlanPath?: string;
  callPlanGate?: string;
  model?: string;
  retrievalOnly: boolean;
  keywordOnly: boolean;
  expansion: boolean;
  expansionReplayPath?: string;
  topK: number;
  noTrajectory: boolean;
  resumeFromPath?: string;
  judge: boolean;
  judgeModel: string;
  maxUsd: number | null;
  arms: RetrievalArmOptions;
  synopsis: SynopsisTierOptions;
  viaOp: { op?: string };
}

export interface LmeCallPlanInput {
  args: readonly string[];
  opts: CallPlanArgs;
  questions: DatasetQuestion[];
  questionByQid: ReadonlyMap<string, DatasetQuestion>;
  pins: RetrievalPins;
  knobs: ResolvedSearchKnobs;
  synopsis: SynopsisTier | null;
  model: string;
  extractorModel: string;
  readerConfig: ReaderConfig;
  decide: DecideEvalRun | null;
  judgeHashFor: (row: RowLike) => string;
}

interface PlannedPage { slug: string; content: string; date?: string; title: string; chunks: ChunkInput[] }

const NO_CLIENT: ThinkLLMClient = { create: async () => { throw new Error('call plan: no provider call is allowed'); } } as unknown as ThinkLLMClient;

function git(root: string, argv: string[]): Buffer {
  return execFileSync('git', ['-C', root, ...argv], { stdio: ['ignore', 'pipe', 'ignore'] });
}

function envState(names: string[]): string {
  return names.map(n => `${n} ${process.env[n]?.trim() ? 'set' : 'unset'}`).join(', ');
}

/** An INPUT line for a tracked, unmodified repo file; otherwise a PRECONDITION with its sha256 and basename. */
function bindInput(root: string, path: string, label: string, plan: CallPlan): void {
  const abs = resolve(path);
  const rel = relative(root, abs);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    try {
      git(root, ['ls-files', '--error-unmatch', '--', rel]);
      git(root, ['diff', '--quiet', 'HEAD', '--', rel]);
      plan.inputs.push({ path: rel.split('\\').join('/'), sha256: createHash('sha256').update(git(root, ['cat-file', 'blob', `HEAD:${rel}`])).digest('hex') });
      return;
    } catch { /* untracked or modified: not bindable */ }
  }
  const sha = createHash('sha256').update(readFileSync(abs)).digest('hex');
  plan.preconditions.push(`${label} ${basename(abs)} sha256=${sha} is not a tracked unmodified file of this repository, so it is not bound to HEAD; the run must read these bytes`);
}

async function planPages(q: DatasetQuestion, maxTokens: number): Promise<PlannedPage[]> {
  const dates = q.haystack_dates ?? [];
  return Promise.all(haystackToPages(q).map(async (p, i) => {
    const screen = screenImportContent({ content: p.content, path: `${p.slug}.md`, fences: 'lenient' });
    if (screen.status !== 'importable' || !screen.parsed) return { ...p, date: dates[i], title: '', chunks: [] };
    const parsed = screen.parsed;
    const body = screen.fences?.fixes.length ? screen.fences.after : { compiled_truth: parsed.compiled_truth, timeline: parsed.timeline ?? '' };
    const chunks = await prepareMarkdownChunks({ compiled_truth: sanitizeText(body.compiled_truth), timeline: sanitizeText(body.timeline), frontmatter: parsed.frontmatter }, maxTokens);
    return { ...p, date: dates[i], title: sanitizeText(parsed.title), chunks };
  }));
}

/** Requests and input tokens `embedBatch(texts)` sends (100-text slices, then the gateway's request plan). */
function embedCost(texts: string[], model: string): { calls: number; tokens: number } {
  const envCap = parseInt(process.env.GBRAIN_EMBED_MAX_BATCH_TOKENS ?? '', 10);
  let calls = 0;
  let tokens = 0;
  for (let i = 0; i < texts.length; i += 100) {
    const slice = texts.slice(i, i + 100).map(t => t.slice(0, EMBED_MAX_CHARS));
    calls += embedRequestCeilings(slice, model, Number.isFinite(envCap) && envCap > 0 ? envCap : undefined).length;
    tokens += slice.reduce((s, t) => s + planTokens(t), 0);
  }
  return { calls, tokens };
}

/** The largest trajectory block the reader can see: 100 one-row groups, every field at its assumed cap. */
function trajectoryBlockBound(): string {
  const field = 'x'.repeat(64);
  const points = Array.from({ length: 100 }, (_, i) => ({
    fact_id: i, valid_from: new Date('2000-01-01T00:00:00Z'), metric: `${field}${i}`, value: -1.2345678901234567e-300, unit: field, period: field,
    event_type: null, text: 'x'.repeat(600), source_session: null, source_markdown_slug: `chat/s-${'0'.repeat(10)}`, embedding: null,
  }));
  return formatTrajectoryBlock(points, `${field}/${field}`, { intent: 'knowledge_update' }).rendered;
}

export async function buildLmeCallPlan(input: LmeCallPlanInput): Promise<CallPlan> {
  const { opts, questions, pins, knobs, synopsis, readerConfig } = input;
  if (input.decide) throw new CallPlanRefusal('--call-plan cannot bound the decide lane (--decide or an inherited GBRAIN_DECIDE_SLOTS): its TypeSafe request shape is not inventoried; plan the run without decide slots');
  if (opts.viaOp.op) throw new CallPlanRefusal('--call-plan cannot bound --via-operation: the operation\'s own expansion, embed and rerank calls are not inventoried');
  if (!opts.keywordOnly && knobs.cross_modal_llm_intent) throw new CallPlanRefusal('--call-plan cannot bound search.cross_modal.llm_intent=true (an LLM intent tie-break per ambiguous question); plan with it off');
  const root = (() => {
    try { return git(import.meta.dir, ['rev-parse', '--show-toplevel']).toString().trim(); } catch { throw new CallPlanRefusal('--call-plan needs gbrain running from a git checkout (GSTACK_EVAL_HEAD binds the plan to a commit)'); }
  })();
  const plan: CallPlan = {
    gate: opts.callPlanGate ?? gateCommand(input.args),
    head: git(root, ['rev-parse', 'HEAD']).toString().trim(),
    inputs: [], preconditions: [], rows: [],
  };
  if (/[\r\n]/.test(plan.gate)) throw new CallPlanRefusal('--call-plan-gate must be one line');
  bindInput(root, opts.datasetPath!, 'dataset', plan);
  if (opts.questionIdsPath) bindInput(root, opts.questionIdsPath, '--question-ids file', plan);
  const replay = opts.expansion && !opts.keywordOnly && opts.expansionReplayPath ? loadExpansionReplay(opts.expansionReplayPath) : null;
  if (replay) bindInput(root, opts.expansionReplayPath!, '--expansion-replay file', plan);

  const rows = new Map<string, CallPlanRow>();
  const add = (purpose: string, model: string, calls: number, inTokens: number, maxOut: number): void => {
    if (calls === 0) return;
    if (/\s/.test(model) || !model) throw new CallPlanRefusal(`--call-plan: lane ${purpose} resolved an unusable model id "${model}"`);
    const r = rows.get(purpose) ?? { purpose, model, calls: 0, in_tokens: 0, out_tokens: 0, max_out_tokens: maxOut, scope: 'full' as const };
    r.calls += calls; r.in_tokens += inTokens; r.out_tokens += calls * maxOut;
    rows.set(purpose, r);
  };

  const embeds = !opts.keywordOnly;
  const factArm = await resolveFactKeyArm(opts.arms, NO_CLIENT);
  const embedModel = embeds || factArm ? (() => { try { return getEmbeddingModel(); } catch { throw new CallPlanRefusal('--call-plan: no embedding model is configured (embedding_model in ~/.gbrain/config.json or GBRAIN_EMBEDDING_MODEL); pass --keyword-only without --fact-keys, or configure one'); } })() : '';
  const maxChunkTokens = resolveMaxChunkTokens();
  const importTitleTier = resolveContextualRetrievalMode({ pageFrontmatter: {}, source: { id: 'default', contextual_retrieval_mode: null, trust_frontmatter_overrides: false },
    globalMode: knobs.contextual_retrieval, killSwitchDisabled: knobs.contextual_retrieval_disabled }).mode !== 'none';
  const expansionLive = opts.expansion && !opts.keywordOnly && !replay;
  let expansionMaxOut = 0;
  const expansionModel = expansionLive ? getExpansionModel() : '';
  if (expansionLive) {
    const { parsed } = resolveRecipe(expansionModel);
    const hit = EXPANSION_DEFAULT_MAX_OUT.find(d => d.provider === parsed.providerId && parsed.modelId.includes(d.match));
    if (!hit) throw new CallPlanRefusal(`--call-plan cannot bound expansion on ${expansionModel}: expansion sends no max_tokens and the provider's output default for that model is not known to the planner; use expansion_model anthropic:claude-haiku-4-5-20251001 or --expansion-replay FILE`);
    expansionMaxOut = hit.maxOut;
  }
  const topNIn = Math.max(knobs.reranker_top_n_in, knobs.diverse_pool_depth);
  const readerModel = normalizeModelId(input.model);
  const trajectoryBound = trajectoryBlockBound();
  const seenExtract = new Set<string>();
  const seenFactBodies = new Set<string>();
  let readerTrajectoryQuestions = 0;

  for (const q of questions) {
    const pages = await planPages(q, maxChunkTokens);
    const question = q.question;
    if (embeds) {
      for (const p of pages) {
        const prefix = importTitleTier ? buildContextualPrefix(p.title, null) : null;
        const doc = embedCost(p.chunks.map(c => wrapChunkForEmbedding(c.chunk_text, prefix, c.chunk_source)), embedModel);
        add('embed_doc', embedModel, doc.calls, doc.tokens, 0);
        if (synopsis && p.chunks.length > 0) {
          const synopsisPrefix = buildContextualPrefix(p.title, SYNOPSIS_BOUND);
          const re = embedCost(p.chunks.map(c => wrapChunkForEmbedding(c.chunk_text, synopsisPrefix, c.chunk_source)), embedModel);
          add('embed_doc', embedModel, re.calls, re.tokens, 0);
        }
      }
      const variants = replay
        ? [question, ...new Set((replay.get(q.question_id) ?? []).filter(v => v !== question))]
        : expansionLive && countCJKAwareWords(question) >= 3 ? [question, 'x'.repeat(EXPANSION_MAX_VARIANT_CHARS), 'x'.repeat(EXPANSION_MAX_VARIANT_CHARS)] : [question];
      add('embed_query', embedModel, variants.length, variants.reduce((s, v) => s + planTokens(v), 0), 0);
    }
    if (expansionLive && countCJKAwareWords(question) >= 3) {
      const sanitized = sanitizeQueryForPrompt(question);
      if (sanitized) add('expansion', expansionModel, 1, planTokens(buildExpansionPrompt(sanitized)) + EXPANSION_TOOL_ALLOWANCE_TOKENS, expansionMaxOut);
    }
    if (pins.reranker.enabled) {
      const docs = pages.flatMap(p => p.chunks.map(c => capRerankDoc(c.chunk_text || p.title || ''))).sort((a, b) => b.length - a.length).slice(0, topNIn);
      add('rerank', pins.reranker.model, docs.length > 0 ? 1 : 0, docs.reduce((s, d) => s + planTokens(question) + planTokens(d), 0), 0);
    }
    if (!opts.noTrajectory) {
      for (const p of pages) {
        const key = createHash('sha256').update(p.content).digest('hex');
        if (seenExtract.has(key)) continue;
        seenExtract.add(key);
        add('trajectory_extract', input.extractorModel, 1, planTokens(EXTRACTOR_SYSTEM_PROMPT) + planTokens(p.content), EXTRACTOR_MAX_TOKENS);
      }
    }
    if (synopsis) {
      const maxOut = thinkingOffOutputCap(synopsis.model, synopsis.maxTokens);
      for (const p of pages) {
        if (p.chunks.length === 0) continue;
        const pagePrompt = planTokens(buildPagePrompt(p.title, p.chunks.filter(c => c.chunk_source !== 'image_asset').map(c => c.chunk_text).join('\n\n')));
        for (const c of p.chunks) {
          if (c.chunk_source === 'fenced_code') continue;
          add('synopsis', synopsis.model, 1, planTokens(SYNOPSIS_SYSTEM_PROMPT) + pagePrompt + planTokens(buildChunkPrompt(c.chunk_text)), maxOut);
        }
      }
    }
    if (factArm) {
      const arm = factArm.arm;
      const thisQuestion = new Set<string>();
      for (const p of pages) {
        const body = bodyOf(p.content);
        let call: { system: string; user: string; maxOut: number } | null = null;
        if (arm.extractor === 'paper') {
          const turns = userTurns(body);
          if (turns) call = { system: PAPER_USER_FACT_SYSTEM, user: paperFactUserPrompt(turns), maxOut: PAPER_FACT_MAX_TOKENS };
        } else {
          let cleaned = body.slice(0, MAX_TURN_TEXT_CHARS);
          for (const pat of INJECTION_PATTERNS) cleaned = cleaned.replace(pat.rx, pat.replacement);
          cleaned = cleaned.trim();
          if (cleaned) call = { system: buildExtractorSystem(true, { dateGrounding: true, attribution: true }), user: `${observationDateLine(null)}\n<turn>\n${cleaned}\n</turn>\n\nExtract up to 10 facts.`, maxOut: DEFAULT_EXTRACTION_MAX_TOKENS };
        }
        if (!call) continue;
        if (!seenFactBodies.has(body)) add('fact_keys', arm.model, 1, planTokens(call.system) + planTokens(call.user), call.maxOut);
        thisQuestion.add(body);
        if (p.chunks.length > 0) {
          const re = embedCost(p.chunks.map(() => 'x'.repeat(EMBED_MAX_CHARS)), embedModel);
          add('embed_doc', embedModel, re.calls, re.tokens, 0);
        }
      }
      for (const b of thisQuestion) seenFactBodies.add(b);
    }
    if (!opts.retrievalOnly) {
      const bySlug = new Map(pages.map(p => [p.slug, p]));
      const rendered = [...bySlug.values()]
        .map(p => ({ s: { session_id: sessionIdFromSlug(p.slug), date: p.date, body: p.content }, n: renderChatBlock([{ session_id: sessionIdFromSlug(p.slug), date: p.date, body: p.content }], { maxSessionChars: READER_MAX_SESSION_CHARS }).rendered.length }))
        .sort((a, b) => b.n - a.n).slice(0, opts.topK).map(x => x.s);
      const routed = !opts.noTrajectory && classifyIntent(q) !== 'other';
      if (routed) readerTrajectoryQuestions++;
      const user = buildReaderUserText({ question, questionDate: typeof q.question_date === 'string' ? q.question_date : undefined, trajectoryBlock: routed ? trajectoryBound : '', rendered: renderChatBlock(rendered, { maxSessionChars: READER_MAX_SESSION_CHARS }).rendered });
      add('reader', readerModel, 1, planTokens(readerConfig.system) + planTokens(user), readerConfig.maxTokens);
    }
    if (opts.judge) {
      const prompt = buildJudgePrompt({ question_id: q.question_id, question_type: q.question_type, question, answer: String(q.answer ?? ''), hypothesis: '' }).prompt;
      add('judge', opts.judgeModel, 1, planTokens(prompt) + readerConfig.maxTokens, JUDGE_MAX_TOKENS);
    }
  }
  if (opts.judge && opts.resumeFromPath && existsSync(opts.resumeFromPath)) {
    const sel = selectBackfillRows(readJsonlRows(opts.resumeFromPath), { questionByQid: input.questionByQid, hashFor: input.judgeHashFor });
    for (const r of sel.candidates) {
      const q = input.questionByQid.get(String(r.question_id))!;
      add('judge', opts.judgeModel, 1, planTokens(buildJudgePrompt({ question_id: q.question_id, question_type: q.question_type, question: q.question, answer: String(q.answer ?? ''), hypothesis: String(r.hypothesis ?? '') }).prompt), JUDGE_MAX_TOKENS);
    }
    if (sel.candidates.length > 0) bindInput(root, opts.resumeFromPath, '--resume-from file (judge backfill rows)', plan);
  }

  const order = ['expansion', 'embed_doc', 'embed_query', 'rerank', 'trajectory_extract', 'synopsis', 'fact_keys', 'reader', 'judge'];
  plan.rows = order.flatMap(p => (rows.has(p) ? [rows.get(p)!] : []));
  const has = (p: string): boolean => rows.has(p);
  const pre = plan.preconditions;
  pre.push(`in_tokens count ceil(chars / ${CALL_PLAN_CHARS_PER_TOKEN}) (CALL_PLAN_CHARS_PER_TOKEN, src/eval/longmemeval/call-plan.ts) over each call's real prompt text and template; no provider tokenizer is in the repo, so text denser than ${CALL_PLAN_CHARS_PER_TOKEN} characters per token (CJK, hex) can exceed it`);
  pre.push('the price is the uncached worst case: the embed, synopsis and fact-key caches under ~/.cache/gbrain-eval and the --resume-from skip are not subtracted; retries and failure-path calls are excluded (AI SDK transport retries, judge timeout/429 retries, synopsis transient retries and title-tier fallback re-embeds, production fact-extractor truncation/malformed retries)');
  pre.push('out_tokens = calls x max_out_tokens, where max_out_tokens is the per-call cap each lane sends: an upper bound');
  if (git(root, ['status', '--porcelain', '--untracked-files=no']).toString().trim()) pre.push('computed from a working tree with uncommitted changes to tracked files; recompute from a clean checkout of HEAD before committing this plan');
  const providers = [...new Set(plan.rows.map(r => r.model.split(':')[0]!))].sort();
  if (providers.length > 0) pre.push(`provider keys for ${providers.join(', ')} set at run time`);
  pre.push('the reader, claim extractor, embedding and rerank lanes have no spend cap in this command');
  pre.push(`${questions.length} question(s) after --question-ids / --limit; haystacks chunked offline at ${maxChunkTokens} max chunk tokens (GBRAIN_MAX_CHUNK_TOKENS or the embedding model's limit), the same functions the import uses`);
  if (has('expansion')) pre.push(`expansion model ${expansionModel} from expansion_model in ~/.gbrain/config.json (default anthropic:claude-haiku-4-5-20251001); expansion sends no max_tokens, so max_out_tokens=${expansionMaxOut} is the AI SDK's default for that model; the structured-output tool block is budgeted at ${EXPANSION_TOOL_ALLOWANCE_TOKENS} tokens per call`);
  if (has('embed_doc') || has('embed_query')) pre.push(`embedding model ${embedModel} from embedding_model in ~/.gbrain/config.json or GBRAIN_EMBEDDING_MODEL (${envState(['GBRAIN_EMBEDDING_MODEL'])}); embed_query counts ${replay ? 'the recorded --expansion-replay variants' : expansionLive ? '3 query variants (the question + 2 rewrites of at most 500 characters) per expanded question' : 'one query per question'}${synopsis ? '; embed_doc includes the synopsis re-embed with a 300-character synopsis per chunk' : ''}${factArm ? '; embed_doc includes a fact-keyed re-embed of every chunk of each extractable session at the 8000-character input cap' : ''}`);
  if (has('rerank')) pre.push(`reranker ${pins.reranker.model} (search.reranker.model pin or snapshot, else the default); rerank in_tokens bound each question's ${topNIn} largest chunks, each sent with the query`);
  if (has('trajectory_extract')) pre.push(`trajectory_extract model ${input.extractorModel} from env GBRAIN_MODEL, else the utility tier default keyed on provider keys (${envState(['GBRAIN_MODEL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])}; ~/.gbrain/config.json keys also count); one call per distinct session page`);
  if (has('synopsis')) pre.push(`synopsis model ${synopsis!.model} from env GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL, else the utility tier default (${envState(['GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY'])}); the synopsis lane honours chat_fallback_chain, whose fallback models are not priced here; spend cap --synopsis-max-usd ${opts.synopsis.maxUsd} stops the run early`);
  if (has('fact_keys')) pre.push(`fact_keys model ${factArm!.arm.model} (${factArm!.arm.extractor} extractor) from --fact-keys-model, else ${factArm!.arm.extractor === 'paper' ? 'env GBRAIN_MODEL or the utility tier default' : 'the facts extraction model'} (${envState(['GBRAIN_MODEL'])}); spend cap --fact-keys-max-usd ${opts.arms.factKeysMaxUsd} errors later questions`);
  if (has('reader')) pre.push(`reader model ${readerModel} from ${opts.model ? '--model' : `env GBRAIN_MODEL, else alias sonnet (${envState(['GBRAIN_MODEL'])})`}; reader in_tokens bound each question's ${opts.topK} largest rendered sessions${readerTrajectoryQuestions > 0 ? ` plus a full trajectory block (100 one-row groups, 500-character row text, 64-character entity/metric/unit/period) on ${readerTrajectoryQuestions} routed question(s)` : ''}`);
  if (has('judge')) pre.push(`judge model ${opts.judgeModel} (--judge-model, default openai:gpt-4o); live hypotheses are bounded at the reader's ${readerConfig.maxTokens} max tokens; spend cap --max-usd ${opts.maxUsd === null ? 'off' : opts.maxUsd} soft-stops judging`);
  return plan;
}

/** `--call-plan FILE`: build, write FILE.tmp, rename; a refusal prints and fails with nothing written. */
export async function runLmeCallPlan(input: LmeCallPlanInput, fail: (code: number) => never): Promise<void> {
  const path = input.opts.callPlanPath!;
  let text: string;
  let plan: CallPlan;
  try {
    plan = await buildLmeCallPlan(input);
    text = formatEvalCalls(plan);
    writeFileSync(`${path}.tmp`, text);
    renameSync(`${path}.tmp`, path);
  } catch (err: any) {
    process.stderr.write(`Error: ${err?.message ?? err}\n`);
    fail(1);
    return;
  }
  process.stderr.write(`[longmemeval] call plan: wrote ${path} (${plan.rows.length} call line(s): ${plan.rows.map(r => `${r.purpose}=${r.calls}`).join(', ') || 'none'}); no provider was called\n`);
}
