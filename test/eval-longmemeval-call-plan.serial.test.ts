/**
 * `--call-plan` counts against an instrumented real run: the same flags run
 * end to end on the fixture with every provider stubbed (reader, extractor
 * and judge clients through the RunOpts seams; synopsis chat, embeddings and
 * the reranker through the gateway test transports), and the plan for those
 * flags is written with every global transport throwing.
 *
 * Protects: the exact lanes (trajectory_extract, synopsis, reader, judge,
 * rerank) plan the call counts the run makes; every lane's planned
 * in_tokens, under the planner's own token rule, is at least what the run
 * sent; embedding requests stay within the embed_doc + embed_query plan;
 * writing the plan reaches no global transport.
 * Serial: mutates the process-global gateway, its transports and an env var.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';
import { planTokens } from '../src/eval/longmemeval/call-plan.ts';
import {
  configureGateway, resetGateway, __clearQueryEmbedCacheForTests, __setChatTransportForTests, __setEmbedTransportForTests, __setRerankTransportForTests,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import type { ThinkLLMClient } from '../src/core/think/index.ts';
import type { JudgeChatFn } from '../src/eval/shared/judge-runner.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'longmemeval-mini.jsonl');
const DIMS = 1536;
const SYNOPSIS_MODEL = 'anthropic:claude-haiku-4-5-20251001';
const tmp = mkdtempSync(join(tmpdir(), 'lme-call-plan-serial-'));
const prevSynopsisModel = process.env.GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL;

interface Lane { calls: number; tokens: number }
const lane = (): Lane => ({ calls: 0, tokens: 0 });
let seen: Record<'extract' | 'synopsis' | 'reader' | 'judge' | 'rerank' | 'embed', Lane>;
const resetSeen = () => { seen = { extract: lane(), synopsis: lane(), reader: lane(), judge: lane(), rerank: lane(), embed: lane() }; };
const textOf = (content: unknown): string[] => typeof content === 'string' ? [content]
  : (content as Array<{ type: string; text?: string }>).map(b => (b.type === 'text' ? b.text ?? '' : ''));

const message = (model: string, text: string) => ({
  id: 'stub', type: 'message', role: 'assistant', model, content: [{ type: 'text', text, citations: null }], stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null }, container: null,
}) as unknown as Anthropic.Message;

const stubClient = (into: 'extract' | 'reader', answer: string): ThinkLLMClient => ({
  async create(params: Anthropic.MessageCreateParamsNonStreaming) {
    seen[into].calls++;
    seen[into].tokens += planTokens(typeof params.system === 'string' ? params.system : '') + params.messages.flatMap(m => textOf(m.content)).reduce((s, t) => s + planTokens(t), 0);
    return message(params.model, answer);
  },
}) as ThinkLLMClient;

const judge: JudgeChatFn = async (opts) => {
  seen.judge.calls++;
  seen.judge.tokens += opts.messages.flatMap(m => textOf(m.content)).reduce((s, t) => s + planTokens(t), 0);
  return { text: 'yes', blocks: [{ type: 'text', text: 'yes' }], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: opts.model ?? '', providerId: 'openai' } as ChatResult;
};

function installCountingTransports(): void {
  __setEmbedTransportForTests((async (p: { values: string[] }) => {
    seen.embed.calls++;
    seen.embed.tokens += p.values.reduce((s, v) => s + planTokens(v), 0);
    return { embeddings: p.values.map(v => Array.from({ length: DIMS }, (_, j) => (j === v.length % DIMS ? 1 : 0.01))), values: p.values, warnings: [], usage: { tokens: p.values.length } };
  }) as never);
  __setChatTransportForTests(async (opts) => {
    seen.synopsis.calls++;
    const blocks = opts.messages.flatMap(m => textOf(m.content));
    seen.synopsis.tokens += planTokens(opts.system ?? '') + blocks.reduce((s, t) => s + planTokens(t), 0);
    const user = blocks.join('\n');
    const chunk = user.slice(user.indexOf('<chunk>') + 8, user.indexOf('</chunk>')).trim();
    return { text: `Synopsis: ${chunk.split(/\s+/).slice(0, 4).join(' ')}`, blocks: [], stopReason: 'end', usage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: SYNOPSIS_MODEL, providerId: 'anthropic' };
  });
  __setRerankTransportForTests((async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { query: string; documents: string[] };
    seen.rerank.calls++;
    seen.rerank.tokens += body.documents.reduce((s, d) => s + planTokens(body.query) + planTokens(d), 0);
    const data = body.documents.map((_, index) => ({ index, relevance_score: 1 - index / (body.documents.length + 1) }));
    return new Response(JSON.stringify({ data, usage: { total_tokens: body.documents.length } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as never);
}

function installThrowingTransports(): void {
  const boom = (name: string) => async () => { throw new Error(`${name} reached during --call-plan`); };
  __setEmbedTransportForTests(boom('embed transport') as never);
  __setChatTransportForTests(boom('chat transport') as never);
  __setRerankTransportForTests(boom('rerank transport') as never);
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try { return await fn(); } finally { process.stderr.write = write; }
}

beforeAll(() => {
  process.env.GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL = SYNOPSIS_MODEL;
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-test', VOYAGE_API_KEY: 'pa-test' } });
});

afterAll(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  __setRerankTransportForTests(null);
  resetGateway();
  if (prevSynopsisModel === undefined) delete process.env.GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL;
  else process.env.GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL = prevSynopsisModel;
  rmSync(tmp, { recursive: true, force: true });
});

describe('eval longmemeval --call-plan vs an instrumented run', () => {
  test('tokenmax + judge: exact lanes match the run, every planned in_tokens covers what the run sent', async () => {
    const flags = ['--mode', 'tokenmax', '--judge', '--no-embed-cache', '--synopsis-cache', join(tmp, 'synopsis.jsonl')];
    const seams = { client: stubClient('reader', 'The answer.'), extractorClient: stubClient('extract', '[]'), judgeClient: judge, rerankerReadiness: async () => ({ plane: 'db', readiness: { ready: true } }) };

    resetSeen();
    installThrowingTransports();
    const planPath = join(tmp, 'plan.calls');
    await quiet(() => runEvalLongMemEval([FIXTURE, ...flags, '--call-plan', planPath], { exitOnError: false, ...seams, createBrain: async () => { throw new Error('no brain for --call-plan'); } } as never));
    expect(Object.values(seen).every(l => l.calls === 0)).toBe(true);
    const rows = Object.fromEntries(readFileSync(planPath, 'utf8').split('\n').filter(l => l.startsWith('GSTACK_EVAL_CALLS v1: ')).map((l) => {
      const r = Object.fromEntries(l.slice('GSTACK_EVAL_CALLS v1: '.length).split(' ').map(kv => kv.split('=') as [string, string]));
      return [r.purpose!, { calls: Number(r.calls), in: Number(r.in_tokens) }];
    }));

    resetSeen();
    installCountingTransports();
    __clearQueryEmbedCacheForTests();
    const engine = await createBenchmarkBrain();
    try {
      await quiet(() => runEvalLongMemEval([FIXTURE, ...flags, '--output', join(tmp, 'out.jsonl')], { exitOnError: false, engine, ...seams } as never));
    } finally {
      await engine.disconnect();
    }

    expect(seen.extract.calls).toBeGreaterThan(0);
    expect(rows.trajectory_extract!.calls).toBe(seen.extract.calls);
    expect(rows.trajectory_extract!.in).toBe(seen.extract.tokens);
    expect(seen.synopsis.calls).toBeGreaterThan(0);
    expect(rows.synopsis!.calls).toBe(seen.synopsis.calls);
    expect(rows.synopsis!.in).toBeGreaterThanOrEqual(seen.synopsis.tokens);
    expect(rows.reader!.calls).toBe(seen.reader.calls);
    expect(rows.reader!.in).toBeGreaterThanOrEqual(seen.reader.tokens);
    expect(rows.judge!.calls).toBe(seen.judge.calls);
    expect(rows.judge!.in).toBeGreaterThanOrEqual(seen.judge.tokens);
    expect(rows.rerank!.calls).toBe(seen.rerank.calls);
    expect(rows.rerank!.in).toBeGreaterThanOrEqual(seen.rerank.tokens);
    expect(rows.embed_doc!.calls + rows.embed_query!.calls).toBeGreaterThanOrEqual(seen.embed.calls);
    expect(rows.embed_doc!.in + rows.embed_query!.in).toBeGreaterThanOrEqual(seen.embed.tokens);
  }, 120_000);
});
