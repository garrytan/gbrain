#!/usr/bin/env bun
/**
 * Benchmark: batched vs per-chunk contextual synopsis generation.
 *
 * Standalone prototype for the v0.41.x batched-synopsis design study. Does NOT
 * touch the worker queue or live DB embeddings. Reads pages + chunks from the
 * brain DB, runs synopsis generation in two modes:
 *
 *   per-chunk (B=1): legacy path — one LM Studio call per chunk
 *   batched (B=4, 8, 16): new path — ceil(N/B) calls per page; numbered-list output
 *
 * Measures, per (page, batch_size):
 *   - wall time
 *   - stopReason (catches truncation)
 *   - parse validity rate (count match, distinct indices, non-empty synopses)
 *   - entity-grounding pass rate (each synopsis contains a distinctive token from
 *     its chunk)
 *   - per-chunk synopses + raw responses saved to /tmp/bench-synopsis-out/{model_slug}/{bucket}-B{N}.json
 *     for follow-up retrieval-rank A/B and eyeball review.
 *
 * Pre-call token estimation guards against context overflow.
 *
 * Bypasses the gateway and calls LM Studio's openai-compat endpoint directly to
 * remove the AI SDK as a variable. Matches the production wire shape.
 *
 * Usage:
 *   bun run scripts/bench-batched-synopsis.ts [--model lmstudio:<id>] [--page <slug>]
 *                                              [--source <id>] [--bucket NAME]
 *                                              [--sizes 1,4,8,16] [--warmup] [--dry-run]
 *
 * Default: runs DEFAULT_PAGES × DEFAULT_SIZES.
 *
 * IMPORTANT: Read-only. Does NOT write to content_chunks, pages, or any other
 * DB table. Only writes to /tmp/bench-synopsis-out/ for the report artifact.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import {
  configureGateway,
  getChatModel,
  type AIGatewayConfig,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Inlined from src/cli.ts:buildGatewayConfig to avoid triggering cli.ts top-level
// main() on import. Mirror the file-plane → env mapping and the local-server
// _BASE_URL passthrough so LM Studio / Ollama / etc resolve correctly.
function buildGatewayConfig(c: GBrainConfig): AIGatewayConfig {
  const envFromConfig: Record<string, string> = {};
  if (c.openai_api_key) envFromConfig.OPENAI_API_KEY = c.openai_api_key;
  if (c.anthropic_api_key) envFromConfig.ANTHROPIC_API_KEY = c.anthropic_api_key;
  if (c.zeroentropy_api_key) envFromConfig.ZEROENTROPY_API_KEY = c.zeroentropy_api_key;
  const envBaseUrls: Record<string, string> = {};
  if (process.env.LLAMA_SERVER_BASE_URL) envBaseUrls['llama-server'] = process.env.LLAMA_SERVER_BASE_URL;
  if (process.env.OLLAMA_BASE_URL) envBaseUrls['ollama'] = process.env.OLLAMA_BASE_URL;
  if (process.env.LMSTUDIO_BASE_URL) envBaseUrls['lmstudio'] = process.env.LMSTUDIO_BASE_URL;
  if (process.env.LITELLM_BASE_URL) envBaseUrls['litellm'] = process.env.LITELLM_BASE_URL;
  if (process.env.OPENROUTER_BASE_URL) envBaseUrls['openrouter'] = process.env.OPENROUTER_BASE_URL;
  return {
    embedding_model: c.embedding_model,
    embedding_dimensions: c.embedding_dimensions,
    embedding_multimodal_model: c.embedding_multimodal_model,
    expansion_model: c.expansion_model,
    chat_model: c.chat_model,
    chat_fallback_chain: c.chat_fallback_chain,
    base_urls: { ...envBaseUrls, ...(c.provider_base_urls ?? {}) },
    env: { ...envFromConfig, ...process.env },
  };
}

const DEFAULT_PAGES: Array<{ slug: string; sourceId: string; bucket: string }> = [
  {
    slug: '2026-03-20-dock-comparison-analysis-7e6d2e62',
    sourceId: 'chats-chatgpt',
    bucket: 'medium-20ch',
  },
  {
    slug: 'transcripts/claude-code/product-onboarding/2026-05-24-174cf712-bee',
    sourceId: 'default',
    bucket: 'large-60ch',
  },
  {
    slug: 'transcripts/claude-code/product-onboarding/2026-05-24-985988a2-d22',
    sourceId: 'default',
    bucket: 'xl-151ch',
  },
];

const DEFAULT_SIZES = [1, 4, 8, 16];

// Production worker env: GBRAIN_SYNOPSIS_DOC_MAX_CHARS=16384. Mirror that here so
// the bench measures production-shape work. Override with env to test bigger docs.
const SYNOPSIS_DOC_MAX_CHARS = parseInt(
  process.env.GBRAIN_SYNOPSIS_DOC_MAX_CHARS ?? '16384',
  10,
);

// Conservative pre-call token estimation. ~3 chars/token covers English + code +
// markdown safely (real tokenizer would give 3.5-4 chars/token typical).
const CHARS_PER_TOKEN_CONSERVATIVE = 3;

// gemma-4-e2b context window: 8192 tokens. Reserve ~700 for output, leave ~7500
// for input. Other models have larger windows; this guard only bites on small
// local models (the case we care about).
const MODEL_CONTEXT_BUDGET_TOKENS = parseInt(
  process.env.GBRAIN_BENCH_CONTEXT_BUDGET ?? '7500',
  10,
);

// Match production: synopsis worker reads GBRAIN_SYNOPSIS_MODEL. Bench should
// use the SAME model so quality comparison reflects production reality. Can be
// overridden via --model CLI flag at runtime.
let synopsisModel: string =
  process.env.GBRAIN_SYNOPSIS_MODEL ?? 'lmstudio:google/gemma-4-e2b';

// Per-model output dir so sequential bench runs don't clobber each other.
// Resolved lazily after CLI parse so --model takes effect.
function outDir(): string {
  const modelSlug = synopsisModel.replace(/[^a-zA-Z0-9-]+/g, '_');
  return `/tmp/bench-synopsis-out/${modelSlug}`;
}

// ---- Prompt construction (mirrors production, extended for batched) ----

const SYSTEM_SINGLE = [
  'You generate one-sentence chunk synopses for a personal knowledge brain.',
  '',
  'Given a document (the FULL_DOCUMENT block) and a chunk from it (the CHUNK',
  'block), write a single concise sentence that orients the chunk within the',
  'document. Name the entities, time, and topic that the chunk is about,',
  'using terms that would appear in user queries.',
  '',
  'Rules:',
  '- One sentence, 15-30 words.',
  '- No preamble like "This chunk is about" — just write the synopsis.',
  '- Use the exact entity names from the document, not generic terms.',
  '- If the chunk is structural (heading, code block, list of links), say so.',
  '- Plain text only. No markdown, no quotes, no XML tags.',
].join('\n');

const SYSTEM_BATCHED = [
  'You generate one-sentence chunk synopses for a personal knowledge brain.',
  '',
  'Given a document (the FULL_DOCUMENT block) and N chunks from it (each in a',
  'CHUNK block with an index), write ONE concise sentence per chunk that',
  'orients the chunk within the document. Name the entities, time, and topic',
  'that the chunk is about, using terms that would appear in user queries.',
  '',
  'Rules:',
  '- One sentence per chunk, 15-30 words each.',
  '- No preamble like "This chunk is about" — just write the synopsis.',
  '- Use the exact entity names from the document, not generic terms.',
  '- If a chunk is structural (heading, code block, list of links), say so.',
  '- Plain text only. No markdown, no quotes, no XML tags.',
  '',
  'Output format: numbered list, one synopsis per line.',
  'The numbering MUST start at 1 and match each chunk in the order given.',
  'If you receive 8 chunks, output exactly 8 numbered lines, no more, no less.',
  '',
  'Example output for 3 chunks:',
  '1. <synopsis for chunk 1>',
  '2. <synopsis for chunk 2>',
  '3. <synopsis for chunk 3>',
].join('\n');

function buildSinglePrompt(pageTitle: string, doc: string, chunkText: string): string {
  return [
    '/no_think',
    '',
    `<page_title>${pageTitle}</page_title>`,
    '',
    '<full_document>',
    doc,
    '</full_document>',
    '',
    '<chunk>',
    chunkText,
    '</chunk>',
    '',
    'Write the one-sentence synopsis for <chunk>:',
  ].join('\n');
}

function buildBatchedPrompt(pageTitle: string, doc: string, chunks: string[]): string {
  const chunkBlocks = chunks
    .map((c, i) => `<chunk index="${i + 1}">\n${c}\n</chunk>`)
    .join('\n');
  return [
    '/no_think',
    '',
    `<page_title>${pageTitle}</page_title>`,
    '',
    '<full_document>',
    doc,
    '</full_document>',
    '',
    '<chunks>',
    chunkBlocks,
    '</chunks>',
    '',
    `Write the ${chunks.length} numbered synopses, one per chunk, in order:`,
  ].join('\n');
}

// ---- Output parsing ----

interface ParsedBatchedOutput {
  ok: boolean;
  synopses: string[];
  reason?: string;
  raw: string;
}

function parseBatchedOutput(raw: string, expectedCount: number): ParsedBatchedOutput {
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const re = /^(\d+)[.):]\s+(.+)$/;
  const synopsesByIndex = new Map<number, string>();
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    const text = m[2].trim();
    if (!text) continue;
    if (synopsesByIndex.has(idx)) {
      return { ok: false, synopses: [], reason: `duplicate-index-${idx}`, raw };
    }
    synopsesByIndex.set(idx, text);
  }
  if (synopsesByIndex.size !== expectedCount) {
    return {
      ok: false,
      synopses: [],
      reason: `count-mismatch-got-${synopsesByIndex.size}-expected-${expectedCount}`,
      raw,
    };
  }
  const synopses: string[] = [];
  for (let i = 1; i <= expectedCount; i++) {
    const s = synopsesByIndex.get(i);
    if (!s) {
      return { ok: false, synopses: [], reason: `missing-index-${i}`, raw };
    }
    synopses.push(s);
  }
  return { ok: true, synopses, raw };
}

// ---- Entity grounding ----

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could',
  'may', 'might', 'must', 'shall', 'can', 'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours',
  'in', 'on', 'at', 'by', 'for', 'with', 'about', 'against', 'between', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up',
  'down', 'of', 'as', 'so', 'if', 'then', 'than', 'while', 'when', 'where',
  'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'not', 'only', 'own', 'same', 'too', 'very', 's', 't',
]);

function extractDistinctiveTokens(text: string): string[] {
  const words = text.match(/\b[\w-]+\b/g) ?? [];
  const distinctive = new Set<string>();
  for (const w of words) {
    const lower = w.toLowerCase();
    if (STOP_WORDS.has(lower)) continue;
    if (w.length < 4) continue;
    if (/^[A-Z]/.test(w)) distinctive.add(w.toLowerCase());
    if (/[\d_]/.test(w)) distinctive.add(w.toLowerCase());
  }
  return Array.from(distinctive);
}

function entityGroundingPass(chunkText: string, synopsis: string): boolean {
  const chunkTokens = extractDistinctiveTokens(chunkText);
  if (chunkTokens.length === 0) return true;
  const synopsisLower = synopsis.toLowerCase();
  for (const tok of chunkTokens) {
    if (synopsisLower.includes(tok)) return true;
  }
  return false;
}

// ---- Pre-call token estimation ----

function estimatePromptTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN_CONSERVATIVE);
}

// ---- Doc text via chunk concat (mirrors readSourceTextWithFallback) ----

function buildDocText(chunkTexts: string[]): string {
  const joined = chunkTexts.filter((t) => t.length > 0).join('\n\n');
  if (joined.length > SYNOPSIS_DOC_MAX_CHARS) {
    return (
      joined.slice(0, SYNOPSIS_DOC_MAX_CHARS) +
      `\n\n[... ${joined.length - SYNOPSIS_DOC_MAX_CHARS} chars truncated for synopsis budget ...]`
    );
  }
  return joined;
}

// ---- Single chat call wrapper ----

interface ChatCallResult {
  text: string;
  stopReason: ChatResult['stopReason'];
  finishReasonRaw: string;
  inputTokens: number;
  outputTokens: number;
  wallMs: number;
  ok: boolean;
  errorText?: string;
  httpStatus?: number;
}

// Bench bypasses the gateway and calls LM Studio's openai-compat endpoint
// directly. The gateway works for production but adds variables (provider
// validation, AI SDK serialization) that obscure the bench's signal. Direct
// fetch removes those variables; matches the production wire shape.
const LMSTUDIO_BASE = process.env.LMSTUDIO_BASE_URL ?? 'http://127.0.0.1:1234/v1';

async function callChat(
  system: string,
  userPrompt: string,
  maxTokens: number,
): Promise<ChatCallResult> {
  const modelId = synopsisModel.replace(/^lmstudio:/, '');
  const body = {
    model: modelId,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: maxTokens,
    temperature: 0,
    stream: false,
  };
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(`${LMSTUDIO_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const wallMs = Math.round(performance.now() - t0);
    return {
      text: '',
      stopReason: 'other',
      finishReasonRaw: 'fetch_error',
      inputTokens: 0,
      outputTokens: 0,
      wallMs,
      ok: false,
      errorText: (err as Error).message,
    };
  }
  const wallMs = Math.round(performance.now() - t0);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return {
      text: '',
      stopReason: 'other',
      finishReasonRaw: `http_${res.status}`,
      inputTokens: 0,
      outputTokens: 0,
      wallMs,
      ok: false,
      errorText: errText,
      httpStatus: res.status,
    };
  }
  const json: any = await res.json();
  const choice = json.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const text = String(msg.content ?? '');
  const finishReason = String(choice.finish_reason ?? 'unknown');
  const stopReason: ChatResult['stopReason'] =
    finishReason === 'length' ? 'length'
      : finishReason === 'stop' ? 'end'
      : finishReason === 'content_filter' ? 'content_filter'
      : finishReason === 'tool_calls' ? 'tool_calls'
      : 'other';
  return {
    text,
    stopReason,
    finishReasonRaw: finishReason,
    inputTokens: Number(json.usage?.prompt_tokens ?? 0),
    outputTokens: Number(json.usage?.completion_tokens ?? 0),
    wallMs,
    ok: true,
  };
}

// ---- Per-page benchmark ----

interface ChunkRow {
  chunk_index: number;
  chunk_text: string;
  chunk_source: string;
}

interface RawCallRecord {
  chunk_start_idx: number;
  num_chunks: number;
  wall_ms: number;
  http_status?: number;
  finish_reason_raw: string;
  input_tokens: number;
  output_tokens: number;
  raw_text: string;
  parse_ok: boolean;
  parse_failure_reason?: string;
  error_text?: string;
}

interface PerModeResult {
  batchSize: number;
  numCalls: number;
  totalWallMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  parseValidCalls: number;
  parseInvalidCalls: number;
  parseFailureReasons: string[];
  truncatedCalls: number;
  httpErrorCalls: number;
  fetchErrorCalls: number;
  entityGroundingPasses: number;
  entityGroundingFails: number;
  synopses: string[];
  rawCalls: RawCallRecord[];
}

async function benchPage(
  engine: BrainEngine,
  page: { slug: string; sourceId: string; bucket: string },
  sizes: number[],
  dryRun: boolean,
): Promise<{ page: typeof page; chunkCount: number; results: PerModeResult[] }> {
  console.log(`[bench] ${page.bucket} :: ${page.slug}`);
  const pageRow = await engine.getPage(page.slug, { sourceId: page.sourceId });
  if (!pageRow) {
    console.error(`[bench] page not found: ${page.slug}`);
    return { page, chunkCount: 0, results: [] };
  }
  const chunks = (await engine.getChunks(page.slug, { sourceId: page.sourceId })) as ChunkRow[];
  const textChunks = chunks.filter((c) => c.chunk_source !== 'fenced_code');
  if (textChunks.length === 0) {
    console.error(`[bench] ${page.slug}: no text chunks (all code or image)`);
    return { page, chunkCount: 0, results: [] };
  }

  const doc = buildDocText(textChunks.map((c) => c.chunk_text));
  const title = pageRow.title;
  console.log(
    `  loaded: ${textChunks.length} text chunks, doc=${doc.length} chars, title="${title}"`,
  );

  const results: PerModeResult[] = [];

  for (const B of sizes) {
    console.log(`  --- batch_size=${B} ---`);
    const numCalls = B === 1 ? textChunks.length : Math.ceil(textChunks.length / B);
    const result: PerModeResult = {
      batchSize: B,
      numCalls,
      totalWallMs: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      parseValidCalls: 0,
      parseInvalidCalls: 0,
      parseFailureReasons: [],
      truncatedCalls: 0,
      httpErrorCalls: 0,
      fetchErrorCalls: 0,
      entityGroundingPasses: 0,
      entityGroundingFails: 0,
      synopses: new Array(textChunks.length).fill(''),
      rawCalls: [],
    };

    if (B === 1) {
      for (let i = 0; i < textChunks.length; i++) {
        const c = textChunks[i];
        const prompt = buildSinglePrompt(title, doc, c.chunk_text);
        const estIn = estimatePromptTokens(SYSTEM_SINGLE) + estimatePromptTokens(prompt);
        if (estIn > MODEL_CONTEXT_BUDGET_TOKENS) {
          console.warn(`    [skip] chunk ${i}: est input ${estIn} > budget ${MODEL_CONTEXT_BUDGET_TOKENS}`);
          continue;
        }
        if (dryRun) {
          console.log(`    [dry] chunk ${i}: est in=${estIn} tokens`);
          continue;
        }
        // B=1 per-chunk: 70 tok synopsis + reasoning headroom for thinking models.
        const callRes = await callChat(SYSTEM_SINGLE, prompt, 1024);
        result.totalWallMs += callRes.wallMs;
        result.totalInputTokens += callRes.inputTokens;
        result.totalOutputTokens += callRes.outputTokens;
        const rawCall: RawCallRecord = {
          chunk_start_idx: i,
          num_chunks: 1,
          wall_ms: callRes.wallMs,
          http_status: callRes.httpStatus,
          finish_reason_raw: callRes.finishReasonRaw,
          input_tokens: callRes.inputTokens,
          output_tokens: callRes.outputTokens,
          raw_text: callRes.text,
          parse_ok: false,
        };
        if (!callRes.ok) {
          rawCall.error_text = callRes.errorText;
          rawCall.parse_failure_reason = callRes.finishReasonRaw.startsWith('http_')
            ? `http-error: ${callRes.httpStatus}`
            : `fetch-error`;
          if (callRes.finishReasonRaw === 'fetch_error') result.fetchErrorCalls++;
          else result.httpErrorCalls++;
          result.parseInvalidCalls++;
          result.parseFailureReasons.push(rawCall.parse_failure_reason);
          console.warn(`    [http-fail] chunk ${i}: ${callRes.finishReasonRaw} ${(callRes.errorText ?? '').slice(0, 100)}`);
          result.rawCalls.push(rawCall);
          continue;
        }
        const synopsis = callRes.text.trim();
        if (synopsis.length === 0) {
          result.parseInvalidCalls++;
          result.parseFailureReasons.push('empty-output');
          rawCall.parse_failure_reason = 'empty-output';
          result.rawCalls.push(rawCall);
          continue;
        }
        if (callRes.stopReason === 'length') result.truncatedCalls++;
        result.parseValidCalls++;
        result.synopses[i] = synopsis;
        rawCall.parse_ok = true;
        result.rawCalls.push(rawCall);
        if (entityGroundingPass(c.chunk_text, synopsis)) {
          result.entityGroundingPasses++;
        } else {
          result.entityGroundingFails++;
        }
        if ((i + 1) % 10 === 0) {
          console.log(`    progress: ${i + 1}/${textChunks.length} chunks, ${result.totalWallMs}ms elapsed`);
        }
      }
    } else {
      for (let bi = 0; bi < textChunks.length; bi += B) {
        const batchChunks = textChunks.slice(bi, bi + B);
        const batchTexts = batchChunks.map((c) => c.chunk_text);
        const prompt = buildBatchedPrompt(title, doc, batchTexts);
        const estIn = estimatePromptTokens(SYSTEM_BATCHED) + estimatePromptTokens(prompt);
        // Batched: B × 90 tok synopses + ~1000 reasoning headroom.
        const maxOut = Math.max(2048, batchChunks.length * 90 + 1000);
        if (estIn > MODEL_CONTEXT_BUDGET_TOKENS) {
          console.warn(`    [skip] batch ${bi}-${bi + B - 1}: est input ${estIn} > budget ${MODEL_CONTEXT_BUDGET_TOKENS}`);
          continue;
        }
        if (dryRun) {
          console.log(`    [dry] batch ${bi}-${bi + B - 1}: est in=${estIn} tokens, maxOut=${maxOut}`);
          continue;
        }
        const callRes = await callChat(SYSTEM_BATCHED, prompt, maxOut);
        result.totalWallMs += callRes.wallMs;
        result.totalInputTokens += callRes.inputTokens;
        result.totalOutputTokens += callRes.outputTokens;
        const rawCall: RawCallRecord = {
          chunk_start_idx: bi,
          num_chunks: batchChunks.length,
          wall_ms: callRes.wallMs,
          http_status: callRes.httpStatus,
          finish_reason_raw: callRes.finishReasonRaw,
          input_tokens: callRes.inputTokens,
          output_tokens: callRes.outputTokens,
          raw_text: callRes.text,
          parse_ok: false,
        };
        if (!callRes.ok) {
          rawCall.error_text = callRes.errorText;
          rawCall.parse_failure_reason = callRes.finishReasonRaw.startsWith('http_')
            ? `http-error: ${callRes.httpStatus}`
            : `fetch-error`;
          if (callRes.finishReasonRaw === 'fetch_error') result.fetchErrorCalls++;
          else result.httpErrorCalls++;
          result.parseInvalidCalls++;
          result.parseFailureReasons.push(rawCall.parse_failure_reason);
          console.warn(`    [http-fail] batch ${bi}: ${callRes.finishReasonRaw} ${(callRes.errorText ?? '').slice(0, 150)}`);
          result.rawCalls.push(rawCall);
          continue;
        }
        if (callRes.stopReason === 'length') result.truncatedCalls++;
        const parsed = parseBatchedOutput(callRes.text, batchChunks.length);
        if (!parsed.ok) {
          result.parseInvalidCalls++;
          result.parseFailureReasons.push(parsed.reason ?? 'unknown');
          rawCall.parse_failure_reason = parsed.reason;
          console.warn(`    [parse-fail] batch ${bi}: ${parsed.reason}`);
          result.rawCalls.push(rawCall);
          continue;
        }
        rawCall.parse_ok = true;
        result.rawCalls.push(rawCall);
        result.parseValidCalls++;
        for (let k = 0; k < batchChunks.length; k++) {
          const synopsis = parsed.synopses[k];
          result.synopses[bi + k] = synopsis;
          if (entityGroundingPass(batchChunks[k].chunk_text, synopsis)) {
            result.entityGroundingPasses++;
          } else {
            result.entityGroundingFails++;
          }
        }
        console.log(`    batch ${bi}-${bi + batchChunks.length - 1}: ${callRes.wallMs}ms, parse-ok`);
      }
    }

    results.push(result);
    if (!dryRun) {
      const outFile = resolve(outDir(), `${page.bucket}-B${B}.json`);
      writeFileSync(
        outFile,
        JSON.stringify(
          {
            page_slug: page.slug,
            source_id: page.sourceId,
            batch_size: B,
            chunk_count: textChunks.length,
            doc_chars: doc.length,
            model: synopsisModel,
            metrics: {
              num_calls: result.numCalls,
              total_wall_ms: result.totalWallMs,
              parse_valid_calls: result.parseValidCalls,
              parse_invalid_calls: result.parseInvalidCalls,
              parse_failure_reasons: result.parseFailureReasons,
              truncated_calls: result.truncatedCalls,
              http_error_calls: result.httpErrorCalls,
              fetch_error_calls: result.fetchErrorCalls,
              entity_grounding_passes: result.entityGroundingPasses,
              entity_grounding_fails: result.entityGroundingFails,
              entity_grounding_rate:
                result.entityGroundingPasses + result.entityGroundingFails === 0
                  ? null
                  : result.entityGroundingPasses /
                    (result.entityGroundingPasses + result.entityGroundingFails),
              total_input_tokens: result.totalInputTokens,
              total_output_tokens: result.totalOutputTokens,
              avg_wall_ms_per_call:
                result.parseValidCalls === 0
                  ? null
                  : Math.round(result.totalWallMs / result.parseValidCalls),
              avg_wall_ms_per_chunk:
                result.parseValidCalls === 0
                  ? null
                  : Math.round(result.totalWallMs / textChunks.length),
            },
            synopses: result.synopses.map((s, idx) => ({
              chunk_index: idx,
              chunk_text_preview: textChunks[idx].chunk_text.slice(0, 200),
              synopsis: s,
            })),
            raw_calls: result.rawCalls,
          },
          null,
          2,
        ),
      );
      console.log(`    wrote ${outFile}`);
    }
  }

  return { page, chunkCount: textChunks.length, results };
}

// ---- Report rendering ----

function renderReport(
  allResults: Array<Awaited<ReturnType<typeof benchPage>>>,
  modelTag: string,
): string {
  const lines: string[] = [];
  lines.push(`# Bench: batched vs per-chunk synopsis`);
  lines.push(``);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Model: ${modelTag}`);
  lines.push(``);

  for (const { page, chunkCount, results } of allResults) {
    if (chunkCount === 0) continue;
    lines.push(`## ${page.bucket} — ${page.slug}`);
    lines.push(`chunks: ${chunkCount}`);
    lines.push(``);
    lines.push(`| B  | calls | wall ms | wall/chunk | parse-OK | truncated | entity-ground-rate | in tok | out tok |`);
    lines.push(`|----|-------|---------|------------|----------|-----------|--------------------|--------|---------|`);
    for (const r of results) {
      const wallPerChunk = r.parseValidCalls > 0 ? Math.round(r.totalWallMs / chunkCount) : 0;
      const parsePct =
        r.parseValidCalls + r.parseInvalidCalls === 0
          ? 'n/a'
          : `${Math.round((r.parseValidCalls / (r.parseValidCalls + r.parseInvalidCalls)) * 100)}%`;
      const egTotal = r.entityGroundingPasses + r.entityGroundingFails;
      const egRate = egTotal === 0 ? 'n/a' : `${Math.round((r.entityGroundingPasses / egTotal) * 100)}%`;
      lines.push(
        `| ${r.batchSize.toString().padStart(2)} | ${r.numCalls.toString().padStart(5)} | ${r.totalWallMs.toString().padStart(7)} | ${wallPerChunk.toString().padStart(10)} | ${parsePct.padStart(8)} | ${r.truncatedCalls.toString().padStart(9)} | ${egRate.padStart(18)} | ${r.totalInputTokens.toString().padStart(6)} | ${r.totalOutputTokens.toString().padStart(7)} |`,
      );
    }
    lines.push(``);
    if (results.some((r) => r.parseFailureReasons.length > 0)) {
      lines.push(`### Parse failures`);
      for (const r of results) {
        if (r.parseFailureReasons.length === 0) continue;
        lines.push(`- B=${r.batchSize}: ${r.parseFailureReasons.slice(0, 5).join('; ')}${r.parseFailureReasons.length > 5 ? ` (+${r.parseFailureReasons.length - 5} more)` : ''}`);
      }
      lines.push(``);
    }
  }

  lines.push(`## Speedup vs B=1`);
  lines.push(``);
  lines.push(`| Page | B=1 ms | B=4 ms | B=8 ms | B=16 ms | speedup(8/1) | speedup(16/1) |`);
  lines.push(`|------|--------|--------|--------|---------|--------------|---------------|`);
  for (const { page, chunkCount, results } of allResults) {
    if (chunkCount === 0) continue;
    const b1 = results.find((r) => r.batchSize === 1);
    const b4 = results.find((r) => r.batchSize === 4);
    const b8 = results.find((r) => r.batchSize === 8);
    const b16 = results.find((r) => r.batchSize === 16);
    const sp8 = b1 && b8 && b8.totalWallMs > 0 ? (b1.totalWallMs / b8.totalWallMs).toFixed(2) : 'n/a';
    const sp16 =
      b1 && b16 && b16.totalWallMs > 0 ? (b1.totalWallMs / b16.totalWallMs).toFixed(2) : 'n/a';
    lines.push(
      `| ${page.bucket} | ${(b1?.totalWallMs ?? '-').toString()} | ${(b4?.totalWallMs ?? '-').toString()} | ${(b8?.totalWallMs ?? '-').toString()} | ${(b16?.totalWallMs ?? '-').toString()} | ${sp8} | ${sp16} |`,
    );
  }
  lines.push(``);
  return lines.join('\n');
}

// ---- Main ----

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let pageOverride: string | null = null;
  let sourceOverride: string | null = null;
  let sizesArg: number[] = DEFAULT_SIZES;
  let dryRun = false;
  let doWarmup = false;
  let customBucket = 'custom';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--page') pageOverride = args[++i];
    else if (args[i] === '--source') sourceOverride = args[++i];
    else if (args[i] === '--sizes') sizesArg = args[++i].split(',').map((n) => parseInt(n, 10));
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--model') synopsisModel = args[++i];
    else if (args[i] === '--warmup') doWarmup = true;
    else if (args[i] === '--bucket') customBucket = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`bench-batched-synopsis.ts

Flags:
  --model <id>       Model id (overrides GBRAIN_SYNOPSIS_MODEL env). Format: lmstudio:<model>
  --page <slug>      Single page to bench (overrides DEFAULT_PAGES)
  --source <id>      Source id for --page (default: 'default')
  --bucket NAME      Bucket label used in output filename (default: 'custom')
  --sizes <a,b,c>    Comma-separated batch sizes (default: 1,4,8,16)
  --warmup           Fire one dummy call before bench to amortize model-load cost
  --dry-run          Estimate tokens only; no LM Studio calls
  --help, -h         This help

Env:
  GBRAIN_SYNOPSIS_MODEL          Default model (used if --model unset)
  GBRAIN_SYNOPSIS_DOC_MAX_CHARS  Doc truncation cap (default 16384, prod 16384)
  GBRAIN_BENCH_CONTEXT_BUDGET    Pre-call token-estimate cap (default 7500)
  LMSTUDIO_BASE_URL              LM Studio openai-compat endpoint (default 127.0.0.1:1234/v1)
`);
      process.exit(0);
    }
  }

  mkdirSync(outDir(), { recursive: true });

  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: gbrain init');
    process.exit(1);
  }
  configureGateway(buildGatewayConfig(config));
  const engineConfig = toEngineConfig(config);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);

  const modelTag = synopsisModel;
  console.log(`[bench] model=${modelTag} (gateway default: ${getChatModel() ?? 'unset'})`);
  console.log(`[bench] doc-max-chars=${SYNOPSIS_DOC_MAX_CHARS} ctx-budget=${MODEL_CONTEXT_BUDGET_TOKENS} sizes=${sizesArg.join(',')} dry=${dryRun}`);

  if (doWarmup && !dryRun) {
    console.log(`[bench] warmup: firing one call to load model into LM Studio memory...`);
    const warmupRes = await callChat(
      'You output one short word.',
      'Write the word: hello',
      20,
    );
    if (warmupRes.ok) {
      console.log(`[bench] warmup ok: ${warmupRes.wallMs}ms (raw="${warmupRes.text.slice(0, 50)}")`);
    } else {
      console.warn(`[bench] warmup FAILED: ${warmupRes.finishReasonRaw} ${(warmupRes.errorText ?? '').slice(0, 200)}`);
      console.warn(`[bench] continuing anyway; bench calls will likely also fail`);
    }
  }

  const pagesToBench =
    pageOverride !== null
      ? [{ slug: pageOverride, sourceId: sourceOverride ?? 'default', bucket: customBucket }]
      : DEFAULT_PAGES;

  const allResults: Array<Awaited<ReturnType<typeof benchPage>>> = [];
  for (const page of pagesToBench) {
    const res = await benchPage(engine, page, sizesArg, dryRun);
    allResults.push(res);
  }

  const report = renderReport(allResults, modelTag);
  const reportPath = `/tmp/bench-batched-synopsis-${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
  writeFileSync(reportPath, report);
  console.log(`\n[bench] report written: ${reportPath}`);
  console.log('\n' + report);

  await engine.disconnect();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
