/**
 * `gbrain eval longmemeval --mode tokenmax` builds the per-chunk synopsis
 * vectors production builds for that mode (fake chat + embed transports; no
 * provider is called).
 *
 * Protects: a tokenmax run re-embeds every imported session through the
 * production contextual-retrieval service, so the embedded inputs carry the
 * generated synopsis and each row reports the tier it built; the synopsis
 * model folds into run_config and retrieval_config_hash; balanced makes no
 * synopsis call; a rerun is served from the on-disk synopsis cache with no
 * chat call; the spend cap stops the run after the question that reached it
 * and fails the run.
 * Serial: mutates the process-global gateway, its transports and an env var.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvalLongMemEval } from '../src/commands/eval-longmemeval.ts';
import { createBenchmarkBrain } from '../src/eval/longmemeval/harness.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'longmemeval-mini.jsonl');
const DIMS = 1536;
const MODEL = 'anthropic:claude-haiku-4-5-20251001';
const tmp = mkdtempSync(join(tmpdir(), 'lme-synopsis-'));
const prevModelEnv = process.env.GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL;

let embedInputs: string[] = [];
let chatModels: string[] = [];
const embedTransport = (async (p: { values: string[] }) => {
  embedInputs.push(...p.values);
  return { embeddings: p.values.map((v) => Array.from({ length: DIMS }, (_, j) => (j === v.length % DIMS ? 1 : 0.01))), values: p.values, warnings: [], usage: { tokens: p.values.length } };
}) as unknown as Parameters<typeof __setEmbedTransportForTests>[0];

async function run(args: string[]): Promise<{ rows: any[]; summary: any; err: string; threw: boolean }> {
  const out = join(tmp, `out-${Math.random().toString(36).slice(2)}.jsonl`);
  const engine = await createBenchmarkBrain();
  const write = process.stderr.write.bind(process.stderr);
  let err = '';
  let threw = false;
  process.stderr.write = ((s: string) => { err += s; return true; }) as typeof process.stderr.write;
  try {
    await runEvalLongMemEval([FIXTURE, '--no-embed-cache', '--by-type', '--retrieval-only', '--no-trajectory', '--reranker', 'off', '--output', out, ...args], {
      engine, exitOnError: false, embedTransport,
    });
  } catch {
    threw = true;
  } finally {
    process.stderr.write = write;
    await engine.disconnect();
  }
  const lines = readFileSync(out, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  return { rows: lines.filter((l) => l.kind !== 'by_type_summary'), summary: lines.find((l) => l.kind === 'by_type_summary'), err, threw };
}

beforeAll(() => {
  process.env.GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL = MODEL;
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests(embedTransport);
  __setChatTransportForTests(async (opts) => {
    chatModels.push(String(opts.model));
    const user = String(opts.messages[0]?.content ?? '');
    const chunk = user.slice(user.indexOf('<chunk>') + 8, user.indexOf('</chunk>')).trim();
    return {
      text: `Synopsis: ${chunk.split(/\s+/).slice(0, 4).join(' ')}`, blocks: [], stopReason: 'end',
      usage: { input_tokens: 1000, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: MODEL, providerId: 'anthropic',
    };
  });
});

beforeEach(() => { embedInputs = []; chatModels = []; });

afterAll(() => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
  if (prevModelEnv === undefined) delete process.env.GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL;
  else process.env.GBRAIN_CONTEXTUAL_SYNOPSIS_MODEL = prevModelEnv;
  rmSync(tmp, { recursive: true, force: true });
});

describe('eval longmemeval tokenmax synopsis tier', () => {
  test('tokenmax embeds production synopses, pins the model, and reruns from the cache', async () => {
    const cache = join(tmp, 'synopsis.jsonl');
    const balanced = await run(['--mode', 'balanced', '--limit', '2']);
    expect(chatModels).toHaveLength(0);
    expect(balanced.rows.every((r) => !('contextual_synopsis' in r))).toBe(true);
    expect(balanced.summary.run_config.contextual_synopsis).toBeUndefined();

    const tm = await run(['--mode', 'tokenmax', '--limit', '2', '--synopsis-cache', cache]);
    expect(tm.threw).toBe(false);
    expect(chatModels.length).toBeGreaterThan(0);
    expect(new Set(chatModels)).toEqual(new Set([MODEL]));
    expect(embedInputs.some((t) => /^<context>[^\n]*\nSynopsis: /.test(t))).toBe(true);
    for (const r of tm.rows) {
      expect(r.contextual_synopsis.pages).toBeGreaterThan(0);
      expect(r.contextual_synopsis.pages_synopsis).toBe(r.contextual_synopsis.pages);
      expect(r.contextual_synopsis.calls).toBe(r.contextual_synopsis.chunks);
      expect(r.contextual_synopsis.usd).toBeCloseTo(r.contextual_synopsis.calls * 0.0011, 6);
    }
    expect(tm.summary.run_config.contextual_synopsis).toMatchObject({ model: MODEL, prompt_version: 1, max_tokens: 200 });
    expect(tm.rows[0].retrieval_config_hash).not.toBe(balanced.rows[0].retrieval_config_hash);
    expect(tm.err).toContain('[longmemeval] synopsis tier:');

    chatModels = [];
    const again = await run(['--mode', 'tokenmax', '--limit', '2', '--synopsis-cache', cache]);
    expect(chatModels).toHaveLength(0);
    expect(again.rows.map((r) => r.contextual_synopsis.cache_hits)).toEqual(tm.rows.map((r) => r.contextual_synopsis.chunks));
    expect(again.rows.map((r) => r.retrieved_session_ids)).toEqual(tm.rows.map((r) => r.retrieved_session_ids));
  }, 120_000);

  test('the spend cap stops the run after the question that reached it and fails the run', async () => {
    const capped = await run(['--mode', 'tokenmax', '--synopsis-max-usd', '0.0005', '--synopsis-concurrency', '1', '--synopsis-cache', join(tmp, 'capped.jsonl')]);
    expect(capped.threw).toBe(true);
    expect(capped.rows).toHaveLength(1);
    expect(String(capped.rows[0].error)).toContain('synopsis spend reached its cap');
    expect(capped.err).toContain('FAIL --synopsis-max-usd');
  }, 120_000);
});
