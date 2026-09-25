import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chat, configureGateway, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { withAIInvocationGuard, type AIInvocationUsage } from '../src/core/ai/invocation-guard.ts';
import { BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import { canonicalLookup } from '../src/core/model-pricing.ts';
import { normalizeSessions, haystackToPages, type LongMemEvalQuestion } from '../src/eval/longmemeval/adapter.ts';
import { buildEvidencePacket, renderFullSessions, type EvidenceSession } from '../src/eval/longmemeval/evidence-packet.ts';
import { buildReaderUserText, READER_SYSTEM_TEXT, READER_MAX_TOKENS, READER_MAX_SESSION_CHARS } from '../src/eval/longmemeval/reader.ts';
import { sanitizeChatContent } from '../src/eval/longmemeval/sanitize.ts';
import { buildJudgePrompt, classifyJudgeResponse, DEFAULT_JUDGE_MODEL, JUDGE_MAX_TOKENS, JUDGE_TEMPERATURE } from '../src/eval/longmemeval/judge.ts';
import { runJudge } from '../src/eval/shared/judge-runner.ts';
import { bootstrapMeanCi } from '../src/eval/shared/bootstrap.ts';
import { redactSecrets, sha256Hex, stableStringify } from '../src/eval/longmemeval/run-config.ts';

export const READER = 'anthropic:claude-sonnet-4-6';
export const VARIANTS = { v1: { anchorRounds: 2, adjacentRounds: 1 }, v2: { anchorRounds: 4, adjacentRounds: 2 } } as const;
const DATA_SHA = 'd6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442';
const RECEIPT_SHA = '65ffeaa8299586e5a1dd6a9e10f269bab33462ab5470a95e329fbf189a703140';
const CAP = 20;
const HOLDOUT_RESERVE = 12;
const CODE_PATHS = ['scripts/eval-answer-packet.ts', 'src/eval/longmemeval/evidence-packet.ts', 'src/eval/longmemeval/reader.ts', 'src/eval/longmemeval/sanitize.ts', 'src/eval/longmemeval/adapter.ts', 'src/eval/longmemeval/judge.ts', 'src/eval/shared/judge-runner.ts', 'src/eval/shared/bootstrap.ts', 'src/eval/longmemeval/run-config.ts', 'src/core/search/title-match.ts', 'src/core/search/token-budget.ts', 'src/core/think/sanitize.ts', 'src/core/ai/gateway.ts', 'src/core/ai/invocation-guard.ts', 'src/core/budget/budget-tracker.ts', 'src/core/model-pricing.ts', 'bun.lock'];
type Question = LongMemEvalQuestion & { question_date?: string };
type Receipt = { question_id: string; retrieved_session_ids: string[] };
type Variant = keyof typeof VARIANTS;
type JsonRecord = Record<string, any>;

export function saveJson(path: string, value: unknown): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}

export function appendRecord(path: string, value: unknown): void {
  const fd = openSync(path, 'a', 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}

export function readRecords(path: string): JsonRecord[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  if (text && !text.endsWith('\n')) throw new Error('Interrupted journal tail; inspect it before resuming');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export function freezeEvidence(q: Question, row: Receipt): EvidenceSession[] {
  if (q.question_id !== row.question_id || !Array.isArray(row.retrieved_session_ids)
    || new Set(row.retrieved_session_ids).size !== row.retrieved_session_ids.length) throw new Error('Invalid frozen receipt identity');
  const sessions = normalizeSessions(q);
  if (sessions.length !== q.haystack_sessions.length) throw new Error('Missing or ambiguous dataset sessions');
  const pages = haystackToPages(q);
  return row.retrieved_session_ids.map(id => {
    const i = sessions.findIndex(s => s.session_id === id);
    if (i < 0) throw new Error(`Missing saved session: ${id}`);
    if (sessions.filter(s => s.session_id === id).length !== 1 || pages.filter(p => p.slug === pages[i].slug).length !== 1) throw new Error('Missing or ambiguous saved session');
    return { source_id: 'longmemeval-public', session_id: id, date: q.haystack_dates?.[i], body: pages[i].content, turns: sessions[i].turns.map(t => ({ role: t.role, content: t.content })) };
  });
}

export function selectCohorts(questions: readonly Question[], splits: { dev40: string[]; decision430: string[] }) {
  const sorted = [...questions].sort((a, b) => sha256Hex(`answer-packet-seed42:${a.question_id}`).localeCompare(sha256Hex(`answer-packet-seed42:${b.question_id}`)));
  const parent = new Map(questions.map(q => [q.question_id, q.question_id]));
  const root = (id: string): string => { const p = parent.get(id)!; return p === id ? id : root(p); };
  const seen = new Map<string, string>();
  for (const q of questions) {
    const keys = [`id:${q.question_id.replace(/_abs$/, '')}`, `question:${q.question.trim().toLowerCase()}`,
      `history:${sha256Hex(stableStringify((q.haystack_session_ids ?? normalizeSessions(q).map(s => s.session_id)).slice().sort()))}`];
    for (const key of keys) {
      const previous = seen.get(key);
      if (previous) parent.set(root(q.question_id), root(previous));
      seen.set(key, q.question_id);
    }
  }
  const groups = Object.fromEntries(questions.map(q => [q.question_id, root(q.question_id)]));
  const used = new Set<string>();
  const categories = [...new Set(questions.filter(q => !q.question_id.endsWith('_abs')).map(q => q.question_type))].sort();
  const pick = (pool: Set<string> | null, n: number, category?: string): string[] => {
    const ids: string[] = [];
    for (const q of sorted) {
      if (pool ? !pool.has(q.question_id) || q.question_type !== category : !q.question_id.endsWith('_abs')) continue;
      if (used.has(groups[q.question_id])) continue;
      ids.push(q.question_id); used.add(groups[q.question_id]);
      if (ids.length === n) break;
    }
    if (ids.length !== n) throw new Error(`Insufficient leakage-safe cohort: ${category ?? 'abstention'}`);
    return ids;
  };
  const dev = categories.flatMap(c => pick(new Set(splits.dev40), 2, c));
  dev.push(...pick(null, 6));
  const holdout = categories.flatMap(c => pick(new Set(splits.decision430), 8, c));
  holdout.push(...pick(null, 12));
  return { dev, holdout, groups, categories };
}

export function readerRequest(q: Pick<Question, 'question' | 'question_date'>, rendered: string): ChatOpts {
  return { model: READER, system: READER_SYSTEM_TEXT, messages: [{ role: 'user', content: buildReaderUserText({ question: q.question, questionDate: q.question_date, rendered }) }], maxTokens: READER_MAX_TOKENS };
}

export function completedReaderText(response: Pick<ChatResult, 'text' | 'stopReason'>, id: string): string {
  if (response.stopReason !== 'end' || !response.text.trim()) throw new Error(`Incomplete reader: ${id} (${response.stopReason})`);
  return response.text.trim();
}

export function inputUpperBound(opts: ChatOpts): number {
  if (!opts.model || opts.tools?.length || opts.messages.some(m => typeof m.content !== 'string') || opts.providerOptions) throw new Error('Only pinned text-only requests are supported');
  return Buffer.byteLength((opts.system ?? '') + opts.messages.map(m => m.content).join(''), 'utf8') + 1024;
}

export function usageCost(model: string, usage: AIInvocationUsage): number {
  const price = canonicalLookup(model);
  if (!price || [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0].some(n => !Number.isFinite(n) || n < 0)) throw new Error('Unknown pricing or invalid usage');
  return (usage.inputTokens * price.input + usage.outputTokens * price.output
    + (usage.cacheReadTokens ?? 0) * (price.cache_read ?? price.input)
    + (usage.cacheWriteTokens ?? 0) * (price.cache_write ?? price.input * 2)) / 1e6;
}

export async function recordedCall(
  path: string, id: string, opts: ChatOpts, maxUsd: number, client: (opts: ChatOpts) => Promise<ChatResult> = chat,
): Promise<ChatResult> {
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > CAP) throw new Error('Invalid total spending cap');
  const records = readRecords(path);
  const fingerprint = sha256Hex(stableStringify(opts));
  const same = records.filter(r => r.id === id);
  if (same.some(r => r.fingerprint !== fingerprint)) throw new Error('Changed request on resume');
  const admitted = records.filter(r => r.event === 'admit');
  if (admitted.some(r => !records.some(s => s.id === r.id && s.attempt === r.attempt && s.event === 'settle' && s.usage))) throw new Error('Unknown paid usage; refuse automatic replay');
  if (same.some(r => r.event === 'error')) throw new Error('Failed paid call; inspect before any retry');
  const prior = same.find(r => r.event === 'response');
  if (prior) {
    if (prior.accepted !== true) throw new Error('Unaccepted paid response; inspect before reuse');
    return prior.response;
  }
  if (same.length) throw new Error('Interrupted or failed paid call; inspect before any retry');
  const tracker = new BudgetTracker({ maxCostUsd: maxUsd, label: 'answer-packet', auditPath: `${path}.budget` });
  for (const r of records.filter(r => r.event === 'settle')) {
    const price = canonicalLookup(r.model)!;
    tracker.record({ modelId: r.model, inputTokens: r.cost_usd * 1e6 / price.input, outputTokens: 0 });
  }
  let attempts = 0;
  const start = performance.now();
  let unknown = false;
  let settlementError: unknown;
  try {
    const result = await withAIInvocationGuard(async call => {
      if (call.model !== opts.model || call.kind !== 'chat' || call.maxOutputTokens !== opts.maxTokens || call.cacheWriteTtl === '1h') throw new Error('Unpinned provider invocation');
      const input = inputUpperBound(opts);
      const price = canonicalLookup(call.model);
      if (!price) throw new Error('Unknown model pricing');
      const reserveInput = input * Math.max(1, (price.cache_write ?? price.input * 2) / price.input);
      tracker.reserve({ modelId: call.model, kind: 'chat', estimatedInputTokens: reserveInput, maxOutputTokens: opts.maxTokens! });
      const attempt = ++attempts;
      appendRecord(path, { event: 'admit', id, attempt, fingerprint, model: call.model, request: opts, input_upper_bound: input,
        reserved_usd: (reserveInput * price.input + opts.maxTokens! * price.output) / 1e6, timestamp: new Date().toISOString() });
      return { settle: async usage => {
        try {
          const cost = usage ? usageCost(call.model, usage) : null;
          appendRecord(path, { event: 'settle', id, attempt, fingerprint, model: call.model, usage, cost_usd: cost, timestamp: new Date().toISOString() });
          if (!usage) { unknown = true; return; }
          tracker.record({ modelId: call.model, inputTokens: cost! * 1e6 / price.input, outputTokens: 0 });
          if (usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > input || usage.outputTokens > opts.maxTokens!) throw new Error('Provider exceeded the admitted token bound');
        } catch (error) { settlementError = error; }
      } };
    }, () => client({ ...opts, abortSignal: AbortSignal.timeout(180_000) }));
    const accepted = !settlementError && attempts === 1 && !unknown;
    appendRecord(path, { event: 'response', id, fingerprint, response: result, accepted, elapsed_ms: performance.now() - start });
    if (!accepted) throw settlementError ?? new Error('Expected one accounted provider attempt');
    return result;
  } catch (error) {
    appendRecord(path, { event: 'error', id, fingerprint, error: redactSecrets(String(error)), elapsed_ms: performance.now() - start });
    throw error;
  }
}

export function pairedSummary(rows: JsonRecord[]) {
  const complete = rows.filter(r => typeof r.baseline_correct === 'boolean' && typeof r.candidate_correct === 'boolean');
  const wins = complete.filter(r => !r.baseline_correct && r.candidate_correct).map(r => r.question_id);
  const losses = complete.filter(r => r.baseline_correct && !r.candidate_correct).map(r => r.question_id);
  return { n: rows.length, complete: complete.length, incomplete: rows.length - complete.length,
    baseline_correct: complete.filter(r => r.baseline_correct).length, candidate_correct: complete.filter(r => r.candidate_correct).length,
    both_right: complete.filter(r => r.baseline_correct && r.candidate_correct).length,
    both_wrong: complete.filter(r => !r.baseline_correct && !r.candidate_correct).length,
    wins, losses, net: wins.length - losses.length,
    delta_ci95: bootstrapMeanCi(complete.map(r => Number(r.candidate_correct) - Number(r.baseline_correct))),
  };
}

export function reportSummaries(manifest: JsonRecord, pairs: JsonRecord[], calls: JsonRecord[]) {
  const runs = new Map<string, { phase: string; variant: string }>();
  for (const r of [...calls.filter(r => r.event === 'phase_start'), ...pairs]) {
    if (['dev', 'holdout'].includes(r.phase) && r.variant in VARIANTS) runs.set(`${r.phase}-${r.variant}`, { phase: r.phase, variant: r.variant });
  }
  return Object.fromEntries([...runs].map(([key, { phase, variant }]) => {
    const observed = pairs.filter(r => r.phase === phase && r.variant === variant);
    const rows = (manifest.cohorts[phase] as string[]).map(id => {
      const row = observed.find(r => r.question_id === id) ?? { question_id: id, ...manifest.case_metadata?.[id] };
      if (!row.category || typeof row.abstention !== 'boolean' || typeof row.retrieval_complete !== 'boolean') throw new Error(`Missing expected case metadata: ${id}`);
      return row;
    });
    return [key, { ...pairedSummary(rows),
      by_category: Object.fromEntries(manifest.cohorts.categories.map((c: string) => [c, pairedSummary(rows.filter(r => r.category === c))])),
      by_abstention: Object.fromEntries([false, true].map(v => [String(v), pairedSummary(rows.filter(r => r.abstention === v))])),
      by_retrieval_complete: Object.fromEntries([false, true].map(v => [String(v), pairedSummary(rows.filter(r => r.retrieval_complete === v))])) }];
  }));
}

async function countReader(opts: ChatOpts): Promise<number> {
  const response = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': process.env.ANTHROPIC_API_KEY! },
    body: JSON.stringify({ model: READER.split(':')[1], system: opts.system, messages: opts.messages }), signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Free token-count preflight failed: HTTP ${response.status}`);
  const result = await response.json() as { input_tokens: number };
  if (!Number.isSafeInteger(result.input_tokens) || result.input_tokens < 0) throw new Error('Invalid provider token count');
  return result.input_tokens;
}

function codePins() {
  return Object.fromEntries(CODE_PATHS.map(p => [p, sha256Hex(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'))]));
}

async function main(args: string[]) {
  const [command, outputArg, datasetPath, receiptPath, variantArg] = args;
  if (!['prepare', 'dev', 'freeze', 'holdout', 'report'].includes(command) || !outputArg) {
    throw new Error('Usage: bun scripts/eval-answer-packet.ts <prepare|dev|freeze|holdout|report> OUT DATASET RECEIPT [v1|v2]. prepare/report make no generation calls; dev/holdout are paid ($20 shared maximum).');
  }
  const out = resolve(outputArg);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const lock = join(out, 'writer.lock');
  const fd = openSync(lock, 'wx', 0o600);
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  try {
    const manifestPath = join(out, 'manifest.json');
    const journal = join(out, 'calls.ndjson');
    if (command === 'report') {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const cases = readRecords(join(out, 'pairs.ndjson'));
      const calls = readRecords(journal);
      const summaries = reportSummaries(manifest, cases, calls);
      const settled = calls.filter(r => r.event === 'settle' && r.usage);
      const costByLane: Record<string, number> = {};
      for (const r of settled) { const [phase, , arm, lane] = r.id.split('/'); const key = `${phase}/${arm}/${lane}`; costByLane[key] = (costByLane[key] ?? 0) + r.cost_usd; }
      const unknown = calls.filter(r => r.event === 'admit' && !settled.some(s => s.id === r.id && s.attempt === r.attempt));
      const report = { summaries, measured_cost_usd: settled.reduce((n, r) => n + r.cost_usd, 0), cost_by_lane: costByLane,
        conservative_unsettled_usd: unknown.reduce((n, r) => n + r.reserved_usd, 0), errors: calls.filter(r => r.event === 'error'),
        pricing_note: 'Usage-priced estimate at pinned canonical rates; not an invoice. Unpriced automatic cache reads use full input rate.', manifest_sha: sha256Hex(stableStringify(manifest)) };
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (!datasetPath || !receiptPath) throw new Error('Dataset and receipt paths are required');
    const datasetText = readFileSync(datasetPath, 'utf8');
    const receiptText = readFileSync(receiptPath, 'utf8');
    if (sha256Hex(datasetText) !== DATA_SHA || sha256Hex(receiptText) !== RECEIPT_SHA) throw new Error('Pinned input hash mismatch');
    const dataset: Question[] = JSON.parse(datasetText);
    const receipts: Receipt[] = receiptText.trim().split('\n').map(l => JSON.parse(l)).filter(r => typeof r.question_id === 'string');
    const splits = JSON.parse(readFileSync(new URL('../evals/longmemeval/splits-seed42.json', import.meta.url), 'utf8'));
    const cohorts = selectCohorts(dataset, splits);
    const caseMetadata = Object.fromEntries([...cohorts.dev, ...cohorts.holdout].map(id => {
      const q = dataset.find(q => q.question_id === id)!;
      const row = receipts.find(r => r.question_id === id);
      if (!row) throw new Error('Missing saved question');
      return [id, { category: q.question_type, abstention: id.endsWith('_abs'),
        retrieval_complete: q.answer_session_ids.length > 0 && q.answer_session_ids.every(id => row.retrieved_session_ids.includes(id)) }];
    }));
    const pins = { dataset_sha: DATA_SHA, receipt_sha: RECEIPT_SHA, split_sha: sha256Hex(stableStringify(splits)), code: codePins(), cohorts,
      case_metadata: caseMetadata,
      reader: READER, judge: DEFAULT_JUDGE_MODEL, variants: VARIANTS, cap_usd: CAP, holdout_reserve_usd: HOLDOUT_RESERVE,
      pricing: { [READER]: canonicalLookup(READER), [DEFAULT_JUDGE_MODEL]: canonicalLookup(DEFAULT_JUDGE_MODEL) },
      accounting: 'UTF-8 byte upper bound + 1024 input overhead; max output; worst cache-write reserve; one guarded attempt, SDK retries disabled',
      token_ceiling: 'baseline provider token-count estimate + 1024 safety overhead + 512 output; packet provider count must not exceed baseline count' };
    if (command === 'prepare') {
      saveJson(manifestPath, pins);
      for (const id of [...cohorts.dev, ...cohorts.holdout]) {
        const q = dataset.find(q => q.question_id === id)!;
        const rows = receipts.filter(r => r.question_id === id);
        if (rows.length !== 1) throw new Error('Missing or duplicate question receipt');
        const sources = freezeEvidence(q, rows[0]);
        renderFullSessions(sources);
        saveJson(join(out, `source-${id}.json`), { question_id: id, question: q.question, question_date: q.question_date, sources,
          source_sha: sha256Hex(stableStringify(sources)), baseline_sanitization: sources.map(s => sanitizeChatContent(s.body, READER_MAX_SESSION_CHARS).matched) });
      }
      console.log(JSON.stringify({ prepared: true, dev: cohorts.dev.length, holdout: cohorts.holdout.length, generation_cost_usd: 0 }));
      return;
    }
    if (stableStringify(JSON.parse(readFileSync(manifestPath, 'utf8'))) !== stableStringify(pins)) throw new Error('Manifest/code/config drift; refuse paid resume');
    const variant: Variant = (variantArg ?? 'v1') as Variant;
    if (!(variant in VARIANTS)) throw new Error('Expected v1 or v2');
    const freezePath = join(out, 'freeze.json');
    const pairsPath = join(out, 'pairs.ndjson');
    if (command === 'freeze') {
      const dev = readRecords(pairsPath).filter(r => r.phase === 'dev' && r.variant === variant);
      if (dev.length !== cohorts.dev.length || pairedSummary(dev).incomplete) throw new Error('Complete development before freezing');
      saveJson(freezePath, { variant, manifest_sha: sha256Hex(stableStringify(pins)), dev_result_sha: sha256Hex(stableStringify(dev)), frozen_at: new Date().toISOString() });
      console.log(JSON.stringify({ frozen: variant, development: pairedSummary(dev) }));
      return;
    }
    const phase = command as 'dev' | 'holdout';
    if (phase === 'dev' && existsSync(freezePath)) throw new Error('Development is closed after freeze');
    if (phase === 'holdout') {
      const frozen = JSON.parse(readFileSync(freezePath, 'utf8'));
      if (frozen.variant !== variant || frozen.manifest_sha !== sha256Hex(stableStringify(pins))) throw new Error('Holdout differs from frozen algorithm');
    }
    if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY) throw new Error('Both reader and judge credentials are required');
    configureGateway({ env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY } });
    appendRecord(journal, { event: 'phase_start', phase, variant, timestamp: new Date().toISOString() });
    for (const [index, id] of cohorts[phase].entries()) {
      if (readRecords(pairsPath).some(r => r.phase === phase && r.variant === variant && r.question_id === id)) continue;
      const q = dataset.find(q => q.question_id === id)!;
      const frozen = JSON.parse(readFileSync(join(out, `source-${id}.json`), 'utf8'));
      const sources: EvidenceSession[] = frozen.sources;
      if (sha256Hex(stableStringify(sources)) !== frozen.source_sha || frozen.question !== q.question || frozen.question_date !== q.question_date
        || stableStringify(sources) !== stableStringify(freezeEvidence(q, receipts.find(r => r.question_id === id)!))) throw new Error('Frozen source drift');
      const baseline = readerRequest(q, renderFullSessions(sources));
      const packet = buildEvidencePacket(q.question, sources, VARIANTS[variant]);
      let candidate = readerRequest(q, packet.rendered);
      const promptPath = join(out, `${phase}-${variant}-${id}-prompts.json`);
      let countBaseline: number, countCandidate: number;
      let providerCountFallback = false;
      if (existsSync(promptPath)) {
        const p = JSON.parse(readFileSync(promptPath, 'utf8'));
        countBaseline = p.count_baseline; countCandidate = p.count_candidate; providerCountFallback = p.provider_count_fallback;
        if (providerCountFallback) candidate = baseline;
        if (stableStringify(p.baseline) !== stableStringify(baseline) || stableStringify(p.candidate) !== stableStringify(candidate)) throw new Error('Saved prompt drift');
      } else {
        countBaseline = await countReader(baseline);
        countCandidate = stableStringify(baseline) === stableStringify(candidate) ? countBaseline : await countReader(candidate);
        if (countCandidate > countBaseline) { candidate = baseline; countCandidate = countBaseline; providerCountFallback = true; }
        saveJson(promptPath, { baseline, candidate, packet, provider_count_fallback: providerCountFallback, count_baseline: countBaseline, count_candidate: countCandidate,
          common_input_output_ceiling: countBaseline + 1024 + READER_MAX_TOKENS });
      }
      const outcomes: JsonRecord = {};
      const order = index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
      for (const arm of order) {
        const armKey = arm === 'baseline' ? 'baseline' : variant;
        const prefix = `${phase}/${id}/${armKey}`;
        const maxUsd = phase === 'dev' ? CAP - HOLDOUT_RESERVE : CAP;
        const response = await recordedCall(journal, `${prefix}/reader`, arm === 'baseline' ? baseline : candidate, maxUsd);
        const answer = completedReaderText(response, prefix);
        if (response.usage.input_tokens + READER_MAX_TOKENS > countBaseline + 1024 + READER_MAX_TOKENS) throw new Error('Reader exceeded common input/output ceiling');
        const judge = await runJudge({ model: DEFAULT_JUDGE_MODEL, prompt: buildJudgePrompt({ ...q, answer: String(q.answer), hypothesis: answer }).prompt,
          maxTokens: JUDGE_MAX_TOKENS, temperature: JUDGE_TEMPERATURE, parse: classifyJudgeResponse, retries: 0,
          client: opts => recordedCall(journal, `${prefix}/judge`, opts, maxUsd) });
        if (judge.kind !== 'verdict') { appendRecord(journal, { event: 'judge_error', id: `${prefix}/judge`, judge }); throw new Error(`Incomplete judge: ${prefix} ${judge.judge_error}`); }
        outcomes[`${arm}_correct`] = judge.verdict === 'correct';
      }
      const row = { phase, variant, question_id: id, category: q.question_type, abstention: id.endsWith('_abs'),
        retrieval_complete: q.answer_session_ids.length > 0 && q.answer_session_ids.every(id => sources.some(s => s.session_id === id)),
        ...outcomes, arm_order: order, budget_fallback: packet.budget_fallback, provider_count_fallback: providerCountFallback,
        baseline_input_count: countBaseline, candidate_input_count: countCandidate };
      appendRecord(pairsPath, row);
      console.log(JSON.stringify({ progress: index + 1, total: cohorts[phase].length, ...row }));
    }
  } finally { unlinkSync(lock); }
}

if (import.meta.main) main(process.argv.slice(2)).catch(error => { console.error(redactSecrets(String(error))); process.exitCode = 1; });
